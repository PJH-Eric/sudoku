/*
 * 數獨小學堂 - 靜態網頁伺服器 ＋ 線上觀戰／留言 API
 *
 * 零外部套件，只用 Node.js 內建模組。啟動：node server.js（或 npm start、按「啟動遊戲.bat」）。
 *
 * 兩件事：
 *   1. 把 public/ 底下的檔案送出去（單機遊戲本體，沒有伺服器也能玩）。
 *   2. 提供線上觀戰用的 API：房間列表、開房、盤面廣播、格子留言、聊天。
 *
 * 傳輸方式刻意選「SSE（下行）＋ POST（上行）」而不是 WebSocket：
 *   - 專案維持零外部套件（Node 內建沒有 WebSocket 伺服器，用 ws 就得加相依）。
 *   - 盤面與聊天都是低頻事件，不需要雙向即時通道。
 *   - EventSource 自帶重連與 Last-Event-ID，斷線恢復不必自己寫。
 *   - Render 免費層對長連線友善，SSE 只要關掉快取與緩衝就能穿過反向代理。
 *
 * 端點：
 *   GET  /health                      健康檢查（雲端平台與前端用）
 *   GET  /api/rooms                   公開房間列表
 *   POST /api/rooms                   開房（回房號與 hostToken）
 *   GET  /api/rooms/:code             單一房間資訊（加入前先確認房間還在）
 *   GET  /api/rooms/:code/stream      SSE：state / note / chat / presence / closed / 心跳
 *   POST /api/rooms/:code/state       主持人更新盤面（需要 hostToken）
 *   POST /api/rooms/:code/note        成員新增一則共享格子留言（需要 hostToken 或 viewerToken）
 *   POST /api/rooms/:code/chat        送出訊息（需要 hostToken 或 viewerToken）
 *   POST /api/rooms/:code/close       主持人關房（需要 hostToken）
 *   POST /api/rooms/:code/invite      重新產生邀請連結，舊連結立刻失效（需要 hostToken）
 *
 * CORS：前端在 GitHub Pages、伺服器在 Render，一定是跨來源，所以 GAME_ALLOWED_ORIGIN
 * 從「選用」變成「建議設定」。沒設定時預設 *（房間本身沒有機密，但設好比較安全）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStore } = require('./lib/rooms');

const PORT = process.env.PORT || 3010;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'public');
/* 允許連線的前端來源。跨來源的 SSE 與 POST 都靠這個決定，由伺服器端說了算，不看前端送什麼。
 * 逗號分隔，完整字串比對 scheme://host:port；* 表示不限制。 */
const ALLOWED_ORIGIN = (process.env.GAME_ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
const STARTED_AT = Date.now();
const VERSION = require('./package.json').version;

const MAX_BODY = 32 * 1024;          // 一次 POST 最多 32KB（盤面快照約 1KB）
const HEARTBEAT_MS = 20000;          // SSE 心跳註解，避免中間的代理把閒置連線切掉
const SWEEP_MS = 15000;              // 房間回收掃描間隔

const store = createStore({
  hostGraceMs: Number(process.env.ROOM_GRACE_MS || 90000),
  maxRooms: Number(process.env.MAX_ROOMS || 40)
});

/* ---------- CORS ---------- */
function corsOrigin(req) {
  if (ALLOWED_ORIGIN.indexOf('*') >= 0) return '*';
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGIN.indexOf(origin) >= 0 ? origin : null;
}
function corsHead(req, head) {
  const origin = corsOrigin(req);
  const out = head || {};
  if (origin) {
    out['Access-Control-Allow-Origin'] = origin;
    out['Vary'] = 'Origin';
  }
  return out;
}
/* 跨來源請求但來源不在白名單：直接拒絕，不要讓瀏覽器收到半套的回應 */
function originBlocked(req) {
  if (ALLOWED_ORIGIN.indexOf('*') >= 0) return false;
  const origin = req.headers.origin;
  if (!origin) return false;                 // 同源請求不帶 Origin
  return ALLOWED_ORIGIN.indexOf(origin) < 0;
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, corsHead(req, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  }));
  res.end(body);
}

function preflight(req, res, methods) {
  res.writeHead(204, corsHead(req, {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store'
  }));
  res.end();
}

function readJson(req, cb) {
  let size = 0;
  const chunks = [];
  let done = false;
  req.on('data', (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      done = true;
      cb(new Error('too large'), null);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    if (!chunks.length) return cb(null, {});
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (e) {
      cb(new Error('bad json'), null);
    }
  });
  req.on('error', () => { if (!done) { done = true; cb(new Error('aborted'), null); } });
}

