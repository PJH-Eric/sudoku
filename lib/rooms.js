/*
 * lib/rooms.js — 線上觀戰房間的權威狀態（純邏輯，不碰 HTTP）
 *
 * 為什麼獨立成一個模組：
 *   1. server.js 只負責 HTTP／SSE 傳輸，房間規則放這裡才測得動（tests/verify.js 直接 require 它）。
 *   2. 所有時間相關的行為（寬限期、閒置回收、聊天頻率）都吃注入的 now()，測試不必真的等。
 *
 * 權威原則：
 *   - 房號、token、版本號、觀戰人數、聊天頻率與長度一律由這裡決定，不看用戶端送什麼。
 *   - 主持人身分＝ hostToken；沒有 token 或 token 不對，就不能改盤面、不能關房、不能以主持人身分發言。
 *   - 盤面只是「主持人狀態的唯讀鏡像」：這裡不重新實作數獨規則，只做結構驗證
 *     （81 格、0–9、題目給的格子不可被竄改），真正的規則仍然只有 public/js/sudoku.js 一份。
 *
 * 房間狀態放在記憶體：Render 重啟或重新部署就會全部消失，這是免費層的已知取捨，README 有寫。
 */
'use strict';

const crypto = require('crypto');

/* 房號字母表：拿掉 I／O／0／1，避免抄錯或唸錯 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

const DEFAULTS = {
  maxRooms: 40,             // 房間總數上限（免費層記憶體有限）
  maxViewersPerRoom: 24,    // 單一房間同時觀戰人數上限
  maxMessages: 60,          // 房內保留的訊息數（超過就丟掉最舊的）
  historyForNewViewer: 25,  // 新加入的人一次看到幾則歷史
  maxTextLength: 120,       // 一則訊息最長幾個字
  maxNoteLength: 10,        // 每則格子留言最長幾個字
  maxNotesPerCell: 60,      // 每格最多保留幾則留言，避免房間記憶體無限增長
  maxNameLength: 12,        // 暱稱最長幾個字
  chatMinIntervalMs: 700,   // 兩則訊息之間至少要隔多久
  chatWindowMs: 10000,      // 頻率限制的觀察窗
  chatMaxPerWindow: 8,      // 觀察窗內最多幾則
  noteMinIntervalMs: 400,   // 格子留言間隔，避免刷爆 SSE
  noteWindowMs: 10000,      // 格子留言頻率限制的觀察窗
  noteMaxPerWindow: 30,     // 觀察窗內最多幾次格子留言
  hostGraceMs: 90000,       // 主持人斷線後可以憑 token 回來的寬限期
  idleCloseMs: 1800000,     // 房間完全沒動靜多久之後回收（30 分鐘）
  doneKeepMs: 600000        // 主持人解完之後房間再留多久（10 分鐘）
};

const CELLS = 81;

/* ---------- 文字淨化 ----------
 * 前端一律用 textContent 顯示，所以這裡不做 HTML 跳脫（會把「5 > 3」變成亂碼）。
 * 這裡要處理的是「用看不見的字元搞亂版面或冒充別人」：控制字元、零寬字元、雙向覆寫字元。 */
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  let s = raw;
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, ' ');
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '');
  s = s.replace(/[\u2028\u2029]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function cleanName(raw, max) {
  const s = cleanText(raw, max);
  return s || '';
}

function isDigitString(v, len) {
  return typeof v === 'string' && v.length === len && /^[0-9]+$/.test(v);
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ---------- 盤面快照驗證 ----------
 * 回傳正規化後的快照，或 null（代表格式不合，呼叫端要拒絕）。
 * puzzle 是題目原本就給的數字，values 是主持人目前填的內容；
 * 題目給的格子在 values 裡必須維持原值，避免有人送一份亂改的鏡像進來。 */
function cleanSnapshot(raw, previous) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isDigitString(raw.puzzle, CELLS) || !isDigitString(raw.values, CELLS)) return null;
  /* 一旦房間開起來，題目就不能被換掉（否則觀戰者看到的東西會前後對不上） */
  if (previous && previous.puzzle !== raw.puzzle) return null;
  for (let i = 0; i < CELLS; i++) {
    const given = raw.puzzle.charAt(i);
    if (given !== '0' && raw.values.charAt(i) !== given) return null;
  }
  const notes = new Array(CELLS);
  const rawNotes = Array.isArray(raw.notes) ? raw.notes : [];
  for (let i = 0; i < CELLS; i++) notes[i] = clampInt(rawNotes[i], 0, 511, 0);

  let givens = 0;
  let filled = 0;
  for (let i = 0; i < CELLS; i++) {
    if (raw.puzzle.charAt(i) !== '0') givens++;
    else if (raw.values.charAt(i) !== '0') filled++;
  }

  return {
    puzzle: raw.puzzle,
    values: raw.values,
    notes: notes,
    /* 超出範圍的選格代表資料有問題，一律當成「沒選」，不要硬夾成第 80 格 */
    selected: (function (v) {
      var n = Math.floor(Number(v));
      return (isFinite(n) && n >= 0 && n < CELLS) ? n : -1;
    }(raw.selected)),
    elapsedMs: clampInt(raw.elapsedMs, 0, 86400000, 0),
    hintsUsed: clampInt(raw.hintsUsed, 0, 999, 0),
    mistakes: clampInt(raw.mistakes, 0, 9999, 0),
    status: raw.status === 'won' ? 'won' : 'playing',
    paused: !!raw.paused,
    givens: givens,
    filled: filled,
    total: CELLS - givens
  };
}

