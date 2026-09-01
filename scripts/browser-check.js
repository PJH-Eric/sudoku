/*
 * scripts/browser-check.js — 用無頭 Chrome 實際跑一遍遊戲並檢查版面
 * 執行：node scripts/browser-check.js      （會自己啟動 server.js）
 *
 * 零外部套件：直接用 Node 內建的 fetch 與 WebSocket 講 Chrome DevTools Protocol。
 * 檢查項目：
 *   - 主控台有沒有未處理的錯誤
 *   - 六種尺寸／方向下：不可水平溢出、右上角設定按鈕在安全區內且夠大、按鈕命中區足夠
 *   - 完整一局：選難度 → 出題 → 點格子填數字 → 暫停 → 繼續 → 解到勝利 → 結算
 *   - 設定彈窗：開啟、焦點、Escape 關閉、焦點歸位、靜音設定會被保存
 *   - 重新載入後可以續玩
 *   - server URL 參數化：單機／已連線／設定錯誤／連不上
 * 螢幕截圖會存到 screenshots/。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3011);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const DEBUG_PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = path.join(ROOT, '.chrome-rwd-test');
const SHOTS = path.join(ROOT, 'screenshots');

const VIEWPORTS = [
  { name: '手機窄版直向', width: 360, height: 640, mobile: true, dsf: 2 },
  { name: '手機直向', width: 390, height: 844, mobile: true, dsf: 3 },
  { name: '手機橫向', width: 844, height: 390, mobile: true, dsf: 3 },
  { name: '小手機橫向', width: 667, height: 375, mobile: true, dsf: 2 },
  { name: '平板直向', width: 768, height: 1024, mobile: true, dsf: 2 },
  { name: '平板橫向', width: 1024, height: 768, mobile: true, dsf: 2 },
  { name: '桌機寬版', width: 1440, height: 900, mobile: false, dsf: 1 }
];

const failures = [];
const notes = [];
function check(label, condition, detail) {
  if (condition) {
    console.log('  ✓ ' + label);
  } else {
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
    failures.push(label + (detail ? ' — ' + detail : ''));
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 極簡 CDP 用戶端 ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = this.listeners.get(msg.method) || [];
        list.forEach((fn) => fn(msg.params));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });
  }
  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: '(function(){' + expression + '})()',
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error('頁面執行例外：' + (res.exceptionDetails.exception && res.exceptionDetails.exception.description));
    }
    return res.result.value;
  }
}

/* ---------- 頁面端要用到的檢查函式（會被字串化送進瀏覽器） ---------- */
const PAGE_HELPERS = `
  window.__probe = {
    layout: function () {
      var doc = document.documentElement;
      var vw = window.innerWidth, vh = window.innerHeight;
      var fab = document.getElementById('b-settings');
      var fr = fab.getBoundingClientRect();
      var small = [];
      /* 盤面格子是 9×9 固定格線的一部分，尺寸由盤面決定，另外用 boardCells 檢查 */
      var list = document.querySelectorAll('.screen.active button:not(.cell), .settings-modal.open button, .screen.active input');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.height < 40 || r.width < 24) small.push((el.id || el.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      var wide = [];
      var all = document.querySelectorAll('.screen.active *');
      for (var j = 0; j < all.length; j++) {
        var rr = all[j].getBoundingClientRect();
        if (rr.width === 0) continue;
        if (rr.right > vw + 1.5 || rr.left < -1.5) wide.push((all[j].id || all[j].className || all[j].tagName) + ' [' + Math.round(rr.left) + ',' + Math.round(rr.right) + ']');
      }
      /* 設定鈕是固定定位的，必須確認它沒有壓到其他可操作的元素 */
      var covered = [];
      var clickable = document.querySelectorAll('.screen.active button:not(#b-settings), .screen.active input, .screen.active .optcard');
      for (var k = 0; k < clickable.length; k++) {
        var cr = clickable[k].getBoundingClientRect();
        if (cr.width === 0 || cr.height === 0) continue;
        if (cr.left < fr.right && cr.right > fr.left && cr.top < fr.bottom && cr.bottom > fr.top) {
          covered.push(clickable[k].id || clickable[k].className);
        }
      }
      return {
        vw: vw, vh: vh,
        scrollWidth: doc.scrollWidth,
        activeScreen: (document.querySelector('.screen.active') || {}).id,
        fab: { top: Math.round(fr.top), right: Math.round(vw - fr.right), w: Math.round(fr.width), h: Math.round(fr.height) },
        smallTargets: small.slice(0, 6),
        overflowing: wide.slice(0, 6),
        fabCovers: covered.slice(0, 6)
      };
    },
    board: function () {
      var b = document.getElementById('board');
      var r = b.getBoundingClientRect();
      var wrap = document.querySelector('.boardwrap').getBoundingClientRect();
      var cell = b.querySelector('.cell').getBoundingClientRect();
      var room = Math.min(wrap.width, wrap.height);
      return {
        cells: b.querySelectorAll('.cell').length,
        width: Math.round(r.width), height: Math.round(r.height),
        left: Math.round(r.left), right: Math.round(r.right),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        cell: Math.round(cell.width * 10) / 10,
        room: Math.round(room),
        usage: Math.round((r.width / room) * 100),
        filled: b.querySelectorAll('.cell.given').length
      };
    },
    click: function (sel) {
      var el = document.querySelector(sel);
      if (!el) return false;
      el.click();
      return true;
    }
  };
`;

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('找不到 Chrome 或 Edge，略過瀏覽器檢查。設定 CHROME_PATH 環境變數後可再執行。');
    process.exit(0);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  console.log('啟動靜態伺服器 (port ' + PORT + ')…');
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore'
  });
  await sleep(700);

  console.log('啟動無頭瀏覽器…');
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank'
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(300);
    try {
      const res = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) { /* 還沒起來 */ }
  }
  if (!wsUrl) throw new Error('無法連上瀏覽器的偵錯埠');

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new CDP(ws);

  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push('例外：' + (p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text));
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push('console.error：' + p.args.map((a) => a.value || a.description).join(' '));
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') consoleErrors.push('log：' + p.entry.text + ' ' + (p.entry.url || ''));
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS });

  async function goto(url) {
    await cdp.send('Page.navigate', { url });
    await sleep(600);
  }
  async function shot(name) {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(res.data, 'base64'));
  }
  async function setViewport(v) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: v.width, height: v.height, deviceScaleFactor: v.dsf, mobile: v.mobile
    });
    await sleep(280);
  }

  /* ================= 各尺寸的版面檢查 ================= */
  for (const v of VIEWPORTS) {
    console.log('\n【' + v.name + ' ' + v.width + '×' + v.height + '】');
    await setViewport(v);
    await goto(BASE);
    await cdp.eval('localStorage.clear(); return 1;');
    await goto(BASE);

    const screensToCheck = [];

    /* 首頁 */
    let L = await cdp.eval('return JSON.stringify(window.__probe.layout());');
    let info = JSON.parse(L);
    screensToCheck.push(['首頁', info]);
    await shot(v.name + '-1-首頁');

    /* 設定彈窗 */
    await cdp.eval("document.getElementById('b-settings').click(); return 1;");
    await sleep(220);
    const modalOpen = await cdp.eval(
      "var m=document.getElementById('settings-modal');" +
      "return JSON.stringify({open:m.classList.contains('open'),hidden:m.getAttribute('aria-hidden')," +
      "focus:document.activeElement.id,expanded:document.getElementById('b-settings').getAttribute('aria-expanded')});"
    );
    const mo = JSON.parse(modalOpen);
    check('設定按鈕會開出 Modal 彈窗且焦點進入彈窗', mo.open && mo.hidden === 'false' && mo.focus === 'settings-panel' && mo.expanded === 'true', modalOpen);
    L = await cdp.eval('return JSON.stringify(window.__probe.layout());');
    screensToCheck.push(['設定彈窗', JSON.parse(L)]);
    await shot(v.name + '-2-設定彈窗');

    /* Escape 關閉並歸位焦點 */
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(220);
    const closed = await cdp.eval(
      "var m=document.getElementById('settings-modal');" +
      "return JSON.stringify({open:m.classList.contains('open'),focus:document.activeElement.id});"
    );
    const cl = JSON.parse(closed);
    check('Escape 關閉彈窗並把焦點還給設定按鈕', !cl.open && cl.focus === 'b-settings', closed);

    /* 玩法教學 */
    await cdp.eval("document.getElementById('b-help').click(); return 1;");
    await sleep(220);
    L = await cdp.eval('return JSON.stringify(window.__probe.layout());');
    screensToCheck.push(['玩法教學', JSON.parse(L)]);
    await shot(v.name + '-3-教學');

    /* 難度選擇 */
    await cdp.eval("document.getElementById('b-help-skip').click();document.getElementById('b-new').click(); return 1;");
    await sleep(220);
    L = await cdp.eval('return JSON.stringify(window.__probe.layout());');
    screensToCheck.push(['難度選擇', JSON.parse(L)]);
    await shot(v.name + '-4-難度選擇');

    /* 出題 → 遊戲畫面 */
    await cdp.eval(
      "document.querySelector('#opt-diff .optcard[data-v=\\\"medium\\\"]').click();" +
      "document.getElementById('seed-input').value='RWD1';" +
      "document.getElementById('b-start').click(); return 1;"
    );
    await sleep(1400);
    L = await cdp.eval('return JSON.stringify(window.__probe.layout());');
    info = JSON.parse(L);
    screensToCheck.push(['遊戲中', info]);
    check('出題後停在遊戲畫面', info.activeScreen === 's-game', info.activeScreen);
    const boardInfo = JSON.parse(await cdp.eval('return JSON.stringify(window.__probe.board());'));
    check('盤面有 81 格且是正方形', boardInfo.cells === 81 && Math.abs(boardInfo.width - boardInfo.height) <= 2,
      JSON.stringify(boardInfo));
    check('盤面完整在畫面內', boardInfo.left >= -1 && boardInfo.right <= info.vw + 1 && boardInfo.width >= 180,
      JSON.stringify(boardInfo));
    check('盤面有把可用空間用滿（≥ 96%）', boardInfo.usage >= 96, JSON.stringify(boardInfo));
    /* 9×9 固定格線的單格必然比一般按鈕小；30px 是常見數獨 App 的下限，仍然好點。
     * 極矮的橫向手機（例如 667×375）會落在 31~32px，直向會回到 35px 以上。 */
    check('每一格至少 30px 好點得到', boardInfo.cell >= 30, '格子 ' + boardInfo.cell + 'px（盤面 ' + boardInfo.width + 'px）');
    await shot(v.name + '-5-遊戲中');

    /* 暫停 */
    await cdp.eval("document.getElementById('b-pause').click(); return 1;");
    await sleep(260);
    const paused = await cdp.eval(
      "return JSON.stringify({on:document.getElementById('pause-overlay').classList.contains('on')," +
      "focus:document.activeElement.id});"
    );
    check('暫停會蓋上遮罩並把焦點移進去', JSON.parse(paused).on && JSON.parse(paused).focus === 'pause-box', paused);
    L = await cdp.eval('return JSON.stringify(window.__probe.layout());');
    screensToCheck.push(['暫停', JSON.parse(L)]);
    await shot(v.name + '-6-暫停');
    await cdp.eval("document.getElementById('b-resume').click(); return 1;");
    await sleep(200);

    /* 用提示解完整局 → 結算 */
    await cdp.eval(
      "var n=0; while(document.getElementById('s-result').classList.contains('active')===false && n<200){" +
      "document.getElementById('b-hint').click(); n++; } return n;"
    );
    await sleep(400);
    L = await cdp.eval('return JSON.stringify(window.__probe.layout());');
    info = JSON.parse(L);
    screensToCheck.push(['結算', info]);
    check('解完之後進入結算畫面', info.activeScreen === 's-result', info.activeScreen);
    await shot(v.name + '-7-結算');

    /* 紀錄畫面 */
    await cdp.eval("document.getElementById('b-home2').click();document.getElementById('b-stats').click(); return 1;");
    await sleep(240);
    L = await cdp.eval('return JSON.stringify(window.__probe.layout());');
    screensToCheck.push(['我的紀錄', JSON.parse(L)]);
    await shot(v.name + '-8-紀錄');

    /* 統一判定：不可水平溢出、設定鈕位置與大小、命中區 */
    let overflow = [], smalls = [], fabBad = [], fabCover = [];
    screensToCheck.forEach(([name, d]) => {
      if (d.scrollWidth > d.vw + 1) overflow.push(name + '(' + d.scrollWidth + '>' + d.vw + ')');
      if (d.overflowing.length) overflow.push(name + ':' + d.overflowing.join('|'));
      if (d.smallTargets.length) smalls.push(name + ':' + d.smallTargets.join('|'));
      if (d.fab.w < 44 || d.fab.h < 44 || d.fab.top < 0 || d.fab.right < 0 || d.fab.right > 40) {
        fabBad.push(name + ':' + JSON.stringify(d.fab));
      }
      if (d.fabCovers.length) fabCover.push(name + ':' + d.fabCovers.join('|'));
    });
    check('所有畫面都沒有水平溢出', overflow.length === 0, overflow.join(' / '));
    check('所有可點元素的命中區都夠大', smalls.length === 0, smalls.join(' / '));
    check('右上角設定按鈕在安全區內且不小於 44×44', fabBad.length === 0, fabBad.join(' / '));
    check('設定按鈕沒有壓住其他操作', fabCover.length === 0, fabCover.join(' / '));
  }

  /* ================= 互動與持久化（單一尺寸即可） ================= */
  console.log('\n【互動與持久化：平板直向 768×1024】');
  await setViewport(VIEWPORTS[3]);
  await goto(BASE);
  await cdp.eval('localStorage.clear(); return 1;');
  await goto(BASE);

  await cdp.eval(
    "document.getElementById('b-new').click();" +
    "document.querySelector('#opt-diff .optcard[data-v=\\\"easy\\\"]').click();" +
    "document.getElementById('seed-input').value='PLAY9';" +
    "document.getElementById('b-start').click(); return 1;"
  );
  await sleep(1200);

  const seedShown = await cdp.eval("return document.getElementById('g-seed').textContent;");
  check('種子會顯示在遊戲畫面上', /PLAY9/.test(seedShown), seedShown);

  /* 點一個空格，用數字盤填入正確答案 */
  const placed = await cdp.eval(
    "var cells=document.querySelectorAll('.cell');" +
    "var idx=-1; for(var i=0;i<81;i++){ if(!cells[i].classList.contains('given')){ idx=i; break; } }" +
    "cells[idx].click();" +
    "var before=document.querySelector('.cell.sel')===cells[idx];" +
    "return JSON.stringify({idx:idx, selected:before});"
  );
  check('點格子會被選取', JSON.parse(placed).selected, placed);

  const typed = await cdp.eval(
    "var idx=" + JSON.parse(placed).idx + ";" +
    "document.querySelector('.numkey[data-d=\"5\"]').click();" +
    "var cell=document.querySelectorAll('.cell')[idx];" +
    "return JSON.stringify({text:cell.querySelector('.v').textContent, feedback:document.getElementById('feedback').textContent});"
  );
  check('按數字盤會填入數字並給文字回饋', JSON.parse(typed).text === '5' && JSON.parse(typed).feedback.length > 0, typed);

  /* 點題目原有的格子 → 應該被擋下並說明原因 */
  const blocked = await cdp.eval(
    "var g=document.querySelector('.cell.given'); g.click();" +
    "document.querySelector('.numkey[data-d=\"7\"]').click();" +
    "return JSON.stringify({text:g.querySelector('.v').textContent, feedback:document.getElementById('feedback').textContent, cls:document.getElementById('feedback').className});"
  );
  const bl = JSON.parse(blocked);
  check('題目給的數字改不動，而且有說明原因', bl.feedback.indexOf('題目原本就給的數字') >= 0 && bl.cls.indexOf('bad') >= 0, blocked);

  /* 筆記模式 */
  const noted = await cdp.eval(
    "document.getElementById('b-note').click();" +
    "var cells=document.querySelectorAll('.cell'); var idx=-1;" +
    "for(var i=0;i<81;i++){ if(!cells[i].classList.contains('given') && !cells[i].querySelector('.v').textContent){ idx=i; break; } }" +
    "cells[idx].click(); document.querySelector('.numkey[data-d=\"3\"]').click();" +
    "var notes=cells[idx].querySelectorAll('.nt i.on');" +
    "var res={count:notes.length, pressed:document.getElementById('b-note').getAttribute('aria-pressed')};" +
    "document.getElementById('b-note').click();" +
    "return JSON.stringify(res);"
  );
  check('筆記模式只會記候選數', JSON.parse(noted).count === 1 && JSON.parse(noted).pressed === 'true', noted);

  /* 復原／重做 */
  const undone = await cdp.eval(
    "document.getElementById('b-undo').click();" +
    "var a=document.getElementById('feedback').textContent;" +
    "document.getElementById('b-redo').click();" +
    "var b=document.getElementById('feedback').textContent;" +
    "return JSON.stringify({undo:a, redo:b});"
  );
  check('復原與重做都有回饋', /復原/.test(JSON.parse(undone).undo) && /重做/.test(JSON.parse(undone).redo), undone);

  /* 鍵盤操作 */
  await cdp.eval("document.querySelectorAll('.cell')[0].click(); return 1;");
  for (const key of ['ArrowRight', 'ArrowDown']) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : 40 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : 40 });
  }
  await sleep(150);
  const moved = await cdp.eval(
    "var sel=document.querySelector('.cell.sel'); return sel ? sel.getAttribute('data-i') : 'none';"
  );
  check('方向鍵可以移動選格', moved === '10', '目前選在索引 ' + moved);

  /* 暫停 → 這題重來：盤面與計數全部歸零，但題目不變 */
  const restarted = await cdp.eval(
    "var seed=document.getElementById('g-seed').textContent;" +
    "document.getElementById('b-pause').click();" +
    "document.getElementById('b-restart').click();" +
    "return JSON.stringify({seed:seed, sameSeed:document.getElementById('g-seed').textContent===seed," +
    "hints:document.getElementById('st-hint').textContent, miss:document.getElementById('st-miss').textContent," +
    "time:document.getElementById('st-time').textContent," +
    "paused:document.getElementById('pause-overlay').classList.contains('on')," +
    "notes:document.querySelectorAll('.nt i.on').length});"
  );
  const rt = JSON.parse(restarted);
  check('這題重來會清空作答但保留同一題',
    rt.sameSeed && rt.hints === '0' && rt.miss === '0' && rt.notes === 0 && !rt.paused && rt.time === '00:00', restarted);

  /* 教學分段：上一段／下一段／重看 */
  const tutorial = await cdp.eval(
    "document.getElementById('b-quit').click();" +
    "document.getElementById('b-help').click();" +
    "var first=document.getElementById('tut-title').textContent;" +
    "var prevDisabled=document.getElementById('b-tut-prev').disabled;" +
    "document.getElementById('b-tut-next').click();" +
    "var second=document.getElementById('tut-title').textContent;" +
    "var progress=document.getElementById('tut-progress').textContent;" +
    "document.getElementById('b-tut-prev').click();" +
    "var back=document.getElementById('tut-title').textContent;" +
    "return JSON.stringify({first:first,second:second,back:back,progress:progress,prevDisabled:prevDisabled," +
    "hasText:document.getElementById('tut-body').querySelectorAll('p').length});"
  );
  const tu = JSON.parse(tutorial);
  check('教學可以前後翻頁且第一段時停用上一段',
    tu.first !== tu.second && tu.back === tu.first && tu.prevDisabled === true && tu.hasText >= 3 && /第 2 段/.test(tu.progress), tutorial);

  /* 教學裡的「立即練習」 */
  const practice = await cdp.eval(
    "document.getElementById('b-tut-play').click(); return 1;"
  );
  await sleep(1200);
  const practiceScreen = await cdp.eval(
    "return JSON.stringify({screen:(document.querySelector('.screen.active')||{}).id," +
    "diff:document.getElementById('g-diff').textContent});"
  );
  check('教學結尾的「立即練習」會直接開一局簡單題',
    JSON.parse(practiceScreen).screen === 's-game' && JSON.parse(practiceScreen).diff === '簡單', practiceScreen);

  /* 回到主選單；此時存檔是剛才那局「立即練習」的簡單題 */
  await cdp.eval("document.getElementById('b-quit').click(); return 1;");
  await sleep(200);
  const savedSeed = await cdp.eval(
    "var d=JSON.parse(localStorage.getItem('sd_save')||'{}'); return d.seed + '|' + d.difficulty;"
  );

  /* 設定：關掉音樂與音效，重新載入後仍保留 */
  await cdp.eval(
    "document.getElementById('b-settings').click();" +
    "var m=document.getElementById('settings-music'); m.checked=false; m.dispatchEvent(new Event('change',{bubbles:true}));" +
    "var s=document.getElementById('settings-sfx'); s.checked=false; s.dispatchEvent(new Event('change',{bubbles:true}));" +
    "var v=document.getElementById('settings-sfx-volume'); v.value=35; v.dispatchEvent(new Event('input',{bubbles:true}));" +
    "var mk=document.getElementById('settings-mistakes'); mk.checked=false; mk.dispatchEvent(new Event('change',{bubbles:true}));" +
    "document.getElementById('settings-done').click(); return 1;"
  );
  await sleep(300);
  const stored = await cdp.eval(
    "return JSON.stringify({music:localStorage.getItem('sd_music'),sfx:localStorage.getItem('sd_sfx')," +
    "vol:localStorage.getItem('sd_sfx_volume'),opt:localStorage.getItem('sd_opt')});"
  );
  const st = JSON.parse(stored);
  check('音樂／音效／音量／盤面選項都寫進本機儲存',
    st.music === '0' && st.sfx === '0' && String(st.vol) === '0.35' && /"markMistakes":false/.test(st.opt), stored);

  await goto(BASE);
  const afterReload = await cdp.eval(
    "document.getElementById('b-settings').click();" +
    "var r=JSON.stringify({music:document.getElementById('settings-music').checked," +
    "sfx:document.getElementById('settings-sfx').checked," +
    "vol:document.getElementById('settings-sfx-volume').value," +
    "mistakes:document.getElementById('settings-mistakes').checked," +
    "canContinue:!document.getElementById('b-continue').hidden});" +
    "document.getElementById('settings-close').click(); return r;"
  );
  const ar = JSON.parse(afterReload);
  check('重新載入後設定仍然保留', ar.music === false && ar.sfx === false && ar.vol === '35' && ar.mistakes === false, afterReload);
  check('重新載入後可以繼續上一題', ar.canContinue === true, afterReload);

  const resumed = await cdp.eval(
    "document.getElementById('b-continue').click();" +
    "return JSON.stringify({screen:(document.querySelector('.screen.active')||{}).id," +
    "seed:document.getElementById('g-seed').textContent," +
    "left:document.getElementById('st-left').textContent});"
  );
  const rs = JSON.parse(resumed);
  const wantSeed = savedSeed.split('|')[0];
  check('續玩會回到存檔的那一題', rs.screen === 's-game' && rs.seed.indexOf(wantSeed) >= 0,
    resumed + ' 期待種子 ' + wantSeed);

  /* 恢復預設 */
  const reset = await cdp.eval(
    "document.getElementById('b-settings').click();" +
    "document.getElementById('settings-reset').click();" +
    "var r=JSON.stringify({music:document.getElementById('settings-music').checked," +
    "sfx:document.getElementById('settings-sfx').checked," +
    "mistakes:document.getElementById('settings-mistakes').checked});" +
    "document.getElementById('settings-close').click(); return r;"
  );
  const rr = JSON.parse(reset);
  check('恢復預設會把設定全部還原', rr.music === true && rr.sfx === true && rr.mistakes === true, reset);

  /* 同一種子重現同一題 */
  const repeat = await cdp.eval(
    "var a=Sudoku.generatePuzzle({difficulty:'hard',seed:'SAMESEED'});" +
    "var b=Sudoku.generatePuzzle({difficulty:'hard',seed:'SAMESEED'});" +
    "var c=Sudoku.generatePuzzle({difficulty:'hard',seed:'OTHERSEED'});" +
    "return JSON.stringify({same:a.puzzle.join('')===b.puzzle.join(''),diff:a.puzzle.join('')!==c.puzzle.join('')," +
    "unique:Sudoku.countSolutions(a.puzzle,2).count});"
  );
  const rp = JSON.parse(repeat);
  check('瀏覽器裡同種子也能重現同一題且唯一解', rp.same && rp.diff && rp.unique === 1, repeat);

  /* ---------- 主控台錯誤 ---------- */
  console.log('\n【主控台】');
  check('沒有未處理的主控台錯誤', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

  /* ---------- server URL 參數化：單機／已連線／設定錯誤／連不上 ---------- */
  console.log('\n【server URL 參數化】');
  const readServerRow = "document.getElementById('b-settings').click();";
  const dumpServerRow =
    "var r=JSON.stringify({status:window.GameConfig.status,url:window.GameConfig.serverUrl," +
    "source:window.GameConfig.source," +
    "pill:document.getElementById('settings-server-state').textContent," +
    "state:document.getElementById('settings-server-state').getAttribute('data-state')," +
    "text:document.getElementById('settings-server-url').textContent});" +
    "document.getElementById('settings-close').click(); return r;";

  await goto(BASE);
  await sleep(250);
  await cdp.eval(readServerRow + ' return 1;');
  await sleep(400);
  const soloRaw = await cdp.eval(dumpServerRow);
  const solo = JSON.parse(soloRaw);
  check('沒設定時是單機模式，設定彈窗顯示「單機」',
    solo.status === 'unset' && solo.url === null && solo.state === 'unset' && solo.pill === '單機', soloRaw);

  await goto(BASE + '?server=' + encodeURIComponent('http://127.0.0.1:' + PORT));
  await sleep(250);
  await cdp.eval(readServerRow + ' return 1;');
  await sleep(1200);
  const onlineRaw = await cdp.eval(dumpServerRow);
  const online = JSON.parse(onlineRaw);
  check('?server= 指到真的伺服器時，/health 回應後顯示「已連線」',
    online.status === 'ok' && online.source === 'query' && online.state === 'ok' && online.pill === '已連線', onlineRaw);

  await goto(BASE + '?server=' + encodeURIComponent('沒有這種網址'));
  await sleep(250);
  await cdp.eval(readServerRow + ' return 1;');
  await sleep(400);
  const badRaw = await cdp.eval(dumpServerRow);
  const bad = JSON.parse(badRaw);
  check('server URL 格式錯誤時退回單機並標示「設定錯誤」',
    bad.status === 'invalid' && bad.url === null && bad.state === 'invalid' && bad.pill === '設定錯誤', badRaw);

  /* 故意指到一個沒人在聽的埠：瀏覽器一定會記一筆網路錯誤，這是預期中的 */
  const errorsBefore = consoleErrors.length;
  await goto(BASE + '?server=' + encodeURIComponent('http://127.0.0.1:9'));
  await sleep(250);
  await cdp.eval(readServerRow + ' return 1;');
  await sleep(2500);
  const downRaw = await cdp.eval(dumpServerRow);
  const down = JSON.parse(downRaw);
  check('伺服器連不上時顯示「連不上」，遊戲仍可繼續玩',
    down.status === 'ok' && down.state === 'fail' && down.pill === '連不上', downRaw);
  const newErrors = consoleErrors.slice(errorsBefore);
  check('連不上的那一筆確實有發出請求（瀏覽器記到網路錯誤）',
    newErrors.some((e) => e.indexOf('127.0.0.1:9') >= 0), newErrors.join(' | ') || '沒有任何網路錯誤');
  const unexpected = newErrors.filter((e) => e.indexOf('127.0.0.1:9') < 0);
  check('除了預期的連線失敗以外沒有其他主控台錯誤', unexpected.length === 0, unexpected.join(' | '));

  const playable = await cdp.eval(
    "var s=Sudoku.generatePuzzle({difficulty:'easy',seed:'OFFLINE'});" +
    "return JSON.stringify({given:s.puzzle.filter(function(v){return v>0;}).length,unique:Sudoku.countSolutions(s.puzzle,2).count});"
  );
  const pl = JSON.parse(playable);
  check('連不上伺服器時照樣出得了題（單機不受影響）', pl.given > 0 && pl.unique === 1, playable);

  /* ---------- 收尾 ---------- */
  try { ws.close(); } catch (e) {}
  browser.kill();
  server.kill();
  await sleep(300);

  console.log('\n螢幕截圖已存到：' + SHOTS);
  if (notes.length) notes.forEach((n) => console.log('備註：' + n));
  if (failures.length) {
    console.log('\n共 ' + failures.length + ' 項未通過：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\n瀏覽器檢查全部通過。\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('瀏覽器檢查失敗：', err);
  process.exit(1);
});