/* ---------- SSE 用戶端登記簿 ---------- */
const clients = new Map();   // 房號 -> Set of client

function addClient(code, client) {
  let set = clients.get(code);
  if (!set) { set = new Set(); clients.set(code, set); }
  set.add(client);
}
function dropClient(code, client) {
  const set = clients.get(code);
  if (!set) return;
  set.delete(client);
  if (!set.size) clients.delete(code);
}
function writeEvent(client, event, data, id) {
  try {
    let out = '';
    if (id) out += 'id: ' + id + '\n';
    out += 'event: ' + event + '\n';
    out += 'data: ' + JSON.stringify(data) + '\n\n';
    client.res.write(out);
  } catch (e) { /* 對方已經走了，等 close 事件收拾 */ }
}
function broadcast(code, event, data, id) {
  const set = clients.get(code);
  if (!set) return;
  set.forEach((client) => writeEvent(client, event, data, id));
}

store.on((evt) => {
  if (evt.type === 'state') broadcast(evt.code, 'state', evt.payload, evt.payload.version);
  else if (evt.type === 'note') broadcast(evt.code, 'note', evt.payload, 'n' + evt.payload.version);
  else if (evt.type === 'chat') broadcast(evt.code, 'chat', evt.payload, 'm' + evt.payload.id);
  else if (evt.type === 'presence') broadcast(evt.code, 'presence', evt.payload);
  else if (evt.type === 'closed') {
    broadcast(evt.code, 'closed', evt.payload);
    const set = clients.get(evt.code);
    if (set) {
      set.forEach((client) => { client.closedByServer = true; try { client.res.end(); } catch (e) {} });
      clients.delete(evt.code);
    }
  }
});

setInterval(() => {
  store.sweep();
  clients.forEach((set) => set.forEach((client) => {
    try { client.res.write(': ping\n\n'); } catch (e) {}
  }));
}, Math.min(HEARTBEAT_MS, SWEEP_MS)).unref();

/* ---------- 路由 ---------- */
const ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9]{1,8})(\/(stream|state|note|chat|close|invite))?$/;

function handleApi(req, res, urlPath, query) {
  if (originBlocked(req)) {
    return sendJson(req, res, 403, { ok: false, code: 'origin', message: '這個來源不在伺服器允許的名單裡（GAME_ALLOWED_ORIGIN）。' });
  }

  /* --- 房間列表／開房 --- */
  if (urlPath === '/api/rooms') {
    if (req.method === 'OPTIONS') return preflight(req, res, 'GET, POST, OPTIONS');
    if (req.method === 'GET') {
      return sendJson(req, res, 200, {
        ok: true,
        rooms: store.listRooms(),
        maxRooms: store.config.maxRooms,
        serverTime: Date.now()
      });
    }
    if (req.method === 'POST') {
      return readJson(req, (err, body) => {
        if (err) return sendJson(req, res, 400, { ok: false, code: 'body', message: '送出的資料格式不正確。' });
        const result = store.createRoom(body);
        if (!result.ok) return sendJson(req, res, result.code === 'full' ? 503 : 400, result);
        return sendJson(req, res, 201, result);
      });
    }
    return sendJson(req, res, 405, { ok: false, message: '不支援的方法。' });
  }

  const m = ROOM_PATH.exec(urlPath);
  if (!m) return sendJson(req, res, 404, { ok: false, code: 'nosuch', message: '沒有這個端點。' });

  const code = m[1].toUpperCase();
  const action = m[3] || '';

  /* --- SSE --- */
  if (action === 'stream') {
    if (req.method === 'OPTIONS') return preflight(req, res, 'GET, OPTIONS');
    if (req.method !== 'GET') return sendJson(req, res, 405, { ok: false, message: '不支援的方法。' });
    return openStream(req, res, code, query);
  }

  if (action === '') {
    if (req.method === 'OPTIONS') return preflight(req, res, 'GET, OPTIONS');
    if (req.method !== 'GET') return sendJson(req, res, 405, { ok: false, message: '不支援的方法。' });
    const room = store.getRoom(code);
    if (!room || room.status === 'closed') {
      return sendJson(req, res, 404, { ok: false, code: 'nosuch', message: '找不到房號 ' + code + '，可能已經關閉了。' });
    }
    return sendJson(req, res, 200, { ok: true, room: store.publicRoom(room) });
  }

  if (req.method === 'OPTIONS') return preflight(req, res, 'POST, OPTIONS');
  if (req.method !== 'POST') return sendJson(req, res, 405, { ok: false, message: '不支援的方法。' });

  return readJson(req, (err, body) => {
    if (err) return sendJson(req, res, 400, { ok: false, code: 'body', message: '送出的資料格式不正確。' });
    const data = body || {};
    let result;
    if (action === 'state') result = store.updateState(code, data.token, data.snapshot);
    else if (action === 'note') result = store.updateCellNote(code, data.token, data.index, data.text, data.name);
    else if (action === 'chat') result = store.chat(code, data.token, data.text, data.name);
    else if (action === 'close') result = store.closeRoom(code, data.token, 'host');
    else if (action === 'invite') result = store.rotateInvite(code, data.token);
    else return sendJson(req, res, 404, { ok: false, message: '沒有這個端點。' });

    if (!result.ok) return sendJson(req, res, result.status || 400, result);
    return sendJson(req, res, 200, result);
  });
}

