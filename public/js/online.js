/* ===== online.js — 線上觀戰／留言的連線層 =====
 * 這一層只做「講話」：組請求、開 SSE、管連線狀態與重試。
 * 它不認識數獨規則（那是 sudoku.js / game.js 的事），也不碰畫面（那是 app.js 的事）。
 *
 * 連線位置一律從 window.GameConfig 拿，這個檔案裡不會出現任何寫死的網址。
 *
 * 為什麼是 SSE（下行）＋ POST（上行），而不是 WebSocket：
 *   - 專案維持零外部套件，Node 內建沒有 WebSocket 伺服器。
 *   - 盤面與聊天都是低頻事件，不需要雙向即時通道。
 *   - EventSource 內建自動重連，斷線恢復不必自己寫一套。
 *
 * 連線狀態（會回報給 app.js 顯示）：
 *   idle 尚未連線 ｜ connecting 連線中 ｜ waking 伺服器喚醒中 ｜ open 已連線
 *   retrying 已斷線，重試中 ｜ failed 連不上（停止重試，給使用者重試／返回）
 *   closed 房間已關閉
 */
(function (w) {
  'use strict';

  var C = w.GameConfig;

  var REQUEST_TIMEOUT_MS = 20000;   // 免費層冷啟動可能要十幾秒，逾時放寬
  var WAKING_HINT_MS = 2500;        // 超過這個時間還沒回應，就說「伺服器喚醒中」
  var MAX_STREAM_RETRIES = 6;       // 連續重試幾次還不行就停下來，不無限轉圈
  var STATE_MIN_INTERVAL_MS = 600;  // 盤面推送最短間隔（合併連續操作）
  var STATE_KEEPALIVE_MS = 3000;    // 沒有操作時也定期推一次，讓觀戰者的計時跟得上

  var session = null;   // { code, role, token, viewerId, name, es, retries, state }
  var handlers = {};
  var pendingSnapshot = null;
  var stateTimer = null;
  var lastStateAt = 0;
  var pushing = false;
  var latencyProbeInFlight = false;

  function T(key, params) {
    return (w.I18N && w.I18N.t) ? w.I18N.t(key, params) : key;
  }

  /* 伺服器的錯誤回應帶 msgKey（字典 key）與 msgParams，前端直接翻譯；
   * message 仍保留中文句子當相容備援：舊版伺服器沒有 msgKey 時，才用下面的「整句對照」找字典 key。 */
  var SRV_EXACT = {
    '不支援的方法。': 'srv.method',
    '主持人身分驗證失敗。': 'srv.hostAuth',
    '你已經不在這個房間裡了，請重新加入。': 'srv.notInRoom',
    '只有開房的人可以更新盤面。': 'srv.hostOnlyUpdate',
    '只有開房的人可以重新產生邀請連結。': 'srv.hostOnlyInvite',
    '只有開房的人可以開始下一局。': 'srv.hostOnlyRound',
    '只有開房的人可以關閉房間。': 'srv.hostOnlyClose',
    '房號產生失敗，請再試一次。': 'srv.codeFail',
    '找不到這個房間。': 'srv.noRoomShort',
    '找不到這個房間，可能已經關閉了。': 'srv.noRoom',
    '格子留言不能是空白。': 'srv.noteEmpty',
    '格子留言太快了，稍等一下再送。': 'srv.noteFast',
    '格子留言格式不正確。': 'srv.noteFormat',
    '沒有這個端點。': 'srv.endpoint',
    '沒有選到有效的格子。': 'srv.noteCell',
    '盤面資料格式不正確。': 'srv.snapshot',
    '盤面資料格式不正確，沒有建立房間。': 'srv.snapshotCreate',
    '目前開著的房間已經達到上限，請稍後再試，或等別人關房。': 'srv.roomsFull',
    '短時間內講太多話了，等幾秒再繼續。': 'srv.chatMany',
    '短時間內送出太多格子留言了，等幾秒再繼續。': 'srv.noteMany',
    '訊息是空的，沒有送出。': 'srv.chatEmpty',
    '訊息送太快了，喘口氣再說。': 'srv.chatFast',
    '送出的資料格式不正確。': 'srv.body',
    '這個來源不在伺服器允許的名單裡（GAME_ALLOWED_ORIGIN）。': 'srv.origin',
    '這個房間已經關閉了。': 'srv.closed',
    '這個房間已經關閉了，留言沒有送出。': 'srv.closedNote',
    '這個房間已經關閉了，訊息沒有送出。': 'srv.closedChat',
    '這個房間的觀戰人數已滿，請稍後再試。': 'srv.viewersFull',
    '這個邀請連結已經失效了（主持人重新產生過連結）。可以改用房號加入，或回大廳看看。': 'srv.inviteGone',
    '這格的共享留言已經太多了。': 'srv.noteTooMany'
  };
  var SRV_PATTERN = [
    [/^一則訊息最多 (\d+) 個字。$/, 'srv.chatLong', 'n'],
    [/^每則格子留言最多 (\d+) 個字。$/, 'srv.noteLong', 'n'],
    [/^找不到房號 (\S+)，可能已經關閉了。$/, 'srv.noCode', 'code']
  ];
  function srvMsg(msg) {
    if (typeof msg !== 'string' || !msg) return msg;
    if (SRV_EXACT[msg]) return T(SRV_EXACT[msg]);
    for (var i = 0; i < SRV_PATTERN.length; i++) {
      var m = SRV_PATTERN[i][0].exec(msg);
      if (m) { var p = {}; p[SRV_PATTERN[i][2]] = m[1]; return T(SRV_PATTERN[i][1], p); }
    }
    return msg;
  }

  function isEnabled() { return !!(C && C.isOnlineEnabled()); }

  /* 線上功能沒開時，要講清楚原因，不可以做成點了沒反應 */
  function disabledReason() {
    if (!C) return T('err.noConfig');
    if (C.status === 'invalid') {
      return T('err.badUrl');
    }
    if (typeof w.EventSource !== 'function' || typeof w.fetch !== 'function') {
      return T('err.noSupport');
    }
    return T('err.offline');
  }

  function apiUrl(path) { return C ? C.url(path) : null; }

  function friendlyNetworkError() {
    return T('err.network');
  }

  /* ---------- 共用請求 ----------
   * cb(err, data)；err 是 { code, message, status } 形狀，訊息可以直接顯示給玩家看。
   * onWaking：請求超過 WAKING_HINT_MS 還沒回來時呼叫一次，讓 UI 顯示「伺服器喚醒中」。 */
  function request(method, path, body, cb, onWaking) {
    if (!isEnabled()) {
      return cb({ code: 'offline', message: disabledReason(), status: 0 }, null);
    }
    var url = apiUrl(path);
    if (!url) return cb({ code: 'offline', message: disabledReason(), status: 0 }, null);

    var done = false;
    var controller = (typeof w.AbortController === 'function') ? new w.AbortController() : null;
    var timeout = setTimeout(function () {
      if (done) return;
      done = true;
      if (controller) { try { controller.abort(); } catch (e) {} }
      cb({ code: 'timeout', message: friendlyNetworkError(), status: 0 }, null);
    }, REQUEST_TIMEOUT_MS);
    var wakeTimer = onWaking ? setTimeout(function () { if (!done) onWaking(); }, WAKING_HINT_MS) : null;

    var init = { method: method, cache: 'no-store' };
    if (controller) init.signal = controller.signal;
    if (body !== undefined && body !== null) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    w.fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = null; }
        return { res: res, data: data };
      });
    }).then(function (r) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (wakeTimer) clearTimeout(wakeTimer);
      if (!r.data) {
        return cb({ code: 'badjson', message: T('err.badjson'), status: r.res.status }, null);
      }
      if (!r.res.ok || r.data.ok === false) {
        return cb({
          code: r.data.code || 'http' + r.res.status,
          message: (r.data.msgKey ? T(r.data.msgKey, r.data.msgParams) : srvMsg(r.data.message)) || T('err.http', { status: r.res.status }),
          status: r.res.status
        }, null);
      }
      cb(null, r.data);
    }).catch(function () {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (wakeTimer) clearTimeout(wakeTimer);
      cb({ code: 'network', message: friendlyNetworkError(), status: 0 }, null);
    });
  }

  /* ---------- 大廳 ---------- */
  function listRooms(cb, onWaking) {
    request('GET', '/api/rooms', null, function (err, data) {
      if (err) return cb(err, null);
      cb(null, { rooms: data.rooms || [], maxRooms: data.maxRooms || 0 });
    }, onWaking);
  }

  function roomInfo(code, cb) {
    request('GET', '/api/rooms/' + encodeURIComponent(String(code || '').toUpperCase()), null, cb);
  }

  /* ---------- 開房 ---------- */
  function createRoom(payload, cb, onWaking) {
    request('POST', '/api/rooms', payload, function (err, data) {
      if (err) return cb(err, null);
      cb(null, { code: data.code, hostToken: data.hostToken, inviteToken: data.inviteToken, room: data.room });
    }, onWaking);
  }

  /* ---------- 連線狀態 ---------- */
  function setConnState(next, detail) {
    if (!session) return;
    if (session.state === next && next !== 'failed') return;
    session.state = next;
    if (next !== 'open' && w.NetworkLatency) w.NetworkLatency.report(null);
    if (handlers.status) handlers.status(next, detail || '');
  }
  function connState() { return session ? session.state : 'idle'; }
  function current() {
    if (!session) return null;
    return {
      code: session.code, role: session.role, viewerId: session.viewerId,
      name: session.name, state: session.state, limits: session.limits || null
    };
  }
  function isHost() { return !!session && session.role === 'host'; }

  /* ---------- SSE 連線 ----------
   * opts: { code, token（主持人才有）, name（觀戰者暱稱）, on: { welcome, state, chat, presence, closed, status } } */
  function connect(opts) {
    disconnect();
    if (!isEnabled()) {
      if (opts.on && opts.on.status) opts.on.status('failed', disabledReason());
      return false;
    }
    if (typeof w.EventSource !== 'function') {
      if (opts.on && opts.on.status) opts.on.status('failed', disabledReason());
      return false;
    }
    handlers = opts.on || {};
    var code = String(opts.code || '').toUpperCase();
    session = {
      code: code,
      role: opts.token ? 'host' : 'viewer',
      token: opts.token || null,
      viewerId: null,
      name: opts.name || '',
      invite: opts.invite || '',
      es: null,
      retries: 0,
      state: 'idle',
      limits: null
    };
    if (w.NetworkLatency) w.NetworkLatency.setProbe(function () {
      var current = session;
      if (latencyProbeInFlight) return;
      if (!current || current.state !== 'open') { w.NetworkLatency.report(null); return; }
      latencyProbeInFlight = true;
      var started = performance.now();
      request('GET', '/health', null, function (err) {
        if (session !== current) return;
        latencyProbeInFlight = false;
        w.NetworkLatency.report(err ? null : performance.now() - started);
      });
    });
    openStream();
    return true;
  }

  function streamUrl() {
    var qs = [];
    if (session.role === 'host') qs.push('token=' + encodeURIComponent(session.token));
    else if (session.name) qs.push('name=' + encodeURIComponent(session.name));
    if (session.role === 'viewer' && session.invite) qs.push('invite=' + encodeURIComponent(session.invite));
    /* 重連時加上時間戳，避免某些代理／瀏覽器拿到快取的串流 */
    qs.push('t=' + Date.now());
    return apiUrl('/api/rooms/' + encodeURIComponent(session.code) + '/stream') + '?' + qs.join('&');
  }

  function openStream() {
    if (!session) return;
    setConnState(session.retries ? 'retrying' : 'connecting');
    var wake = setTimeout(function () {
      if (session && session.state !== 'open') setConnState('waking');
    }, WAKING_HINT_MS);

    var es;
    try {
      es = new w.EventSource(streamUrl());
    } catch (e) {
      clearTimeout(wake);
      setConnState('failed', friendlyNetworkError());
      return;
    }
    session.es = es;

    function on(name, fn) {
      es.addEventListener(name, function (ev) {
        var data = null;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        fn(data);
      });
    }

    es.addEventListener('open', function () {
      clearTimeout(wake);
      if (!session) return;
      session.retries = 0;
      setConnState('open');
    });

    on('welcome', function (data) {
      if (!session) return;
      /* 觀戰者每次重連都會拿到新的身分，所以 token 一律以最新一次為準 */
      if (session.role === 'viewer') {
        session.token = data.token;
        session.viewerId = data.viewerId;
        if (data.name) session.name = data.name;
      }
      session.limits = data.limits || null;
      setConnState('open');
      if (handlers.welcome) handlers.welcome(data);
    });
    on('state', function (data) { if (handlers.state) handlers.state(data); });
    on('note', function (data) { if (handlers.note) handlers.note(data); });
    on('chat', function (data) { if (handlers.chat) handlers.chat(data); });
    on('presence', function (data) { if (handlers.presence) handlers.presence(data); });
    on('closed', function (data) {
      clearTimeout(wake);
      var s = session;
      if (!s) return;
      s.retries = MAX_STREAM_RETRIES;   // 房間關了就不要再重連
      try { s.es.close(); } catch (e) {}
      setConnState('closed', (data && data.reason) || 'closed');
      if (handlers.closed) handlers.closed(data || {});
    });

    es.addEventListener('error', function () {
      clearTimeout(wake);
      if (!session || session.es !== es) return;
      if (session.state === 'closed') return;

      if (es.readyState === 2 /* CLOSED */) {
        /* 伺服器直接拒絕（房間不見、房滿、身分不符）：EventSource 不會再自己重連，
         * 這裡去問一次房間狀態，才能給出「房間已關閉」還是「連不上」的正確說明。 */
        try { es.close(); } catch (e) {}
        roomInfo(session.code, function (err) {
          if (!session) return;
          if (err && err.status === 404) {
            setConnState('closed', 'gone');
            if (handlers.closed) handlers.closed({ reason: 'gone' });
          } else if (session.retries < MAX_STREAM_RETRIES) {
            session.retries++;
            setTimeout(function () { if (session) openStream(); }, 1200 * session.retries);
          } else {
            setConnState('failed', friendlyNetworkError());
          }
        });
        return;
      }

      /* readyState === 0：EventSource 正在自己重連 */
      session.retries++;
      if (session.retries > MAX_STREAM_RETRIES) {
        try { es.close(); } catch (e) {}
        setConnState('failed', friendlyNetworkError());
        return;
      }
      setConnState('retrying', T('conn.retryN', { n: session.retries }));
    });
  }

  function disconnect() {
    stopStatePush();
    latencyProbeInFlight = false;
    if (w.NetworkLatency) { w.NetworkLatency.setProbe(null); w.NetworkLatency.report(null); }
    if (session && session.es) {
      try { session.es.close(); } catch (e) {}
    }
    session = null;
    handlers = {};
  }

  /* 主持人主動關房：先通知伺服器，再收掉自己的連線 */
  function closeRoom(cb) {
    if (!session || session.role !== 'host') {
      if (cb) cb({ code: 'norole', message: T('err.noHostClose') }, null);
      return;
    }
    var code = session.code;
    var token = session.token;
    stopStatePush();
    request('POST', '/api/rooms/' + encodeURIComponent(code) + '/close', { token: token }, function (err, data) {
      disconnect();
      if (cb) cb(err, data);
    });
  }

  /* 主持人換下一局時保留同一個房間與觀戰者，不重新建立 SSE 連線。 */
  function restartRoom(payload, cb) {
    if (!session || session.role !== 'host') {
      if (cb) cb({ code: 'norole', message: T('err.noHostRound') }, null);
      return;
    }
    var body = Object.assign({}, payload || {}, { token: session.token });
    request('POST', '/api/rooms/' + encodeURIComponent(session.code) + '/round', body, cb);
  }

  /* 重新產生邀請連結：舊連結立刻失效，房號仍然可以進來（房間是公開的） */
  function rotateInvite(cb) {
    if (!session || session.role !== 'host') {
      return cb({ code: 'norole', message: T('err.noHost') }, null);
    }
    request('POST', '/api/rooms/' + encodeURIComponent(session.code) + '/invite', { token: session.token }, cb);
  }

  /* ---------- 聊天 ---------- */
  function sendChat(text, name, cb) {
    if (!session) return cb({ code: 'norole', message: T('err.noRoomConn') }, null);
    request('POST', '/api/rooms/' + encodeURIComponent(session.code) + '/chat', {
      token: session.token, text: text, name: name
    }, cb);
  }

  function sendNote(index, text, name, cb) {
    if (!session) return cb({ code: 'norole', message: T('err.noRoomConn') }, null);
    request('POST', '/api/rooms/' + encodeURIComponent(session.code) + '/note', {
      token: session.token, index: index, text: text, name: name
    }, cb);
  }

  /* ---------- 主持人推送盤面 ----------
   * 連續操作會被合併，最少間隔 STATE_MIN_INTERVAL_MS；
   * 沒有操作時也會每 STATE_KEEPALIVE_MS 補推一次，讓觀戰者的計時不會停住。 */
  function pushState(snapshot) {
    if (!session || session.role !== 'host') return;
    pendingSnapshot = snapshot;
    scheduleStatePush();
  }

  function scheduleStatePush() {
    if (stateTimer || pushing) return;
    var wait = Math.max(0, STATE_MIN_INTERVAL_MS - (Date.now() - lastStateAt));
    stateTimer = setTimeout(flushState, wait);
  }

  function flushState() {
    stateTimer = null;
    if (!session || session.role !== 'host' || !pendingSnapshot) return;
    var snapshot = pendingSnapshot;
    pendingSnapshot = null;
    pushing = true;
    lastStateAt = Date.now();
    var code = session.code;
    var token = session.token;
    request('POST', '/api/rooms/' + encodeURIComponent(code) + '/state', { token: token, snapshot: snapshot }, function (err) {
      pushing = false;
      if (!session || session.code !== code) return;
      if (err) {
        if (err.status === 404 || err.status === 410) {
          setConnState('closed', 'gone');
          if (handlers.closed) handlers.closed({ reason: 'gone' });
        } else if (handlers.pushError) {
          handlers.pushError(err);
        }
        return;
      }
      if (handlers.pushOk) handlers.pushOk();
      /* 推送期間又有新動作的話，等這一次回來再送最新的那份 */
      if (pendingSnapshot) scheduleStatePush();
    });
  }

  function startStatePush(getSnapshot) {
    stopStatePush();
    if (!session || session.role !== 'host') return;
    session.keepalive = setInterval(function () {
      if (!session || session.role !== 'host') return;
      var snap = getSnapshot();
      if (snap) pushState(snap);
    }, STATE_KEEPALIVE_MS);
  }
  function stopStatePush() {
    if (session && session.keepalive) { clearInterval(session.keepalive); session.keepalive = null; }
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    pendingSnapshot = null;
  }

  w.Online = {
    MAX_STREAM_RETRIES: MAX_STREAM_RETRIES,
    isEnabled: isEnabled,
    disabledReason: disabledReason,
    listRooms: listRooms,
    roomInfo: roomInfo,
    createRoom: createRoom,
    connect: connect,
    disconnect: disconnect,
    closeRoom: closeRoom,
    restartRoom: restartRoom,
    rotateInvite: rotateInvite,
    sendChat: sendChat,
    sendNote: sendNote,
    pushState: pushState,
    startStatePush: startStatePush,
    stopStatePush: stopStatePush,
    connState: connState,
    current: current,
    isHost: isHost
  };
})(typeof window !== 'undefined' ? window : this);
