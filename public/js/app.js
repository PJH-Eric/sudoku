/* ===== app.js — 畫面切換、盤面繪製、輸入與設定彈窗 =====
 * 這一層只負責「呈現與輸入」：所有規則判斷都交給 sudoku.js / game.js，
 * 所有儲存都交給 storage.js，所有聲音都交給 audio.js。
 */
(function (w) {
  'use strict';
  var D = document;
  var S = w.Sudoku;
  var G = w.SudokuGame;

  function tr(key, params) { return w.I18N.t(key, params); }
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
  var roomInfoLastFocus = null;
  var roomInfoHistory = false;
  var pauseLastFocus = null;
  var cells = [];
  var padButtons = [];
  var pendingDifficulty = w.Store.loadLastDifficulty() || 'beginner';
  var tutStep = 0;

  function diffLabel(d) { return S.PRESETS[d] ? tr('diff.' + d) : (d || ''); }
  function techName(name) { return S.techLabel ? S.techLabel(name) : (name || ''); }
  /* 玩家輸入的暱稱不翻譯；只有「沒填暱稱時的預設名」依語言顯示 */
  var DEFAULT_NICKS = { '路過的觀眾': 'nick.default', '匿名主持人': 'nick.anonHost' };
  function displayName(name) { return DEFAULT_NICKS[name] ? tr(DEFAULT_NICKS[name]) : name; }

  /* ---------- 純文字教學（字典在 locales.js：tut.<段>.title / tut.<段>.<行>） ---------- */
  var TUT_LINES = [3, 4, 4, 4, 3, 3, 5];

  /* ---------- 小工具 ---------- */
  function fmtTime(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(total / 60), s = total % 60;
    var h = Math.floor(m / 60);
    if (h > 0) return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  var lastSay = null;   // 靜態訊息記下 key，切換語言時可以重畫
  function say(message, kind) {
    var host = q('feedback');
    lastSay = null;
    if (!host) return;
    host.textContent = message;
    host.className = 'feedback' + (kind ? ' ' + kind : '');
  }
  function sayKey(key, params, kind) {
    say(tr(key, params), kind);
    lastSay = { key: key, params: params, kind: kind };
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
    if (w.ServerOutage) w.ServerOutage.setScreen(id);
    if (cur === 's-game' && id !== 's-game') stopTimer();
    if (cur === 's-lobby' && id !== 's-lobby') stopLobbyAuto();
    qa('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    cur = id;
    if (w.NetworkLatency) w.NetworkLatency.setActive((id === 's-game' && hostMode && state && state.status === 'playing') || (id === 's-watch' && !!(watch && watch.view && watch.view.status === 'playing')));
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
      w.UI.setLabel(btn, '<span class="ico">▶</span>' + tr('menu.continueDiff', { d: diffLabel(saved.difficulty) }));
      setTimeout(function () { w.UI.paint(btn); }, 0);
    } else {
      btn.hidden = true;
    }
    /* 第一次進來才主動提示教學，熟練的玩家不會被打擾 */
    var firstTime = !w.Store.hasSeenHelp();
    var helpBtn = q('b-help');
    w.UI.setColor(helpBtn, firstTime ? 'lemon' : 'sky');
    q('home-note').textContent = !w.Store.available
      ? tr('home.noteNoStorage')
      : (firstTime ? tr('home.noteFirst') : tr('home.noteReturn'));
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
    corner.setAttribute('aria-label', tr('cell.noteView'));
    var count = D.createElement('span');
    count.className = 'cell-note-count';
    corner.appendChild(count);

    var popover = D.createElement('span');
    popover.className = 'cell-note-popover';
    popover.hidden = true;
    popover.setAttribute('role', 'status');
    var title = D.createElement('b');
    title.className = 'cell-note-popover-title';
    title.textContent = tr('cell.noteTitle');
    var items = D.createElement('span');
    items.className = 'cell-note-items';
    popover.appendChild(title);
    popover.appendChild(items);

    cell.appendChild(corner);
    cell.appendChild(popover);
  }

  function bindTouchCellNotes(board) {
    var timer = null;
    var touchInput = false;
    var held = false;
    var origin = null;
    function cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
    board.addEventListener('pointerdown', function (e) {
      cancel();
      touchInput = e.pointerType === 'touch' || e.pointerType === 'pen';
      held = false;
      var cell = e.target.closest ? e.target.closest('.cell') : null;
      if (!touchInput || !e.isPrimary || !cell || paused || cur !== 's-game') return;
      origin = { x: e.clientX, y: e.clientY };
      timer = setTimeout(function () {
        timer = null;
        if (paused || cur !== 's-game') return;
        held = true;
        toggleHostCellNotes(parseInt(cell.getAttribute('data-i'), 10));
      }, 500);
    });
    board.addEventListener('pointermove', function (e) {
      if (origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 10) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
      board.addEventListener(name, cancel);
    });
    board.addEventListener('click', function (e) {
      if (!held) return;
      held = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    board.addEventListener('contextmenu', function (e) { if (touchInput) e.preventDefault(); });
    w.addEventListener('blur', cancel);
    D.addEventListener('visibilitychange', cancel);
    return function (e) {
      return e.pointerType === 'touch' || e.pointerType === 'pen' || (e.detail > 0 && touchInput);
    };
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
    var isTouchClick = bindTouchCellNotes(board);
    var touchHintShown = false;
    board.addEventListener('click', function (e) {
      var noteToggle = e.target.closest ? e.target.closest('.cell-note-corner') : null;
      if (noteToggle && !isTouchClick(e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleHostCellNotes(parseInt(noteToggle.parentNode.getAttribute('data-i'), 10));
        return;
      }
      var target = e.target.closest ? e.target.closest('.cell') : null;
      if (!target) return;
      selectCell(parseInt(target.getAttribute('data-i'), 10), true);
      if (noteToggle && !touchHintShown) {
        touchHintShown = true;
        toast(tr('cell.noteHold'));
      }
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
      b.setAttribute('aria-label', tr('pad.fill', { d: d }));
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
      el.setAttribute('aria-selected', i === selected ? 'true' : 'false');

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
        (shared.length ? tr('sep.comma') + tr('cell.shared', { n: shared.length }) : ''));
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
    var sep = tr('sep.comma');
    var pos = tr('cell.pos', { r: S.ROW_OF[i] + 1, c: S.COL_OF[i] + 1 });
    if (v) {
      return pos + sep + (state.given[i] ? tr('cell.givenPrefix') : '') + v +
        (conflict ? sep + tr('cell.conflict') : '') + (isWrong ? sep + tr('cell.wrong') : '');
    }
    if (mask) return pos + sep + tr('cell.empty') + sep + tr('cell.notes', { list: S.maskToDigits(mask).join(tr('sep.list')) });
    return pos + sep + tr('cell.empty');
  }

  function renderStatus() {
    if (!state) return;
    var left = G.remaining(state);
    q('st-left').textContent = String(left);
    q('st-hint').textContent = String(state.hintsUsed);
    q('st-miss').textContent = String(state.mistakes);
    q('st-time').textContent = fmtTime(state.elapsedMs);
    q('g-diff').textContent = S.PRESETS[state.difficulty] ? diffLabel(state.difficulty) : (state.label || '');
    q('g-seed').textContent = tr('game.seed', { seed: state.seed });
    q('g-tech').textContent = techName(state.technique);
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
      btn.setAttribute('aria-label', tr(noteMode ? 'pad.note' : 'pad.fill', { d: d }) +
        tr('sep.comma') + (rest > 0 ? tr('pad.left', { n: rest }) : tr('pad.done')));
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
    if (screenId === 's-game' && w.matchMedia('(orientation:portrait)').matches) {
      var body = screen.querySelector('.gamebody');
      var bodyStyle = w.getComputedStyle(body);
      var screenStyle = w.getComputedStyle(screen);
      h1 = screen.clientHeight - screen.querySelector('.gtop').offsetHeight -
        screen.querySelector('.gfoot').offsetHeight - screen.querySelector('.padwrap').offsetHeight -
        parseFloat(bodyStyle.paddingTop) - parseFloat(bodyStyle.paddingBottom) -
        parseFloat(bodyStyle.rowGap) - parseFloat(screenStyle.paddingTop) - parseFloat(screenStyle.paddingBottom);
      var boardSize = Math.max(180, Math.floor(Math.min(w1, h1)) - 2);
      wrap.style.setProperty('--board-size', boardSize + 'px');
    } else {
      wrap.style.removeProperty('--board-size');
    }
    if (!w1 || !h1) return;
    var size = Math.max(180, Math.floor(Math.min(w1, h1)) - 2);
    board.style.setProperty('--bs', size + 'px');
  }
  function resizeBoard() {
    resizeBoardIn('s-game', 'board');
    var screen = q('s-game');
    if (!screen || !screen.classList.contains('active')) return;
    var boardLeft = q('board').getBoundingClientRect().left;
    var topLeft = screen.querySelector('.gtop').getBoundingClientRect().left;
    screen.style.setProperty('--board-left', Math.max(0, boardLeft - topLeft) + 'px');
  }

  /* ---------- 選格 ---------- */
  function selectCell(index, fromUser) {
    if (index < 0 || index >= 81) return;
    hostNoteOpenIndex = -1;
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
      sayKey('msg.pickCell', null, 'bad');
      toast(tr('toast.pickCell'));
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
      sayKey('msg.pickCellErase', null, 'bad');
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
    w.UI.setColor(b, noteMode ? 'grape' : 'sky');
    q('note-tag').textContent = noteMode ? tr('common.on') : tr('common.off');
    sayKey(noteMode ? 'msg.noteModeOn' : 'msg.noteModeOff', null, 'good');
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
  function startNewGame(difficulty, seed, keepHostRoom) {
    var reuseRoom = !!keepHostRoom && !!host;
    if (host && !reuseRoom) {
      /* 換難度或從其他流程開新題目時，仍維持一間房只對應一題。 */
      endHostRoom(true);
      hostMode = true;
    }
    if (reuseRoom) {
      /* 換題期間先停掉舊題目的定時推送，避免把上一局快照送回伺服器。 */
      w.Online.stopStatePush();
      host.cellNotes = normalizeCellNotes();
      hostNoteOpenIndex = -1;
    }
    pendingDifficulty = difficulty;
    w.Store.saveLastDifficulty(difficulty);
    q('loading-note').textContent = tr('loading.noteDiff', { d: diffLabel(difficulty) });
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
        q('error-note').textContent = tr('error.noteLong');
        go('s-error');
        return;
      }
      state = G.fromPuzzle(puzzle, { autoClearNotes: options.autoClearNotes });
      beginGame(true);
      if (reuseRoom && host) {
        restartHostRoom();
      } else if (hostMode) {
        openRoom();
      }
    }, 40);
  }

  function restartHostRoom() {
    if (!host || !state) return;
    var code = host.code;
    setHostConn('connecting', 'conn.syncing');
    w.Online.restartRoom({
      difficulty: state.difficulty,
      label: state.label,
      technique: state.technique,
      seed: state.seed,
      snapshot: hostSnapshot()
    }, function (err) {
      if (!host || host.code !== code) return;
      if (err) {
        say(tr('room.restartFail', { msg: err.message }), 'bad');
        toast(tr('toast.restartFail'));
        endHostRoom(false);
        return;
      }
      setHostConn('open');
      sayKey('room.restartOk', { code: code }, 'good');
      w.Online.startStatePush(hostSnapshot);
    });
  }

  function beginGame(isNew) {
    if (isNew) GameAnalytics.start({ mode: 'solo', difficulty: state.difficulty, players: 1 });
    paused = false;
    q('pause-overlay').classList.remove('on');
    q('pause-overlay').setAttribute('aria-hidden', 'true');
    q('b-room-info').hidden = !hostMode;
    q('b-room-info').setAttribute('aria-expanded', 'false');
    toggleNoteMode(false);
    q('s-game').classList.toggle('hosting-room', hostMode);
    selected = firstEmpty();
    renderBoard();
    go('s-game');
    resizeBoard();
    saveNow();
    if (isNew) {
      w.Sound.play('start');
      sayKey('msg.newPuzzle', null, 'good');
    } else {
      sayKey('msg.resumed', null, 'good');
    }
    if (w.Sound.isMusicOn()) w.Sound.startBgm('game');
  }

  function continueSaved() {
    var data = w.Store.loadGame();
    var restored = data ? G.deserialize(data) : null;
    if (!restored) {
      w.Store.clearGame();
      toast(tr('toast.noSaved'));
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
      sayKey('msg.paused', null, 'good');
      pushHostState();
    } else {
      startTimer();
      w.Sound.play('resume');
      sayKey('msg.resumedPlay', null, 'good');
      pushHostState();
      if (pauseLastFocus && pauseLastFocus.focus) pauseLastFocus.focus();
      pauseLastFocus = null;
    }
  }

  /* ---------- 結算 ---------- */
  function finishGame() {
    GameAnalytics.end({ result: 'win' });
    stopTimer();
    w.Store.clearGame();
    w.Sound.play('win');
    w.Sound.vibrate([24, 60, 24, 60, 40]);
    var rec = w.Store.recordWin(state.difficulty, state.elapsedMs, {
      hints: state.hintsUsed, mistakes: state.mistakes, seed: state.seed
    });
    lastRec = rec;
    renderResult();
    go('s-result');
  }

  var lastRec = null;
  /* 結算畫面的文字：切換語言時用同一份資料重畫 */
  function renderResult() {
    if (!state || !lastRec) return;
    var rec = lastRec;
    q('res-trophy').innerHTML = w.UI.trophy();
    q('res-title').textContent = rec.isNew ? tr('result.titleNew') : tr('result.title');
    q('res-sub').textContent = tr('result.sub');
    var rows = [
      [tr('result.diff'), tr('result.diffVal', { d: S.PRESETS[state.difficulty] ? diffLabel(state.difficulty) : (state.label || ''), t: techName(state.technique) })],
      [tr('result.time'), fmtTime(state.elapsedMs)],
      [tr('result.hints'), tr('result.times', { n: state.hintsUsed })],
      [tr('result.misses'), tr('result.times', { n: state.mistakes })],
      [tr('result.seed'), state.seed],
      [tr('result.best'), fmtTime(rec.best) + (rec.isNew ? tr('result.thisRun') : '')],
      [tr('result.total'), tr('result.puzzles', { n: rec.count })]
    ];
    q('res-stats').innerHTML = rows.map(function (r, i) {
      return '<div class="row' + (rec.isNew && i === 5 ? ' best' : '') + '"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
    }).join('');
  }

  /* ---------- 我的紀錄 ---------- */
  function renderStats() {
    var best = w.Store.loadBest();
    var host = q('ranklist');
    var html = '';
    S.DIFFICULTIES.forEach(function (d) {
      var b = best[d];
      var count = best[d + '_count'] || 0;
      html += '<div class="rankgrp"><h4>' + diffLabel(d) + '</h4>';
      if (b) {
        html += '<div class="r"><span>' + tr('stats.bestTime') + '</span><b>' + fmtTime(b.ms) + '</b></div>';
        html += '<div class="r"><span>' + tr('stats.hintsMiss') + '</span><b>' + (b.hints | 0) + ' / ' + (b.mistakes | 0) + '</b></div>';
        html += '<div class="r"><span>' + tr('result.seed') + '</span><b>' + (b.seed || '—') + '</b></div>';
      } else {
        html += '<div class="r empty-row"><span>' + tr('stats.none') + '</span><b>—</b></div>';
      }
      html += '<div class="r"><span>' + tr('result.total') + '</span><b>' + tr('result.puzzles', { n: count }) + '</b></div>';
      html += '</div>';
    });
    host.innerHTML = html;
  }

  /* ---------- 教學 ---------- */
  function renderTutorial() {
    var total = TUT_LINES.length;
    q('tut-progress').textContent = tr('tut.progress', { n: tutStep + 1, total: total });
    q('tut-title').textContent = tr('tut.' + tutStep + '.title');
    var paras = [];
    for (var li = 0; li < TUT_LINES[tutStep]; li++) paras.push('<p>' + tr('tut.' + tutStep + '.' + li) + '</p>');
    q('tut-body').innerHTML = paras.join('');
    q('b-tut-prev').disabled = tutStep === 0;
    w.UI.setLabel(q('b-tut-next'), tutStep === total - 1 ? tr('help.again') : tr('help.next'));
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
  var pendingInvite = null; // 邀請連結：先讓來賓確認暱稱，再建立觀戰連線
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

  function connText(kind) { return tr('conn.' + kind); }

  function nickOrDefault() { return nick || tr('nick.default'); }

  /* ---------- 大廳 ---------- */
  var lobbyMsg = null;   // 以 key 設定的狀態列文字，切換語言時重畫
  function setLobbyState(kind, text, key, params) {
    var el = q('lobby-state');
    if (!el) return;
    lobbyMsg = key ? { kind: kind, key: key, params: params } : null;
    el.textContent = key ? tr(key, params) : text;
    el.setAttribute('data-state', kind);
  }
  function setLobbyKey(kind, key, params) { setLobbyState(kind, '', key, params); }

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
    if (!quiet) setLobbyKey('loading', 'lobby.loading');
    w.Online.listRooms(function (err, data) {
      if (cur !== 's-lobby') return;
      if (err) {
        setLobbyState('error', err.message);
        renderRooms(null);
        return;
      }
      renderRooms(data.rooms);
      setLobbyKey('ok', 'lobby.count', { n: data.rooms.length, max: data.maxRooms });
    }, function () {
      if (cur === 's-lobby') setLobbyKey('waking', 'lobby.waking');
    });
  }

  /* 房間卡片一律用 textContent 塞入使用者資料（暱稱由別人輸入，絕不能碰 innerHTML） */
  var lastRooms;
  function renderRooms(rooms) {
    lastRooms = rooms;
    var host2 = q('roomlist');
    host2.innerHTML = '';
    if (rooms === null) {
      var fail = D.createElement('div');
      fail.className = 'rooms-empty';
      fail.textContent = tr('lobby.failList');
      host2.appendChild(fail);
      return;
    }
    if (!rooms.length) {
      var empty = D.createElement('div');
      empty.className = 'rooms-empty';
      empty.textContent = tr('lobby.noRooms');
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
    who.textContent = displayName(room.hostName);
    var meta = D.createElement('span');
    meta.className = 'rc-meta';

    function tag(text, cls) {
      var t = D.createElement('span');
      t.className = 'rc-tag' + (cls ? ' ' + cls : '');
      t.textContent = text;
      meta.appendChild(t);
    }
    var roomDiff = S.PRESETS[room.difficulty] ? diffLabel(room.difficulty) : (room.label || room.difficulty || tr('room.diffUnknown'));
    tag(roomDiff);
    tag(room.status === 'done' ? tr('room.done') : tr('room.live'), room.status === 'done' ? 'done' : 'live');
    if (!room.hostOnline) tag(tr('room.hostOffline'), 'off');
    tag('👀 ' + room.viewers + ' / ' + room.maxViewers);
    tag(tr('room.filled', { a: room.filled, b: room.total }));
    tag('⏱ ' + fmtTime(room.elapsedMs));
    tag(tr('room.opened', { ago: agoText(room.createdAt) }));

    main.appendChild(who);
    main.appendChild(meta);

    var go2 = D.createElement('span');
    go2.className = 'rc-go';
    go2.textContent = room.viewers >= room.maxViewers ? tr('room.full') : tr('room.enter');

    var bar = D.createElement('span');
    bar.className = 'rc-bar';
    var fill = D.createElement('i');
    fill.style.width = Math.round((room.total ? room.filled / room.total : 0) * 100) + '%';
    bar.appendChild(fill);

    card.appendChild(code);
    card.appendChild(main);
    card.appendChild(go2);
    card.appendChild(bar);
    card.setAttribute('aria-label', tr('room.cardAria', {
      code: room.code, host: displayName(room.hostName), diff: roomDiff,
      status: room.status === 'done' ? tr('room.done') : tr('room.live'),
      filled: room.filled, viewers: room.viewers
    }));
    card.addEventListener('click', function () {
      w.Sound.play('click');
      joinRoom(room.code, '');
    });
    return card;
  }

  function agoText(at) {
    var sec = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (sec < 60) return tr('ago.s', { n: sec });
    if (sec < 3600) return tr('ago.m', { n: Math.round(sec / 60) });
    return tr('ago.h', { n: Math.round(sec / 3600) });
  }

  /* ---------- 開房（主持人） ---------- */
  var hostConn = { kind: '', key: '', detail: '' };
  function setHostConn(kind, key, detail) {
    hostConn = { kind: kind, key: key || '', detail: detail || '' };
    renderHostConn();
  }
  function renderHostConn() {
    var el = q('h-conn');
    if (!el || !hostConn.kind) return;
    var text = tr(hostConn.key || ('conn.' + hostConn.kind));
    if (hostConn.detail && hostConn.kind === 'retrying') text = tr('conn.withDetail', { t: text, d: hostConn.detail });
    el.textContent = text;
    el.setAttribute('data-state', hostConn.kind);
  }
  function renderHostViewers(n) {
    q('h-viewers').textContent = tr('room.viewers', { n: n });
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
      toast(tr('toast.noHost'));
      say(w.Online.disabledReason(), 'bad');
      return;
    }
    q('s-game').classList.add('hosting-room');
    q('b-room-info').hidden = false;
    q('b-room-info').setAttribute('aria-expanded', 'false');
    setTimeout(function () { w.UI.paint(q('b-room-info')); }, 0);
    q('hostbar').hidden = false;
    q('h-code').textContent = tr('conn.opening');
    renderHostViewers(0);
    setHostConn('connecting', 'conn.opening');
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
        q('s-game').classList.remove('hosting-room');
        q('b-room-info').hidden = true;
        q('b-room-info').setAttribute('aria-expanded', 'false');
        q('hostbar').hidden = true;
        setChatVisible(false);
        say(tr('room.openFail', { msg: err.message }), 'bad');
        toast(tr('toast.openFail'));
        return;
      }
      GameAnalytics.track('room_create', { mode: 'online' });
      host = {
        code: data.code, token: data.hostToken, invite: data.inviteToken, viewers: 0,
        cellNotes: normalizeCellNotes()
      };
      if (w.NetworkLatency) w.NetworkLatency.setActive(cur === 's-game' && !!state && state.status === 'playing');
      q('h-code').textContent = host.code;
      resetChat('chat.roomHost', { code: host.code });
      setChatVisible(true);
      w.Sound.play('join');
      sayKey('room.openOk', { code: host.code }, 'good');

      w.Online.connect({
        code: host.code,
        token: host.token,
        on: {
          state: onHostState,
          note: onSharedNote,
          status: function (st, detail) {
            setHostConn(st, '', detail);
            setChatEnabled(st === 'open');
          },
          presence: function (p) {
            if (!host) return;
            var before = host.viewers;
            host.viewers = p.viewers;
            renderHostViewers(p.viewers);
            if (p.viewers > before) {
              systemChat(tr('chat.sysJoin', { n: p.viewers }));
              w.Sound.playChat();
            } else if (p.viewers < before) {
              systemChat(tr('chat.sysLeave', { n: p.viewers }));
            }
          },
          chat: onChatMessage,
          closed: function () {
            systemChat(tr('chat.sysClosed'));
            endHostRoom(false);
          }
        }
      });
      w.Online.startStatePush(hostSnapshot);
      pushHostState();
    }, function () {
      setHostConn('waking');
    });
  }

  /* 結束開房。announce=true 代表主動通知伺服器關房。 */
  function endHostRoom(announce) {
    if (!host) return;
    if (w.NetworkLatency) w.NetworkLatency.setActive(false);
    var code = host.code;
    q('b-room-info').hidden = true;
    setRoomInfoOpen(false);
    host = null;
    hostMode = false;
    q('s-game').classList.remove('hosting-room');
    q('b-room-info').setAttribute('aria-expanded', 'false');
    q('hostbar').hidden = true;
    setChatVisible(false);
    setChatOpen(false);
    if (announce) {
      w.Online.closeRoom(function () {});
      toast(tr('toast.roomClosed', { code: code }));
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
    var text = tr('share.text', { code: host.code });
    if (w.navigator && typeof w.navigator.share === 'function') {
      w.navigator.share({ title: tr('share.title'), text: text, url: url })
        .then(function () { say(tr('share.done'), 'good'); })
        .catch(function () { copyShare(url); });
      return;
    }
    copyShare(url);
  }

  function copyShare(url) {
    if (w.navigator && w.navigator.clipboard && typeof w.navigator.clipboard.writeText === 'function') {
      w.navigator.clipboard.writeText(url).then(function () {
        toast(tr('toast.linkCopied'));
        say(tr('share.copied', { url: url }), 'good');
      }).catch(function () {
        say(tr('share.copyFail', { url: url }), 'warn');
      });
      return;
    }
    say(tr('share.manual', { url: url }), 'warn');
  }

  function copyRoomCode() {
    if (!host) return;
    var code = host.code;
    if (w.navigator && w.navigator.clipboard && typeof w.navigator.clipboard.writeText === 'function') {
      w.navigator.clipboard.writeText(code).then(function () {
        toast(tr('toast.codeCopied'));
        say(tr('code.copied', { code: code }), 'good');
      }).catch(function () {
        say(tr('code.copyFail', { code: code }), 'warn');
      });
      return;
    }
    say(tr('code.manual', { code: code }), 'warn');
  }

  function doReinvite() {
    if (!host) return;
    w.Online.rotateInvite(function (err, data) {
      if (err) { say(tr('room.reinviteFail', { msg: err.message }), 'bad'); return; }
      host.invite = data.inviteToken;
      toast(tr('toast.oldLink'));
      say(tr('room.reinviteOk', { code: host.code }), 'good');
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
      ? tr('cell.noteViewN', { n: list.length })
      : tr('cell.noteViewNone'));
    corner.setAttribute('title', el.closest('#board') && w.matchMedia('(any-pointer:coarse)').matches
      ? tr('cell.noteHold') : corner.getAttribute('aria-label'));
    var popTitle = popover.querySelector('.cell-note-popover-title');
    if (popTitle) popTitle.textContent = tr('cell.noteTitle');
    popover.hidden = !open;
    while (items.firstChild) items.removeChild(items.firstChild);
    if (!list.length) {
      var empty = D.createElement('span');
      empty.className = 'cell-note-empty';
      empty.textContent = tr('cell.noteNone');
      items.appendChild(empty);
      return;
    }
    list.forEach(function (note) {
      var row = D.createElement('span');
      row.className = 'cell-note-item';
      var who = D.createElement('b');
      who.textContent = (note.role === 'host' ? tr('cell.hostPrefix') : '') + displayName(note.name);
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
      label.textContent = tr('watch.noCell');
      if (D.activeElement !== input) input.value = '';
      listEl.textContent = tr('watch.pickCell');
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
      empty.textContent = tr('watch.noteEmpty');
      listEl.appendChild(empty);
      return;
    }
    list.forEach(function (note) {
      var row = D.createElement('div');
      row.className = 'watch-note-item' + (note.authorId === noteAuthorId() ? ' mine' : '');
      var who = D.createElement('b');
      who.textContent = displayName(note.name) + (note.authorId === noteAuthorId() ? tr('tag.you') : '') +
        (note.role === 'host' ? tr('tag.host') : '');
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
      el.setAttribute('aria-label', tr('cell.pos', { r: S.ROW_OF[i] + 1, c: S.COL_OF[i] + 1 }) + tr('sep.comma') +
        (v ? (view.given[i] ? tr('cell.givenPrefix') : '') + v : tr('cell.empty')) + tr('sep.comma') +
        (shared.length ? tr('cell.shared', { n: shared.length }) : tr('cell.sharedCanWrite')));
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
      toast(tr('toast.codeFormat'));
      setLobbyKey('error', 'lobby.badCode');
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
    watchAct = { key: 'act.wait' };
    hideWatchOverlay();
    resetChat('chat.room', { code: code });
    setChatVisible(true);
    setChatEnabled(false);
    setWatchFeedbackKey('watch.connectingTo', { code: code }, '');
    renderWatchMeta();
    go('s-watch');

    w.Online.connect({
      code: code,
      name: nickOrDefault(),
      invite: invite,
      on: {
        status: onWatchStatus,
        welcome: function () { GameAnalytics.roomAccepted('join', code, invite ? 'invite_link' : 'lobby'); },
        state: onWatchState,
        note: onSharedNote,
        chat: onChatMessage,
        presence: function (p) {
          if (!watch) return;
          watch.viewers = p.viewers;
          q('w-viewers').textContent = String(p.viewers);
          watch.presence = { hostName: p.hostName, hostOnline: p.hostOnline };
          renderWatchMeta();
        },
        closed: function (data) {
          var why = data && data.reason;
          showWatchOverlay('closed',
            why === 'idle' ? 'watch.why.idle'
              : why === 'hostgone' ? 'watch.why.hostgone'
                : why === 'shutdown' ? 'watch.why.shutdown'
                  : why === 'gone' ? 'watch.why.gone'
                    : 'watch.why.ended');
        }
      }
    });
  }

  function joinPendingInvite() {
    if (!pendingInvite) return;
    var value = w.Store.normalizeNick(q('lobby-nick').value);
    if (!value) {
      toast(tr('toast.needNick'));
      q('lobby-nick').focus();
      return;
    }
    nick = value;
    w.Store.saveNick(nick);
    var invite = pendingInvite;
    pendingInvite = null;
    q('lobby-invite').hidden = true;
    joinRoom(invite.code, invite.token);
  }

  function onWatchStatus(st, detail) {
    setChatConn(st, detail);
    watchConn = st;
    q('sum-conn').textContent = connText(st);
    var live = q('w-live');
    if (live) live.setAttribute('data-state', st === 'open' ? '' : st);
    setChatEnabled(st === 'open');
    setWatchNoteEnabled(st === 'open');
    if (st === 'failed') {
      showWatchOverlay('failed', detail ? '' : 'watch.failedNote', detail || '');
    } else if (st === 'open') {
      hideWatchOverlay();
      setWatchFeedbackKey('watch.openFb', null, 'good');
    } else if (st === 'retrying' || st === 'waking' || st === 'connecting') {
      setWatchFeedbackKey('conn.' + st, null, 'warn');
    }
  }

  function onWatchState(data) {
    if (!watch) return;
    var view = G.spectatorView(data.board);
    if (!view) return;
    if (w.NetworkLatency) w.NetworkLatency.setActive(cur === 's-watch' && view.status === 'playing');
    var prev = lastWatchValues;
    watch.meta = data;
    if (watch.presence) watch.presence.hostOnline = data.hostOnline;
    watch.view = view;
    watch.cellNotes = normalizeCellNotes(data.cellNotes);
    if (!watchCells.length) buildWatchBoard();
    renderWatchBoard();
    resizeWatchBoard();

    q('w-left').textContent = String(view.remaining);
    q('w-hint').textContent = String(view.hintsUsed);
    q('w-miss').textContent = String(view.mistakes);
    q('w-viewers').textContent = String(data.viewers);

    var values = G.gridToString(view.values);
    watchAct = describeChange(prev, values, view);
    lastWatchValues = values;
    renderWatchMeta();

    startWatchClock(view);
    if (view.status === 'won') {
      setWatchFeedbackKey('watch.wonFb', { time: fmtTime(view.elapsedMs), n: view.hintsUsed }, 'good');
      stopWatchClock();
    }
  }

  var watchAct = { key: 'act.wait' };
  var watchConn = 'connecting';
  /* 觀戰畫面所有「由資料組出來的文字」集中在這裡：收到新盤面、切換語言都用同一份資料重畫 */
  function renderWatchMeta() {
    var data = watch && watch.meta;
    var view = watch && watch.view;
    var pres = watch && watch.presence;
    var hostName = (pres && pres.hostName) || (data && data.hostName) || '';
    var hostOnline = pres ? pres.hostOnline : (data ? data.hostOnline : true);
    q('w-code').textContent = watch ? tr('watch.code', { code: (data && data.code) || watch.code }) : tr('watch.codeNone');
    q('w-host').textContent = hostName ? tr('watch.host', { name: displayName(hostName) }) : tr('watch.hostNone');
    var diffText = '—';
    if (data) diffText = S.PRESETS[data.difficulty] ? diffLabel(data.difficulty) : (data.label || data.difficulty || '—');
    q('w-diff').textContent = diffText;
    q('sum-host').textContent = hostName ? displayName(hostName) + (hostOnline ? '' : tr('watch.offline')) : '—';
    q('sum-diff').textContent = data
      ? diffText + (data.technique ? tr('watch.techWrap', { t: techName(data.technique) }) : '')
      : '—';
    q('sum-seed').textContent = (data && data.seed) || '—';
    q('sum-progress').textContent = view
      ? tr('watch.progress', { filled: view.filled, total: view.total, left: view.remaining })
      : '—';
    q('sum-role').textContent = view && view.status === 'won' ? tr('watch.roleWon') : tr('watch.role');
    q('sum-activity').textContent = tr(watchAct.key, watchAct.params);
    q('sum-conn').textContent = connText(watchConn);
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
      setWatchFeedbackKey('watch.fbPick', null, 'warn');
      return;
    }
    var input = q('watch-note-input');
    var text = input.value;
    if (text.length > 10) {
      setWatchFeedbackKey('watch.fbLong', null, 'bad');
      return;
    }
    if (!text.trim()) {
      setWatchFeedbackKey('watch.fbEmpty', null, 'warn');
      return;
    }
    setWatchNoteEnabled(false);
    setWatchFeedbackKey('watch.fbSending', null, '');
    w.Online.sendNote(watch.selected, text, nickOrDefault(), function (err) {
      var open = w.Online.connState() === 'open';
      setWatchNoteEnabled(open);
      if (err) {
        setWatchFeedback(tr('watch.fbFail', { msg: err.message }), 'bad');
        w.Sound.play('blocked');
        return;
      }
      input.value = '';
      renderWatchNotePanel();
      setWatchFeedbackKey('watch.fbOk', null, 'good');
      w.Sound.play('note');
    });
  }

  /* 比對前後兩份盤面，用一句話說明主持人剛剛做了什麼 */
  function describeChange(before, after, view) {
    if (view.status === 'won') return { key: 'act.won' };
    if (view.paused) return { key: 'act.paused' };
    if (!before || before === after) {
      return view.selected >= 0 ? { key: 'act.looking', params: { cell: S.cellName(view.selected) } } : { key: 'act.thinking' };
    }
    for (var i = 0; i < 81; i++) {
      if (before.charAt(i) !== after.charAt(i)) {
        var now = after.charAt(i);
        return now === '0'
          ? { key: 'act.cleared', params: { cell: S.cellName(i) } }
          : { key: 'act.filled', params: { cell: S.cellName(i), d: now } };
      }
    }
    return { key: 'act.notes' };
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

  var watchFb = null;
  function setWatchFeedback(text, kind) {
    var el = q('w-feedback');
    watchFb = null;
    if (!el) return;
    el.textContent = text;
    el.className = 'feedback' + (kind ? ' ' + kind : '');
  }
  function setWatchFeedbackKey(key, params, kind) {
    setWatchFeedback(tr(key, params), kind);
    watchFb = { key: key, params: params, kind: kind };
  }

  var watchOv = null;
  function showWatchOverlay(kind, noteKey, rawNote) {
    var ov = q('watch-overlay');
    stopWatchClock();
    watchOv = { kind: kind, key: noteKey, raw: rawNote };
    renderWatchOverlay();
    q('b-watch-retry').hidden = false;
    ov.classList.add('on');
    ov.setAttribute('aria-hidden', 'false');
    setChatEnabled(false);
    setTimeout(function () { var b = q('watch-ov-box'); if (b) b.focus(); }, 20);
    w.Sound.play('leave');
  }
  function renderWatchOverlay() {
    if (!watchOv) return;
    q('watch-ov-face').textContent = watchOv.kind === 'failed' ? '📡' : '📴';
    q('watch-ov-title').textContent = watchOv.kind === 'failed' ? tr('watch.failedTitle') : tr('watch.closedTitle');
    q('watch-ov-note').textContent = watchOv.key ? tr(watchOv.key) : (watchOv.raw || '');
  }
  function hideWatchOverlay() {
    var ov = q('watch-overlay');
    ov.classList.remove('on');
    ov.setAttribute('aria-hidden', 'true');
    watchOv = null;
  }

  function leaveWatch(goLobby) {
    if (watch) {
      GameAnalytics.roomLeft();
      if (w.NetworkLatency) w.NetworkLatency.setActive(false);
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
      ? tr('chat.openAriaN', { n: chatUnread })
      : tr('chat.openAria'));
  }

  var chatRoom = null;
  function resetChat(roomKey, roomParams) {
    chatSeen = {};
    chatUnread = 0;
    updateChatBadge();
    chatRoom = roomKey ? { key: roomKey, params: roomParams } : null;
    renderChatRoom();
    var log = q('chat-log');
    log.innerHTML = '';
    var hint = D.createElement('p');
    hint.className = 'chat-empty';
    hint.textContent = tr('chat.empty');
    log.appendChild(hint);
    setChatNoteKey('chat.limit', false);
  }
  function renderChatRoom() {
    q('chat-room').textContent = chatRoom ? tr(chatRoom.key, chatRoom.params) : '';
  }

  var chatConnState = null;
  function setChatConn(kind, detail) {
    var el = q('chat-conn');
    if (!el) return;
    chatConnState = { kind: kind, detail: detail };
    renderChatConn();
  }
  function renderChatConn() {
    var el = q('chat-conn');
    if (!el || !chatConnState) return;
    var kind = chatConnState.kind, detail = chatConnState.detail;
    el.setAttribute('data-state', kind);
    var text = connText(kind);
    el.textContent = detail && kind === 'retrying' ? tr('conn.withDetail', { t: text, d: detail }) : text;
  }

  var chatNoteKey = null;
  function setChatNote(text, bad) {
    var el = q('chat-note');
    chatNoteKey = null;
    el.textContent = text;
    el.className = 'chat-note' + (bad ? ' bad' : '');
  }
  function setChatNoteKey(key, bad) {
    setChatNote(tr(key), bad);
    chatNoteKey = { key: key, bad: bad };
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
    who.textContent = displayName(msg.name) + (msg.role === 'host' ? tr('tag.host') : '');
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
    if (!text) { setChatNoteKey('chat.writeFirst', true); return; }
    setChatEnabled(false);
    setChatNoteKey('chat.sending', false);
    w.Online.sendChat(text, nickOrDefault(), function (err) {
      var open = w.Online.connState() === 'open';
      setChatEnabled(open);
      if (err) {
        setChatNote(tr('chat.fail', { msg: err.message }), true);
        w.Sound.play('blocked');
        return;
      }
      input.value = '';
      setChatNoteKey('chat.limit', false);
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
    pendingInvite = { code: String(m[1] || '').toUpperCase(), token: invite };
    q('lobby-code').value = pendingInvite.code;
    q('lobby-invite').hidden = false;
    q('lobby-invite-note').textContent = invite ? tr('lobby.inviteNoteToken') : tr('lobby.inviteNote');
    if (!w.Online.isEnabled()) {
      go('s-lobby');
      renderLobby();
      return true;
    }
    go('s-lobby');
    renderLobby();
    setLobbyKey('ok', 'lobby.inviteReady');
    try { q('lobby-nick').focus(); } catch (e) {}
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
      var code = q('lobby-code').value;
      if (pendingInvite && pendingInvite.code === String(code || '').toUpperCase()) {
        joinPendingInvite();
        return;
      }
      joinRoom(code, '');
    });
    q('b-lobby-invite').addEventListener('click', function () {
      w.Sound.play('click');
      joinPendingInvite();
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
    q('b-copy-room-code').addEventListener('click', function () { w.Sound.play('click'); copyRoomCode(); });
    q('b-reinvite').addEventListener('click', function () { w.Sound.play('click'); doReinvite(); });
    q('b-close-room').addEventListener('click', function () {
      w.Sound.play('click');
      endHostRoom(true);
      sayKey('room.closedSay', null, 'good');
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
      q('b-sum-toggle').textContent = open ? tr('watch.expand') : tr('watch.collapse');
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
  /* 伺服器狀態只反映設定，不主動探測；進入線上模式時才建立連線。 */
  var SERVER_STATES = { unset: 1, invalid: 1, ready: 1 };
  var serverStateNow = 'unset';
  function setServerState(state) {
    var pill = q('settings-server-state');
    var note = q('settings-server-note');
    if (!SERVER_STATES[state]) state = 'unset';
    serverStateNow = state;
    if (pill) { pill.textContent = tr('server.' + state + '.pill'); pill.setAttribute('data-state', state); }
    if (note) note.textContent = tr('server.' + state + '.note');
  }
  function syncServerRow() {
    var C = w.GameConfig;
    var urlEl = q('settings-server-url');
    if (!C || !urlEl) return;
    urlEl.textContent = C.describe();
    setServerState(C.status === 'ok' ? 'ready' : C.status);
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
    q('settings-music-status').textContent = musicOn ? tr('common.on') : tr('common.off');
    q('settings-sfx-status').textContent = sfxOn ? tr('common.on') : tr('common.off');
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
      ? tr('settings.audioReady')
      : tr('settings.audioLocked');
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

  function setRoomInfoOpen(open, fromHistory) {
    var modal = q('room-info-modal');
    var trigger = q('b-room-info');
    if (!modal) return;
    if (open) {
      if (!host || modal.classList.contains('open')) return;
      roomInfoLastFocus = D.activeElement;
      if (!roomInfoHistory && !fromHistory) {
        try { history.pushState({ sdRoomInfo: true }, '', location.href); roomInfoHistory = true; } catch (e) {}
      }
    }
    modal.classList.toggle('open', !!open);
    modal.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      w.UI.repaintAll(q('room-info-panel'));
      q('room-info-panel').focus();
    } else {
      var back = (roomInfoLastFocus && roomInfoLastFocus !== D.body && !roomInfoLastFocus.hidden && typeof roomInfoLastFocus.focus === 'function')
        ? roomInfoLastFocus : (trigger && !trigger.hidden ? trigger : q('b-quit'));
      if (back && back.focus) back.focus();
      roomInfoLastFocus = null;
      if (roomInfoHistory && !fromHistory) {
        roomInfoHistory = false;
        try { history.back(); } catch (e) {}
      }
    }
  }
  function isRoomInfoOpen() { return q('room-info-modal').classList.contains('open'); }

  function bindRoomInfo() {
    q('b-room-info').addEventListener('click', function () { w.Sound.play('click'); setRoomInfoOpen(true); });
    q('room-info-close').addEventListener('click', function () { w.Sound.play('click'); setRoomInfoOpen(false); });
    qa('[data-room-info-close]').forEach(function (el) {
      el.addEventListener('click', function () { setRoomInfoOpen(false); });
    });

    /* 房間資訊也是 Modal：Tab 不應跳到背後的遊戲控制。 */
    q('room-info-modal').addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var list = focusableIn(q('room-info-panel'));
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && (D.activeElement === first || D.activeElement === q('room-info-panel'))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && D.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });

    w.addEventListener('popstate', function () {
      if (isRoomInfoOpen()) { roomInfoHistory = false; setRoomInfoOpen(false, true); }
    });
  }

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
      toast(tr('toast.resetDone'));
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
      /* 線上模式下開始新題目就直接成為主持人；沒有伺服器時仍維持單機遊戲。 */
      setHostMode(w.Online.isEnabled());
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
      sayKey('msg.restartedSay', null, 'good');
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
      startNewGame(state ? state.difficulty : pendingDifficulty, '', true);
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
      toast(tr('toast.statsCleared'));
    });

    q('b-tut-prev').addEventListener('click', function () {
      w.Sound.play('click');
      if (tutStep > 0) tutStep--;
      renderTutorial();
    });
    q('b-tut-next').addEventListener('click', function () {
      w.Sound.play('click');
      tutStep = (tutStep + 1) % TUT_LINES.length;
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
      if (isRoomInfoOpen()) {
        if (e.key === 'Escape') { e.preventDefault(); setRoomInfoOpen(false); }
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
    w.UI.setLabel(q('b-start'), hostMode ? tr('setup.startHost') : tr('setup.start'));
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
  /* 切換語言：靜態文字由 I18N.apply 處理；這裡把「由程式組出來的文字」用現有資料重畫，不動遊戲狀態 */
  function syncLobbyLink() {
    var a = D.querySelector('.lobby-home-link');
    if (a) {
      if (!a.getAttribute('data-base')) a.setAttribute('data-base', a.getAttribute('href'));
      a.setAttribute('href', w.I18N.withLang(a.getAttribute('data-base')));
    }
  }
  function onLangChange() {
    syncLobbyLink();
    q('logo').innerHTML = w.UI.logo();
    refreshHome();
    renderTutorial();
    setHostMode(hostMode);
    updateChatBadge();
    if (state) { renderBoard(); toggleNoteLabel(); }
    if (lastSay) sayKey(lastSay.key, lastSay.params, lastSay.kind);
    if (cur === 's-result') renderResult();
    if (cur === 's-stats') renderStats();
    if (cur === 's-error') q('error-note').textContent = tr('error.noteLong');
    /* 大廳 */
    if (!q('lobby-off').hidden) q('lobby-off-note').textContent = w.Online.disabledReason();
    if (lobbyMsg) setLobbyState(lobbyMsg.kind, '', lobbyMsg.key, lobbyMsg.params);
    if (lastRooms !== undefined) renderRooms(lastRooms);
    if (pendingInvite) {
      q('lobby-invite-note').textContent = pendingInvite.token ? tr('lobby.inviteNoteToken') : tr('lobby.inviteNote');
    }
    /* 房主 */
    renderHostConn();
    if (!q('hostbar').hidden) {
      renderHostViewers(host ? host.viewers : 0);
      if (!host) q('h-code').textContent = tr('conn.opening');
    }
    /* 觀戰 */
    renderWatchMeta();
    if (watch && watch.view) renderWatchBoard();
    if (watchFb) setWatchFeedbackKey(watchFb.key, watchFb.params, watchFb.kind);
    renderWatchOverlay();
    q('b-sum-toggle').textContent = q('w-summary').classList.contains('collapsed') ? tr('watch.expand') : tr('watch.collapse');
    /* 留言板 */
    renderChatRoom();
    renderChatConn();
    if (chatNoteKey) setChatNoteKey(chatNoteKey.key, chatNoteKey.bad);
    /* 設定彈窗 */
    if (isSettingsOpen()) syncSettings(); else setServerState(serverStateNow);
    setTimeout(function () { w.UI.repaintAll(q(cur)); resizeBoard(); resizeWatchBoard(); }, 40);
  }
  function toggleNoteLabel() {
    q('note-tag').textContent = noteMode ? tr('common.on') : tr('common.off');
  }

  function init() {
    q('logo').innerHTML = w.UI.logo();
    w.UI.bgDeco(q('bgdeco'));
    buildBoard();
    buildNumpad();
    w.UI.decorateAll();
    buildWatchBoard();
    bind();
    bindSettings();
    bindRoomInfo();
    bindOnline();
    applyOptions();
    markDiff(pendingDifficulty);
    refreshHome();
    renderTutorial();
    updateChatBadge();
    setChatVisible(false);
    /* 語言切換鈕：緊鄰右上角設定鈕（樣式見 style.css 的 .lang-toggle） */
    w.I18N.mountToggle({ after: q('b-settings') });
    w.I18N.onChange(onLangChange);
    w.I18N.apply();
    onLangChange();
    /* 有 ?room=XXXX 就直接進觀戰，沒有就照常回主選單 */
    if (!deepLinkRoom()) go('s-home');
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
