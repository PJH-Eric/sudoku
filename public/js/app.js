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
  var peekLastFocus = null;
  var pauseLastFocus = null;
  var cells = [];
  var padButtons = [];
  var pendingDifficulty = w.Store.loadLastDifficulty() || 'beginner';
  var tutStep = 0;
  var pendingSeed = '';

  function diffLabel(d) { return S.PRESETS[d] ? tr('diff.' + d) : (d || ''); }
  function techName(name) { return S.techLabel ? S.techLabel(name) : (name || ''); }
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

  function refreshDailyDate() {
    q('daily-date').textContent = tr('daily.date', { date: new Date().toISOString().slice(0, 10) });
  }

  function refreshHome() {
    refreshDailyDate();
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
      el.setAttribute('aria-label', cellLabel(i, v, mask, conflicts[i], wrong && wrong[i]));
    }
    renderStatus();
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
  function startNewGame(difficulty, seed) {
    pendingDifficulty = difficulty;
    pendingSeed = seed;
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
    } else {
      startTimer();
      w.Sound.play('resume');
      sayKey('msg.resumedPlay', null, 'good');
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

  /* ---------- 設定彈窗 ---------- */

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
    q('settings-motion').checked = options.motion;
    q('settings-autonotes').checked = options.autoClearNotes;
    q('settings-mistakes').checked = options.markMistakes;
    q('settings-same').checked = options.highlightSame;
    q('settings-units').checked = options.highlightUnits;
    q('settings-remaining').checked = options.showRemaining;
    q('settings-audio-note').textContent = w.Sound.isUnlocked()
      ? tr('settings.audioReady')
      : tr('settings.audioLocked');
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

  function setPeekOpen(open) {
    var modal = q('peek-modal');
    var trigger = q('b-peek');
    if (open) {
      if (!state || !state.solution || modal.classList.contains('open')) return;
      var grid = q('peek-grid');
      grid.textContent = '';
      for (var i = 0; i < 81; i++) {
        var c = D.createElement('div');
        var r = Math.floor(i / 9), col = i % 9;
        c.className = 'peek-cell' + (state.given[i] ? ' given' : '') +
          (col % 3 === 2 && col < 8 ? ' cr' : '') + (r % 3 === 2 && r < 8 ? ' cb' : '');
        c.textContent = String(state.solution[i]);
        grid.appendChild(c);
      }
      peekLastFocus = D.activeElement;
    }
    modal.classList.toggle('open', !!open);
    modal.setAttribute('aria-hidden', open ? 'false' : 'true');
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) q('peek-panel').focus();
    else {
      var back = peekLastFocus && typeof peekLastFocus.focus === 'function' ? peekLastFocus : trigger;
      back.focus();
      peekLastFocus = null;
    }
  }
  function isPeekOpen() { return q('peek-modal').classList.contains('open'); }

  function bindPeek() {
    q('b-peek').addEventListener('click', function () { w.Sound.play('click'); setPeekOpen(true); });
    q('peek-close').addEventListener('click', function () { w.Sound.play('click'); setPeekOpen(false); });
    qa('[data-peek-close]').forEach(function (el) {
      el.addEventListener('click', function () { setPeekOpen(false); });
    });
    q('peek-modal').addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var list = focusableIn(q('peek-panel'));
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && (D.activeElement === first || D.activeElement === q('peek-panel'))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && D.activeElement === last) {
        e.preventDefault(); first.focus();
      }
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
    setInterval(function () { if (cur === 's-home') refreshDailyDate(); }, 30000);
    qa('[data-back]').forEach(function (b) {
      b.addEventListener('click', function () { w.Sound.play('click'); go(b.getAttribute('data-back')); });
    });

    q('b-new').addEventListener('click', function () {
      w.Sound.play('click');
      markDiff(pendingDifficulty);
      go('s-setup');
    });
    q('daily-buttons').addEventListener('click', function (e) {
      var button = e.target.closest('[data-daily]');
      if (!button) return;
      w.Sound.play('click');
      startNewGame(button.getAttribute('data-daily'), w.RNG.dailySeed());
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
      startNewGame(pendingDifficulty, pendingSeed);
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
      sayKey('msg.restartedSay', null, 'good');
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
    q('b-home2').addEventListener('click', function () {
      w.Sound.play('click');
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
    q('b-tut-play').addEventListener('click', function () { w.Sound.play('click'); startNewGame('beginner', ''); });

    /* 鍵盤操作 */
    D.addEventListener('keydown', function (e) {
      if (isSettingsOpen()) {
        if (e.key === 'Escape') { e.preventDefault(); setSettingsOpen(false); }
        return;
      }
      if (isPeekOpen()) {
        if (e.key === 'Escape') { e.preventDefault(); setPeekOpen(false); }
        return;
      }
      /* 在任何文字欄位打字時，不可以把按鍵當成盤面操作 */
      var ae = D.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
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
    pendingDifficulty = S.PRESETS[v] ? v : 'beginner';
    qa('.optcard', q('opt-diff')).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === pendingDifficulty);
      b.setAttribute('aria-pressed', b.getAttribute('data-v') === pendingDifficulty ? 'true' : 'false');
    });
  }

  /* ---------- 啟動 ---------- */
  /* 切換語言：靜態文字由 I18N.apply 處理；這裡把「由程式組出來的文字」用現有資料重畫，不動遊戲狀態 */
  function onLangChange() {
    q('logo').innerHTML = w.UI.logo();
    refreshHome();
    renderTutorial();
    if (state) { renderBoard(); toggleNoteLabel(); }
    if (lastSay) sayKey(lastSay.key, lastSay.params, lastSay.kind);
    if (cur === 's-result') renderResult();
    if (cur === 's-stats') renderStats();
    if (cur === 's-error') q('error-note').textContent = tr('error.noteLong');
    if (isSettingsOpen()) syncSettings();
    setTimeout(function () { w.UI.repaintAll(q(cur)); resizeBoard(); }, 40);
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
    bind();
    bindSettings();
    bindPeek();
    applyOptions();
    markDiff(pendingDifficulty);
    refreshHome();
    renderTutorial();
    /* 語言切換鈕：緊鄰右上角設定鈕（樣式見 style.css 的 .lang-toggle） */
    w.I18N.mountToggle({ after: q('b-settings') });
    w.I18N.onChange(onLangChange);
    w.I18N.apply();
    onLangChange();
    go('s-home');
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