function token() {
  return crypto.randomBytes(16).toString('hex');
}

function createStore(options) {
  const cfg = Object.assign({}, DEFAULTS, options || {});
  const now = (options && typeof options.now === 'function') ? options.now : Date.now;
  const rooms = new Map();
  const listeners = [];
  let messageSeq = 0;
  let noteSeq = 0;

  function emit(type, code, payload) {
    for (let i = 0; i < listeners.length; i++) {
      try { listeners[i]({ type: type, code: code, payload: payload }); } catch (e) { /* 單一訂閱者出錯不影響其他人 */ }
    }
  }

  function makeCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    return null;
  }

  /* ---------- 建立房間 ---------- */
  function createRoom(input) {
    const data = input || {};
    sweep();
    if (rooms.size >= cfg.maxRooms) {
      return { ok: false, code: 'full', message: '目前開著的房間已經達到上限，請稍後再試，或等別人關房。' };
    }
    const snapshot = cleanSnapshot(data.snapshot, null);
    if (!snapshot) {
      return { ok: false, code: 'snapshot', message: '盤面資料格式不正確，沒有建立房間。' };
    }
    const hostName = cleanName(data.hostName, cfg.maxNameLength) || '匿名主持人';
    const code = makeCode();
    if (!code) {
      return { ok: false, code: 'code', message: '房號產生失敗，請再試一次。' };
    }
    const t = now();
    const room = {
      code: code,
      hostToken: token(),
      /* 邀請 token：不可猜測、綁定這個房間、主持人可以隨時換掉讓舊連結失效 */
      inviteToken: token(),
      hostName: hostName,
      difficulty: typeof data.difficulty === 'string' ? cleanText(data.difficulty, 12) : '',
      label: cleanText(data.label, 12) || '',
      technique: cleanText(data.technique, 24) || '',
      seed: cleanText(data.seed, 12).toUpperCase(),
      snapshot: snapshot,
      version: 1,
      status: snapshot.status === 'won' ? 'done' : 'live',
      createdAt: t,
      updatedAt: t,
      lastActiveAt: t,
      doneAt: snapshot.status === 'won' ? t : 0,
      hostOnline: false,
      hostSeenAt: t,
      viewers: new Map(),      // viewerId -> { id, token, name, joinedAt, chat: [] }
      messages: [],
      chatLog: new Map(),      // token -> 最近送出時間陣列（頻率限制用）
      cellNotes: Array.from({ length: CELLS }, () => []),
      noteVersion: 0,
      noteLog: new Map()       // token -> 最近送出格子留言的時間陣列（頻率限制用）
    };
    rooms.set(code, room);
    emit('roomlist', code, null);
    return { ok: true, code: code, hostToken: room.hostToken, inviteToken: room.inviteToken, room: publicRoom(room) };
  }

  /* ---------- 查詢 ---------- */
  function publicRoom(room) {
    return {
      code: room.code,
      hostName: room.hostName,
      difficulty: room.difficulty,
      label: room.label,
      technique: room.technique,
      seed: room.seed,
      status: room.status,
      hostOnline: room.hostOnline,
      viewers: room.viewers.size,
      maxViewers: cfg.maxViewersPerRoom,
      filled: room.snapshot.filled,
      total: room.snapshot.total,
      elapsedMs: room.snapshot.elapsedMs,
      hintsUsed: room.snapshot.hintsUsed,
      mistakes: room.snapshot.mistakes,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      version: room.version
    };
  }

  function stateEvent(room) {
    return {
      code: room.code,
      version: room.version,
      status: room.status,
      hostOnline: room.hostOnline,
      hostName: room.hostName,
      difficulty: room.difficulty,
      label: room.label,
      technique: room.technique,
      seed: room.seed,
      viewers: room.viewers.size,
      board: room.snapshot,
      cellNotes: room.cellNotes.map((notes) => notes.map((note) => Object.assign({}, note))),
      noteVersion: room.noteVersion
    };
  }

  function cellNoteEvent(room, index) {
    return {
      code: room.code,
      index: index,
      version: room.noteVersion,
      notes: room.cellNotes[index].map((note) => Object.assign({}, note))
    };
  }

  function getRoom(code) {
    const room = rooms.get(String(code || '').toUpperCase());
    return room || null;
  }

  function listRooms() {
    sweep();
    const out = [];
    rooms.forEach((room) => { if (room.status !== 'closed') out.push(publicRoom(room)); });
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  function roomCount() { return rooms.size; }

  /* ---------- 主持人更新盤面 ---------- */
  function updateState(code, hostToken, rawSnapshot) {
    const room = getRoom(code);
    if (!room) return { ok: false, code: 'nosuch', status: 404, message: '找不到這個房間，可能已經關閉了。' };
    if (room.hostToken !== hostToken) {
      return { ok: false, code: 'forbidden', status: 403, message: '只有開房的人可以更新盤面。' };
    }
    if (room.status === 'closed') {
      return { ok: false, code: 'closed', status: 410, message: '這個房間已經關閉了。' };
    }
    const snapshot = cleanSnapshot(rawSnapshot, room.snapshot);
    if (!snapshot) return { ok: false, code: 'snapshot', status: 400, message: '盤面資料格式不正確。' };

    room.snapshot = snapshot;
    room.version++;
    const t = now();
    room.updatedAt = t;
    room.lastActiveAt = t;
    room.hostSeenAt = t;
    if (snapshot.status === 'won' && room.status !== 'done') {
      room.status = 'done';
      room.doneAt = t;
    }
    emit('state', room.code, stateEvent(room));
    emit('roomlist', room.code, null);
    return { ok: true, version: room.version, state: stateEvent(room) };
  }

  /* ---------- 主持人連線／斷線（SSE 開關） ---------- */
  function attachHost(code, hostToken) {
    const room = getRoom(code);
    if (!room) return { ok: false, code: 'nosuch', status: 404, message: '找不到這個房間，可能已經關閉了。' };
    if (room.hostToken !== hostToken) {
      return { ok: false, code: 'forbidden', status: 403, message: '主持人身分驗證失敗。' };
    }
    if (room.status === 'closed') {
      return { ok: false, code: 'closed', status: 410, message: '這個房間已經關閉了。' };
    }
    room.hostOnline = true;
    room.hostSeenAt = now();
    room.lastActiveAt = room.hostSeenAt;
    emit('presence', room.code, presenceEvent(room));
    emit('roomlist', room.code, null);
    return { ok: true, room: room, state: stateEvent(room), history: recentMessages(room) };
  }

  function detachHost(code, hostToken) {
    const room = getRoom(code);
    if (!room || room.hostToken !== hostToken) return { ok: false };
    room.hostOnline = false;
    room.hostSeenAt = now();
    emit('presence', room.code, presenceEvent(room));
    emit('roomlist', room.code, null);
    return { ok: true };
  }

  /* ---------- 觀戰者加入／離開 ---------- */
  function addViewer(code, input) {
    const data = input || {};
    const room = getRoom(code);
    if (!room) return { ok: false, code: 'nosuch', status: 404, message: '找不到這個房間，可能已經關閉了。' };
    if (room.status === 'closed') {
      return { ok: false, code: 'closed', status: 410, message: '這個房間已經關閉了。' };
    }
    /* 帶了邀請 token 就一定要對：主持人換過連結之後，舊連結必須明確失效。
     * 沒帶 token 的人（從公開房間列表或房號進來）照常放行。 */
    if (data.invite && data.invite !== room.inviteToken) {
      return { ok: false, code: 'invite', status: 403, message: '這個邀請連結已經失效了（主持人重新產生過連結）。可以改用房號加入，或回大廳看看。' };
    }
    if (room.viewers.size >= cfg.maxViewersPerRoom) {
      return { ok: false, code: 'full', status: 409, message: '這個房間的觀戰人數已滿，請稍後再試。' };
    }
    const viewer = {
      id: 'v' + (++messageSeq) + '-' + crypto.randomBytes(4).toString('hex'),
      token: token(),
      name: cleanName(data.name, cfg.maxNameLength) || '路過的觀眾',
      joinedAt: now()
    };
    room.viewers.set(viewer.id, viewer);
    room.lastActiveAt = viewer.joinedAt;
    emit('presence', room.code, presenceEvent(room));
    emit('roomlist', room.code, null);
    return {
      ok: true,
      viewerId: viewer.id,
      viewerToken: viewer.token,
      name: viewer.name,
      state: stateEvent(room),
      history: recentMessages(room)
    };
  }

  function removeViewer(code, viewerId) {
    const room = getRoom(code);
    if (!room) return { ok: false };
    const viewer = room.viewers.get(viewerId);
    if (!viewer) return { ok: false };
    room.viewers.delete(viewerId);
    room.chatLog.delete(viewer.token);
    room.lastActiveAt = now();
    emit('presence', room.code, presenceEvent(room));
    emit('roomlist', room.code, null);
    return { ok: true };
  }

  function identify(room, senderToken) {
    if (senderToken && senderToken === room.hostToken) {
      return { role: 'host', id: 'host', name: room.hostName };
    }
    let found = null;
    room.viewers.forEach((viewer) => {
      if (!found && viewer.token === senderToken) found = viewer;
    });
    if (!found) return null;
    return { role: 'viewer', id: found.id, name: found.name, viewer: found };
  }

  function presenceEvent(room) {
    return {
      code: room.code,
      viewers: room.viewers.size,
      maxViewers: cfg.maxViewersPerRoom,
      hostOnline: room.hostOnline,
      hostName: room.hostName,
      status: room.status
    };
  }

  /* ---------- 聊天 ---------- */
  function recentMessages(room) {
    return room.messages.slice(-cfg.historyForNewViewer);
  }

  function allowedByRate(room, senderToken) {
    const t = now();
    const list = (room.chatLog.get(senderToken) || []).filter((at) => t - at < cfg.chatWindowMs);
    if (list.length && t - list[list.length - 1] < cfg.chatMinIntervalMs) {
      return { ok: false, code: 'toofast', status: 429, message: '訊息送太快了，喘口氣再說。' };
    }
    if (list.length >= cfg.chatMaxPerWindow) {
      return { ok: false, code: 'toomany', status: 429, message: '短時間內講太多話了，等幾秒再繼續。' };
    }
    list.push(t);
    room.chatLog.set(senderToken, list);
    return { ok: true };
  }

  function chat(code, senderToken, rawText, rawName) {
    const room = getRoom(code);
    if (!room) return { ok: false, code: 'nosuch', status: 404, message: '找不到這個房間，可能已經關閉了。' };
    if (room.status === 'closed') {
      return { ok: false, code: 'closed', status: 410, message: '這個房間已經關閉了，訊息沒有送出。' };
    }

    let role = null;
    let viewer = null;
    if (senderToken && senderToken === room.hostToken) {
      role = 'host';
    } else {
      room.viewers.forEach((v) => { if (!viewer && v.token === senderToken) viewer = v; });
      if (viewer) role = 'viewer';
    }
    if (!role) {
      return { ok: false, code: 'forbidden', status: 403, message: '你已經不在這個房間裡了，請重新加入。' };
    }

    const text = cleanText(rawText, cfg.maxTextLength);
    if (!text) return { ok: false, code: 'empty', status: 400, message: '訊息是空的，沒有送出。' };
    if (typeof rawText === 'string' && rawText.trim().length > cfg.maxTextLength) {
      return { ok: false, code: 'toolong', status: 400, message: '一則訊息最多 ' + cfg.maxTextLength + ' 個字。' };
    }

    const gate = allowedByRate(room, senderToken);
    if (!gate.ok) return gate;

    /* 暱稱可以隨時改，但主持人的顯示名稱固定用開房時登記的，避免有人冒充 */
    let name;
    if (role === 'host') {
      const wanted = cleanName(rawName, cfg.maxNameLength);
      if (wanted) room.hostName = wanted;
      name = room.hostName;
    } else {
      const wanted = cleanName(rawName, cfg.maxNameLength);
      if (wanted) viewer.name = wanted;
      name = viewer.name;
    }

    const t = now();
    const message = {
      id: ++messageSeq,
      role: role,
      name: name,
      text: text,
      at: t
    };
    room.messages.push(message);
    if (room.messages.length > cfg.maxMessages) room.messages.splice(0, room.messages.length - cfg.maxMessages);
    room.lastActiveAt = t;
    if (role === 'host') room.hostSeenAt = t;
    emit('chat', room.code, message);
    return { ok: true, message: message };
  }

  /* ---------- 共享格子留言 ----------
   * 每次送出都新增一則留言，和聊天室一樣保留歷史，不會取代同一人的舊內容。
   * 留言不是盤面狀態，不會混進主持人的 state 快照；所有人透過 note 事件看到同一份清單。 */
  function allowedNoteByRate(room, senderToken) {
    const t = now();
    const list = (room.noteLog.get(senderToken) || [])
      .filter((at) => t - at < cfg.noteWindowMs);
    if (list.length && t - list[list.length - 1] < cfg.noteMinIntervalMs) {
      return { ok: false, code: 'toofast', status: 429, message: '格子留言太快了，稍等一下再送。' };
    }
    if (list.length >= cfg.noteMaxPerWindow) {
      return { ok: false, code: 'toomany', status: 429, message: '短時間內送出太多格子留言了，等幾秒再繼續。' };
    }
    list.push(t);
    room.noteLog.set(senderToken, list);
    return { ok: true };
  }

  function updateCellNote(code, senderToken, rawIndex, rawText, rawName) {
    const room = getRoom(code);
    if (!room) return { ok: false, code: 'nosuch', status: 404, message: '找不到這個房間，可能已經關閉了。' };
    if (room.status === 'closed') {
      return { ok: false, code: 'closed', status: 410, message: '這個房間已經關閉了，留言沒有送出。' };
    }
    const member = identify(room, senderToken);
    if (!member) {
      return { ok: false, code: 'forbidden', status: 403, message: '你已經不在這個房間裡了，請重新加入。' };
    }

    const index = Math.floor(Number(rawIndex));
    if (!isFinite(index) || index < 0 || index >= CELLS) {
      return { ok: false, code: 'index', status: 400, message: '沒有選到有效的格子。' };
    }
    if (typeof rawText !== 'string') {
      return { ok: false, code: 'text', status: 400, message: '格子留言格式不正確。' };
    }
    if (rawText.trim().length > cfg.maxNoteLength) {
      return { ok: false, code: 'toolong', status: 400, message: '每則格子留言最多 ' + cfg.maxNoteLength + ' 個字。' };
    }
    const text = cleanText(rawText, cfg.maxNoteLength);
    if (!text) {
      return { ok: false, code: 'empty', status: 400, message: '格子留言不能是空白。' };
    }
    const gate = allowedNoteByRate(room, senderToken);
    if (!gate.ok) return gate;

    if (member.role === 'viewer') {
      const wanted = cleanName(rawName, cfg.maxNameLength);
      if (wanted) member.viewer.name = wanted;
      member.name = member.viewer.name;
    }

    const list = room.cellNotes[index];
    if (list.length >= cfg.maxNotesPerCell) {
      return { ok: false, code: 'full', status: 409, message: '這格的共享留言已經太多了。' };
    }
    list.push({
      id: 'n' + (++noteSeq),
      authorId: member.id,
      role: member.role,
      name: member.name,
      text: text,
      at: now()
    });

    const t = now();
    room.noteVersion++;
    room.lastActiveAt = t;
    if (member.role === 'host') room.hostSeenAt = t;
    const event = cellNoteEvent(room, index);
    emit('note', room.code, event);
    return { ok: true, index: index, version: room.noteVersion, note: event.notes[event.notes.length - 1], notes: event.notes };
  }

  /* ---------- 重新產生邀請連結（撤銷舊連結） ---------- */
  function rotateInvite(code, hostToken) {
    const room = getRoom(code);
    if (!room) return { ok: false, code: 'nosuch', status: 404, message: '找不到這個房間。' };
    if (room.hostToken !== hostToken) {
      return { ok: false, code: 'forbidden', status: 403, message: '只有開房的人可以重新產生邀請連結。' };
    }
    if (room.status === 'closed') {
      return { ok: false, code: 'closed', status: 410, message: '這個房間已經關閉了。' };
    }
    room.inviteToken = token();
    room.lastActiveAt = now();
    return { ok: true, inviteToken: room.inviteToken };
  }

  /* ---------- 關房 ---------- */
  function closeRoom(code, hostToken, reason) {
    const room = getRoom(code);
    if (!room) return { ok: false, code: 'nosuch', status: 404, message: '找不到這個房間。' };
    if (room.hostToken !== hostToken) {
      return { ok: false, code: 'forbidden', status: 403, message: '只有開房的人可以關閉房間。' };
    }
    forceClose(room, reason || 'host');
    return { ok: true };
  }

  function forceClose(room, reason) {
    if (room.status === 'closed') return;
    room.status = 'closed';
    room.hostOnline = false;
    room.viewers.clear();
    rooms.delete(room.code);
    emit('closed', room.code, { code: room.code, reason: reason });
    emit('roomlist', room.code, null);
  }

  /* ---------- 回收 ----------
   * 三種情況會關房：
   *   1. 主持人斷線超過寬限期（沒有憑 token 回來）
   *   2. 解完之後放置太久
   *   3. 整個房間完全沒動靜太久 */
  function sweep() {
    const t = now();
    const doomed = [];
    rooms.forEach((room) => {
      if (room.status === 'closed') { doomed.push([room, 'closed']); return; }
      if (!room.hostOnline && t - room.hostSeenAt > cfg.hostGraceMs) { doomed.push([room, 'hostgone']); return; }
      if (room.status === 'done' && room.doneAt && t - room.doneAt > cfg.doneKeepMs) { doomed.push([room, 'done']); return; }
      if (t - room.lastActiveAt > cfg.idleCloseMs) { doomed.push([room, 'idle']); }
    });
    doomed.forEach(([room, reason]) => forceClose(room, reason));
    return doomed.length;
  }

  return {
    config: cfg,
    createRoom: createRoom,
    getRoom: getRoom,
    listRooms: listRooms,
    roomCount: roomCount,
    publicRoom: publicRoom,
    stateEvent: stateEvent,
    presenceEvent: presenceEvent,
    recentMessages: recentMessages,
    updateState: updateState,
    attachHost: attachHost,
    detachHost: detachHost,
    addViewer: addViewer,
    removeViewer: removeViewer,
    chat: chat,
    updateCellNote: updateCellNote,
    rotateInvite: rotateInvite,
    closeRoom: closeRoom,
    sweep: sweep,
    on: function (fn) { listeners.push(fn); return function () { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
  };
}

module.exports = {
  CODE_ALPHABET: CODE_ALPHABET,
  CODE_LENGTH: CODE_LENGTH,
  DEFAULTS: DEFAULTS,
  cleanText: cleanText,
  cleanSnapshot: cleanSnapshot,
  createStore: createStore
};
