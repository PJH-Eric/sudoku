/* ===== game.js — 一局數獨的狀態機 =====
 * 只依賴 sudoku.js（規則）與 rng.js（種子亂數），完全不碰 DOM／音訊／localStorage 讀寫，
 * 所以同一份程式可以直接在 Node 單元測試裡跑完一整局。
 *
 * 所有會改變盤面的動作都回傳 { ok, code, message, ... }：
 *   ok = false 時盤面保持不變，message 是可以直接顯示給玩家看的中文說明。
 */
(function (w) {
  'use strict';

  var S = w.Sudoku;
  var CELLS = 81;

  var DEFAULT_OPTIONS = {
    autoClearNotes: true,   // 填入數字後自動清掉同列／行／宮筆記中的該數字
    markMistakes: true      // 是否即時標示填錯（規則核心一律記錄，這裡只影響 UI 要不要顯示）
  };

  function gridToString(grid) {
    var out = '';
    for (var i = 0; i < CELLS; i++) out += String(grid[i] || 0);
    return out;
  }
  function stringToGrid(str) {
    var g = S.emptyGrid();
    if (typeof str !== 'string') return g;
    for (var i = 0; i < CELLS && i < str.length; i++) {
      var v = parseInt(str.charAt(i), 10);
      g[i] = (v >= 1 && v <= 9) ? v : 0;
    }
    return g;
  }

  /* ---------- 建立新的一局 ---------- */
  function create(options) {
    var opts = options || {};
    var puzzle = S.generatePuzzle({ difficulty: opts.difficulty, seed: opts.seed });
    return fromPuzzle(puzzle, opts);
  }

  function fromPuzzle(puzzle, options) {
    var opts = options || {};
    var given = new Array(CELLS);
    var values = new Array(CELLS);
    var notes = new Array(CELLS);
    for (var i = 0; i < CELLS; i++) {
      given[i] = puzzle.puzzle[i] !== 0;
      values[i] = puzzle.puzzle[i];
      notes[i] = 0;
    }
    return {
      version: 1,
      difficulty: puzzle.difficulty,
      label: puzzle.label,
      seed: puzzle.seed,
      tier: puzzle.tier,
      technique: puzzle.technique,
      givens: puzzle.givens,
      puzzle: puzzle.puzzle.slice(),
      solution: puzzle.solution.slice(),
      given: given,
      values: values,
      notes: notes,
      history: [],
      future: [],
      hintsUsed: 0,
      mistakes: 0,
      elapsedMs: 0,
      status: 'playing',
      createdAt: opts.now || Date.now(),
      finishedAt: 0,
      autoClearNotes: opts.autoClearNotes === undefined ? DEFAULT_OPTIONS.autoClearNotes : !!opts.autoClearNotes
    };
  }

  /* ---------- 查詢 ---------- */
  function remaining(state) {
    var n = 0;
    for (var i = 0; i < CELLS; i++) if (!state.values[i]) n++;
    return n;
  }
  /* 每個數字還剩幾格沒填（給數字盤顯示用），索引 1..9 */
  function digitCounts(state) {
    var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < CELLS; i++) if (state.values[i]) counts[state.values[i]]++;
    return counts;
  }
  function conflicts(state) {
    return S.findConflicts(state.values);
  }
  /* 填了但和答案不符的格子（給「即時標錯」用） */
  function wrongCells(state) {
    var flags = new Array(CELLS);
    for (var i = 0; i < CELLS; i++) {
      flags[i] = (!state.given[i] && state.values[i] && state.values[i] !== state.solution[i]) ? 1 : 0;
    }
    return flags;
  }
  function isWon(state) {
    for (var i = 0; i < CELLS; i++) if (state.values[i] !== state.solution[i]) return false;
    return true;
  }

  /* ---------- 復原用的補丁 ---------- */
  function snapshotCells(state, indices) {
    var cells = [];
    for (var i = 0; i < indices.length; i++) {
      var idx = indices[i];
      cells.push({ i: idx, value: state.values[idx], notes: state.notes[idx] });
    }
    return cells;
  }
  function pushHistory(state, label, before, after) {
    state.history.push({
      label: label,
      before: before,
      after: after,
      mistakes: state.mistakes,
      hintsUsed: state.hintsUsed
    });
    if (state.history.length > 300) state.history.shift();
    state.future.length = 0;
  }
  function applyCells(state, cells) {
    for (var i = 0; i < cells.length; i++) {
      state.values[cells[i].i] = cells[i].value;
      state.notes[cells[i].i] = cells[i].notes;
    }
  }

  function finishIfWon(state, result) {
    if (state.status === 'playing' && isWon(state)) {
      state.status = 'won';
      state.finishedAt = Date.now();
      result.won = true;
    }
    return result;
  }

  /* ---------- 動作：填入數字 ---------- */
  function setValue(state, index, digit, options) {
    var opts = options || {};
    if (state.status !== 'playing') {
      return { ok: false, code: 'finished', message: '這一局已經完成了，可以按「再來一題」開始新的挑戰。' };
    }
    if (index < 0 || index >= CELLS) {
      return { ok: false, code: 'range', message: '沒有選到格子，請先點一格再輸入數字。' };
    }
    if (state.given[index]) {
      return { ok: false, code: 'given', message: '這格是題目原本就給的數字，不能修改。' };
    }
    if (digit < 1 || digit > 9) {
      return { ok: false, code: 'digit', message: '只能填 1 到 9 的數字。' };
    }
    if (state.values[index] === digit) {
      /* 重複按同一個數字＝取消填入，是一個合法動作 */
      return clearCell(state, index);
    }

    var touched = [index];
    var i;
    if (state.autoClearNotes) {
      var peers = S.PEERS[index];
      for (i = 0; i < peers.length; i++) {
        if (state.notes[peers[i]] & S.BIT[digit]) touched.push(peers[i]);
      }
    }
    var before = snapshotCells(state, touched);

    state.values[index] = digit;
    state.notes[index] = 0;
    if (state.autoClearNotes) {
      for (i = 1; i < touched.length; i++) state.notes[touched[i]] &= ~S.BIT[digit];
    }
    var after = snapshotCells(state, touched);

    var wrong = digit !== state.solution[index];
    if (wrong) state.mistakes++;
    pushHistory(state, wrong ? '填入（不符答案）' : '填入', before, after);

    var conflictFlags = S.findConflicts(state.values);
    return finishIfWon(state, {
      ok: true, code: 'set', index: index, digit: digit,
      wrong: wrong,
      conflict: !!conflictFlags[index],
      message: wrong
        ? (S.cellName(index) + ' 填了 ' + digit + '，和正確答案不一樣，可以按「復原」或直接改成別的數字。')
        : (S.cellName(index) + ' 填入 ' + digit + '。'),
      won: false
    });
  }

  /* ---------- 動作：筆記（候選數） ---------- */
  function toggleNote(state, index, digit) {
    if (state.status !== 'playing') {
      return { ok: false, code: 'finished', message: '這一局已經完成了，可以按「再來一題」開始新的挑戰。' };
    }
    if (index < 0 || index >= CELLS) {
      return { ok: false, code: 'range', message: '沒有選到格子，請先點一格再輸入數字。' };
    }
    if (state.given[index]) {
      return { ok: false, code: 'given', message: '題目原本就給的數字不需要做筆記。' };
    }
    if (state.values[index]) {
      return { ok: false, code: 'filled', message: '這格已經填了 ' + state.values[index] + '，先按「清除」才能做筆記。' };
    }
    if (digit < 1 || digit > 9) {
      return { ok: false, code: 'digit', message: '只能記 1 到 9 的數字。' };
    }
    var before = snapshotCells(state, [index]);
    state.notes[index] ^= S.BIT[digit];
    var after = snapshotCells(state, [index]);
    pushHistory(state, '筆記', before, after);
    var on = !!(state.notes[index] & S.BIT[digit]);
    return {
      ok: true, code: 'note', index: index, digit: digit, on: on,
      message: S.cellName(index) + (on ? ' 記下候選數 ' : ' 取消候選數 ') + digit + '。'
    };
  }

  /* ---------- 動作：清除 ---------- */
  function clearCell(state, index) {
    if (state.status !== 'playing') {
      return { ok: false, code: 'finished', message: '這一局已經完成了，可以按「再來一題」開始新的挑戰。' };
    }
    if (index < 0 || index >= CELLS) {
      return { ok: false, code: 'range', message: '沒有選到格子，請先點一格再按清除。' };
    }
    if (state.given[index]) {
      return { ok: false, code: 'given', message: '這格是題目原本就給的數字，不能清除。' };
    }
    if (!state.values[index] && !state.notes[index]) {
      return { ok: false, code: 'empty', message: '這格本來就是空的，沒有東西可以清除。' };
    }
    var before = snapshotCells(state, [index]);
    state.values[index] = 0;
    state.notes[index] = 0;
    var after = snapshotCells(state, [index]);
    pushHistory(state, '清除', before, after);
    return { ok: true, code: 'clear', index: index, message: S.cellName(index) + ' 已清空。' };
  }

  /* ---------- 動作：復原／重做 ---------- */
  function undo(state) {
    if (!state.history.length) {
      return { ok: false, code: 'nothing', message: '目前沒有可以復原的步驟。' };
    }
    var entry = state.history.pop();
    applyCells(state, entry.before);
    state.future.push(entry);
    if (state.status === 'won') { state.status = 'playing'; state.finishedAt = 0; }
    return { ok: true, code: 'undo', message: '已復原「' + entry.label + '」。', index: entry.before[0] ? entry.before[0].i : -1 };
  }
  function redo(state) {
    if (!state.future.length) {
      return { ok: false, code: 'nothing', message: '目前沒有可以重做的步驟。' };
    }
    var entry = state.future.pop();
    applyCells(state, entry.after);
    state.history.push(entry);
    return finishIfWon(state, {
      ok: true, code: 'redo', message: '已重做「' + entry.label + '」。',
      index: entry.after[0] ? entry.after[0].i : -1, won: false
    });
  }

  /* ---------- 動作：提示 ---------- */
  function hint(state) {
    if (state.status !== 'playing') {
      return { ok: false, code: 'finished', message: '這一局已經完成了，不需要提示。' };
    }
    /* 盤面上有填錯的數字時，先幫玩家找出錯誤，不然後面的推理都是白費的 */
    for (var i = 0; i < CELLS; i++) {
      if (!state.given[i] && state.values[i] && state.values[i] !== state.solution[i]) {
        return {
          ok: true, code: 'fix', index: i, digit: state.values[i], fix: true,
          message: S.cellName(i) + ' 的 ' + state.values[i] + ' 和答案不符，先把它清掉再繼續推理。'
        };
      }
    }
    var step = S.nextStep(state.values, state.solution);
    if (!step) {
      return { ok: false, code: 'complete', message: '盤面已經沒有空格了。' };
    }
    var before = snapshotCells(state, [step.index]);
    state.values[step.index] = step.digit;
    state.notes[step.index] = 0;
    var after = snapshotCells(state, [step.index]);
    state.hintsUsed++;
    pushHistory(state, '提示', before, after);
    return finishIfWon(state, {
      ok: true, code: 'hint', index: step.index, digit: step.digit,
      technique: step.technique, tier: step.tier,
      message: '【' + step.technique + '】' + step.reason,
      won: false
    });
  }

  /* ---------- 動作：全部重來（同一題） ---------- */
  function restart(state) {
    for (var i = 0; i < CELLS; i++) {
      state.values[i] = state.puzzle[i];
      state.notes[i] = 0;
    }
    state.history.length = 0;
    state.future.length = 0;
    state.hintsUsed = 0;
    state.mistakes = 0;
    state.elapsedMs = 0;
    state.status = 'playing';
    state.finishedAt = 0;
    state.createdAt = Date.now();
    return { ok: true, code: 'restart', message: '已回到題目一開始的樣子。' };
  }

  /* ---------- 存檔／讀檔（給 localStorage 用，本身不做 I/O） ---------- */
  function serialize(state) {
    return {
      version: 1,
      difficulty: state.difficulty,
      label: state.label,
      seed: state.seed,
      tier: state.tier,
      technique: state.technique,
      givens: state.givens,
      puzzle: gridToString(state.puzzle),
      solution: gridToString(state.solution),
      values: gridToString(state.values),
      notes: state.notes.slice(),
      hintsUsed: state.hintsUsed,
      mistakes: state.mistakes,
      elapsedMs: state.elapsedMs,
      status: state.status,
      createdAt: state.createdAt,
      finishedAt: state.finishedAt,
      autoClearNotes: state.autoClearNotes
    };
  }

  function deserialize(data) {
    if (!data || data.version !== 1 || typeof data.puzzle !== 'string' || typeof data.solution !== 'string') return null;
    var puzzle = stringToGrid(data.puzzle);
    var solution = stringToGrid(data.solution);
    if (!S.isSolved(solution)) return null;
    var state = fromPuzzle({
      puzzle: puzzle, solution: solution,
      difficulty: data.difficulty, label: data.label, seed: data.seed,
      tier: data.tier, technique: data.technique, givens: data.givens
    }, { autoClearNotes: data.autoClearNotes });
    var values = stringToGrid(data.values);
    for (var i = 0; i < CELLS; i++) {
      /* 提示格一律以題目為準，避免存檔被竄改後盤面不合法 */
      state.values[i] = state.given[i] ? puzzle[i] : values[i];
      var n = (data.notes && data.notes[i]) | 0;
      state.notes[i] = state.values[i] ? 0 : (n & S.FULL_MASK);
    }
    state.hintsUsed = data.hintsUsed | 0;
    state.mistakes = data.mistakes | 0;
    state.elapsedMs = Math.max(0, data.elapsedMs | 0);
    state.createdAt = data.createdAt || Date.now();
    state.finishedAt = data.finishedAt || 0;
    state.status = isWon(state) ? 'won' : 'playing';
    return state;
  }

  /* ---------- 線上觀戰用的唯讀快照 ----------
   * 觀戰＝主持人狀態的唯讀鏡像，所以「要送什麼」只有這裡一份定義，主持人與觀戰端共用。
   * 刻意不送 solution：觀戰者不需要答案，也不該從網路封包裡拿得到。
   * 衝突、剩餘數量、每個數字還剩幾格，觀戰端都用同一份 sudoku.js 自己算，規則核心不會分岔。 */
  function spectatorSnapshot(state, extra) {
    var e = extra || {};
    return {
      puzzle: gridToString(state.puzzle),
      values: gridToString(state.values),
      notes: state.notes.slice(),
      selected: (typeof e.selected === 'number' && e.selected >= 0 && e.selected < CELLS) ? e.selected : -1,
      elapsedMs: Math.max(0, Math.floor(state.elapsedMs || 0)),
      hintsUsed: state.hintsUsed | 0,
      mistakes: state.mistakes | 0,
      status: state.status === 'won' ? 'won' : 'playing',
      paused: !!e.paused
    };
  }

  /* 觀戰端：把快照變成一個欄位名稱與一般局面相同的物件，
   * 這樣畫面層可以沿用同一套繪製邏輯，差別只在 readOnly 為 true、沒有 solution。 */
  function spectatorView(board) {
    if (!board || typeof board.puzzle !== 'string' || typeof board.values !== 'string') return null;
    if (board.puzzle.length !== CELLS || board.values.length !== CELLS) return null;
    var puzzle = stringToGrid(board.puzzle);
    var values = stringToGrid(board.values);
    var given = new Array(CELLS);
    var notes = new Array(CELLS);
    var i, filled = 0, total = 0;
    for (i = 0; i < CELLS; i++) {
      given[i] = puzzle[i] !== 0;
      /* 題目原本就給的格子一律以題目為準，不接受鏡像資料把它改掉 */
      if (given[i]) values[i] = puzzle[i];
      else {
        total++;
        if (values[i]) filled++;
      }
      var n = (board.notes && board.notes[i]) | 0;
      notes[i] = values[i] ? 0 : (n & S.FULL_MASK);
    }
    var sel = board.selected;
    return {
      readOnly: true,
      puzzle: puzzle,
      values: values,
      given: given,
      notes: notes,
      selected: (typeof sel === 'number' && sel >= 0 && sel < CELLS) ? sel : -1,
      elapsedMs: Math.max(0, Math.floor(board.elapsedMs || 0)),
      hintsUsed: board.hintsUsed | 0,
      mistakes: board.mistakes | 0,
      status: board.status === 'won' ? 'won' : 'playing',
      paused: !!board.paused,
      filled: filled,
      total: total,
      remaining: total - filled
    };
  }

  w.SudokuGame = {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    spectatorSnapshot: spectatorSnapshot,
    spectatorView: spectatorView,
    create: create,
    fromPuzzle: fromPuzzle,
    remaining: remaining,
    digitCounts: digitCounts,
    conflicts: conflicts,
    wrongCells: wrongCells,
    isWon: isWon,
    setValue: setValue,
    toggleNote: toggleNote,
    clearCell: clearCell,
    undo: undo,
    redo: redo,
    hint: hint,
    restart: restart,
    serialize: serialize,
    deserialize: deserialize,
    gridToString: gridToString,
    stringToGrid: stringToGrid
  };
})(typeof window !== 'undefined' ? window : globalThis);
