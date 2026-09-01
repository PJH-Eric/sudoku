/*
 * scripts/online-check.js — 啟動真實 HTTP 伺服器，驗證主持人／觀戰者流程。
 * 執行：npm run test:online
 *
 * 使用兩個獨立 SSE 用戶端，不依賴瀏覽器或外部套件，檢查：
 *   開房 → 主持人／多位觀戰者連線 → 盤面廣播 → 格子留言 → 聊天 → 邀請撤銷 → 關房通知。
 */
'use strict';

const assert = require('assert');
const path = require('path');

const port = 3200 + (process.pid % 500);
const origin = 'https://example.test';
process.env.PORT = String(port);
process.env.HOST = '127.0.0.1';
process.env.GAME_ALLOWED_ORIGIN = origin;

const server = require(path.join(__dirname, '..', 'server.js'));
const base = 'http://127.0.0.1:' + port;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function jsonRequest(url, options) {
  const headers = Object.assign({ Origin: origin }, (options && options.headers) || {});
  const res = await fetch(url, Object.assign({}, options || {}, { headers }));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { throw new Error('伺服器回應不是 JSON：' + text); }
  return { res, data };
}

class SseClient {
  constructor(response, controller) {
    assert.ok(response.ok, 'SSE 連線失敗：HTTP ' + response.status);
    this.response = response;
    this.controller = controller;
    this.events = [];
    this.waiters = [];
    this.buffer = '';
    this.eventName = '';
    this.eventData = [];
    this.reading = this.readLoop();
  }

  async readLoop() {
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        this.buffer += decoder.decode(part.value, { stream: true });
        this.consumeLines();
      }
    } catch (e) {
      if (!this.controller.signal.aborted) this.error = e;
    }
  }

  consumeLines() {
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) {
        this.dispatch();
      } else if (line.charAt(0) === ':') {
        continue;
      } else if (line.indexOf('event:') === 0) {
        this.eventName = line.slice(6).trim();
      } else if (line.indexOf('data:') === 0) {
        this.eventData.push(line.slice(5).trimStart());
      }
    }
  }

  dispatch() {
    if (!this.eventName || !this.eventData.length) {
      this.eventName = '';
      this.eventData = [];
      return;
    }
    let data;
    try { data = JSON.parse(this.eventData.join('\n')); } catch (e) { data = null; }
    const event = { name: this.eventName, data: data };
    this.events.push(event);
    const pending = this.waiters.slice();
    this.waiters = [];
    pending.forEach((waiter) => {
      if (waiter.name === event.name && (!waiter.test || waiter.test(event.data))) {
        clearTimeout(waiter.timer);
        waiter.resolve(event.data);
      } else {
        this.waiters.push(waiter);
      }
    });
    this.eventName = '';
    this.eventData = [];
  }

  waitFor(name, test, timeoutMs) {
    const found = this.events.find((event) => event.name === name && (!test || test(event.data)));
    if (found) return Promise.resolve(found.data);
    return new Promise((resolve, reject) => {
      const waiter = { name, test, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('等待 SSE 事件逾時：' + name));
      }, timeoutMs || 5000);
      this.waiters.push(waiter);
    });
  }

  close() { this.controller.abort(); }
}

function makeSnapshot() {
  return {
    puzzle: '0'.repeat(81),
    values: '0'.repeat(81),
    notes: new Array(81).fill(0),
    selected: -1,
    elapsedMs: 0,
    hintsUsed: 0,
    mistakes: 0,
    status: 'playing',
    paused: false
  };
}

async function openSse(url) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { Origin: origin }, signal: controller.signal });
  return new SseClient(response, controller);
}

