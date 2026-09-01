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
  var pendingDifficulty = w.Store.loadLastDifficulty() || 'beginner';
  var tutStep = 0;

  var DIFF_LABEL = { beginner: '新手入門', easy: '簡單', medium: '普通', hard: '困難', expert: '專家' };

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
        '五種難度不是只有空格數量不同，而是「解得下去所需要的技巧」與「會卡住幾次」都不同：新手入門大多是「整列或整宮只剩一格」，一眼就看得到；簡單全程只要「這格只剩一個數字可填」；普通會卡住好幾次，要找「這一宮只有這格放得下 X」；困難整局都要用區塊摒除、裸對先刪候選數；專家的盤面不對稱、卡點更多更早，還可能用到裸三或 X-Wing。',
        '出題畫面可以輸入「種子」。同一組種子加上同一個難度，永遠會拿到同一題，可以跟朋友比同一題誰快。',
        '右上角的 ⚙ 在每個畫面都在，可以分別調整背景音樂與音效的開關和音量、留言提示音、觸控震動、動畫、暱稱，以及盤面要不要幫你標示與高亮。',
        '主選單的「線上觀戰與留言」可以看別人解題、順便聊天；也可以自己開一間房，把連結傳給朋友讓他們進來看你解。這需要有設定遊戲伺服器，沒有設定時畫面會直接說明原因。',
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
    if (cur === 's-lobby' && id !== 's-lobby') stopLobbyAuto();
    qa('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    cur = id;
    w.Sound.setTrack((id === 's-game' || id === 's-watch') ? 'game' : 'menu');
    if (id === 's-game') {
      setTimeout(resizeBoard, 40);
      if (!paused) startTimer();
    }
    if (id === 's-watch') setTimeout(resizeWatchBoard, 40);
    if (id === 's-stats') renderStats();
    if (id === 's-lobby') renderLobby();
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
  function appendSharedNoteChrome(cell) {
    var corner = D.createElement('span');
    corner.className = 'cell-note-corner';
    corner.setAttribute('role', 'button');
    corner.setAttribute('tabindex', '-1');
    corner.setAttribute('aria-label', '查看這格的格子留言');
    var count = D.createElement('span');
    count.className = 'cell-note-count';
    corner.appendChild(count);

    var popover = D.createElement('span');
    popover.className = 'cell-note-popover';
    popover.hidden = true;
    popover.setAttribute('role', 'status');
    var title = D.createElement('b');
    title.className = 'cell-note-popover-title';
    title.textContent = '格子留言';
    var items = D.createElement('span');
    items.className = 'cell-note-items';
    popover.appendChild(title);
    popover.appendChild(items);

    cell.appendChild(corner);
    cell.appendChild(popover);
  }

  function buildBoard() {
    var board = q('board');
    board.innerHTML = '';
    cells = [];
    for (var i = 0; i < 81; i++) {
      var r = S.ROW_OF[i], c = S.COL_OF[i];
      var btn = D.createElement('button');
      btn.type = 'button';
      btn.className = 'cell' + ((c === 2 || c === 5) ? ' br' : '') + ((r === 2 || r === 5) ? ' bb' : '') +
        (c >= 7 ? ' note-right' : '') + (r >= 7 ? ' note-bottom' : '');
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
      appendSharedNoteChrome(btn);
      board.appendChild(btn);
      cells.push(btn);
    }
    board.addEventListener('click', function (e) {
      var noteToggle = e.target.closest ? e.target.closest('.cell-note-corner') : null;
      if (noteToggle) {
        e.preventDefault();
        e.stopPropagation();
        toggleHostCellNotes(parseInt(noteToggle.parentNode.getAttribute('data-i'), 10));
        return;
      }
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
      if (S.COL_OF[i] >= 7) cls += ' note-right';
      if (S.ROW_OF[i] >= 7) cls += ' note-bottom';
      if (state.given[i]) cls += ' given';
      if (i === selected) cls += ' sel';
      else if (options.highlightUnits && selected >= 0 &&
        (S.ROW_OF[i] === selRow || S.COL_OF[i] === selCol || S.BOX_OF[i] === selBox)) cls += ' peer';
      if (options.highlightSame && selValue && v === selValue) cls += ' same';
      if (conflicts[i]) cls += ' conflict';
      if (wrong && wrong[i]) cls += ' wrong';
      el.className = cls;
      el.tabIndex = (i === selected) ? 0 : -1;

      var value = el.querySelector('.v');
      value.textContent = v ? String(v) : '';
      var notes = el.querySelector('.nt');
      var mask = v ? 0 : state.notes[i];
      notes.style.display = mask ? '' : 'none';
      for (var d = 1; d <= 9; d++) {
        notes.childNodes[d - 1].className = (mask & S.BIT[d]) ? 'on' : '';
      }
      renderCellNotes(el, host, i, hostNoteOpenIndex === i);
      var shared = notesFor(host, i);
      el.setAttribute('aria-label', cellLabel(i, v, mask, conflicts[i], wrong && wrong[i]) +
        (shared.length ? '，有 ' + shared.length + ' 則格子留言' : ''));
    }
    renderStatus();
  }

  function toggleHostCellNotes(index) {
    if (index < 0 || index >= 81) return;
    selected = index;
    hostNoteOpenIndex = hostNoteOpenIndex === index ? -1 : index;
    renderBoard();
    if (cells[index]) cells[index].focus({ preventScroll: true });
    pushHostState();
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
  function resizeBoardIn(screenId, boardId) {
    var screen = q(screenId);
    var board = q(boardId);
    if (!screen || !board) return;
    var wrap = screen.querySelector('.boardwrap');
    if (!wrap) return;
    var w1 = wrap.clientWidth, h1 = wrap.clientHeight;
    if (!w1 || !h1) return;
    var size = Math.max(180, Math.floor(Math.min(w1, h1)) - 2);
    board.style.setProperty('--bs', size + 'px');
  }
  function resizeBoard() { resizeBoardIn('s-game', 'board'); }

  /* ---------- 選格 ---------- */
  function selectCell(index, fromUser) {
    if (index < 0 || index >= 81) return;
    selected = index;
    renderBoard();
    if (cells[index]) cells[index].focus({ preventScroll: true });
    if (fromUser) w.Sound.play('select');
    pushHostState();
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
    pushHostState();
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
    if (host) {
      /* 一間房綁一題：換題目就換一間房，避免觀戰者看到的題目突然變掉 */
      endHostRoom(true);
      hostMode = true;
    }
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
      if (hostMode) openRoom();
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
      pushHostState();
    } else {
      startTimer();
      w.Sound.play('resume');
      say('繼續囉！', 'good');
      pushHostState();
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

  /* ============================================================
   * 線上觀戰與留言
   *
   * 角色只有兩種，權限差很多：
   *   主持人（host）：照常解題，盤面會被推送出去；可以分享／換連結、關房。
   *   觀戰者（watch）：只收盤面、共享格子留言與聊天室；不能填數字、不能用提示、不能改房間設定。
   *
   * 盤面資料一律走 SudokuGame.spectatorSnapshot / spectatorView，
   * 衝突、剩餘數量都由觀戰端用同一份 sudoku.js 算，規則核心沒有第二套。
   * ========================================================== */

  var host = null;         // 開房中：{ code, token, invite, viewers }
  var watch = null;        // 觀戰中：{ code, invite, view, meta, viewers, cellNotes, selected }
  var hostMode = false;    // 難度選擇畫面是否為「開房模式」
  var nick = w.Store.loadNick();
  var watchCells = [];
  var watchTimer = null;
  var watchClock = null;
  var hostNoteOpenIndex = -1;
  var watchNoteOpenIndex = -1;
  var lobbyTimer = null;
  var chatOpen = false;
  var chatUnread = 0;
  var chatSeen = {};
  var chatLastFocus = null;
  var lastWatchValues = '';

  var CONN_TEXT = {
    idle: '尚未連線',
    connecting: '連線中…',
    waking: '伺服器喚醒中…（免費方案冷啟動要十幾秒）',
    open: '已連線',
    retrying: '連線中斷，重試中…',
    failed: '連不上伺服器',
    closed: '房間已關閉'
  };

  function nickOrDefault() { return nick || '路過的觀眾'; }

  /* ---------- 大廳 ---------- */
  function setLobbyState(kind, text) {
    var el = q('lobby-state');
    if (!el) return;
    el.textContent = text;
    el.setAttribute('data-state', kind);
  }

  function renderLobby() {
    var on = w.Online.isEnabled();
    q('lobby-off').hidden = on;
    q('lobby-live').hidden = !on;
    if (!on) {
      q('lobby-off-note').textContent = w.Online.disabledReason();
      stopLobbyAuto();
      return;
    }
    q('lobby-nick').value = nick;
    refreshLobby();
    startLobbyAuto();
  }

  function startLobbyAuto() {
    stopLobbyAuto();
    lobbyTimer = setInterval(function () {
      if (cur === 's-lobby' && w.Online.isEnabled()) refreshLobby(true);
    }, 12000);
  }
  function stopLobbyAuto() {
    if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
  }

  function refreshLobby(quiet) {
    if (!w.Online.isEnabled()) return;
    if (!quiet) setLobbyState('loading', '正在讀取房間列表…');
    w.Online.listRooms(function (err, data) {
      if (cur !== 's-lobby') return;
      if (err) {
        setLobbyState('error', err.message);
        renderRooms(null);
        return;
      }
      renderRooms(data.rooms);
      setLobbyState('ok', '目前有 ' + data.rooms.length + ' 間房間（伺服器上限 ' + data.maxRooms + ' 間）。');
    }, function () {
      if (cur === 's-lobby') setLobbyState('waking', '伺服器好像在睡覺，正在喚醒…免費方案冷啟動大約要十幾秒，請稍等。');
    });
  }

  /* 房間卡片一律用 textContent 塞入使用者資料（暱稱由別人輸入，絕不能碰 innerHTML） */
  function renderRooms(rooms) {
    var host2 = q('roomlist');
    host2.innerHTML = '';
    if (rooms === null) {
      var fail = D.createElement('div');
      fail.className = 'rooms-empty';
      fail.textContent = '暫時拿不到房間列表。可以按上面的「重新整理」再試一次，或直接輸入房號加入。';
      host2.appendChild(fail);
      return;
    }
    if (!rooms.length) {
      var empty = D.createElement('div');
      empty.className = 'rooms-empty';
      empty.textContent = '現在沒有人開房。你可以按「開一間房來解題」，讓別人進來看你解題兼聊天。';
      host2.appendChild(empty);
      return;
    }
    rooms.forEach(function (room) {
      host2.appendChild(roomCard(room));
    });
  }

  function roomCard(room) {
    var card = D.createElement('button');
    card.type = 'button';
    card.className = 'roomcard';
    card.setAttribute('data-code', room.code);

    var code = D.createElement('span');
    code.className = 'rc-code';
    code.textContent = room.code;

    var main = D.createElement('span');
    main.className = 'rc-main';
    var who = D.createElement('span');
    who.className = 'rc-host';
    who.textContent = room.hostName;
    var meta = D.createElement('span');
    meta.className = 'rc-meta';

    function tag(text, cls) {
      var t = D.createElement('span');
      t.className = 'rc-tag' + (cls ? ' ' + cls : '');
      t.textContent = text;
      meta.appendChild(t);
    }
    tag(room.label || room.difficulty || '難度未知');
    tag(room.status === 'done' ? '已完成' : '進行中', room.status === 'done' ? 'done' : 'live');
    if (!room.hostOnline) tag('主持人離線中', 'off');
    tag('👀 ' + room.viewers + ' / ' + room.maxViewers);
    tag('已填 ' + room.filled + ' / ' + room.total);
    tag('⏱ ' + fmtTime(room.elapsedMs));
    tag('開房 ' + agoText(room.createdAt));

    main.appendChild(who);
    main.appendChild(meta);

    var go2 = D.createElement('span');
    go2.className = 'rc-go';
    go2.textContent = room.viewers >= room.maxViewers ? '已滿' : '進去看 ▶';

    var bar = D.createElement('span');
    bar.className = 'rc-bar';
    var fill = D.createElement('i');
    fill.style.width = Math.round((room.total ? room.filled / room.total : 0) * 100) + '%';
    bar.appendChild(fill);

    card.appendChild(code);
    card.appendChild(main);
    card.appendChild(go2);
    card.appendChild(bar);
    card.setAttribute('aria-label',
      '房號 ' + room.code + '，主持人 ' + room.hostName + '，' + (room.label || '') +
      '，' + (room.status === 'done' ? '已完成' : '進行中') +
      '，已填 ' + room.filled + ' 格，共 ' + room.viewers + ' 人觀戰');
    card.addEventListener('click', function () {
      w.Sound.play('click');
      joinRoom(room.code, '');
    });
    return card;
  }

  function agoText(at) {
    var sec = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (sec < 60) return sec + ' 秒前';
    if (sec < 3600) return Math.round(sec / 60) + ' 分鐘前';
    return Math.round(sec / 3600) + ' 小時前';
  }

  /* ---------- 開房（主持人） ---------- */
  function setHostConn(kind, text) {
    var el = q('h-conn');
    if (!el) return;
    el.textContent = text || CONN_TEXT[kind] || kind;
    el.setAttribute('data-state', kind);
  }

  function hostSnapshot() {
    if (!state) return null;
    return G.spectatorSnapshot(state, { selected: selected, paused: paused });
  }

  function onHostState(data) {
    if (!host || !data) return;
    host.cellNotes = normalizeCellNotes(data.cellNotes);
    if (state) renderBoard();
  }

  function onSharedNote(data) {
    if (!data || data.index < 0 || data.index >= 81) return;
    var list = normalizeCellNoteList(data.notes);
    if (host) {
      host.cellNotes[data.index] = list;
      if (state) renderBoard();
    }
    if (watch) {
      watch.cellNotes[data.index] = list;
      renderWatchBoard();
    }
  }

  function pushHostState() {
    if (!host) return;
    var snap = hostSnapshot();
    if (snap) w.Online.pushState(snap);
  }

  function openRoom() {
    if (!state) return;
    if (!w.Online.isEnabled()) {
      hostMode = false;
      toast('目前是單機模式，沒辦法開房。');
      say(w.Online.disabledReason(), 'bad');
      return;
    }
    q('hostbar').hidden = false;
    q('h-code').textContent = '開房中…';
    q('h-viewers').textContent = '👀 0 人觀戰';
    setHostConn('connecting', '開房中…');
    setChatEnabled(false);

    w.Online.createRoom({
      hostName: nickOrDefault(),
      difficulty: state.difficulty,
      label: state.label,
      technique: state.technique,
      seed: state.seed,
      snapshot: hostSnapshot()
    }, function (err, data) {
      if (err) {
        host = null;
        hostMode = false;
        q('hostbar').hidden = true;
        setChatVisible(false);
        say('開房失敗：' + err.message, 'bad');
        toast('開房失敗');
        return;
      }
      host = {
        code: data.code, token: data.hostToken, invite: data.inviteToken, viewers: 0,
        cellNotes: normalizeCellNotes()
      };
      q('h-code').textContent = '房號 ' + host.code;
      resetChat('房號 ' + host.code + '（你是主持人）');
      setChatVisible(true);
      w.Sound.play('join');
      say('房間開好了！房號 ' + host.code + '，按「分享連結」把它傳給朋友，他們就能進來看你解題。', 'good');
      toast('房號 ' + host.code);

      w.Online.connect({
        code: host.code,
        token: host.token,
        on: {
          state: onHostState,
          note: onSharedNote,
          status: function (st, detail) {
            setHostConn(st, CONN_TEXT[st] + (detail && st === 'retrying' ? '（' + detail + '）' : ''));
            setChatEnabled(st === 'open');
          },
          presence: function (p) {
            if (!host) return;
            var before = host.viewers;
            host.viewers = p.viewers;
            q('h-viewers').textContent = '👀 ' + p.viewers + ' 人觀戰';
            if (p.viewers > before) {
              systemChat('有人進來觀戰了，目前 ' + p.viewers + ' 人。');
              w.Sound.playChat();
            } else if (p.viewers < before) {
              systemChat('有人離開了，目前 ' + p.viewers + ' 人。');
            }
          },
          chat: onChatMessage,
          closed: function () {
            systemChat('房間已經關閉。');
            endHostRoom(false);
          }
        }
      });
      w.Online.startStatePush(hostSnapshot);
      pushHostState();
    }, function () {
      setHostConn('waking', CONN_TEXT.waking);
    });
  }

  /* 結束開房。announce=true 代表主動通知伺服器關房。 */
  function endHostRoom(announce) {
    if (!host) return;
    var code = host.code;
    host = null;
    hostMode = false;
    q('hostbar').hidden = true;
    setChatVisible(false);
    setChatOpen(false);
    if (announce) {
      w.Online.closeRoom(function () {});
      toast('房間 ' + code + ' 已關閉');
    } else {
      w.Online.disconnect();
    }
  }

  function shareUrl() {
    if (!host) return '';
    var base = w.location.origin + w.location.pathname;
    var params = [];
    /* 保留目前的 ?server= 覆蓋，不然對方打開連結會連到別台（或單機） */
    var override = /[?&]server=([^&]*)/.exec(w.location.search);
    if (override) params.push('server=' + override[1]);
    params.push('room=' + encodeURIComponent(host.code));
    params.push('invite=' + encodeURIComponent(host.invite));
    return base + '?' + params.join('&');
  }

  function doShare() {
    if (!host) return;
    var url = shareUrl();
    var text = '來看我解數獨！房號 ' + host.code;
    if (w.navigator && typeof w.navigator.share === 'function') {
      w.navigator.share({ title: '數獨小學堂 觀戰', text: text, url: url })
        .then(function () { say('連結已經分享出去了。', 'good'); })
        .catch(function () { copyShare(url); });
      return;
    }
    copyShare(url);
  }

  function copyShare(url) {
    if (w.navigator && w.navigator.clipboard && typeof w.navigator.clipboard.writeText === 'function') {
      w.navigator.clipboard.writeText(url).then(function () {
        toast('連結已複製');
        say('觀戰連結已複製到剪貼簿：' + url, 'good');
      }).catch(function () {
        say('複製失敗，請手動複製這個連結：' + url, 'warn');
      });
      return;
    }
    say('請手動複製這個觀戰連結：' + url, 'warn');
  }

  function doReinvite() {
    if (!host) return;
    w.Online.rotateInvite(function (err, data) {
      if (err) { say('換連結失敗：' + err.message, 'bad'); return; }
      host.invite = data.inviteToken;
      toast('舊連結已失效');
      say('已經產生新的觀戰連結，之前發出去的連結立刻失效（用房號 ' + host.code + ' 還是進得來）。', 'good');
    });
  }

  /* ---------- 觀戰 ---------- */
  function buildWatchBoard() {
    var board = q('watch-board');
    board.innerHTML = '';
    watchCells = [];
    for (var i = 0; i < 81; i++) {
      var r = S.ROW_OF[i], c = S.COL_OF[i];
      var cell = D.createElement('div');
      cell.className = 'cell' + ((c === 2 || c === 5) ? ' br' : '') + ((r === 2 || r === 5) ? ' bb' : '') +
        (c >= 7 ? ' note-right' : '') + (r >= 7 ? ' note-bottom' : '');
      cell.setAttribute('data-i', String(i));
      cell.setAttribute('role', 'gridcell');
      var v = D.createElement('span'); v.className = 'v';
      var nt = D.createElement('span'); nt.className = 'nt';
      for (var d = 1; d <= 9; d++) {
        var n = D.createElement('i');
        n.textContent = String(d);
        nt.appendChild(n);
      }
      cell.appendChild(v);
      cell.appendChild(nt);
      appendSharedNoteChrome(cell);
      board.appendChild(cell);
      watchCells.push(cell);
    }
    board.addEventListener('click', function (e) {
      var noteToggle = e.target.closest ? e.target.closest('.cell-note-corner') : null;
      if (noteToggle) {
        e.preventDefault();
        e.stopPropagation();
        selectWatchCell(parseInt(noteToggle.parentNode.getAttribute('data-i'), 10), true, true);
        return;
      }
      var target = e.target.closest ? e.target.closest('.cell') : null;
      if (!target) return;
      selectWatchCell(parseInt(target.getAttribute('data-i'), 10), true, true);
    });
  }

  function normalizeCellNoteList(raw) {
    var out = [];
    if (!Array.isArray(raw)) return out;
    raw.forEach(function (note) {
      if (!note || typeof note.text !== 'string' || !note.text) return;
      out.push({
        id: String(note.id || ''),
        authorId: String(note.authorId || ''),
        role: note.role === 'host' ? 'host' : 'viewer',
        name: String(note.name || '路過的觀眾'),
        text: note.text.slice(0, 10)
      });
    });
    return out;
  }

  function normalizeCellNotes(raw) {
    var out = [];
    for (var i = 0; i < 81; i++) out[i] = normalizeCellNoteList(raw && raw[i]);
    return out;
  }

  function notesFor(owner, index) {
    return owner && owner.cellNotes && Array.isArray(owner.cellNotes[index])
      ? owner.cellNotes[index] : [];
  }

  function renderCellNotes(el, owner, index, open) {
    var list = notesFor(owner, index);
    var corner = el.querySelector('.cell-note-corner');
    var count = corner.querySelector('.cell-note-count');
    var popover = el.querySelector('.cell-note-popover');
    var items = popover.querySelector('.cell-note-items');
    el.classList.toggle('has-shared-notes', list.length > 0);
    corner.classList.toggle('has-notes', list.length > 0);
    count.textContent = list.length ? String(list.length) : '';
    corner.setAttribute('aria-label', list.length
      ? '查看這格的 ' + list.length + ' 則格子留言'
      : '查看這格的格子留言，目前沒有內容');
    popover.hidden = !open;
    while (items.firstChild) items.removeChild(items.firstChild);
    if (!list.length) {
      var empty = D.createElement('span');
      empty.className = 'cell-note-empty';
      empty.textContent = '目前沒有格子留言';
      items.appendChild(empty);
      return;
    }
    list.forEach(function (note) {
      var row = D.createElement('span');
      row.className = 'cell-note-item';
      var who = D.createElement('b');
      who.textContent = (note.role === 'host' ? '主持人：' : '') + note.name;
      var text = D.createElement('span');
      text.textContent = note.text;
      row.appendChild(who);
      row.appendChild(text);
      items.appendChild(row);
    });
  }

  function noteAuthorId() {
    var me = w.Online.current();
    return me && me.role === 'host' ? 'host' : (me && me.viewerId ? me.viewerId : '');
  }

  function renderWatchNotePanel() {
    var label = q('watch-note-cell');
    var input = q('watch-note-input');
    var listEl = q('watch-note-list');
    if (!label || !input || !listEl) return;
    if (!watch || !watch.view || watch.selected < 0) {
      label.textContent = '尚未選格';
      if (D.activeElement !== input) input.value = '';
      listEl.textContent = '先點盤面上的格子。';
      return;
    }

    var index = watch.selected;
    var list = notesFor(watch, index);
    label.textContent = S.cellName(index);
    if (D.activeElement !== input) {
      input.value = '';
    }
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    if (!list.length) {
      var empty = D.createElement('p');
      empty.className = 'watch-note-empty';
      empty.textContent = '這格目前還沒有格子留言。';
      listEl.appendChild(empty);
      return;
    }
    list.forEach(function (note) {
      var row = D.createElement('div');
      row.className = 'watch-note-item' + (note.authorId === noteAuthorId() ? ' mine' : '');
      var who = D.createElement('b');
      who.textContent = note.name + (note.authorId === noteAuthorId() ? '（你）' : '') +
        (note.role === 'host' ? '（主持人）' : '');
      var text = D.createElement('span');
      text.textContent = note.text;
      row.appendChild(who);
      row.appendChild(text);
      listEl.appendChild(row);
    });
  }

  function renderWatchBoard() {
    if (!watch || !watch.view) return;
    var view = watch.view;
    /* 衝突用同一份 sudoku.js 算，不是伺服器算好送過來的 */
    var conflicts = S.findConflicts(view.values);
    var selValue = watch.selected >= 0 ? view.values[watch.selected] : 0;
    for (var i = 0; i < 81; i++) {
      var el = watchCells[i];
      var v = view.values[i];
      var cls = 'cell';
      if (S.COL_OF[i] === 2 || S.COL_OF[i] === 5) cls += ' br';
      if (S.ROW_OF[i] === 2 || S.ROW_OF[i] === 5) cls += ' bb';
      if (S.COL_OF[i] >= 7) cls += ' note-right';
      if (S.ROW_OF[i] >= 7) cls += ' note-bottom';
      if (view.given[i]) cls += ' given';
      if (i === view.selected) cls += ' sel host-sel';
      if (i === watch.selected) cls += ' watch-sel';
      if (options.highlightSame && selValue && v === selValue) cls += ' same';
      if (conflicts[i]) cls += ' conflict';
      el.className = cls;
      el.tabIndex = i === watch.selected ? 0 : -1;

      el.querySelector('.v').textContent = v ? String(v) : '';
      var notes = el.querySelector('.nt');
      var mask = v ? 0 : view.notes[i];
      notes.style.display = mask ? '' : 'none';
      for (var d = 1; d <= 9; d++) {
        notes.childNodes[d - 1].className = (mask & S.BIT[d]) ? 'on' : '';
      }
      renderCellNotes(el, watch, i, watchNoteOpenIndex === i);
      var shared = notesFor(watch, i);
      el.setAttribute('aria-label', '第 ' + (S.ROW_OF[i] + 1) + ' 列第 ' + (S.COL_OF[i] + 1) + ' 行，' +
        (v ? (view.given[i] ? '題目給的 ' : '') + v : '空格') +
        (shared.length ? '，有 ' + shared.length + ' 則格子留言' : '，可查看或填寫格子留言'));
    }
    renderWatchNotePanel();
  }

  function selectWatchCell(index, fromUser, openNotes) {
    if (!watch || !watch.view || index < 0 || index >= 81) return;
    if (openNotes) {
      watchNoteOpenIndex = watchNoteOpenIndex === index ? -1 : index;
    } else {
      watchNoteOpenIndex = -1;
    }
    watch.selected = index;
    renderWatchBoard();
    if (watchCells[index]) watchCells[index].focus({ preventScroll: true });
    if (fromUser) w.Sound.play('select');
  }

  function moveWatchSelection(dr, dc) {
    if (!watch || !watch.view) return;
    var index = watch.selected >= 0 ? watch.selected : 0;
    var r = S.ROW_OF[index], c = S.COL_OF[index];
    r = Math.min(8, Math.max(0, r + dr));
    c = Math.min(8, Math.max(0, c + dc));
    selectWatchCell(r * 9 + c, true, false);
  }

  function joinRoom(code, invite) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length !== 4) {
      toast('房號要 4 個英數字');
      setLobbyState('error', '房號格式不對：要 4 個英數字，例如 K7Q2。');
      return;
    }
    if (!w.Online.isEnabled()) {
      go('s-lobby');
      renderLobby();
      return;
    }
    leaveWatch(false);
    watch = {
      code: code, invite: invite || '', view: null, meta: null, viewers: 0,
      cellNotes: normalizeCellNotes(), selected: -1
    };
    watchNoteOpenIndex = -1;
    lastWatchValues = '';
    q('w-code').textContent = '房號 ' + code;
    q('w-host').textContent = '主持人 —';
    q('w-diff').textContent = '—';
    q('sum-host').textContent = '—';
    q('sum-diff').textContent = '—';
    q('sum-seed').textContent = '—';
    q('sum-progress').textContent = '—';
    q('sum-activity').textContent = '等待第一筆盤面…';
    hideWatchOverlay();
    resetChat('房號 ' + code);
    setChatVisible(true);
    setChatEnabled(false);
    setWatchFeedback('正在連線到房間 ' + code + '…', '');
    go('s-watch');

    w.Online.connect({
      code: code,
      name: nickOrDefault(),
      invite: invite,
      on: {
        status: onWatchStatus,
        state: onWatchState,
        note: onSharedNote,
        chat: onChatMessage,
        presence: function (p) {
          if (!watch) return;
          watch.viewers = p.viewers;
          q('w-viewers').textContent = String(p.viewers);
          q('w-host').textContent = '主持人 ' + p.hostName;
          q('sum-host').textContent = p.hostName + (p.hostOnline ? '' : '（離線中）');
        },
        closed: function (data) {
          var why = data && data.reason;
          showWatchOverlay('closed',
            why === 'idle' ? '房間閒置太久被回收了。'
              : why === 'hostgone' ? '主持人離線超過寬限期，房間已經關閉。'
                : why === 'shutdown' ? '伺服器正在重新啟動，房間都被關掉了。'
                  : why === 'gone' ? '這個房間已經不存在了。'
                    : '主持人結束了這個房間。');
        }
      }
    });
  }

  function onWatchStatus(st, detail) {
    setChatConn(st, detail);
    q('sum-conn').textContent = CONN_TEXT[st] || st;
    var live = q('w-live');
    if (live) live.setAttribute('data-state', st === 'open' ? '' : st);
    setChatEnabled(st === 'open');
    setWatchNoteEnabled(st === 'open');
    if (st === 'failed') {
      showWatchOverlay('failed', detail || '連不上伺服器。可能是網路斷了，或伺服器正在休眠。');
    } else if (st === 'open') {
      hideWatchOverlay();
      setWatchFeedback('觀戰中：主持人的盤面唯讀；你可以點格子填格子留言，大家都看得到。', 'good');
    } else if (st === 'retrying' || st === 'waking' || st === 'connecting') {
      setWatchFeedback(CONN_TEXT[st], 'warn');
    }
  }

  function onWatchState(data) {
    if (!watch) return;
    var view = G.spectatorView(data.board);
    if (!view) return;
    var prev = lastWatchValues;
    watch.meta = data;
    watch.view = view;
    watch.cellNotes = normalizeCellNotes(data.cellNotes);
    if (!watchCells.length) buildWatchBoard();
    renderWatchBoard();
    resizeWatchBoard();

    q('w-host').textContent = '主持人 ' + data.hostName;
    q('w-diff').textContent = data.label || data.difficulty || '—';
    q('w-code').textContent = '房號 ' + data.code;
    q('w-left').textContent = String(view.remaining);
    q('w-hint').textContent = String(view.hintsUsed);
    q('w-miss').textContent = String(view.mistakes);
    q('w-viewers').textContent = String(data.viewers);

    q('sum-host').textContent = data.hostName + (data.hostOnline ? '' : '（離線中）');
    q('sum-diff').textContent = (data.label || data.difficulty || '—') + (data.technique ? '（' + data.technique + '）' : '');
    q('sum-seed').textContent = data.seed || '—';
    q('sum-progress').textContent = '已填 ' + view.filled + ' / ' + view.total + ' 格，還剩 ' + view.remaining + ' 格';
    q('sum-role').textContent = view.status === 'won' ? '觀戰中（這局已完成）' : '觀戰中（盤面唯讀）';

    var values = G.gridToString(view.values);
    q('sum-activity').textContent = describeChange(prev, values, view);
    lastWatchValues = values;

    startWatchClock(view);
    if (view.status === 'won') {
      setWatchFeedback('主持人完成了這一題！用了 ' + fmtTime(view.elapsedMs) + '，提示 ' + view.hintsUsed + ' 次。', 'good');
      stopWatchClock();
    }
  }

  function setWatchNoteEnabled(on) {
    var input = q('watch-note-input');
    var button = q('b-watch-note');
    if (input) input.disabled = !on;
    if (button) button.disabled = !on;
    if (button) setTimeout(function () { w.UI.paint(button); }, 0);
  }

  function submitWatchNote() {
    if (!watch || !watch.view || watch.selected < 0) {
      setWatchFeedback('請先點一格，再輸入格子留言。', 'warn');
      return;
    }
    var input = q('watch-note-input');
    var text = input.value;
    if (text.length > 10) {
      setWatchFeedback('每則格子留言最多 10 個字。', 'bad');
      return;
    }
    if (!text.trim()) {
      setWatchFeedback('請輸入留言內容；每次送出都會新增一則。', 'warn');
      return;
    }
    setWatchNoteEnabled(false);
    setWatchFeedback('格子留言送出中…', '');
    w.Online.sendNote(watch.selected, text, nickOrDefault(), function (err) {
      var open = w.Online.connState() === 'open';
      setWatchNoteEnabled(open);
      if (err) {
        setWatchFeedback('格子留言沒有送出去：' + err.message, 'bad');
        w.Sound.play('blocked');
        return;
      }
      input.value = '';
      renderWatchNotePanel();
      setWatchFeedback('格子留言已新增，玩家和其他觀戰者都看得到。', 'good');
      w.Sound.play('note');
    });
  }

  /* 比對前後兩份盤面，用一句話說明主持人剛剛做了什麼 */
  function describeChange(before, after, view) {
    if (view.status === 'won') return '已經完成整題！';
    if (view.paused) return '主持人暫停了，盤面先停在這裡。';
    if (!before || before === after) {
      return view.selected >= 0 ? ('正在看 ' + S.cellName(view.selected) + '。') : '正在思考…';
    }
    for (var i = 0; i < 81; i++) {
      if (before.charAt(i) !== after.charAt(i)) {
        var now = after.charAt(i);
        return now === '0'
          ? ('把 ' + S.cellName(i) + ' 清掉了。')
          : ('在 ' + S.cellName(i) + ' 填了 ' + now + '。');
      }
    }
    return '調整了筆記。';
  }

  function startWatchClock(view) {
    stopWatchClock();
    watchClock = { base: view.elapsedMs, at: Date.now(), running: view.status === 'playing' && !view.paused };
    q('w-time').textContent = fmtTime(view.elapsedMs);
    if (!watchClock.running) return;
    watchTimer = setInterval(function () {
      if (!watchClock || cur !== 's-watch') return;
      q('w-time').textContent = fmtTime(watchClock.base + (Date.now() - watchClock.at));
    }, 1000);
  }
  function stopWatchClock() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }

  function setWatchFeedback(text, kind) {
    var el = q('w-feedback');
    if (!el) return;
    el.textContent = text;
    el.className = 'feedback' + (kind ? ' ' + kind : '');
  }

  function showWatchOverlay(kind, note) {
    var ov = q('watch-overlay');
    stopWatchClock();
    q('watch-ov-face').textContent = kind === 'failed' ? '📡' : '📴';
    q('watch-ov-title').textContent = kind === 'failed' ? '連不上房間' : '房間已關閉';
    q('watch-ov-note').textContent = note || '';
    q('b-watch-retry').hidden = false;
    ov.classList.add('on');
    ov.setAttribute('aria-hidden', 'false');
    setChatEnabled(false);
    setTimeout(function () { var b = q('watch-ov-box'); if (b) b.focus(); }, 20);
    w.Sound.play('leave');
  }
  function hideWatchOverlay() {
    var ov = q('watch-overlay');
    ov.classList.remove('on');
    ov.setAttribute('aria-hidden', 'true');
  }

  function leaveWatch(goLobby) {
    if (watch) {
      w.Online.disconnect();
      watch = null;
    }
    stopWatchClock();
    watchClock = null;
    hideWatchOverlay();
    setChatVisible(false);
    setChatOpen(false);
    if (goLobby) go('s-lobby');
  }

  /* ---------- 留言板 ---------- */
  function setChatVisible(on) {
    var fab = q('b-chat');
    fab.hidden = !on;
    if (!on) {
      q('chat-panel').classList.remove('open');
      q('chat-panel').setAttribute('aria-hidden', 'true');
      q('chat-backdrop').hidden = true;
      fab.classList.remove('chat-fab-hidden');
      fab.tabIndex = 0;
      chatOpen = false;
    }
    setTimeout(function () { if (on) w.UI.paint(fab); }, 0);
  }

  function setChatOpen(on) {
    var panel = q('chat-panel');
    var fab = q('b-chat');
    var wasOpen = chatOpen;
    chatOpen = !!on && !fab.hidden;
    panel.classList.toggle('open', chatOpen);
    panel.setAttribute('aria-hidden', chatOpen ? 'false' : 'true');
    fab.setAttribute('aria-expanded', chatOpen ? 'true' : 'false');
    fab.classList.toggle('chat-fab-hidden', chatOpen);
    fab.tabIndex = chatOpen ? -1 : 0;
    /* 遮罩只在窄版出現（CSS 決定是否顯示成整片），寬版點外面也不會誤關 */
    q('chat-backdrop').hidden = !chatOpen || w.innerWidth > 560;
    if (chatOpen) {
      chatUnread = 0;
      updateChatBadge();
      if (!wasOpen) chatLastFocus = fab;
      var log = q('chat-log');
      log.scrollTop = log.scrollHeight;
      q('chat-close').focus();
      setTimeout(function () { w.UI.repaintAll(panel); }, 20);
    } else if (chatLastFocus && chatLastFocus.focus) {
      try { chatLastFocus.focus(); } catch (e) {}
      chatLastFocus = null;
    }
  }

  function updateChatBadge() {
    var badge = q('chat-badge');
    badge.hidden = chatUnread <= 0;
    badge.textContent = chatUnread > 99 ? '99+' : String(chatUnread);
    q('b-chat').setAttribute('aria-label', chatUnread > 0
      ? ('開啟房間留言板，有 ' + chatUnread + ' 則新訊息')
      : '開啟房間留言板');
  }

  function resetChat(roomLabel) {
    chatSeen = {};
    chatUnread = 0;
    updateChatBadge();
    q('chat-room').textContent = roomLabel || '';
    var log = q('chat-log');
    log.innerHTML = '';
    var hint = D.createElement('p');
    hint.className = 'chat-empty';
    hint.textContent = '這裡是房間留言板，房間關掉之後訊息就不會保留。禮貌一點，大家都看得到。';
    log.appendChild(hint);
    setChatNote('最多 120 字，送太快會被伺服器擋下來。', false);
  }

  function setChatConn(kind, detail) {
    var el = q('chat-conn');
    if (!el) return;
    el.setAttribute('data-state', kind);
    el.textContent = (CONN_TEXT[kind] || kind) + (detail && kind === 'retrying' ? '（' + detail + '）' : '');
  }

  function setChatNote(text, bad) {
    var el = q('chat-note');
    el.textContent = text;
    el.className = 'chat-note' + (bad ? ' bad' : '');
  }

  function setChatEnabled(on) {
    q('chat-input').disabled = !on;
    q('b-chat-send').disabled = !on;
    setTimeout(function () { w.UI.paint(q('b-chat-send')); }, 0);
  }

  function chatLogEl() {
    var log = q('chat-log');
    var empty = log.querySelector('.chat-empty');
    if (empty) log.removeChild(empty);
    return log;
  }

  function systemChat(text) {
    var log = chatLogEl();
    var box = D.createElement('div');
    box.className = 'chat-msg system';
    var tx = D.createElement('span');
    tx.className = 'tx';
    tx.textContent = text;
    box.appendChild(tx);
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }

  function onChatMessage(msg) {
    if (!msg || chatSeen[msg.id]) return;
    chatSeen[msg.id] = true;
    var me = w.Online.current();
    var mine = !!(me && ((me.role === 'host' && msg.role === 'host') ||
      (me.role === 'viewer' && msg.role === 'viewer' && msg.name === nickOrDefault())));

    var log = chatLogEl();
    var box = D.createElement('div');
    box.className = 'chat-msg' + (msg.role === 'host' ? ' host' : '') + (mine ? ' me' : '');
    var who = D.createElement('span');
    who.className = 'who';
    /* 使用者輸入一律 textContent，絕不用 innerHTML */
    who.textContent = msg.name + (msg.role === 'host' ? '（主持人）' : '');
    var tx = D.createElement('span');
    tx.className = 'tx';
    tx.textContent = msg.text;
    box.appendChild(who);
    box.appendChild(tx);
    log.appendChild(box);

    var near = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
    if (near || mine) log.scrollTop = log.scrollHeight;

    if (!mine) {
      if (!chatOpen) { chatUnread++; updateChatBadge(); }
      w.Sound.playChat();
    }
  }

  function submitChat() {
    var input = q('chat-input');
    var text = input.value.trim();
    if (!text) { setChatNote('先寫點東西再送出。', true); return; }
    setChatEnabled(false);
    setChatNote('送出中…', false);
    w.Online.sendChat(text, nickOrDefault(), function (err) {
      var open = w.Online.connState() === 'open';
      setChatEnabled(open);
      if (err) {
        setChatNote('沒送出去：' + err.message, true);
        w.Sound.play('blocked');
        return;
      }
      input.value = '';
      setChatNote('最多 120 字，送太快會被伺服器擋下來。', false);
      if (open) input.focus();
    });
  }

  /* ---------- 觀戰盤面尺寸 ---------- */
  function resizeWatchBoard() {
    resizeBoardIn('s-watch', 'watch-board');
  }

  /* ---------- 深連結：?room=XXXX&invite=... ---------- */
  function deepLinkRoom() {
    var m = /[?&]room=([A-Za-z0-9]{1,8})/.exec(w.location.search);
    if (!m) return false;
    var invite = '';
    var mi = /[?&]invite=([^&]*)/.exec(w.location.search);
    if (mi) { try { invite = decodeURIComponent(mi[1]); } catch (e) { invite = mi[1]; } }
    if (!w.Online.isEnabled()) {
      go('s-lobby');
      renderLobby();
      return true;
    }
    joinRoom(m[1], invite);
    return true;
  }

  /* ---------- 綁定 ---------- */
  function bindOnline() {
    q('b-online').addEventListener('click', function () {
      w.Sound.play('click');
      go('s-lobby');
    });
    q('b-lobby-refresh').addEventListener('click', function () {
      w.Sound.play('click');
      refreshLobby();
    });
    q('b-lobby-host').addEventListener('click', function () {
      w.Sound.play('click');
      setHostMode(true);
      markDiff(pendingDifficulty);
      go('s-setup');
    });
    q('b-lobby-join').addEventListener('click', function () {
      w.Sound.play('click');
      joinRoom(q('lobby-code').value, '');
    });
    q('lobby-code').addEventListener('input', function (e) {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });
    q('lobby-code').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); joinRoom(e.target.value, ''); }
    });
    q('lobby-nick').addEventListener('input', function (e) {
      nick = w.Store.normalizeNick(e.target.value);
      w.Store.saveNick(nick);
    });

    q('b-share').addEventListener('click', function () { w.Sound.play('click'); doShare(); });
    q('b-reinvite').addEventListener('click', function () { w.Sound.play('click'); doReinvite(); });
    q('b-close-room').addEventListener('click', function () {
      w.Sound.play('click');
      endHostRoom(true);
      say('觀戰房間已經關閉，你可以繼續自己解這一題。', 'good');
    });

    q('b-watch-leave').addEventListener('click', function () { w.Sound.play('click'); leaveWatch(true); });
    q('b-watch-lobby').addEventListener('click', function () { w.Sound.play('click'); leaveWatch(true); });
    q('b-watch-retry').addEventListener('click', function () {
      w.Sound.play('click');
      if (!watch) { go('s-lobby'); return; }
      joinRoom(watch.code, watch.invite);
    });
    q('watch-note-form').addEventListener('submit', function (e) {
      e.preventDefault();
      submitWatchNote();
    });

    q('b-sum-toggle').addEventListener('click', function () {
      var box = q('w-summary');
      var open = box.classList.toggle('collapsed');
      q('b-sum-toggle').setAttribute('aria-expanded', open ? 'false' : 'true');
      q('b-sum-toggle').textContent = open ? '展開' : '收合';
      w.Sound.play('click');
      setTimeout(resizeWatchBoard, 30);
    });

    q('b-chat').addEventListener('click', function () { w.Sound.play('click'); setChatOpen(!chatOpen); });
    q('chat-close').addEventListener('click', function () { w.Sound.play('click'); setChatOpen(false); });
    q('chat-backdrop').addEventListener('click', function () { setChatOpen(false); });
    q('chat-form').addEventListener('submit', function (e) { e.preventDefault(); submitChat(); });

    /* 離開分頁前把房間收乾淨，別留下殭屍房 */
    w.addEventListener('pagehide', function () {
      if (host) w.Online.closeRoom(function () {});
      else if (watch) w.Online.disconnect();
    });
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
    q('settings-chatcue').checked = w.Sound.isChatCueOn();
    q('settings-nick').value = nick;
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
    return qa('button, input, summary, [tabindex]:not([tabindex="-1"])', root).filter(function (el) {
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
      /* 彈窗原本是 display:none，立體按鈕量不到尺寸，開啟後補畫一次 */
      w.UI.repaintAll(q('settings-panel'));
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
    q('settings-chatcue').addEventListener('change', function (e) { w.Sound.setChatCue(e.target.checked); });
    q('settings-nick').addEventListener('input', function (e) {
      nick = w.Store.normalizeNick(e.target.value);
      w.Store.saveNick(nick);
      var lobbyNick = q('lobby-nick');
      if (lobbyNick) lobbyNick.value = nick;
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
      setHostMode(false);
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
      if (host) endHostRoom(true);
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
      if (host) endHostRoom(true);
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
    q('b-home2').addEventListener('click', function () {
      w.Sound.play('click');
      if (host) endHostRoom(true);
      setHostMode(false);
      go('s-home');
    });

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
    q('b-tut-play').addEventListener('click', function () { w.Sound.play('click'); setHostMode(false); startNewGame('beginner', ''); });

    /* 鍵盤操作 */
    D.addEventListener('keydown', function (e) {
      if (isSettingsOpen()) {
        if (e.key === 'Escape') { e.preventDefault(); setSettingsOpen(false); }
        return;
      }
      /* 在留言板或任何文字欄位打字時，不可以把按鍵當成盤面操作 */
      var ae = D.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape' && chatOpen) { e.preventDefault(); setChatOpen(false); }
        return;
      }
      if (e.key === 'Escape' && chatOpen) { e.preventDefault(); setChatOpen(false); return; }
      if (cur === 's-watch') {
        if (!watch || watch.selected < 0) return;
        switch (e.key) {
          case 'ArrowUp': e.preventDefault(); moveWatchSelection(-1, 0); break;
          case 'ArrowDown': e.preventDefault(); moveWatchSelection(1, 0); break;
          case 'ArrowLeft': e.preventDefault(); moveWatchSelection(0, -1); break;
          case 'ArrowRight': e.preventDefault(); moveWatchSelection(0, 1); break;
          case 'Enter': case ' ': e.preventDefault(); selectWatchCell(watch.selected, true, true); break;
          case 'Escape': e.preventDefault(); watchNoteOpenIndex = -1; renderWatchBoard(); break;
          default: break;
        }
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
        resizeWatchBoard();
        if (chatOpen) setChatOpen(true);
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

  function setHostMode(on) {
    hostMode = !!on;
    q('setup-online').hidden = !hostMode;
    w.UI.setLabel(q('b-start'), hostMode ? '開房並開始 ▶' : '出題開始 ▶');
    setTimeout(function () { w.UI.paint(q('b-start')); }, 20);
  }

  function markDiff(v) {
    pendingDifficulty = S.PRESETS[v] ? v : 'beginner';
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
    buildWatchBoard();
    bind();
    bindSettings();
    bindOnline();
    applyOptions();
    markDiff(pendingDifficulty);
    refreshHome();
    renderTutorial();
    updateChatBadge();
    setChatVisible(false);
    /* 有 ?room=XXXX 就直接進觀戰，沒有就照常回主選單 */
    if (!deepLinkRoom()) go('s-home');
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
