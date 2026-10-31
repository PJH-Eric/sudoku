/*
 * tests/i18n.js — 字典完整性檢查（繁體中文 zh-Hant 與 English en）
 * 執行：node tests/i18n.js（也包含在 npm run verify 與 npm test 之內）
 *
 * 檢查：
 *   1. 兩種語言的 key 集合完全相同，且每個值都不是空字串
 *   2. 兩種語言的 {參數} 名稱一致
 *   3. 原始碼（HTML 與前端 JS）用到的 key 都存在於字典
 *   4. 英文字典不得含中文字（語言切換提示 lang.switchTo 會寫出「繁體中文」，除外）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const dicts = {};
const sandbox = { I18N: { register: (code, d) => { dicts[code] = Object.assign(dicts[code] || {}, d); } } };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('public/js/locales.js'), sandbox, { filename: 'locales.js' });

let passed = 0;
function ok(label, fn) { fn(); passed++; console.log('  ✓ ' + label); }
const zh = dicts['zh-Hant'];
const en = dicts.en;
const params = (v) => [...new Set(String(v).match(/\{(\w+)\}/g) || [])].sort().join(',');

console.log('\n字典完整性');

ok('兩種語言的 key 集合完全相同', () => {
  const a = Object.keys(zh), b = Object.keys(en);
  assert.ok(a.length > 100, '字典數量不合理：' + a.length);
  assert.deepStrictEqual(a.filter((k) => !(k in en)), [], 'en 缺少這些 key');
  assert.deepStrictEqual(b.filter((k) => !(k in zh)), [], 'zh-Hant 缺少這些 key');
});

ok('每個翻譯都是非空字串', () => {
  [['zh-Hant', zh], ['en', en]].forEach(([n, d]) => Object.keys(d).forEach((k) => {
    assert.ok(typeof d[k] === 'string' && d[k].trim().length > 0, n + ' 的 ' + k + ' 是空的');
  }));
});

ok('兩種語言的 {參數} 一致', () => {
  Object.keys(zh).forEach((k) => assert.strictEqual(params(zh[k]), params(en[k]), k + ' 的 {參數} 不一致'));
});

ok('英文字典沒有殘留中文字', () => {
  Object.keys(en).filter((k) => k !== 'lang.switchTo').forEach((k) => assert.ok(!/[一-鿿]/.test(en[k]), 'en 的 ' + k + ' 含中文字'));
});

ok('原始碼用到的 key 都存在於字典', () => {
  const used = new Map();
  const add = (k, f) => { if (!used.has(k)) used.set(k, f); };
  const files = ['public/index.html', 'server.js']
    .concat(fs.readdirSync(path.join(root, 'public/js')).filter((f) => f.endsWith('.js') && !/^(locales|i18n)\.js$/.test(f)).map((f) => 'public/js/' + f));
  files.forEach((f) => {
    const src = read(f);
    let m;
    const reHtml = /data-i18n(?:-html|-title|-content)?="([\w.]+)"/g;
    while ((m = reHtml.exec(src))) add(m[1], f);
    const reAttr = /data-i18n-attr="([^"]+)"/g;
    while ((m = reAttr.exec(src))) m[1].split(';').forEach((p) => { const v = p.split('=')[1]; if (v) add(v.trim(), f); });
    const reCall = /\b(?:tr|T|I18N\.t|w\.I18N\.t|sayKey|setMsg)\(\s*'([\w.]+)'/g;
    while ((m = reCall.exec(src))) add(m[1], f);
    const reKey = /(?:msgKey|labelKey|key|i18n)\s*[:=]\s*'((?:srv|err|tech|tier|hint|diff|nick|cfg)\.[\w.]+)'/g;
    while ((m = reKey.exec(src))) add(m[1], f);
    const reSrv = /'((?:srv|tech|tier)\.[\w]+)'/g;
    while ((m = reSrv.exec(src))) add(m[1], f);
  });
  assert.ok(used.size > 80, '掃到的 key 太少（' + used.size + '），檢查規則可能失效');
  /* 動態組 key（例如 'tut.' + n）只檢查前綴底下有字典項目 */
  const missing = [...used].filter(([k]) => (k.endsWith('.') ? !Object.keys(zh).some((z) => z.indexOf(k) === 0) : !(k in zh))).map(([k, f]) => k + '（' + f + '）');
  assert.deepStrictEqual(missing, [], '字典缺少這些 key');
});

console.log('\ni18n 檢查全部通過（' + passed + ' 組，' + Object.keys(zh).length + ' 個 key）。');