async function main() {
  while (!server.listening) await sleep(10);
  const initial = makeSnapshot();
  const created = await jsonRequest(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hostName: '主持人甲', difficulty: 'easy', label: '簡單', seed: 'E2E', snapshot: initial
    })
  });
  assert.strictEqual(created.res.status, 201);
  assert.strictEqual(created.data.ok, true);
  assert.strictEqual(created.res.headers.get('access-control-allow-origin'), origin);

  const room = created.data;
  const host = await openSse(base + '/api/rooms/' + room.code + '/stream?token=' + encodeURIComponent(room.hostToken));
  const viewer = await openSse(base + '/api/rooms/' + room.code + '/stream?name=' + encodeURIComponent('觀戰者甲') + '&invite=' + encodeURIComponent(room.inviteToken));
  const viewer2 = await openSse(base + '/api/rooms/' + room.code + '/stream?name=' + encodeURIComponent('觀戰者乙') + '&invite=' + encodeURIComponent(room.inviteToken));
  const [hostWelcome, viewerWelcome, viewer2Welcome] = await Promise.all([
    host.waitFor('welcome'), viewer.waitFor('welcome'), viewer2.waitFor('welcome')
  ]);
  assert.strictEqual(hostWelcome.role, 'host');
  assert.strictEqual(viewerWelcome.role, 'viewer');
  assert.strictEqual(viewer2Welcome.role, 'viewer');
  assert.ok(viewerWelcome.token, '觀戰者要取得送留言用的暫時 token');
  assert.ok(viewer2Welcome.token, '每位觀戰者都要取得自己的暫時 token');
  await Promise.all([host.waitFor('state'), viewer.waitFor('state'), viewer2.waitFor('state')]);
  await viewer.waitFor('presence', (data) => data.viewers === 1);
  await viewer2.waitFor('presence', (data) => data.viewers === 2);

  const next = makeSnapshot();
  next.values = '9' + next.values.slice(1);
  const updated = await jsonRequest(base + '/api/rooms/' + room.code + '/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: room.hostToken, snapshot: next })
  });
  assert.strictEqual(updated.res.status, 200);
  assert.strictEqual(updated.data.ok, true);
  await Promise.all([
    host.waitFor('state', (data) => data.version === 2 && data.board.values.charAt(0) === '9'),
    viewer.waitFor('state', (data) => data.version === 2 && data.board.values.charAt(0) === '9'),
    viewer2.waitFor('state', (data) => data.version === 2 && data.board.values.charAt(0) === '9')
  ]);

  const noted = await jsonRequest(base + '/api/rooms/' + room.code + '/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: viewerWelcome.token, index: 80, text: '可能是7', name: '觀戰者甲' })
  });
  assert.strictEqual(noted.res.status, 200);
  assert.strictEqual(noted.data.ok, true);
  assert.strictEqual(noted.data.notes[0].text, '可能是7');
  await Promise.all([
    host.waitFor('note', (data) => data.index === 80 && data.notes[0].text === '可能是7'),
    viewer.waitFor('note', (data) => data.index === 80 && data.notes[0].text === '可能是7'),
    viewer2.waitFor('note', (data) => data.index === 80 && data.notes[0].text === '可能是7')
  ]);

  await sleep(450);
  const notedAgain = await jsonRequest(base + '/api/rooms/' + room.code + '/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: viewerWelcome.token, index: 80, text: '再看一眼', name: '觀戰者甲' })
  });
  assert.strictEqual(notedAgain.res.status, 200);
  assert.strictEqual(notedAgain.data.ok, true);
  assert.strictEqual(notedAgain.data.notes.length, 2);
  assert.strictEqual(notedAgain.data.notes[1].text, '再看一眼');
  await Promise.all([
    host.waitFor('note', (data) => data.index === 80 && data.notes.length === 2 && data.notes[1].text === '再看一眼'),
    viewer.waitFor('note', (data) => data.index === 80 && data.notes.length === 2 && data.notes[1].text === '再看一眼'),
    viewer2.waitFor('note', (data) => data.index === 80 && data.notes.length === 2 && data.notes[1].text === '再看一眼')
  ]);

  const chatted = await jsonRequest(base + '/api/rooms/' + room.code + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: viewerWelcome.token, name: '觀戰者甲', text: '<b>加油！</b>' })
  });
  assert.strictEqual(chatted.res.status, 200);
  const message = await host.waitFor('chat', (data) => data.text === '<b>加油！</b>');
  assert.strictEqual(message.role, 'viewer');

  const rotated = await jsonRequest(base + '/api/rooms/' + room.code + '/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: room.hostToken })
  });
  assert.strictEqual(rotated.res.status, 200);
  assert.notStrictEqual(rotated.data.inviteToken, room.inviteToken);
  const rejected = await fetch(
    base + '/api/rooms/' + room.code + '/stream?name=舊連結&invite=' + encodeURIComponent(room.inviteToken),
    { headers: { Origin: origin } }
  );
  assert.strictEqual(rejected.status, 403, '舊邀請連結必須在伺服器端失效');
  await rejected.body.cancel();

  const closed = await jsonRequest(base + '/api/rooms/' + room.code + '/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: room.hostToken })
  });
  assert.strictEqual(closed.res.status, 200);
  await viewer.waitFor('closed');
  await viewer2.waitFor('closed');
  const gone = await jsonRequest(base + '/api/rooms/' + room.code);
  assert.strictEqual(gone.res.status, 404);

  host.close();
  viewer.close();
  viewer2.close();
  console.log('線上端到端檢查全部通過（主持人＋多位觀戰者 SSE、盤面、格子留言、聊天、邀請撤銷、關房）。');
}

main().catch((error) => {
  console.error('線上端到端檢查失敗：', error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => server.close(), 0);
});
