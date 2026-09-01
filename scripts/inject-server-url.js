/*
 * scripts/inject-server-url.js — 把 server URL 寫進 public/js/config.js
 *
 * GitHub Pages 只吃靜態檔，沒有伺服器端環境變數，所以正式網址是在「部署當下」
 * 由 CI 從 repository variable 注入，不進版控（版控裡永遠是空字串＝單機模式）。
 *
 * 用法：
 *   GAME_SERVER_URL=https://sudoku.example.com node scripts/inject-server-url.js
 *   node scripts/inject-server-url.js https://sudoku.example.com
 *   node scripts/inject-server-url.js --allow-local http://localhost:3010   （本機測試用）
 *   node scripts/inject-server-url.js --clear                               （還原成單機模式）
 *
 * 沒有給值時：保持單機模式並正常結束（這個遊戲不需要伺服器也能玩）。
 * 給了但格式不對：直接失敗，不會靜默回退成 localhost 或寫死的網域。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'public', 'js', 'config.js');
const BEGIN = '/* GAME_SERVER_URL:BEGIN';
const LINE = /(\/\* GAME_SERVER_URL:BEGIN[\s\S]*?\*\/\s*\n\s*var INJECTED = )'[^']*'(;)/;

const args = process.argv.slice(2);
const allowLocal = args.includes('--allow-local');
const clear = args.includes('--clear');
const positional = args.filter((a) => !a.startsWith('--'));
const raw = clear ? '' : String(positional[0] || process.env.GAME_SERVER_URL || '').trim();

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function validate(value) {
  let u;
  try {
    u = new URL(value);
  } catch (e) {
    fail('GAME_SERVER_URL 不是合法的絕對網址：' + value);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    fail('GAME_SERVER_URL 只接受 http 或 https：' + value);
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname);
  if (local && !allowLocal) {
    fail('正式部署不可以用本機網址（' + u.hostname + '）。本機測試請加 --allow-local。');
  }
  if (!local && u.protocol === 'http:') {
    fail('正式部署請用 https，避免 GitHub Pages（https）連 http 被瀏覽器擋掉：' + value);
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

const source = fs.readFileSync(CONFIG, 'utf8');
if (!source.includes(BEGIN) || !LINE.test(source)) {
  fail('config.js 找不到可注入的標記，請確認 GAME_SERVER_URL:BEGIN 區塊沒有被改壞。');
}

if (!raw) {
  const next = source.replace(LINE, "$1''$2");
  fs.writeFileSync(CONFIG, next, 'utf8');
  console.log('· 沒有提供 GAME_SERVER_URL，維持單機模式（config.js 的 server URL 留空）。');
  process.exit(0);
}

const url = validate(raw);
if ([39, 92].some(function (c) { return url.indexOf(String.fromCharCode(c)) >= 0; })) fail('網址含有不允許的字元：' + url);

fs.writeFileSync(CONFIG, source.replace(LINE, "$1'" + url + "'$2"), 'utf8');
console.log('✓ 已把 server URL 注入 public/js/config.js：' + url);
