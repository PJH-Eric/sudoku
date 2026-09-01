/* ===== app.js — 畫面切換、盤面繪製、輸入與設定彈窗 =====
 * 這一層只負責「呈現與輸入」：所有規則判斷都交給 sudoku.js / game.js，
 * 所有儲存都交給 storage.js，所有聲音都交給 audio.js。
 */
(function (w) {
  'use strict';
  var D = document;
  var S = w.Sudoku;
  var G = w.SudokuGame;

  function q(id) { return D.getElementById(id); }
  function qa(sel, root) { return Array.prototype.slice.call((root || D).querySelectorAll(sel)); }

  /* ---------- 全域狀態 ---------- */
  var cur = 's-home';
  var state = null;              // 目前這一局（game.js 的狀態物件）
  var options = w.Store.loadOptions();
  var selected = -1;
  var noteMode = false;
  var paused = false;
  var timerId = null;
  var tickAt = 0;
  var saveTimer = null;
  var toastTimer = null;
  var settingsLastFocus = null;
  var settingsHistory = false;
  var pauseLastFocus = null;
  var cells = [];
  var padButtons = [];
  var pendingDifficulty = w.Store.loadLastDifficulty() || 'easy';
  var tutStep = 0;

  var DIFF_LABEL = { easy: '簡單', medium: '普通', hard: '困難', expert: '專家' };

  /* ---------- 純文字教學 ---------- */
  var TUTORIAL = [
    {
      title: '目標是什麼？',
      body: [
        '盤面是 9 列 × 9 行，被粗線分成 9 個 3×3 的「宮」。',
        '要把每一個空格填上 1 到 9，讓每一列、每一行、每一宮裡面的 1 到 9 都剛好各出現一次。',
        '全部填滿而且沒有重複，這一局就完成了。'
      ]
    },
    {
      title: '怎麼填數字？',
      body: [
        '第一步：用手指點（或滑鼠按）一個空格，那一格會被框起來，代表現在選中它。',
        '第二步：按畫面下方數字盤上的 1 到 9，數字就會填進去。',
        '用鍵盤也可以：方向鍵移動選格，直接按 1 到 9 填入。',
        '再按一次同一個數字，就等於把它取消。'
      ]
    },
    {
      title: '填錯了會怎樣？',
      body: [
        '題目一開始就印好的數字是灰底的，點它會顯示「這格是題目原本就給的數字，不能修改」，盤面不會有任何變動。',
        '如果填的數字跟同一列、同一行或同一宮已經有的數字重複，那兩格會一起變成紅色。',
        '預設還會即時比對答案：填錯的數字會標紅，畫面下方也會用文字告訴你哪一格錯了。',
        '不想被劇透的話，可以到右上角 ⚙ 設定關掉「即時標示填錯」，改成自己檢查。'
      ]
    },
    {
      title: '筆記（候選數）',
      body: [
        '按下工具列的「筆記」按鈕，按鈕會顯示「開」，這時候按數字不會真的填進去，而是在格子角落記下小小的候選數。',
        '想不出來的時候，先把一格所有可能的數字記下來，之後刪到剩一個，那格答案就出來了。',
        '再按一次「筆記」就會切回正常填入模式。',
        '預設開啟「自動整理筆記」：你填入一個數字後，同列、同行、同宮的相同筆記會自動被清掉。'
      ]
    },
    {
      title: '清除、復原、重做',
      body: [
        '「清除」會把選中格子的數字和筆記一起清空（鍵盤 Backspace 或 Delete 也可以）。',
        '「復原」回到上一步，「重做」再做回來，隨時可以反悔，不會弄壞盤面。',
        '暫停畫面裡的「這題重來」會把整題恢復成一開始的樣子，時間和計數也一起歸零。'
      ]
    },
    {
      title: '提示怎麼用？',
      body: [
        '按「提示」會直接幫你填好一格，同時用文字說明「為什麼是這個數字」，例如「第 3 宮裡面只有 R2C5 放得下 7」。',
        '如果盤面上已經有填錯的數字，提示會先幫你抓出那一格，因為錯的數字會讓後面的推理全部走歪。',
        '提示次數不限制，但會記在結算畫面上，想挑戰的話就少用一點。'
      ]
    },
    {
      title: '難度、種子與設定',
      body: [
        '四種難度不是只有空格數量不同，而是「解得下去所需要的技巧」不同：簡單只要「這格只剩一個數字可填」；普通要找「這一宮只有這格放得下 X」；困難需要區塊摒除、裸對這類先刪候選數的技巧；專家連基本技巧都推不完，得靠假設試誤。',
        '出題畫面可以輸入「種子」。同一組種子加上同一個難度，永遠會拿到同一題，可以跟朋友比同一題誰快。',
        '右上角的 ⚙ 在每個畫面都在，可以分別調整背景音樂與音效的開關和音量、觸控震動、動畫、以及盤面要不要幫你標示與高亮。',
        '離開遊戲不用擔心：目前這一題會存在這台裝置上，下次回來主選單按「繼續上一題」就能接著玩。'
      ]
    }
  ];

  /* ---------- 小工具 ---------- */
  function fmtTime(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(total / 60), s = total % 60;
    var h = Math.floor(m / 60);
    if (h > 0) return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function say(message, kind) {
    var host = q('feedback');
    if (!host) return;
    host.textContent = message;
    host.className = 'feedback' + (kind ? ' ' + kind : '');
  }

  function toast(message) {
    var host = q('toast');
    if (!host) return;
    host.textContent = message;
    host.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.classList.remove('on'); }, 2200);
  }

  /* ---------- 畫面切換 ---------- */
  function go(id) {
    if (cur === 's-game' && id !== 's-game') stopTimer();
    qa('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    cur = id;
    w.Sound.setTrack(id === 's-game' ? 'game' : 'menu');
    if (id === 's-game') {
      setTimeout(resizeBoard, 40);
      if (!paused) startTimer();
    }
    if (id === 's-stats') renderStats();
    if (id === 's-home') refreshHome();
    setTimeout(function () { w.UI.repaintAll(q(id)); }, 30);
  }

  function refreshHome() {
    var saved = w.Store.loadGame();
    var btn = q('b-continue');
    if (saved && saved.status !== 'won') {
      btn.hidden = false;
      w.UI.setLabel(btn, '<span class="ico">▶</span>繼續上一題（' + (DIFF_LABEL[saved.difficulty] || '') + '）');
      setTimeout(function () { w.UI.paint(btn); }, 0);
    } else {
      btn.hidden = true;
    }
    /* 第一次進來才主動提示教學，熟練的玩家不會被打擾 */
    var firstTime = !w.Store.hasSeenHelp();
    var helpBtn = q('b-help');
    w.UI.setColor(helpBtn, firstTime ? 'lemon' : 'sky');
    q('home-note').textContent = !w.Store.available
      ? '這個瀏覽器停用了本機儲存，設定與進度不會被保留，但遊戲仍然完整可玩。'
      : (firstTime
        ? '第一次玩嗎？先點「玩法教學」，七段純文字說明大約一分鐘看完。'
        : '全部題目都保證只有一組答案，離開再回來也能接著玩。');
  }

  function openHelp() {
    w.Store.markHelpSeen();
    tutStep = 0;
    renderTutorial();
    go('s-help');
  }

  /* ---------- 選項套用 ---------- */
  function applyOptions() {
    D.documentElement.classList.toggle('reduced-motion', !options.motion);
    D.documentElement.classList.toggle('hide-remaining', !options.showRemaining);
    if (state) state.autoClearNotes = options.autoClearNotes;
    if (state) renderBoard();
  }

  /* ---------- 盤面建立 ---------- */
  function buildBoard() {
    var board = q('board');
    board.innerHTML = '';
    cells = [];
    for (var i = 0; i < 81; i++) {
      var r = S.ROW_OF[i], c = S.COL_OF[i];
      var btn = D.createElement('button');
      btn.type = 'button';
      btn.className = 'cell' + ((c === 2 || c === 5) ? ' br' : '') + ((r === 2 || r === 5) ? ' bb' : '');
      btn.setAttribute('data-i', String(i));
      btn.setAttribute('role', 'gridcell');
      btn.tabIndex = -1;
      var v = D.createElement('span'); v.className = 'v';
      var nt = D.createElement('span'); nt.className = 'nt';
      for (var d = 1; d <= 9; d++) {
        var n = D.createElement('i');
        n.textContent = String(d);
        nt.appendChild(n);
      }
      btn.appendChild(v);
      btn.appendChild(nt);
      board.appendChild(btn);
      cells.push(btn);
    }
    board.addEventListener('click', function (e) {
      var target = e.target.closest ? e.target.closest('.cell') : null;
      if (!target) return;
      selectCell(parseInt(target.getAttribute('data-i'), 10), true);
    });
  }

  function buildNumpad() {
    var pad = q('numpad');
    pad.innerHTML = '';
    padButtons = [];
    for (var d = 1; d <= 9; d++) {
      var b = D.createElement('button');
      b.type = 'button';
      b.className = 'btn3d numkey';
      b.setAttribute('data-color', 'grape');
      b.setAttribute('data-d', String(d));
      b.innerHTML = '<span class="nk">' + d + '</span><span class="nleft" aria-hidden="true"></span>';
      b.setAttribute('aria-label', '填入數字 ' + d);
      pad.appendChild(b);
      padButtons.push(b);
    }
    w.UI.decorateAll(pad);
    pad.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.numkey') : null;
      if (!t) return;
      inputDigit(parseInt(t.getAttribute('data-d'), 10));
    });
  }

  /* ---------- 盤面繪製 ---------- */
  function renderBoard() {
    if (!state) return;
    var conflicts = S.findConflicts(state.values);
    var wrong = options.markMistakes ? G.wrongCells(state) : null;
    var selValue = selected >= 0 ? state.values[selected] : 0;
    var selRow = selected >= 0 ? S.ROW_OF[selected] : -1;
    var selCol = selected >= 0 ? S.COL_OF[selected] : -1;
    var selBox = selected >= 0 ? S.BOX_OF[selected] : -1;

    for (var i = 0; i < 81; i++) {
      var el = cells[i];
      var v = state.values[i];
      var cls = 'cell';
      if (S.COL_OF[i] === 2 || S.COL_OF[i] === 5) cls += ' br';
      if (S.ROW_OF[i] === 2 || S.ROW_OF[i] === 5) cls += ' bb';
      if (state.given[i]) cls += ' given';
      if (i === selected) cls += ' sel';
      else if (options.highlightUnits && selected >= 0 &&
        (S.ROW_OF[i] === selRow || S.COL_OF[i] === selCol || S.BOX_OF[i] === selBox)) cls += ' peer';
      if (options.highlightSame && selValue && v === selValue) cls += ' same';
      if (conflicts[i]) cls += ' conflict';
      if (wrong && wrong[i]) cls += ' wrong';
      el.className = cls;
      el.tabIndex = (i === selected) ? 0 : -1;

      var value = el.firstChild;
      value.textContent = v ? String(v) : '';
      var notes = el.lastChild;
      var mask = v ? 0 : state.notes[i];
      notes.style.display = mask ? '' : 'none';
      for (var d = 1; d <= 9; d++) {
        notes.childNodes[d - 1].className = (mask & S.BIT[d]) ? 'on' : '';
      }
      el.setAttribute('aria-label', cellLabel(i, v, mask, conflicts[i], wrong && wrong[i]));
    }
    renderStatus();
  }

  function cellLabel(i, v, mask, conflict, isWrong) {
    var pos = '第 ' + (S.ROW_OF[i] + 1) + ' 列第 ' + (S.COL_OF[i] + 1) + ' 行';
    if (v) {
      return pos + '，' + (state.given[i] ? '題目給的 ' : '') + v +
        (conflict ? '，和同列行宮重複' : '') + (isWrong ? '，和答案不符' : '');
    }
    if (mask) return pos + '，空格，筆記 ' + S.maskToDigits(mask).join('、');
    return pos + '，空格';
  }

  function renderStatus() {
    if (!state) return;
    var left = G.remaining(state);
    q('st-left').textContent = String(left);
    q('st-hint').textContent = String(state.hintsUsed);
    q('st-miss').textContent = String(state.mistakes);
    q('st-time').textContent = fmtTime(state.elapsedMs);
    q('g-diff').textContent = state.label || DIFF_LABEL[state.difficulty] || '';
    q('g-seed').textContent = '種子 ' + state.seed;
    q('g-tech').textContent = state.technique || '';
    q('b-undo').disabled = !state.history.length;
    q('b-redo').disabled = !state.future.length;

    var counts = G.digitCounts(state);
    for (var d = 1; d <= 9; d++) {
      var btn = padButtons[d - 1];
      if (!btn) continue;
      var rest = 9 - counts[d];
      var span = btn.querySelector('.nleft');
      if (span) span.textContent = rest > 0 ? String(rest) : '✓';
      btn.classList.toggle('done', rest <= 0);
      btn.setAttribute('aria-label', (noteMode ? '記下候選數 ' : '填入數字 ') + d +
        (rest > 0 ? '，還有 ' + rest + ' 格' : '，這個數字已經填完'));
    }
  }

  /* ---------- 盤面尺寸（RWD 的關鍵） ---------- */
  function resizeBoard() {
    var wrap = q('boardwrap') || D.querySelector('.boardwrap');
    var board = q('board');
    if (!wrap || !board) return;
    var w1 = wrap.clientWidth, h1 = wrap.clientHeight;
    if (!w1 || !h1) return;
    var size = Math.max(180, Math.floor(Math.min(w1, h1)) - 2);
    board.style.setProperty('--bs', size + 'px');
  }

  /* ---------- 選格 ---------- */
  function selectCell(index, fromUser) {
    if (index < 0 || index >= 81) return;
    selected = index;
    renderBoard();
    if (cells[index]) cells[index].focus({ preventScroll: true });
    if (fromUser) w.Sound.play('select');
  }

  function moveSelection(dr, dc) {
    if (selected < 0) { selectCell(firstEmpty(), true); return; }
    var r = S.ROW_OF[selected], c = S.COL_OF[selected];
    r = Math.min(8, Math.max(0, r + dr));
    c = Math.min(8, Math.max(0, c + dc));
    selectCell(r * 9 + c, true);
  }

  function firstEmpty() {
    if (!state) return 0;
    for (var i = 0; i < 81; i++) if (!state.values[i]) return i;
    return 0;
  }

  /* ---------- 動作處理 ---------- */
  function handleResult(res) {
    if (!res.ok) {
      say(res.message, 'bad');
      toast(res.message);
      w.Sound.play('blocked');
      w.Sound.vibrate([12, 40, 12]);
      return res;
    }
    renderBoard();
    scheduleSave();
    if (res.won) {
      finishGame();
      return res;
    }
    say(res.message, res.wrong ? 'warn' : 'good');
    return res;
  }

  function inputDigit(d) {
    if (!state || paused) return;
    if (selected < 0) {
      say('請先點一個空格，再按數字。', 'bad');
      toast('請先點一個空格');
      w.Sound.play('blocked');
      return;
    }
    var res = noteMode ? G.toggleNote(state, selected, d) : G.setValue(state, selected, d);
    if (res.ok) {
      if (res.code === 'note') { w.Sound.play('note'); w.Sound.vibrate(8); }
      else if (res.code === 'clear') { w.Sound.play('clear'); w.Sound.vibrate(8); }
      else if (res.wrong) { w.Sound.play('wrong'); w.Sound.vibrate([16, 50, 16]); }
      else { w.Sound.play('place'); w.Sound.vibrate(10); }
    }
    handleResult(res);
  }

  function doErase() {
    if (!state || paused) return;
    if (selected < 0) {
      say('請先點一個格子，再按清除。', 'bad');
      w.Sound.play('blocked');
      return;
    }
    var res = G.clearCell(state, selected);
    if (res.ok) { w.Sound.play('clear'); w.Sound.vibrate(8); }
    handleResult(res);
  }

  function doUndo() {
    if (!state || paused) return;
    var res = G.undo(state);
    if (res.ok) {
      w.Sound.play('undo');
      if (res.index >= 0) selected = res.index;
    }
    handleResult(res);
  }
  function doRedo() {
    if (!state || paused) return;
    var res = G.redo(state);
    if (res.ok) {
      w.Sound.play('undo');
      if (res.index >= 0) selected = res.index;
    }
    handleResult(res);
  }

  function doHint() {
    if (!state || paused) return;
    var res = G.hint(state);
    if (res.ok) {
      selected = res.index;
      w.Sound.play('hint');
      w.Sound.vibrate(14);
      if (cells[res.index]) {
        cells[res.index].classList.add('hinted');
        setTimeout(function () { if (cells[res.index]) cells[res.index].classList.remove('hinted'); }, 1400);
      }
    }
    handleResult(res);
  }

  function toggleNoteMode(force) {
    noteMode = (force === undefined) ? !noteMode : !!force;
    var b = q('b-note');
    b.setAttribute('aria-pressed', noteMode ? 'true' : 'false');
    b.classList.toggle('on', noteMode);
    w.UI.setColor(b, noteMode ? 'mint' : 'sky');
    q('note-tag').textContent = noteMode ? '開' : '關';
    say(noteMode ? '筆記模式已開啟：按數字只會在角落記候選數。' : '筆記模式已關閉：按數字會直接填入格子。', 'good');
    w.Sound.play('click');
  }

  /* ---------- 計時 ---------- */
  function startTimer() {
    stopTimer();
    if (!state || state.status !== 'playing') return;
    tickAt = Date.now();
    timerId = setInterval(function () {
      var now = Date.now();
      state.elapsedMs += now - tickAt;
      tickAt = now;
      q('st-time').textContent = fmtTime(state.elapsedMs);
      if (state.elapsedMs % 15000 < 1100) scheduleSave();
    }, 1000);
  }
  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
    if (state && tickAt) {
      state.elapsedMs += Date.now() - tickAt;
      tickAt = 0;
    }
  }

  /* ---------- 存檔 ---------- */
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }
  function saveNow() {
    if (!state) return;
    w.Store.saveGame(G.serialize(state));
  }

  /* ---------- 出題流程 ---------- */
  function startNewGame(difficulty, seed) {
    pendingDifficulty = difficulty;
    w.Store.saveLastDifficulty(difficulty);
    q('loading-note').textContent = '正在為「' + (DIFF_LABEL[difficulty] || difficulty) + '」挖洞並驗證唯一解…';
    go('s-loading');
    /* 讓載入畫面先畫出來，再做比較重的出題運算 */
    setTimeout(function () {
      var puzzle = null;
      try {
        puzzle = S.generatePuzzle({ difficulty: difficulty, seed: seed });
      } catch (e) {
        puzzle = null;
      }
      if (!puzzle || !puzzle.puzzle) {
        q('error-note').textContent = '出題時發生問題，請再試一次，或換一個難度。';
        go('s-error');
        return;
      }
      state = G.fromPuzzle(puzzle, { autoClearNotes: options.autoClearNotes });
      beginGame(true);
    }, 40);
  }

  function beginGame(isNew) {
    paused = false;
    q('pause-overlay').classList.remove('on');
    q('pause-overlay').setAttribute('aria-hidden', 'true');
    toggleNoteMode(false);
    selected = firstEmpty();
    renderBoard();
    go('s-game');
    resizeBoard();
    saveNow();
    if (isNew) {
      w.Sound.play('start');
      say('新題目來了！點一個空格，再按下面的數字就能填入。', 'good');
    } else {
      say('接著上次的進度繼續，加油！', 'good');
    }
    if (w.Sound.isMusicOn()) w.Sound.startBgm('game');
  }

  function continueSaved() {
    var data = w.Store.loadGame();
    var restored = data ? G.deserialize(data) : null;
    if (!restored) {
      w.Store.clearGame();
      toast('找不到可以繼續的題目，幫你開一題新的。');
      startNewGame(pendingDifficulty, '');
      return;
    }
    state = restored;
    state.autoClearNotes = options.autoClearNotes;
    beginGame(false);
  }

  /* ---------- 暫停 ---------- */
  function setPaused(on) {
    if (!state) return;
    paused = !!on;
    var ov = q('pause-overlay');
    ov.classList.toggle('on', paused);
    ov.setAttribute('aria-hidden', paused ? 'false' : 'true');
    q('board').classList.toggle('hidden-board', paused);
    if (paused) {
      pauseLastFocus = D.activeElement;
      stopTimer();
      saveNow();
      w.Sound.play('pause');
      setTimeout(function () { q('pause-box').focus(); }, 20);
      say('遊戲已暫停，計時停住了。', 'good');
    } else {
      startTimer();
      w.Sound.play('resume');
      say('繼續囉！', 'good');
      if (pauseLastFocus && pauseLastFocus.focus) pauseLastFocus.focus();
      pauseLastFocus = null;
    }
  }

  /* ---------- 結算 ---------- */
  function finishGame() {
    stopTimer();
    w.Store.clearGame();
    w.Sound.play('win');
    w.Sound.vibrate([24, 60, 24, 60, 40]);
    var rec = w.Store.recordWin(state.difficulty, state.elapsedMs, {
      hints: state.hintsUsed, mistakes: state.mistakes, seed: state.seed
    });
    q('res-trophy').innerHTML = w.UI.trophy();
    q('res-title').textContent = rec.isNew ? '新紀錄！完成了！' : '完成了！';
    q('res-sub').textContent = '每一列、每一行、每一宮的 1 到 9 都剛好各一個。';
    var rows = [
      ['難度', (state.label || '') + '（' + (state.technique || '') + '）'],
      ['花費時間', fmtTime(state.elapsedMs)],
      ['提示次數', state.hintsUsed + ' 次'],
      ['填錯次數', state.mistakes + ' 次'],
      ['題目種子', state.seed],
      ['這個難度最佳', fmtTime(rec.best) + (rec.isNew ? '（就是這一局）' : '')],
      ['累計完成', rec.count + ' 題']
    ];
    q('res-stats').innerHTML = rows.map(function (r, i) {
      return '<div class="row' + (rec.isNew && i === 5 ? ' best' : '') + '"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
    }).join('');
    go('s-result');
  }

  /* ---------- 我的紀錄 ---------- */
  function renderStats() {
    var best = w.Store.loadBest();
    var host = q('ranklist');
    var html = '';
    S.DIFFICULTIES.forEach(function (d) {
      var b = best[d];
      var count = best[d + '_count'] || 0;
      html += '<div class="rankgrp"><h4>' + DIFF_LABEL[d] + '</h4>';
      if (b) {
        html += '<div class="r"><span>最佳時間</span><b>' + fmtTime(b.ms) + '</b></div>';
        html += '<div class="r"><span>那一局的提示／填錯</span><b>' + (b.hints | 0) + ' ／ ' + (b.mistakes | 0) + '</b></div>';
        html += '<div class="r"><span>題目種子</span><b>' + (b.seed || '—') + '</b></div>';
      } else {
        html += '<div class="r empty-row"><span>還沒有完成紀錄</span><b>—</b></div>';
      }
      html += '<div class="r"><span>累計完成</span><b>' + count + ' 題</b></div>';
      html += '</div>';
    });
    host.innerHTML = html;
  }

  /* ---------- 教學 ---------- */
  function renderTutorial() {
    var stepData = TUTORIAL[tutStep];
    q('tut-progress').textContent = '第 ' + (tutStep + 1) + ' 段 / 共 ' + TUTORIAL.length + ' 段';
    q('tut-title').textContent = stepData.title;
    q('tut-body').innerHTML = stepData.body.map(function (p) { return '<p>' + p + '</p>'; }).join('');
    q('b-tut-prev').disabled = tutStep === 0;
    w.UI.setLabel(q('b-tut-next'), tutStep === TUTORIAL.length - 1 ? '重看第一段 ↻' : '下一段 ▶');
    setTimeout(function () { w.UI.repaintAll(q('s-help')); }, 10);
  }

  /* ---------- 設定彈窗 ---------- */
  /* 連線狀態：server URL 只從 GameConfig 拿，這裡不自己拼網址。
   * 單機模式（沒設定）不會發出任何請求，畫面直接顯示「單機」。 */
  var SERVER_STATE_TEXT = {
    unset: { pill: '單機', note: '這是單機遊戲，沒有伺服器也能完整遊玩；成績與進度都存在這台裝置上。' },
    invalid: { pill: '設定錯誤', note: '伺服器網址格式不正確，已自動改用單機模式。請檢查部署時注入的 GAME_SERVER_URL。' },
    checking: { pill: '連線中', note: '正在確認伺服器狀態…免費雲端服務剛醒來時可能要等十幾秒。' },
    ok: { pill: '已連線', note: '伺服器回應正常。' },
    fail: { pill: '連不上', note: '目前連不上伺服器，遊戲會以單機模式繼續，不影響這一局。' }
  };
  function setServerState(state) {
    var pill = q('settings-server-state');
    var note = q('settings-server-note');
    var info = SERVER_STATE_TEXT[state] || SERVER_STATE_TEXT.unset;
    if (pill) { pill.textContent = info.pill; pill.setAttribute('data-state', state); }
    if (note) note.textContent = info.note;
  }
  function syncServerRow() {
    var C = w.GameConfig;
    var urlEl = q('settings-server-url');
    if (!C || !urlEl) return;
    urlEl.textContent = C.describe();
    setServerState(C.status);
    C.checkHealth(setServerState);
  }

  function syncSettings() {
    var musicOn = w.Sound.isMusicOn(), sfxOn = w.Sound.isSfxOn();
    var mv = Math.round(w.Sound.getMusicVolume() * 100);
    var sv = Math.round(w.Sound.getSfxVolume() * 100);
    q('settings-music').checked = musicOn;
    q('settings-sfx').checked = sfxOn;
    q('settings-music-volume').value = mv;
    q('settings-sfx-volume').value = sv;
    q('settings-music-volume-value').textContent = mv + '%';
    q('settings-sfx-volume-value').textContent = sv + '%';
    q('settings-music-status').textContent = musicOn ? '開啟' : '關閉';
    q('settings-sfx-status').textContent = sfxOn ? '開啟' : '關閉';
    q('settings-haptic').checked = w.Sound.isHapticOn();
    q('settings-motion').checked = options.motion;
    q('settings-autonotes').checked = options.autoClearNotes;
    q('settings-mistakes').checked = options.markMistakes;
    q('settings-same').checked = options.highlightSame;
    q('settings-units').checked = options.highlightUnits;
    q('settings-remaining').checked = options.showRemaining;
    q('settings-audio-note').textContent = w.Sound.isUnlocked()
      ? '聲音已經可以播放了。'
      : '聲音會在你第一次點畫面之後才開始播放，這是瀏覽器的規定。';
    syncServerRow();
  }

  function focusableIn(root) {
    return qa('button, input, [tabindex]:not([tabindex="-1"])', root).filter(function (el) {
      return !el.disabled && el.offsetParent !== null;
    });
  }

  function setSettingsOpen(open, fromHistory) {
    var modal = q('settings-modal');
    if (!modal) return;
    if (open) {
      settingsLastFocus = D.activeElement;
      if (!settingsHistory && !fromHistory) {
        try { history.pushState({ sdSettings: true }, '', location.href); settingsHistory = true; } catch (e) {}
      }
    }
    modal.classList.toggle('open', !!open);
    modal.setAttribute('aria-hidden', open ? 'false' : 'true');
    q('b-settings').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      syncSettings();
      q('settings-panel').focus();
    } else {
      /* 關閉後把焦點還給原本的元素；若原本沒有明確焦點（例如觸控直接點開），就還給設定按鈕 */
      var back = (settingsLastFocus && settingsLastFocus !== D.body && typeof settingsLastFocus.focus === 'function')
        ? settingsLastFocus : q('b-settings');
      if (back && back.focus) back.focus();
      settingsLastFocus = null;
      if (settingsHistory && !fromHistory) {
        settingsHistory = false;
        try { history.back(); } catch (e) {}
      }
    }
  }
  function isSettingsOpen() { return q('settings-modal').classList.contains('open'); }

  function bindSettings() {
    q('b-settings').addEventListener('click', function () { w.Sound.play('click'); setSettingsOpen(true); });
    q('settings-close').addEventListener('click', function () { w.Sound.play('click'); setSettingsOpen(false); });
    q('settings-done').addEventListener('click', function () { w.Sound.play('click'); setSettingsOpen(false); });
    qa('[data-settings-close]').forEach(function (el) {
      el.addEventListener('click', function () { setSettingsOpen(false); });
    });

    q('settings-music').addEventListener('change', function (e) {
      w.Sound.setMusic(e.target.checked);
      if (e.target.checked && cur === 's-game') w.Sound.startBgm('game');
      syncSettings();
    });
    q('settings-sfx').addEventListener('change', function (e) { w.Sound.setSfx(e.target.checked); syncSettings(); });
    q('settings-music-volume').addEventListener('input', function (e) {
      w.Sound.setMusicVolume(e.target.value / 100);
      q('settings-music-volume-value').textContent = e.target.value + '%';
    });
    q('settings-sfx-volume').addEventListener('input', function (e) {
      w.Sound.setSfxVolume(e.target.value / 100);
      q('settings-sfx-volume-value').textContent = e.target.value + '%';
    });
    q('settings-sfx-volume').addEventListener('change', function () { w.Sound.play('click'); });
    q('settings-haptic').addEventListener('change', function (e) {
      w.Sound.setHaptic(e.target.checked);
      if (e.target.checked) w.Sound.vibrate(12);
    });

    function optionToggle(id, key) {
      q(id).addEventListener('change', function (e) {
        options[key] = e.target.checked;
        w.Store.saveOptions(options);
        applyOptions();
      });
    }
    optionToggle('settings-motion', 'motion');
    optionToggle('settings-autonotes', 'autoClearNotes');
    optionToggle('settings-mistakes', 'markMistakes');
    optionToggle('settings-same', 'highlightSame');
    optionToggle('settings-units', 'highlightUnits');
    optionToggle('settings-remaining', 'showRemaining');

    q('settings-reset').addEventListener('click', function () {
      w.Sound.resetDefaults();
      options = w.Store.defaultOptions();
      w.Store.saveOptions(options);
      applyOptions();
      syncSettings();
      toast('已恢復預設設定');
      w.Sound.play('click');
    });

    /* 焦點鎖定：Tab 只在彈窗內循環 */
    q('settings-modal').addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var list = focusableIn(q('settings-panel'));
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && (D.activeElement === first || D.activeElement === q('settings-panel'))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && D.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });

    /* 手機的返回鍵／瀏覽器上一頁：關掉彈窗而不是離開遊戲 */
    w.addEventListener('popstate', function () {
      if (isSettingsOpen()) { settingsHistory = false; setSettingsOpen(false, true); }
    });
  }

  /* ---------- 綁定 ---------- */
  function bind() {
    qa('[data-back]').forEach(function (b) {
      b.addEventListener('click', function () { w.Sound.play('click'); go(b.getAttribute('data-back')); });
    });

    q('b-new').addEventListener('click', function () {
      w.Sound.play('click');
      markDiff(pendingDifficulty);
      go('s-setup');
    });
    q('b-continue').addEventListener('click', function () { w.Sound.play('click'); continueSaved(); });
    q('b-stats').addEventListener('click', function () { w.Sound.play('click'); go('s-stats'); });
    q('b-help').addEventListener('click', function () { w.Sound.play('click'); openHelp(); });

    q('opt-diff').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.optcard') : null;
      if (!b) return;
      w.Sound.play('click');
      markDiff(b.getAttribute('data-v'));
    });
    q('b-seed-random').addEventListener('click', function () {
      w.Sound.play('click');
      q('seed-input').value = w.RNG.randomSeed();
    });
    q('seed-input').addEventListener('input', function (e) {
      var pos = e.target.selectionStart;
      e.target.value = w.RNG.normalizeSeed(e.target.value);
      try { e.target.setSelectionRange(pos, pos); } catch (err) {}
    });
    q('b-start').addEventListener('click', function () {
      w.Sound.play('click');
      startNewGame(pendingDifficulty, w.RNG.normalizeSeed(q('seed-input').value));
    });
    q('b-retry').addEventListener('click', function () {
      w.Sound.play('click');
      startNewGame(pendingDifficulty, w.RNG.normalizeSeed(q('seed-input').value));
    });

    q('b-quit').addEventListener('click', function () {
      w.Sound.play('click');
      stopTimer(); saveNow(); go('s-home');
    });
    q('b-pause').addEventListener('click', function () { setPaused(!paused); });
    q('b-resume').addEventListener('click', function () { setPaused(false); });
    q('b-restart').addEventListener('click', function () {
      w.Sound.play('click');
      G.restart(state);
      selected = firstEmpty();
      setPaused(false);
      renderBoard();
      saveNow();
      say('已回到題目一開始的樣子。', 'good');
    });
    q('b-pausequit').addEventListener('click', function () {
      w.Sound.play('click');
      setPaused(false);
      stopTimer(); saveNow(); go('s-home');
    });

    q('b-note').addEventListener('click', function () { toggleNoteMode(); });
    q('b-erase').addEventListener('click', doErase);
    q('b-undo').addEventListener('click', doUndo);
    q('b-redo').addEventListener('click', doRedo);
    q('b-hint').addEventListener('click', doHint);

    q('b-again').addEventListener('click', function () {
      w.Sound.play('click');
      startNewGame(state ? state.difficulty : pendingDifficulty, '');
    });
    q('b-changediff').addEventListener('click', function () { w.Sound.play('click'); markDiff(pendingDifficulty); go('s-setup'); });
    q('b-home2').addEventListener('click', function () { w.Sound.play('click'); go('s-home'); });

    q('b-clearstats').addEventListener('click', function () {
      w.Sound.play('click');
      w.Store.clearBest();
      renderStats();
      toast('已清除本機紀錄');
    });

    q('b-tut-prev').addEventListener('click', function () {
      w.Sound.play('click');
      if (tutStep > 0) tutStep--;
      renderTutorial();
    });
    q('b-tut-next').addEventListener('click', function () {
      w.Sound.play('click');
      tutStep = (tutStep + 1) % TUTORIAL.length;
      renderTutorial();
    });
    q('b-help-skip').addEventListener('click', function () { w.Sound.play('click'); go('s-home'); });
    q('b-tut-play').addEventListener('click', function () { w.Sound.play('click'); startNewGame('easy', ''); });

    /* 鍵盤操作 */
    D.addEventListener('keydown', function (e) {
      if (isSettingsOpen()) {
        if (e.key === 'Escape') { e.preventDefault(); setSettingsOpen(false); }
        return;
      }
      if (cur !== 's-game' || !state) return;
      if (paused) {
        if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setPaused(false); }
        return;
      }
      var k = e.key;
      if (k >= '1' && k <= '9') { e.preventDefault(); inputDigit(parseInt(k, 10)); return; }
      switch (k) {
        case 'ArrowUp': e.preventDefault(); moveSelection(-1, 0); break;
        case 'ArrowDown': e.preventDefault(); moveSelection(1, 0); break;
        case 'ArrowLeft': e.preventDefault(); moveSelection(0, -1); break;
        case 'ArrowRight': e.preventDefault(); moveSelection(0, 1); break;
        case 'Backspace': case 'Delete': case '0': e.preventDefault(); doErase(); break;
        case 'n': case 'N': e.preventDefault(); toggleNoteMode(); break;
        case 'z': case 'Z': e.preventDefault(); doUndo(); break;
        case 'y': case 'Y': e.preventDefault(); doRedo(); break;
        case 'h': case 'H': e.preventDefault(); doHint(); break;
        case 'Escape': e.preventDefault(); setPaused(true); break;
        default: break;
      }
    });

    /* 版面尺寸變化：直橫向切換、瀏覽器工具列縮放都要重新量測 */
    var resizeTimer = null;
    function onResize() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeBoard();
        w.UI.repaintAll(q(cur));
      }, 80);
    }
    w.addEventListener('resize', onResize);
    w.addEventListener('orientationchange', onResize);
    if (w.visualViewport) w.visualViewport.addEventListener('resize', onResize);

    /* 切到背景或關閉分頁時保存進度 */
    D.addEventListener('visibilitychange', function () {
      if (D.hidden) {
        if (cur === 's-game' && !paused) stopTimer();
        saveNow();
      } else if (cur === 's-game' && !paused) {
        startTimer();
      }
    });
    w.addEventListener('pagehide', saveNow);

    /* 第一次手勢解鎖音訊 */
    function firstGesture() {
      w.Sound.unlock();
      if (w.Sound.isMusicOn()) w.Sound.startBgm(cur === 's-game' ? 'game' : 'menu');
      D.removeEventListener('pointerdown', firstGesture);
      D.removeEventListener('keydown', firstGesture);
    }
    D.addEventListener('pointerdown', firstGesture);
    D.addEventListener('keydown', firstGesture);
  }

  function markDiff(v) {
    pendingDifficulty = S.PRESETS[v] ? v : 'easy';
    qa('.optcard', q('opt-diff')).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === pendingDifficulty);
      b.setAttribute('aria-pressed', b.getAttribute('data-v') === pendingDifficulty ? 'true' : 'false');
    });
  }

  /* ---------- 啟動 ---------- */
  function init() {
    q('logo').innerHTML = w.UI.logo();
    w.UI.bgDeco(q('bgdeco'));
    buildBoard();
    buildNumpad();
    w.UI.decorateAll();
    bind();
    bindSettings();
    applyOptions();
    markDiff(pendingDifficulty);
    refreshHome();
    renderTutorial();
    go('s-home');
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
