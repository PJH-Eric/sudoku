/* ===== sudoku.js — 數獨規則核心 =====
 * 這個檔案只處理「規則」：盤面表示、合法性、解題、唯一解驗證、出題挖洞、難度分級與提示。
 * 完全不碰 DOM、不碰音訊、不碰儲存，因此瀏覽器與 Node 單元測試可以共用同一份程式。
 *
 * 盤面資料格式：長度 81 的一般陣列，索引 0..80（由左而右、由上而下），值 0 代表空格，1..9 代表數字。
 * 候選數以 9 位元的位元遮罩表示：數字 d 對應 bit (d - 1)。
 */
(function (w) {
  'use strict';

  var SIZE = 9;
  var CELLS = 81;
  var FULL = 0x1FF;               // 9 個 bit 全開 = 候選數 1..9

  /* ---------- 位元工具 ---------- */
  var BIT = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256];
  var POPCOUNT = new Uint8Array(512);
  var LOWEST = new Uint8Array(512);       // 遮罩 -> 最小的候選數字（1..9），0 表示沒有
  (function () {
    for (var m = 1; m < 512; m++) {
      POPCOUNT[m] = POPCOUNT[m >> 1] + (m & 1);
      for (var d = 1; d <= 9; d++) {
        if (m & BIT[d]) { LOWEST[m] = d; break; }
      }
    }
  })();

  function maskToDigits(mask) {
    var out = [];
    for (var d = 1; d <= 9; d++) if (mask & BIT[d]) out.push(d);
    return out;
  }

  /* ---------- 幾何：列、行、宮、同儕格 ---------- */
  var ROW_OF = new Uint8Array(CELLS);
  var COL_OF = new Uint8Array(CELLS);
  var BOX_OF = new Uint8Array(CELLS);
  var UNITS = [];                 // 27 個單元（9 列 + 9 行 + 9 宮），每個是 9 個索引
  var UNIT_KIND = [];             // 'row' | 'col' | 'box'
  var UNIT_NO = [];               // 該類型中的第幾個（0 起算）
  var UNITS_OF = [];              // 每格所屬的 3 個單元編號
  var PEERS = [];                 // 每格的 20 個同儕格

  (function build() {
    var i, r, c;
    for (i = 0; i < CELLS; i++) {
      ROW_OF[i] = (i / SIZE) | 0;
      COL_OF[i] = i % SIZE;
      BOX_OF[i] = (((i / 27) | 0) * 3) + (((i % SIZE) / 3) | 0);
    }
    for (r = 0; r < SIZE; r++) {
      var row = [];
      for (c = 0; c < SIZE; c++) row.push(r * SIZE + c);
      UNITS.push(row); UNIT_KIND.push('row'); UNIT_NO.push(r);
    }
    for (c = 0; c < SIZE; c++) {
      var col = [];
      for (r = 0; r < SIZE; r++) col.push(r * SIZE + c);
      UNITS.push(col); UNIT_KIND.push('col'); UNIT_NO.push(c);
    }
    for (var b = 0; b < SIZE; b++) {
      var box = [];
      var br = ((b / 3) | 0) * 3;
      var bc = (b % 3) * 3;
      for (var dr = 0; dr < 3; dr++) {
        for (var dc = 0; dc < 3; dc++) box.push((br + dr) * SIZE + bc + dc);
      }
      UNITS.push(box); UNIT_KIND.push('box'); UNIT_NO.push(b);
    }
    for (i = 0; i < CELLS; i++) { UNITS_OF.push([]); PEERS.push([]); }
    for (var u = 0; u < UNITS.length; u++) {
      for (var k = 0; k < UNITS[u].length; k++) UNITS_OF[UNITS[u][k]].push(u);
    }
    for (i = 0; i < CELLS; i++) {
      var seen = {};
      for (var j = 0; j < UNITS_OF[i].length; j++) {
        var unit = UNITS[UNITS_OF[i][j]];
        for (var t = 0; t < unit.length; t++) {
          var p = unit[t];
          if (p !== i && !seen[p]) { seen[p] = 1; PEERS[i].push(p); }
        }
      }
    }
  })();

  /* ---------- 盤面基本操作 ---------- */
  function emptyGrid() {
    var g = new Array(CELLS);
    for (var i = 0; i < CELLS; i++) g[i] = 0;
    return g;
  }
  function cloneGrid(grid) { return grid.slice(); }

  function cellName(index) {
    return 'R' + (ROW_OF[index] + 1) + 'C' + (COL_OF[index] + 1);
  }
  function unitName(unitIndex) {
    var no = UNIT_NO[unitIndex] + 1;
    if (UNIT_KIND[unitIndex] === 'row') return '第 ' + no + ' 列';
    if (UNIT_KIND[unitIndex] === 'col') return '第 ' + no + ' 行';
    return '第 ' + no + ' 宮';
  }

  /* 某格填入某數字是否不違反規則（不看該格自己原本的值） */
  function isLegal(grid, index, digit) {
    if (!digit) return true;
    var peers = PEERS[index];
    for (var i = 0; i < peers.length; i++) {
      if (grid[peers[i]] === digit) return false;
    }
    return true;
  }

  /* 找出所有互相衝突的格子；回傳長度 81 的 0/1 陣列 */
  function findConflicts(grid) {
    var flags = new Array(CELLS);
    var i;
    for (i = 0; i < CELLS; i++) flags[i] = 0;
    for (var u = 0; u < UNITS.length; u++) {
      var unit = UNITS[u];
      var seen = {};
      for (i = 0; i < unit.length; i++) {
        var v = grid[unit[i]];
        if (!v) continue;
        if (seen[v] === undefined) seen[v] = unit[i];
        else { flags[unit[i]] = 1; flags[seen[v]] = 1; }
      }
    }
    return flags;
  }

  function isFilled(grid) {
    for (var i = 0; i < CELLS; i++) if (!grid[i]) return false;
    return true;
  }

  /* 盤面是否已經完成（填滿且完全合法） */
  function isSolved(grid) {
    if (!isFilled(grid)) return false;
    var flags = findConflicts(grid);
    for (var i = 0; i < CELLS; i++) if (flags[i]) return false;
    return true;
  }

  /* 單一格目前的候選數遮罩（依同儕格已填數字扣除） */
  function candidates(grid, index) {
    if (grid[index]) return 0;
    var mask = FULL;
    var peers = PEERS[index];
    for (var i = 0; i < peers.length; i++) {
      var v = grid[peers[i]];
      if (v) mask &= ~BIT[v];
    }
    return mask;
  }

  function buildCandidates(grid) {
    var cand = new Array(CELLS);
    for (var i = 0; i < CELLS; i++) cand[i] = candidates(grid, i);
    return cand;
  }

  /* ---------- 回溯解題與唯一解驗證 ---------- */
  /* 計算解的數量，最多算到 limit 個就停（驗證唯一解時 limit = 2 即可）。
   * order 若給定，會依該順序挑選同分的格子，讓產生答案時可以受種子控制。 */
  function countSolutions(grid, limit, order) {
    var max = limit || 2;
    var work = grid.slice();
    var cand = buildCandidates(work);
    var found = 0;
    var firstSolution = null;

    function place(index, digit, undo) {
      work[index] = digit;
      undo.push([index, cand[index]]);
      cand[index] = 0;
      var peers = PEERS[index];
      var b = ~BIT[digit];
      for (var i = 0; i < peers.length; i++) {
        var p = peers[i];
        if (!work[p] && (cand[p] & BIT[digit])) {
          undo.push([p, cand[p]]);
          cand[p] &= b;
          if (cand[p] === 0) return false;
        }
      }
      return true;
    }
    function rollback(undo, from) {
      for (var i = undo.length - 1; i >= from; i--) {
        var e = undo[i];
        if (work[e[0]] && cand[e[0]] === 0 && e[1] !== 0) work[e[0]] = 0;
        cand[e[0]] = e[1];
      }
      undo.length = from;
    }

    function search() {
      /* MRV：挑候選數最少的空格 */
      var best = -1, bestCount = 10;
      for (var i = 0; i < CELLS; i++) {
        if (work[i]) continue;
        var n = POPCOUNT[cand[i]];
        if (n === 0) return false;
        if (n < bestCount) { bestCount = n; best = i; if (n === 1) break; }
      }
      if (best < 0) {
        found++;
        if (!firstSolution) firstSolution = work.slice();
        return found >= max;
      }
      var digits = maskToDigits(cand[best]);
      if (order) {
        /* 依外部給的順序決定嘗試數字的先後，讓產生答案可被種子控制 */
        var pref = order[best] || null;
        if (pref) {
          digits.sort(function (a, b2) { return pref.indexOf(a) - pref.indexOf(b2); });
        }
      }
      for (var k = 0; k < digits.length; k++) {
        var undo = [];
        var mark = 0;
        var ok = place(best, digits[k], undo);
        if (ok && search()) { rollback(undo, mark); return true; }
        rollback(undo, mark);
        work[best] = 0;
      }
      return false;
    }

    search();
    return { count: found, solution: firstSolution };
  }

  /* 求出第一組解；無解回傳 null */
  function solve(grid) {
    return countSolutions(grid, 1).solution;
  }

  function hasUniqueSolution(grid) {
    return countSolutions(grid, 2).count === 1;
  }

  /* ---------- 產生完整解答 ---------- */
  function generateSolution(rng) {
    var next = rng || Math.random;
    var grid = emptyGrid();
    var cand = buildCandidates(grid);

    function place(index, digit, undo) {
      grid[index] = digit;
      undo.push([index, cand[index]]);
      cand[index] = 0;
      var peers = PEERS[index];
      var b = ~BIT[digit];
      for (var i = 0; i < peers.length; i++) {
        var p = peers[i];
        if (!grid[p] && (cand[p] & BIT[digit])) {
          undo.push([p, cand[p]]);
          cand[p] &= b;
          if (cand[p] === 0) return false;
        }
      }
      return true;
    }
    function rollback(undo) {
      for (var i = undo.length - 1; i >= 0; i--) {
        var e = undo[i];
        if (cand[e[0]] === 0 && e[1] !== 0) grid[e[0]] = 0;
        cand[e[0]] = e[1];
      }
    }

    function fill() {
      var best = -1, bestCount = 10;
      for (var i = 0; i < CELLS; i++) {
        if (grid[i]) continue;
        var n = POPCOUNT[cand[i]];
        if (n === 0) return false;
        if (n < bestCount) { bestCount = n; best = i; if (n === 1) break; }
      }
      if (best < 0) return true;
      var digits = w.RNG ? w.RNG.shuffle(maskToDigits(cand[best]), next) : maskToDigits(cand[best]);
      for (var k = 0; k < digits.length; k++) {
        var undo = [];
        if (place(best, digits[k], undo) && fill()) return true;
        rollback(undo);
        grid[best] = 0;
      }
      return false;
    }

    fill();
    return grid;
  }

  /* ---------- 人類解法：技巧分級 ----------
   * 1 唯一候選數 Naked Single
   * 2 隱藏唯一數 Hidden Single
   * 3 區塊摒除 Locked Candidates／裸對 Naked Pair
   * 4 裸三、隱藏對、X-Wing
   * 5 以上都不夠，需要試誤或更進階的鏈結技巧
   */
  var TIER = { SINGLE: 1, HIDDEN: 2, LOCKED: 3, ADVANCED: 4, GUESS: 5 };
  var TIER_NAMES = {
    1: '唯一候選數',
    2: '隱藏唯一數',
    3: '區塊摒除／裸對',
    4: '裸三、隱藏對與 X-Wing',
    5: '需要試誤推理'
  };
  /* 給玩家看的技巧說明（出現在難度卡與結算畫面） */
  var TIER_HINTS = {
    1: '每一步都會有某一格只剩一個數字可以填。',
    2: '需要找出「某個數字在這一列／行／宮只剩一格能放」。',
    3: '需要用到區塊摒除或裸對，先刪候選數才推得下去。',
    4: '需要裸三、隱藏對或 X-Wing 這類進階刪除。',
    5: '基本技巧推不完，需要試誤或更進階的鏈結推理。'
  };

  function makeSolverState(grid) {
    return { grid: grid.slice(), cand: buildCandidates(grid) };
  }

  function solverPlace(st, index, digit) {
    st.grid[index] = digit;
    st.cand[index] = 0;
    var peers = PEERS[index];
    var b = ~BIT[digit];
    for (var i = 0; i < peers.length; i++) st.cand[peers[i]] &= b;
  }

  function hasContradiction(st) {
    for (var i = 0; i < CELLS; i++) {
      if (!st.grid[i] && st.cand[i] === 0) return true;
    }
    return false;
  }

  /* --- 技巧 1：唯一候選數 --- */
  function techNakedSingle(st) {
    for (var i = 0; i < CELLS; i++) {
      if (st.grid[i] || POPCOUNT[st.cand[i]] !== 1) continue;
      var d = LOWEST[st.cand[i]];
      return {
        tier: TIER.SINGLE, technique: '唯一候選數', index: i, digit: d, placed: true,
        reason: cellName(i) + ' 的同列、同行、同宮已經用掉其他 8 個數字，所以只能填 ' + d + '。'
      };
    }
    return null;
  }

  /* --- 技巧 2：隱藏唯一數 --- */
  function techHiddenSingle(st) {
    for (var u = 0; u < UNITS.length; u++) {
      var unit = UNITS[u];
      for (var d = 1; d <= 9; d++) {
        var bit = BIT[d];
        var spot = -1, n = 0, used = false;
        for (var k = 0; k < unit.length; k++) {
          var c = unit[k];
          if (st.grid[c] === d) { used = true; break; }
          if (!st.grid[c] && (st.cand[c] & bit)) { n++; spot = c; }
        }
        if (used || n !== 1) continue;
        return {
          tier: TIER.HIDDEN, technique: '隱藏唯一數', index: spot, digit: d, placed: true,
          reason: unitName(u) + '裡面只有 ' + cellName(spot) + ' 放得下 ' + d + '，所以這格填 ' + d + '。'
        };
      }
    }
    return null;
  }

  /* --- 技巧 3a：區塊摒除（宮 → 列/行、列/行 → 宮） --- */
  function techLockedCandidates(st) {
    var u, d, k, c, cells, removed, i;
    /* 宮內某數字只出現在同一列或同一行 → 該列／行的宮外格可刪除此候選 */
    for (u = 18; u < 27; u++) {
      cells = UNITS[u];
      for (d = 1; d <= 9; d++) {
        var spots = [];
        var digitUsed = false;
        for (k = 0; k < cells.length; k++) {
          if (st.grid[cells[k]] === d) { digitUsed = true; break; }
          if (!st.grid[cells[k]] && (st.cand[cells[k]] & BIT[d])) spots.push(cells[k]);
        }
        if (digitUsed || spots.length < 2) continue;
        var sameRow = true, sameCol = true;
        for (k = 1; k < spots.length; k++) {
          if (ROW_OF[spots[k]] !== ROW_OF[spots[0]]) sameRow = false;
          if (COL_OF[spots[k]] !== COL_OF[spots[0]]) sameCol = false;
        }
        var line = null, lineLabel = '';
        if (sameRow) { line = UNITS[ROW_OF[spots[0]]]; lineLabel = '第 ' + (ROW_OF[spots[0]] + 1) + ' 列'; }
        else if (sameCol) { line = UNITS[9 + COL_OF[spots[0]]]; lineLabel = '第 ' + (COL_OF[spots[0]] + 1) + ' 行'; }
        if (!line) continue;
        removed = 0;
        for (k = 0; k < line.length; k++) {
          c = line[k];
          if (BOX_OF[c] === UNIT_NO[u]) continue;
          if (!st.grid[c] && (st.cand[c] & BIT[d])) { st.cand[c] &= ~BIT[d]; removed++; }
        }
        if (removed) {
          return {
            tier: TIER.LOCKED, technique: '區塊摒除', placed: false, eliminated: removed, digit: d,
            reason: unitName(u) + '的 ' + d + ' 只能落在' + lineLabel + '，所以' + lineLabel + '其他宮的格子可以刪掉 ' + d + '。'
          };
        }
      }
    }
    /* 列／行內某數字只出現在同一宮 → 該宮其他格可刪除此候選 */
    for (u = 0; u < 18; u++) {
      cells = UNITS[u];
      for (d = 1; d <= 9; d++) {
        var lineSpots = [];
        var seen = false;
        for (k = 0; k < cells.length; k++) {
          if (st.grid[cells[k]] === d) { seen = true; break; }
          if (!st.grid[cells[k]] && (st.cand[cells[k]] & BIT[d])) lineSpots.push(cells[k]);
        }
        if (seen || lineSpots.length < 2) continue;
        var box = BOX_OF[lineSpots[0]], same = true;
        for (k = 1; k < lineSpots.length; k++) if (BOX_OF[lineSpots[k]] !== box) { same = false; break; }
        if (!same) continue;
        removed = 0;
        var boxCells = UNITS[18 + box];
        for (k = 0; k < boxCells.length; k++) {
          c = boxCells[k];
          if (UNITS_OF[c].indexOf(u) >= 0) continue;
          if (!st.grid[c] && (st.cand[c] & BIT[d])) { st.cand[c] &= ~BIT[d]; removed++; }
        }
        if (removed) {
          return {
            tier: TIER.LOCKED, technique: '區塊摒除', placed: false, eliminated: removed, digit: d,
            reason: unitName(u) + '的 ' + d + ' 全部落在' + unitName(18 + box) + '，所以該宮其他格子可以刪掉 ' + d + '。'
          };
        }
      }
    }
    return null;
  }

  /* --- 技巧 3b：裸對 --- */
  function techNakedPair(st) {
    for (var u = 0; u < UNITS.length; u++) {
      var unit = UNITS[u];
      for (var a = 0; a < unit.length; a++) {
        var ca = unit[a];
        if (st.grid[ca] || POPCOUNT[st.cand[ca]] !== 2) continue;
        for (var b = a + 1; b < unit.length; b++) {
          var cb = unit[b];
          if (st.grid[cb] || st.cand[cb] !== st.cand[ca]) continue;
          var removed = 0;
          for (var k = 0; k < unit.length; k++) {
            var c = unit[k];
            if (c === ca || c === cb || st.grid[c]) continue;
            if (st.cand[c] & st.cand[ca]) { st.cand[c] &= ~st.cand[ca]; removed++; }
          }
          if (removed) {
            var ds = maskToDigits(st.cand[ca]).join(' 和 ');
            return {
              tier: TIER.LOCKED, technique: '裸對', placed: false, eliminated: removed,
              reason: unitName(u) + '的 ' + cellName(ca) + '、' + cellName(cb) + ' 只能是 ' + ds +
                '，所以同一單元其他格子不能再填這兩個數字。'
            };
          }
        }
      }
    }
    return null;
  }

  /* --- 技巧 4a：裸三 --- */
  function techNakedTriple(st) {
    for (var u = 0; u < UNITS.length; u++) {
      var unit = UNITS[u];
      var open = [];
      for (var k = 0; k < unit.length; k++) {
        var c = unit[k];
        if (!st.grid[c] && POPCOUNT[st.cand[c]] >= 2 && POPCOUNT[st.cand[c]] <= 3) open.push(c);
      }
      for (var a = 0; a < open.length; a++) {
        for (var b = a + 1; b < open.length; b++) {
          for (var d = b + 1; d < open.length; d++) {
            var mask = st.cand[open[a]] | st.cand[open[b]] | st.cand[open[d]];
            if (POPCOUNT[mask] !== 3) continue;
            var removed = 0;
            for (var t = 0; t < unit.length; t++) {
              var cc = unit[t];
              if (cc === open[a] || cc === open[b] || cc === open[d] || st.grid[cc]) continue;
              if (st.cand[cc] & mask) { st.cand[cc] &= ~mask; removed++; }
            }
            if (removed) {
              return {
                tier: TIER.ADVANCED, technique: '裸三', placed: false, eliminated: removed,
                reason: unitName(u) + '的 ' + cellName(open[a]) + '、' + cellName(open[b]) + '、' + cellName(open[d]) +
                  ' 三格只用得到 ' + maskToDigits(mask).join('、') + '，其他格子可以刪掉這些數字。'
              };
            }
          }
        }
      }
    }
    return null;
  }

  /* --- 技巧 4b：隱藏對 --- */
  function techHiddenPair(st) {
    for (var u = 0; u < UNITS.length; u++) {
      var unit = UNITS[u];
      for (var d1 = 1; d1 <= 8; d1++) {
        var spots1 = spotsFor(st, unit, d1);
        if (!spots1 || spots1.length !== 2) continue;
        for (var d2 = d1 + 1; d2 <= 9; d2++) {
          var spots2 = spotsFor(st, unit, d2);
          if (!spots2 || spots2.length !== 2) continue;
          if (spots1[0] !== spots2[0] || spots1[1] !== spots2[1]) continue;
          var mask = BIT[d1] | BIT[d2];
          var removed = 0;
          for (var k = 0; k < 2; k++) {
            var c = spots1[k];
            if (st.cand[c] !== mask) { st.cand[c] = mask; removed++; }
          }
          if (removed) {
            return {
              tier: TIER.ADVANCED, technique: '隱藏對', placed: false, eliminated: removed,
              reason: unitName(u) + '裡只有 ' + cellName(spots1[0]) + ' 和 ' + cellName(spots1[1]) +
                ' 放得下 ' + d1 + ' 與 ' + d2 + '，這兩格就只能是這兩個數字。'
            };
          }
        }
      }
    }
    return null;
  }
  function spotsFor(st, unit, d) {
    var out = [];
    for (var k = 0; k < unit.length; k++) {
      var c = unit[k];
      if (st.grid[c] === d) return null;
      if (!st.grid[c] && (st.cand[c] & BIT[d])) out.push(c);
    }
    return out;
  }

  /* --- 技巧 4c：X-Wing --- */
  function techXWing(st) {
    var d, i, j;
    for (d = 1; d <= 9; d++) {
      /* 列方向 */
      var rowSpots = [];
      for (i = 0; i < 9; i++) {
        var s = spotsFor(st, UNITS[i], d);
        rowSpots.push(s && s.length === 2 ? s : null);
      }
      for (i = 0; i < 9; i++) {
        if (!rowSpots[i]) continue;
        for (j = i + 1; j < 9; j++) {
          if (!rowSpots[j]) continue;
          if (COL_OF[rowSpots[i][0]] !== COL_OF[rowSpots[j][0]]) continue;
          if (COL_OF[rowSpots[i][1]] !== COL_OF[rowSpots[j][1]]) continue;
          var cols = [COL_OF[rowSpots[i][0]], COL_OF[rowSpots[i][1]]];
          var removed = 0;
          for (var r = 0; r < 9; r++) {
            if (r === i || r === j) continue;
            for (var t = 0; t < 2; t++) {
              var c = r * 9 + cols[t];
              if (!st.grid[c] && (st.cand[c] & BIT[d])) { st.cand[c] &= ~BIT[d]; removed++; }
            }
          }
          if (removed) {
            return {
              tier: TIER.ADVANCED, technique: 'X-Wing', placed: false, eliminated: removed, digit: d,
              reason: '第 ' + (i + 1) + ' 列與第 ' + (j + 1) + ' 列的 ' + d + ' 都只能落在第 ' +
                (cols[0] + 1) + '、' + (cols[1] + 1) + ' 行，這兩行其他格子可以刪掉 ' + d + '。'
            };
          }
        }
      }
      /* 行方向 */
      var colSpots = [];
      for (i = 0; i < 9; i++) {
        var s2 = spotsFor(st, UNITS[9 + i], d);
        colSpots.push(s2 && s2.length === 2 ? s2 : null);
      }
      for (i = 0; i < 9; i++) {
        if (!colSpots[i]) continue;
        for (j = i + 1; j < 9; j++) {
          if (!colSpots[j]) continue;
          if (ROW_OF[colSpots[i][0]] !== ROW_OF[colSpots[j][0]]) continue;
          if (ROW_OF[colSpots[i][1]] !== ROW_OF[colSpots[j][1]]) continue;
          var rows = [ROW_OF[colSpots[i][0]], ROW_OF[colSpots[i][1]]];
          var removed2 = 0;
          for (var cc = 0; cc < 9; cc++) {
            if (cc === i || cc === j) continue;
            for (var t2 = 0; t2 < 2; t2++) {
              var c2 = rows[t2] * 9 + cc;
              if (!st.grid[c2] && (st.cand[c2] & BIT[d])) { st.cand[c2] &= ~BIT[d]; removed2++; }
            }
          }
          if (removed2) {
            return {
              tier: TIER.ADVANCED, technique: 'X-Wing', placed: false, eliminated: removed2, digit: d,
              reason: '第 ' + (i + 1) + ' 行與第 ' + (j + 1) + ' 行的 ' + d + ' 都只能落在第 ' +
                (rows[0] + 1) + '、' + (rows[1] + 1) + ' 列，這兩列其他格子可以刪掉 ' + d + '。'
            };
          }
        }
      }
    }
    return null;
  }

  var TECHNIQUES = [
    { tier: TIER.SINGLE, run: techNakedSingle },
    { tier: TIER.HIDDEN, run: techHiddenSingle },
    { tier: TIER.LOCKED, run: techLockedCandidates },
    { tier: TIER.LOCKED, run: techNakedPair },
    { tier: TIER.ADVANCED, run: techNakedTriple },
    { tier: TIER.ADVANCED, run: techHiddenPair },
    { tier: TIER.ADVANCED, run: techXWing }
  ];

  /* 以人類技巧解題。maxTier 決定允許用到第幾級技巧。
   * 回傳 { solved, tier, steps, grid }；tier 為實際用到的最高技巧等級。 */
  function humanSolve(grid, maxTier, collectSteps) {
    var cap = maxTier || TIER.ADVANCED;
    var st = makeSolverState(grid);
    var usedTier = 0;
    var steps = collectSteps ? [] : null;
    var guard = 0;
    for (;;) {
      if (guard++ > 2000) break;
      if (hasContradiction(st)) return { solved: false, contradiction: true, tier: usedTier, steps: steps, grid: st.grid };
      if (isFilled(st.grid)) break;
      var step = null;
      for (var t = 0; t < TECHNIQUES.length; t++) {
        if (TECHNIQUES[t].tier > cap) continue;
        step = TECHNIQUES[t].run(st);
        if (step) break;
      }
      if (!step) break;
      if (step.tier > usedTier) usedTier = step.tier;
      if (steps) steps.push(step);
      if (step.placed) solverPlace(st, step.index, step.digit);
    }
    var solved = isFilled(st.grid);
    return {
      solved: solved,
      tier: solved ? Math.max(usedTier, TIER.SINGLE) : TIER.GUESS,
      steps: steps,
      grid: st.grid
    };
  }

  /* 題目難度分級：回傳 1..5 */
  function grade(grid) {
    return humanSolve(grid, TIER.ADVANCED).tier;
  }

  /* 提示：回傳下一個可以「填入數字」的邏輯步驟。
   * 若純邏輯無法推進（需要試誤），而且有提供答案，就直接揭示一格。 */
  function nextStep(grid, solution) {
    var st = makeSolverState(grid);
    var usedTier = 0;
    var guard = 0;
    for (;;) {
      if (guard++ > 2000) break;
      if (hasContradiction(st)) break;
      if (isFilled(st.grid)) return null;
      var step = null;
      for (var t = 0; t < TECHNIQUES.length; t++) {
        step = TECHNIQUES[t].run(st);
        if (step) break;
      }
      if (!step) break;
      if (step.tier > usedTier) usedTier = step.tier;
      if (step.placed) {
        step.viaTier = usedTier;
        return step;
      }
      /* 純消去的步驟先套用，繼續找下一個可填入的格子 */
    }
    if (solution) {
      for (var i = 0; i < CELLS; i++) {
        if (!grid[i]) {
          return {
            tier: TIER.GUESS, technique: '直接揭示', index: i, digit: solution[i], placed: true, viaTier: TIER.GUESS,
            reason: cellName(i) + ' 已經超出一般技巧能推出的範圍，直接告訴你答案是 ' + solution[i] + '。'
          };
        }
      }
    }
    return null;
  }

  /* ---------- 出題：挖洞 ---------- */
  var DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
  /* 難度＝「所需技巧等級」＋「提示數上限」兩件事一起控制：
   *   maxTier      挖洞過程中允許用到的最高技巧（超過就不挖，確保題目不會太難）
   *   minTier      題目至少要用到的技巧（不到就繼續挖／換一組重來，確保題目不會太簡單）
   *   targetGivens 提示數挖到這個數量以下才算達標
   *   minGivens    絕不挖到比這更少，避免同一難度差太多 */
  var PRESETS = {
    easy:   { label: '簡單', maxTier: TIER.SINGLE,   minTier: TIER.SINGLE,   targetGivens: 42, minGivens: 36, symmetry: true,  attempts: 8 },
    medium: { label: '普通', maxTier: TIER.HIDDEN,   minTier: TIER.HIDDEN,   targetGivens: 34, minGivens: 28, symmetry: true,  attempts: 12 },
    hard:   { label: '困難', maxTier: TIER.ADVANCED, minTier: TIER.LOCKED,   targetGivens: 32, minGivens: 23, symmetry: true,  attempts: 48 },
    expert: { label: '專家', maxTier: TIER.GUESS,    minTier: TIER.GUESS,    targetGivens: 26, minGivens: 20, symmetry: false, attempts: 20 }
  };

  /* 依序嘗試挖洞：
   * 1. 只有在「仍是唯一解」且「不超過允許技巧上限」時才真的挖掉。
   * 2. 挖到目標提示數之後，如果難度還沒到下限，就繼續挖，直到達標或沒得挖。 */
  function dig(solution, rng, preset) {
    var grid = solution.slice();
    var order = [];
    for (var i = 0; i < CELLS; i++) order.push(i);
    if (w.RNG) w.RNG.shuffle(order, rng);
    var givens = CELLS;
    var tier = TIER.SINGLE;

    for (var k = 0; k < order.length; k++) {
      var a = order[k];
      if (!grid[a]) continue;
      var group = [a];
      if (preset.symmetry) {
        var b = CELLS - 1 - a;
        if (b !== a && grid[b]) group.push(b);
      }
      if (givens - group.length < preset.minGivens) continue;

      var backup = [];
      var t;
      for (t = 0; t < group.length; t++) { backup.push(grid[group[t]]); grid[group[t]] = 0; }

      var ok = countSolutions(grid, 2).count === 1;
      if (ok && preset.maxTier < TIER.GUESS) {
        ok = humanSolve(grid, preset.maxTier).solved;
      }
      if (!ok) {
        for (t = 0; t < group.length; t++) grid[group[t]] = backup[t];
        continue;
      }
      givens -= group.length;
      if (givens <= preset.targetGivens) {
        tier = grade(grid);
        if (tier >= preset.minTier) break;
      }
    }
    if (givens > preset.targetGivens || tier < preset.minTier) tier = grade(grid);
    return { grid: grid, givens: givens, tier: tier };
  }

  /* 產生一題。傳入相同的 seed 與 difficulty 一定得到同一題。 */
  function generatePuzzle(options) {
    var opts = options || {};
    var difficulty = PRESETS[opts.difficulty] ? opts.difficulty : 'easy';
    var preset = PRESETS[difficulty];
    var seed = (opts.seed === undefined || opts.seed === null || opts.seed === '')
      ? (w.RNG ? w.RNG.randomSeed() : String(Date.now()))
      : opts.seed;
    var maxAttempts = opts.attempts || preset.attempts;
    var best = null;

    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      var rng = w.RNG ? w.RNG.createRng(String(seed) + '#' + difficulty + '#' + attempt) : Math.random;
      var solution = generateSolution(rng);
      var res = dig(solution, rng, preset);
      var candidate = {
        puzzle: res.grid,
        solution: solution,
        givens: res.givens,
        tier: res.tier,
        technique: TIER_NAMES[res.tier],
        difficulty: difficulty,
        label: preset.label,
        seed: String(seed),
        attempts: attempt + 1
      };
      if (res.tier >= preset.minTier && res.givens <= preset.targetGivens) return candidate;
      if (!best || res.tier > best.tier || (res.tier === best.tier && res.givens < best.givens)) best = candidate;
    }
    return best;
  }

  w.Sudoku = {
    SIZE: SIZE, CELLS: CELLS, FULL_MASK: FULL, BIT: BIT,
    ROW_OF: ROW_OF, COL_OF: COL_OF, BOX_OF: BOX_OF,
    UNITS: UNITS, PEERS: PEERS,
    TIER: TIER, TIER_NAMES: TIER_NAMES, TIER_HINTS: TIER_HINTS,
    DIFFICULTIES: DIFFICULTIES, PRESETS: PRESETS,
    emptyGrid: emptyGrid, cloneGrid: cloneGrid, cellName: cellName,
    maskToDigits: maskToDigits, popcount: function (m) { return POPCOUNT[m]; },
    isLegal: isLegal, findConflicts: findConflicts, isFilled: isFilled, isSolved: isSolved,
    candidates: candidates, buildCandidates: buildCandidates,
    countSolutions: countSolutions, solve: solve, hasUniqueSolution: hasUniqueSolution,
    generateSolution: generateSolution,
    humanSolve: humanSolve, grade: grade, nextStep: nextStep,
    dig: dig, generatePuzzle: generatePuzzle
  };
})(typeof window !== 'undefined' ? window : globalThis);
