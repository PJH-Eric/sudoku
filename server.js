/*
 * 數獨小學堂 - 靜態網頁伺服器
 * 這個遊戲是純單機的，伺服器只負責把 public/ 底下的檔案送出去，沒有任何連線對戰邏輯。
 * 零外部套件，只用 Node.js 內建模組。
 * 啟動：node server.js   （或 npm start、按「啟動遊戲.bat」）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3010;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'public');
/* 允許連線的前端來源。之後若真的加上 API，CORS 由伺服器這邊決定，不看前端送什麼。
 * 逗號分隔；預設 * 是因為目前只有唯讀的 /health，沒有任何機密或副作用。 */
const ALLOWED_ORIGIN = (process.env.GAME_ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
const STARTED_AT = Date.now();
const VERSION = require('./package.json').version;

function corsOrigin(req) {
  if (ALLOWED_ORIGIN.indexOf('*') >= 0) return '*';
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGIN.indexOf(origin) >= 0 ? origin : null;
}

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
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('網址格式錯誤');
  }
  /* 健康檢查：免費雲端平台會定時打這裡，前端也用它判斷「伺服器醒了沒」。
   * 冷啟動中的服務可能要十幾秒才回應，所以前端那邊有逾時與重試。 */
  if (urlPath === '/health') {
    const origin = corsOrigin(req);
    const head = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (origin) {
      head['Access-Control-Allow-Origin'] = origin;
      head['Vary'] = 'Origin';
    }
    if (req.method === 'OPTIONS') {
      head['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
      res.writeHead(204, head);
      return res.end();
    }
    res.writeHead(200, head);
    return res.end(JSON.stringify({
      status: 'ok',
      game: 'sudoku',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000)
    }));
  }
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
  console.log('  （關閉此視窗即停止伺服器）');
  console.log('');
});