function openStream(req, res, code, query) {
  const asHost = !!query.token;
  const joined = asHost
    ? store.attachHost(code, query.token)
    : store.addViewer(code, { name: query.name, invite: query.invite });

  if (!joined.ok) {
    return sendJson(req, res, joined.status || 400, joined);
  }

  /* SSE 必要的標頭：不要快取、不要壓縮／轉換、告訴 nginx 類的代理不要緩衝 */
  res.writeHead(200, corsHead(req, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    'Content-Encoding': 'identity',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  }));
  /* 有些代理要看到一點資料才會把回應轉出去 */
  res.write(': 連線建立\n\n');
  res.write('retry: 3000\n\n');

  const room = store.getRoom(code);
  const client = {
    res: res,
    role: asHost ? 'host' : 'viewer',
    viewerId: joined.viewerId || null,
    closedByServer: false
  };
  addClient(code, client);

  writeEvent(client, 'welcome', {
    code: code,
    role: client.role,
    viewerId: joined.viewerId || null,
    token: asHost ? query.token : joined.viewerToken,
    name: asHost ? (room ? room.hostName : '') : joined.name,
    limits: {
      maxTextLength: store.config.maxTextLength,
      maxNameLength: store.config.maxNameLength,
      maxViewers: store.config.maxViewersPerRoom,
      hostGraceMs: store.config.hostGraceMs
    }
  });
  writeEvent(client, 'state', joined.state, joined.state.version);
  (joined.history || []).forEach((msg) => writeEvent(client, 'chat', msg, 'm' + msg.id));
  if (room) writeEvent(client, 'presence', store.presenceEvent(room));

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    dropClient(code, client);
    if (client.closedByServer) return;
    if (asHost) store.detachHost(code, query.token);
    else if (client.viewerId) store.removeViewer(code, client.viewerId);
  }
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}

/* ---------- 靜態檔案 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  let urlPath;
  let query = {};
  try {
    const parts = req.url.split('?');
    urlPath = decodeURIComponent(parts[0]);
    if (parts[1]) {
      new URLSearchParams(parts[1]).forEach((v, k) => { query[k] = v; });
    }
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('網址格式錯誤');
  }

  /* 健康檢查：免費雲端平台會定時打這裡，前端也用它判斷「伺服器醒了沒」。
   * 冷啟動中的服務可能要十幾秒才回應，所以前端那邊有逾時與重試。 */
  if (urlPath === '/health') {
    if (req.method === 'OPTIONS') return preflight(req, res, 'GET, OPTIONS');
    return sendJson(req, res, 200, {
      status: 'ok',
      game: 'sudoku',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      online: true,
      rooms: store.roomCount(),
      maxRooms: store.config.maxRooms
    });
  }

  if (urlPath.indexOf('/api/') === 0) return handleApi(req, res, urlPath, query);

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('找不到檔案');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

/* SSE 是長連線，不要被 Node 預設的閒置逾時切掉 */
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 76000;

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k]) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }
  console.log('');
  console.log('  數獨小學堂 伺服器已啟動！');
  console.log('  ------------------------------------------');
  console.log('  本機開啟：  http://localhost:' + PORT);
  ips.forEach((ip) => console.log('  平板連線：  http://' + ip + ':' + PORT));
  console.log('  ------------------------------------------');
  console.log('  健康檢查：  /health');
  console.log('  線上觀戰：  /api/rooms （房間上限 ' + store.config.maxRooms + '）');
  console.log('  允許來源：  ' + ALLOWED_ORIGIN.join(', '));
  console.log('  （關閉此視窗即停止伺服器；房間狀態只放在記憶體，重啟就會消失）');
  console.log('');
});

/* 優雅關閉：先告訴每個房間的觀戰者「房間關了」，再收掉伺服器 */
function shutdown() {
  clients.forEach((set) => set.forEach((client) => {
    writeEvent(client, 'closed', { reason: 'shutdown' });
    try { client.res.end(); } catch (e) {}
  }));
  clients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = server;
