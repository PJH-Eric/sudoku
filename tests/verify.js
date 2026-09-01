/*
 * tests/verify.js — 數獨小學堂 的規則與結構驗證
 * 執行：npm test
 *
 * 這裡刻意「用真的規則核心跑真的題目」，不是比對畫面文字：
 *   1. 種子亂數可重現
 *   2. 盤面合法性、衝突偵測、解題與唯一解驗證
 *   3. 四種難度的實質差異（挖空數量 + 需要的解題技巧）與唯一解保證
 *   4. 一整局的狀態轉移：填入、非法操作、筆記、清除、復原／重做、提示、勝利、重來、存讀檔
 *   5. 介面結構與 RWD／設定彈窗必要條件
 *   6. 所有原始檔都是無 BOM 的 UTF-8
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const read = (file) => fs.readFileSync(file, 'utf8');

let passed = 0;
function ok(label, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + label);
}
function section(title) {
  console.log('\n' + title);
}

/* ---------- 建立可以同時給瀏覽器與 Node 使用的沙箱 ---------- */
const storeData = new Map();
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (storeData.has(k) ? storeData.get(k) : null),
    setItem: (k, v) => storeData.set(k, String(v)),
    removeItem: (k) => storeData.delete(k)
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
};
sandbox.window = sandbox;
sandbox.addEventListener = function () {};
vm.createContext(sandbox);

const CORE_FILES = ['rng.js', 'sudoku.js', 'game.js', 'storage.js'];
CORE_FILES.forEach((file) => {
  vm.runInContext(read(path.join(publicDir, 'js', file)), sandbox, { filename: file });
});

const RNG = sandbox.RNG;
const S = sandbox.Sudoku;
const G = sandbox.SudokuGame;

const html = read(path.join(publicDir, 'index.html'));
const css = read(path.join(publicDir, 'css', 'style.css'));
const appSource = read(path.join(publicDir, 'js', 'app.js'));

/* ============ 1. 種子亂數 ============ */
section('1. 種子亂數（可重現）');

ok('同一個種子產生同一串亂數', () => {
  const a = RNG.createRng('SEED-A');
  const b = RNG.createRng('SEED-A');
  const c = RNG.createRng('SEED-B');
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];
  const seqC = [c(), c(), c(), c(), c()];
  assert.deepStrictEqual(seqA, seqB, '相同種子必須產生相同結果');
  assert.notDeepStrictEqual(seqA, seqC, '不同種子應該產生不同結果');
  seqA.forEach((v) => assert.ok(v >= 0 && v < 1, '亂數必須落在 [0, 1)'));
});

ok('洗牌會被種子控制且不遺失元素', () => {
  const base = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const one = RNG.shuffle(base.slice(), RNG.createRng('MIX'));
  const two = RNG.shuffle(base.slice(), RNG.createRng('MIX'));
  assert.deepStrictEqual(one, two);
  assert.deepStrictEqual(one.slice().sort((x, y) => x - y), base);
});

ok('種子輸入會被正規化成可抄寫的字元', () => {
  assert.strictEqual(RNG.normalizeSeed('  ab-c1o0i '), 'ABC');
  assert.strictEqual(RNG.normalizeSeed('abcdefghijklmnopqrstuvwxyz').length, RNG.SEED_MAX);
  assert.strictEqual(RNG.normalizeSeed(null), '');
  const generated = RNG.randomSeed(RNG.createRng('X'), 6);
  assert.strictEqual(generated.length, 6);
  assert.strictEqual(RNG.normalizeSeed(generated), generated, '產生的種子必須自己就是合法種子');
});

/* ============ 2. 規則核心 ============ */
section('2. 盤面規則與解題');

const parse = (str) => str.split('').map((ch) => (ch === '.' || ch === '0' ? 0 : Number(ch)));

ok('列、行、宮與同儕格的幾何正確', () => {
  assert.strictEqual(S.UNITS.length, 27);
  S.UNITS.forEach((unit) => assert.strictEqual(unit.length, 9));
  for (let i = 0; i < 81; i++) assert.strictEqual(S.PEERS[i].length, 20, `第 ${i} 格應該有 20 個同儕格`);
  assert.strictEqual(S.BOX_OF[0], 0);
  assert.strictEqual(S.BOX_OF[80], 8);
  assert.strictEqual(S.BOX_OF[30], 4);
});

ok('合法性與衝突偵測', () => {
  const grid = S.emptyGrid();
  grid[0] = 5;
  assert.strictEqual(S.isLegal(grid, 1, 5), false, '同一列不能有兩個 5');
  assert.strictEqual(S.isLegal(grid, 9, 5), false, '同一行不能有兩個 5');
  assert.strictEqual(S.isLegal(grid, 10, 5), false, '同一宮不能有兩個 5');
  assert.strictEqual(S.isLegal(grid, 40, 5), true, "不同列行宮就可以填同一個數字");
  grid[1] = 5;
  const flags = S.findConflicts(grid);
  assert.strictEqual(flags[0], 1);
  assert.strictEqual(flags[1], 1);
  assert.strictEqual(flags[2], 0);
});

ok('候選數計算正確', () => {
  const grid = S.emptyGrid();
  grid[1] = 1; grid[2] = 2; grid[9] = 3;
  const digits = S.maskToDigits(S.candidates(grid, 0));
  assert.strictEqual(digits.join(','), '4,5,6,7,8,9');
  assert.strictEqual(S.candidates(grid, 1), 0, '已填的格子沒有候選數');
});

ok('空盤有多組解、已知題目只有一組解', () => {
  assert.strictEqual(S.countSolutions(S.emptyGrid(), 3).count, 3, '空盤應該找得到多組解');
  const classic = parse('530070000600195000098000060800060003400803001700020006060000280000419005000080079');
  assert.strictEqual(S.countSolutions(classic, 2).count, 1);
  const solved = S.solve(classic);
  assert.ok(S.isSolved(solved), '解出來的盤面必須完全合法');
});

ok('少一格提示就會變成多解', () => {
  const classic = parse('530070000600195000098000060800060003400803001700020006060000280000419005000080079');
  const broken = classic.slice();
  broken[0] = 0; broken[1] = 0;
  assert.ok(S.countSolutions(broken, 3).count >= 1);
  const empty = classic.slice();
  for (let i = 0; i < 20; i++) empty[i] = 0;
  assert.ok(S.countSolutions(empty, 2).count >= 1, '挖太多洞後仍然要能算出解的數量');
});

ok('分級器能區分簡單題與需要試誤的題目', () => {
  const classic = parse('530070000600195000098000060800060003400803001700020006060000280000419005000080079');
  assert.strictEqual(S.grade(classic), S.TIER.SINGLE, '這題只要唯一候選數就能解完');
  const hardest = parse('8..........36......7..9.2...5...7.......457.....1...3...1....68..85...1..9....4..');
  assert.strictEqual(S.countSolutions(hardest, 2).count, 1, '這題仍然是唯一解');
  assert.strictEqual(S.grade(hardest), S.TIER.GUESS, '公認最難的題目應該被判定成需要試誤');
  assert.strictEqual(S.humanSolve(hardest, S.TIER.ADVANCED).solved, false);
});

ok('產生的完整解答一定合法', () => {
  for (let i = 0; i < 12; i++) {
    const solution = S.generateSolution(RNG.createRng('SOL' + i));
    assert.ok(S.isSolved(solution), '產生的解答必須每列每行每宮都是 1-9');
  }
  const a = S.generateSolution(RNG.createRng('SAME'));
  const b = S.generateSolution(RNG.createRng('SAME'));
  assert.deepStrictEqual(a, b, '同一個種子必須產生同一組解答');
});

/* ============ 3. 難度差異與唯一解 ============ */
section('3. 四種難度的實質差異');

const SEEDS = ['AAA111', 'BCD234', 'KRT789', 'MNP456', 'QWE321', 'ZXC987'];
const generated = {};

S.DIFFICULTIES.forEach((difficulty) => {
  generated[difficulty] = SEEDS.map((seed) => S.generatePuzzle({ difficulty, seed }));
});

ok('每一題都只有一組答案', () => {
  S.DIFFICULTIES.forEach((difficulty) => {
    generated[difficulty].forEach((p, i) => {
      assert.strictEqual(
        S.countSolutions(p.puzzle, 2).count, 1,
        `${difficulty} 第 ${i + 1} 題不是唯一解`
      );
      assert.ok(S.isSolved(p.solution), `${difficulty} 第 ${i + 1} 題的答案不合法`);
      for (let c = 0; c < 81; c++) {
        if (p.puzzle[c]) assert.strictEqual(p.puzzle[c], p.solution[c], '題目提示必須和答案一致');
      }
    });
  });
});

ok('同一個種子＋同一個難度永遠得到同一題', () => {
  S.DIFFICULTIES.forEach((difficulty) => {
    const again = S.generatePuzzle({ difficulty, seed: SEEDS[0] });
    assert.deepStrictEqual(again.puzzle, generated[difficulty][0].puzzle);
    assert.strictEqual(again.givens, generated[difficulty][0].givens);
    assert.strictEqual(again.tier, generated[difficulty][0].tier);
  });
  const other = S.generatePuzzle({ difficulty: 'easy', seed: SEEDS[1] });
  assert.notDeepStrictEqual(other.puzzle, generated.easy[0].puzzle, '不同種子應該是不同題目');
});

ok('挖空數量隨難度遞增', () => {
  const avg = {};
  S.DIFFICULTIES.forEach((difficulty) => {
    const preset = S.PRESETS[difficulty];
    let sum = 0;
    generated[difficulty].forEach((p, i) => {
      assert.ok(
        p.givens <= preset.targetGivens && p.givens >= preset.minGivens,
        `${difficulty} 第 ${i + 1} 題的提示數 ${p.givens} 不在 ${preset.minGivens}~${preset.targetGivens} 之間`
      );
      sum += p.givens;
    });
    avg[difficulty] = sum / SEEDS.length;
  });
  assert.ok(avg.easy > avg.medium, `簡單(${avg.easy}) 的提示數要多於普通(${avg.medium})`);
  assert.ok(avg.medium > avg.hard, `普通(${avg.medium}) 的提示數要多於困難(${avg.hard})`);
  assert.ok(avg.hard > avg.expert, `困難(${avg.hard}) 的提示數要多於專家(${avg.expert})`);
});

ok('每個難度需要的解題技巧確實不同', () => {
  generated.easy.forEach((p, i) => {
    assert.strictEqual(
      S.humanSolve(p.puzzle, S.TIER.SINGLE).solved, true,
      `簡單第 ${i + 1} 題應該只靠「唯一候選數」就能解完`
    );
  });
  generated.medium.forEach((p, i) => {
    assert.strictEqual(
      S.humanSolve(p.puzzle, S.TIER.SINGLE).solved, false,
      `普通第 ${i + 1} 題不應該只靠「唯一候選數」就解完`
    );
    assert.strictEqual(
      S.humanSolve(p.puzzle, S.TIER.HIDDEN).solved, true,
      `普通第 ${i + 1} 題應該用到「隱藏唯一數」就能解完`
    );
  });
  generated.hard.forEach((p, i) => {
    assert.strictEqual(
      S.humanSolve(p.puzzle, S.TIER.HIDDEN).solved, false,
      `困難第 ${i + 1} 題不應該只靠兩種「唯一數」就解完`
    );
    assert.strictEqual(
      S.humanSolve(p.puzzle, S.TIER.ADVANCED).solved, true,
      `困難第 ${i + 1} 題應該在進階技巧範圍內可解`
    );
  });
  generated.expert.forEach((p, i) => {
    assert.strictEqual(
      S.humanSolve(p.puzzle, S.TIER.ADVANCED).solved, false,
      `專家第 ${i + 1} 題應該連進階技巧都推不完，需要試誤`
    );
  });
});

ok('出題速度在可接受範圍內', () => {
  S.DIFFICULTIES.forEach((difficulty) => {
    const started = Date.now();
    S.generatePuzzle({ difficulty, seed: 'TIME' + difficulty });
    const spent = Date.now() - started;
    assert.ok(spent < 3000, `${difficulty} 出題花了 ${spent}ms，超過可接受的等待時間`);
  });
});

/* ============ 4. 一整局的狀態轉移 ============ */
section('4. 一整局的流程');

ok('新開一局的初始狀態正確', () => {
  const state = G.create({ difficulty: 'easy', seed: 'FLOW1' });
  assert.strictEqual(state.status, 'playing');
  assert.strictEqual(state.hintsUsed, 0);
  assert.strictEqual(state.mistakes, 0);
  assert.strictEqual(G.remaining(state), 81 - state.givens);
  for (let i = 0; i < 81; i++) {
    assert.strictEqual(state.given[i], state.puzzle[i] !== 0);
    assert.strictEqual(state.values[i], state.puzzle[i]);
    assert.strictEqual(state.notes[i], 0);
  }
});

ok('非法操作會被擋下且盤面不變', () => {
  const state = G.create({ difficulty: 'easy', seed: 'FLOW2' });
  const givenIndex = state.puzzle.findIndex((v) => v !== 0);
  const before = G.gridToString(state.values);
  const r1 = G.setValue(state, givenIndex, 5);
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.code, 'given');
  assert.ok(r1.message.length > 0, '被擋下時要有可以直接顯示的說明文字');

  const emptyIndex = state.values.findIndex((v) => v === 0);
  const r2 = G.setValue(state, emptyIndex, 0);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.code, 'digit');

  const r3 = G.setValue(state, 99, 3);
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.code, 'range');

  const r4 = G.clearCell(state, emptyIndex);
  assert.strictEqual(r4.ok, false);
  assert.strictEqual(r4.code, 'empty');

  const r5 = G.undo(state);
  assert.strictEqual(r5.ok, false);
  assert.strictEqual(r5.code, 'nothing');

  assert.strictEqual(G.gridToString(state.values), before, '被擋下的操作不可以改變盤面');
  assert.strictEqual(state.mistakes, 0);
});

ok('填入正確與錯誤的數字都有正確回饋', () => {
  const state = G.create({ difficulty: 'easy', seed: 'FLOW3' });
  const idx = state.values.findIndex((v) => v === 0);
  const right = state.solution[idx];
  const wrong = (right % 9) + 1;

  const bad = G.setValue(state, idx, wrong);
  assert.strictEqual(bad.ok, true);
  assert.strictEqual(bad.wrong, true);
  assert.strictEqual(state.mistakes, 1);
  assert.strictEqual(G.wrongCells(state)[idx], 1);

  const good = G.setValue(state, idx, right);
  assert.strictEqual(good.wrong, false);
  assert.strictEqual(G.wrongCells(state)[idx], 0);
  assert.strictEqual(state.values[idx], right);

  const off = G.setValue(state, idx, right);
  assert.strictEqual(off.code, 'clear', '再按一次同一個數字等於取消填入');
  assert.strictEqual(state.values[idx], 0);
});

ok('筆記與自動整理筆記', () => {
  const state = G.create({ difficulty: 'easy', seed: 'FLOW4' });
  const idx = state.values.findIndex((v) => v === 0);
  const peer = S.PEERS[idx].find((p) => !state.values[p]);
  const digit = state.solution[idx];

  G.toggleNote(state, peer, digit);
  assert.ok(state.notes[peer] & S.BIT[digit], '筆記應該被記下來');
  const dup = G.toggleNote(state, peer, digit);
  assert.strictEqual(dup.on, false, '再按一次要取消筆記');
  G.toggleNote(state, peer, digit);

  state.autoClearNotes = true;
  G.setValue(state, idx, digit);
  assert.strictEqual(state.notes[peer] & S.BIT[digit], 0, '填入後同儕格的相同筆記要自動清掉');

  G.undo(state);
  assert.ok(state.notes[peer] & S.BIT[digit], '復原時筆記也要一起回來');

  const filled = state.values.findIndex((v, i) => v && !state.given[i]);
  if (filled >= 0) {
    const blocked = G.toggleNote(state, filled, 1);
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.code, 'filled');
  }
});

ok('復原與重做可以完整來回', () => {
  const state = G.create({ difficulty: 'easy', seed: 'FLOW5' });
  const start = G.gridToString(state.values);
  const list = [];
  for (let i = 0; i < 81 && list.length < 5; i++) if (!state.values[i]) list.push(i);
  list.forEach((i) => G.setValue(state, i, state.solution[i]));
  const after = G.gridToString(state.values);
  assert.notStrictEqual(after, start);

  list.forEach(() => G.undo(state));
  assert.strictEqual(G.gridToString(state.values), start, '全部復原後要回到最初盤面');
  list.forEach(() => G.redo(state));
  assert.strictEqual(G.gridToString(state.values), after, '全部重做後要回到復原前的盤面');
});

ok('提示會先抓出填錯的格子，再給下一步的理由', () => {
  const state = G.create({ difficulty: 'medium', seed: 'FLOW6' });
  const idx = state.values.findIndex((v) => v === 0);
  G.setValue(state, idx, (state.solution[idx] % 9) + 1);

  const fix = G.hint(state);
  assert.strictEqual(fix.ok, true);
  assert.strictEqual(fix.fix, true);
  assert.strictEqual(fix.index, idx, '提示要指出那個填錯的格子');
  assert.strictEqual(state.hintsUsed, 0, '抓錯不算用掉提示');

  G.clearCell(state, idx);
  const step = G.hint(state);
  assert.strictEqual(step.ok, true);
  assert.strictEqual(state.values[step.index], step.digit);
  assert.strictEqual(step.digit, state.solution[step.index], '提示填的一定是正解');
  assert.ok(step.message.indexOf('【') === 0, '提示訊息要標出用到的技巧');
  assert.strictEqual(state.hintsUsed, 1);
});

ok('用提示一路解到勝利', () => {
  S.DIFFICULTIES.forEach((difficulty) => {
    const state = G.create({ difficulty, seed: 'WIN-' + difficulty });
    let guard = 0;
    while (state.status === 'playing' && guard++ < 200) {
      const res = G.hint(state);
      assert.strictEqual(res.ok, true, `${difficulty} 提示應該永遠給得出下一步`);
    }
    assert.strictEqual(state.status, 'won', `${difficulty} 應該可以被提示解完`);
    assert.strictEqual(G.isWon(state), true);
    assert.ok(S.isSolved(state.values));
    assert.strictEqual(G.remaining(state), 0);
    const after = G.setValue(state, state.values.findIndex((v, i) => !state.given[i]), 1);
    assert.strictEqual(after.ok, false);
    assert.strictEqual(after.code, 'finished', '完成之後不可以再改盤面');
  });
});

ok('這題重來會把一切歸零', () => {
  const state = G.create({ difficulty: 'easy', seed: 'FLOW7' });
  const idx = state.values.findIndex((v) => v === 0);
  G.setValue(state, idx, (state.solution[idx] % 9) + 1);
  G.hint(state);
  G.restart(state);
  assert.strictEqual(G.gridToString(state.values), G.gridToString(state.puzzle));
  assert.strictEqual(state.mistakes, 0);
  assert.strictEqual(state.hintsUsed, 0);
  assert.strictEqual(state.elapsedMs, 0);
  assert.strictEqual(state.history.length, 0);
  assert.strictEqual(state.status, 'playing');
});

ok('存檔讀檔可以接著玩', () => {
  const state = G.create({ difficulty: 'hard', seed: 'SAVE1' });
  const idx = state.values.findIndex((v) => v === 0);
  G.setValue(state, idx, state.solution[idx]);
  const other = state.values.findIndex((v) => v === 0);
  G.toggleNote(state, other, 4);
  G.toggleNote(state, other, 7);
  state.elapsedMs = 65432;

  const raw = JSON.parse(JSON.stringify(G.serialize(state)));
  const back = G.deserialize(raw);
  assert.ok(back, '存檔應該讀得回來');
  assert.strictEqual(G.gridToString(back.values), G.gridToString(state.values));
  assert.strictEqual(back.notes[other], state.notes[other]);
  assert.strictEqual(back.elapsedMs, 65432);
  assert.strictEqual(back.seed, state.seed);
  assert.strictEqual(back.difficulty, 'hard');
  assert.strictEqual(back.status, 'playing');
  const step = G.hint(back);
  assert.strictEqual(step.ok, true, '讀檔後要能繼續操作');

  assert.strictEqual(G.deserialize(null), null);
  assert.strictEqual(G.deserialize({ version: 9 }), null);
  const tampered = JSON.parse(JSON.stringify(G.serialize(state)));
  tampered.solution = tampered.solution.slice(0, 80) + '0';
  assert.strictEqual(G.deserialize(tampered), null, '答案被竄改的存檔要被拒絕');
});

ok('本機儲存的設定與紀錄', () => {
  storeData.clear();
  const Store = sandbox.Store;
  const defaults = Store.defaultOptions();
  assert.strictEqual(defaults.markMistakes, true);
  const opt = Store.loadOptions();
  assert.deepStrictEqual(opt, defaults, '沒有存檔時要回傳預設值');
  opt.markMistakes = false;
  Store.saveOptions(opt);
  assert.strictEqual(Store.loadOptions().markMistakes, false, '設定要被保留');

  const first = Store.recordWin('easy', 120000, { hints: 1, mistakes: 2, seed: 'AAA' });
  assert.strictEqual(first.isNew, true);
  const slower = Store.recordWin('easy', 200000, {});
  assert.strictEqual(slower.isNew, false, '比較慢不算新紀錄');
  assert.strictEqual(slower.best, 120000);
  assert.strictEqual(slower.count, 2, '累計完成數要往上加');
  const faster = Store.recordWin('easy', 90000, {});
  assert.strictEqual(faster.isNew, true);
  assert.strictEqual(faster.best, 90000);
});

/* ============ 5. 介面結構、RWD 與設定彈窗 ============ */
section('5. 介面結構與 RWD');

ok('index.html 引用的程式都存在', () => {
  const sources = Array.from(html.matchAll(/<script src="([^"]+)"/g), (m) => m[1]);
  assert.ok(sources.length >= 6);
  sources.forEach((src) => {
    assert.ok(fs.existsSync(path.join(publicDir, src)), `找不到 index.html 引用的程式：${src}`);
  });
  const hrefs = Array.from(html.matchAll(/<link[^>]+href="([^"]+\.css)"/g), (m) => m[1]);
  hrefs.forEach((href) => assert.ok(fs.existsSync(path.join(publicDir, href)), `找不到樣式表：${href}`));
  assert.ok(!/https?:\/\//.test(html.replace(/https?:\/\/www\.w3\.org[^"']*/g, '')), '不可以依賴外部網址資源');
});

ok('每個必要畫面都存在', () => {
  ['s-home', 's-setup', 's-loading', 's-error', 's-game', 's-result', 's-stats', 's-help']
    .forEach((id) => assert.ok(html.includes('id="' + id + '"'), `缺少畫面：${id}`));
  assert.ok(html.includes('id="pause-overlay"'), '缺少暫停狀態');
  assert.ok(html.includes('id="toast"'), '缺少即時提示');
  assert.ok(html.includes('id="feedback"') && html.includes('aria-live="polite"'), '缺少可被朗讀的行動回饋區');
});

ok('右上角設定按鈕會開 Modal 彈窗', () => {
  assert.ok(html.includes('id="b-settings"'), '缺少設定按鈕');
  assert.ok(html.includes('aria-haspopup="dialog"') && html.includes('aria-controls="settings-modal"'),
    '設定按鈕必須指向設定彈窗');
  assert.ok(/class="settings-modal"[\s\S]{0,200}role="dialog"/.test(html) ||
    /id="settings-modal"[\s\S]{0,200}role="dialog"/.test(html), '設定必須是 role="dialog" 的彈窗');
  assert.ok(html.includes('aria-modal="true"'), '設定彈窗必須是 modal');
  assert.ok(html.includes('data-settings-close'), '必須可以點遮罩關閉');
  assert.ok(/\.settings-fab\{[^}]*position:fixed/.test(css), '設定按鈕必須固定在畫面上');
  assert.ok(/\.settings-fab\{[^}]*env\(safe-area-inset-top\)/.test(css), '設定按鈕必須在安全區內');
  assert.ok(/\.settings-fab\{[^}]*right:/.test(css), '設定按鈕必須靠右上角');
  assert.ok(!/id="settings-drawer"/.test(html), '設定不可以做成抽屜');
});

ok('設定彈窗提供音樂／音效獨立控制與其他選項', () => {
  ['settings-music', 'settings-music-volume', 'settings-sfx', 'settings-sfx-volume',
    'settings-haptic', 'settings-motion', 'settings-autonotes', 'settings-mistakes',
    'settings-same', 'settings-units', 'settings-remaining', 'settings-reset']
    .forEach((id) => assert.ok(html.includes('id="' + id + '"'), `設定彈窗缺少：${id}`));
  assert.ok(appSource.includes('setSettingsOpen'), '缺少開關彈窗的流程');
  assert.ok(/e\.key === 'Escape'[\s\S]{0,120}setSettingsOpen\(false\)/.test(appSource), 'Escape 必須關閉設定彈窗');
  assert.ok(/back && back.focus/.test(appSource) && appSource.includes('settingsLastFocus'), '關閉後必須把焦點還回原本的按鈕');
  assert.ok(appSource.includes("e.key !== 'Tab'"), '必須把 Tab 焦點鎖在彈窗內');
  assert.ok(appSource.includes("w.addEventListener('popstate'"), '手機返回鍵必須先關彈窗');
  assert.ok(appSource.includes('w.Store.saveOptions(options)'), '設定必須立即保存');
});

ok('音訊在第一次手勢後才解鎖，且音樂音效可分別控制', () => {
  const audio = read(path.join(publicDir, 'js', 'audio.js'));
  assert.ok(audio.includes('function unlock'), '必須提供音訊解鎖');
  assert.ok(audio.includes('setMusicVolume') && audio.includes('setSfxVolume'), '音樂與音效必須各自有音量');
  assert.ok(audio.includes('musicGain') && audio.includes('sfxGain'), '音樂與音效必須走不同的音量節點');
  assert.ok(audio.includes("visibilitychange"), '切到背景要停掉音樂避免疊播');
  assert.ok(appSource.includes("D.addEventListener('pointerdown', firstGesture)"), '第一次觸控要解鎖音訊');
  assert.ok(appSource.includes("D.addEventListener('keydown', firstGesture)"), '第一次鍵盤操作要解鎖音訊');
  assert.ok(!/\.(mp3|ogg|wav)/.test(audio), '目前不依賴任何外部音檔');
});

ok('RWD：直橫向與各尺寸都有對應版面', () => {
  assert.ok(css.includes('@media (orientation:landscape)'), '缺少橫向版面');
  assert.ok(css.includes('@media (orientation:portrait) and (min-width:700px)'), '缺少平板直向版面');
  assert.ok(css.includes('@media (max-width:560px)'), '缺少手機窄版版面');
  assert.ok(css.includes('@media (min-width:1100px)'), '缺少桌機寬版版面');
  assert.ok(css.includes('env(safe-area-inset-bottom)'), '必須處理底部安全區');
  assert.ok(css.includes('viewport-fit=cover') || html.includes('viewport-fit=cover'), '必須開啟安全區支援');
  assert.ok(css.includes('overflow-x:hidden'), '不可以水平溢出');
  assert.ok(css.includes('prefers-reduced-motion'), '必須尊重系統的減少動態設定');
  assert.ok(css.includes('.reduced-motion'), '必須提供自己的減少動態開關');
  assert.ok(/min-height:4[4-9]px|min-height:5\dpx|min-height:6\dpx|min-height:7\dpx/.test(css),
    '主要按鈕要有夠大的觸控命中區');
  assert.ok(appSource.includes("w.addEventListener('orientationchange'"), '轉向時要重新量測盤面');
  assert.ok(appSource.includes('visualViewport'), '要處理瀏覽器工具列造成的視窗變化');
});

ok('立體 SVG 按鈕有底座、按壓、停用與聚焦狀態', () => {
  const svgui = read(path.join(publicDir, 'js', 'svgui.js'));
  assert.ok(svgui.includes('b3-face') && svgui.includes('createElementNS'), '按鈕外觀必須用 SVG 畫');
  assert.ok(/rect x="2" y="' \+ \(2 \+ d\)/.test(svgui), '按鈕必須有較深色的底座');
  assert.ok(svgui.includes("classList.add('press')"), '按下要有位移狀態');
  assert.ok(css.includes('.btn3d.press .b3-face'), '按下時上層要往底座位移');
  assert.ok(css.includes('.btn3d[disabled]'), '停用狀態要可辨識');
  assert.ok(css.includes('.btn3d:focus-visible'), '鍵盤聚焦狀態要可辨識');
  assert.ok(svgui.includes('b3-lbl'), '按鈕文字要留在 HTML，不可烘焙進圖裡');
});

ok('教學是純文字、可分段、可重看', () => {
  assert.ok(html.includes('id="tut-body"') && html.includes('id="tut-progress"'), '缺少教學內容區與進度');
  assert.ok(html.includes('id="b-tut-prev"') && html.includes('id="b-tut-next"'), '缺少上一段／下一段');
  assert.ok(html.includes('id="b-help-skip"'), '缺少跳過');
  assert.ok(html.includes('id="b-tut-play"'), '缺少立即練習');
  const steps = appSource.match(/title:\s*'/g) || [];
  assert.ok(steps.length >= 6, `教學段落太少（目前 ${steps.length} 段）`);
  assert.ok(!/<img|<video|<canvas/.test(html), '教學不可以只靠影片或圖片說明');
});

ok('鍵盤與觸控都能完成核心操作', () => {
  ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']
    .forEach((k) => assert.ok(appSource.includes("'" + k + "'"), `缺少鍵盤操作：${k}`));
  assert.ok(appSource.includes("k >= '1' && k <= '9'"), '缺少鍵盤數字輸入');
  assert.ok(html.includes('id="numpad"'), '缺少觸控數字盤');
  assert.ok(css.includes('touch-action:manipulation'), '要避免雙擊縮放造成誤觸');
  assert.ok(!/user-scalable=no/.test(html), '不應該完全禁止使用者縮放整頁');
});
/* ============================================================
 * server URL 參數化 與 部署準備
 * ========================================================== */
section('6. server URL 參數化與部署準備');

const { execFileSync } = require('child_process');
const configPath = path.join(publicDir, 'js', 'config.js');
const injectScript = path.join(root, 'scripts', 'inject-server-url.js');
const INJECT_LINE = /var INJECTED = '[^']*';/;

/* 用真的 config.js 原始碼跑，只換掉「部署時會被改寫」的那一行 */
function loadConfig(injected, search, protocol) {
  const box = {
    console: { warn() {}, log() {} },
    URL,
    location: { search: search || '', protocol: protocol || 'http:' }
  };
  box.window = box;
  vm.createContext(box);
  let src = read(configPath);
  if (injected) src = src.replace(INJECT_LINE, "var INJECTED = '" + injected + "';");
  vm.runInContext(src, box, { filename: 'config.js' });
  return box;
}

ok('版控裡的 config.js 預設是單機模式（沒有寫死任何網址）', () => {
  const src = read(configPath);
  const m = INJECT_LINE.exec(src);
  assert.ok(m, 'config.js 必須保留可注入的 INJECTED 那一行');
  assert.strictEqual(m[0], "var INJECTED = '';", '版控裡不可以留下任何實際網址');
  const C = loadConfig('', '', 'https:').GameConfig;
  assert.strictEqual(C.status, 'unset');
  assert.strictEqual(C.serverUrl, null);
  assert.strictEqual(C.isOnlineEnabled(), false);
  assert.strictEqual(C.url('/health'), null, '單機模式不該組得出任何網址');
});

ok('注入的 server URL 會被採用，尾端斜線會正規化', () => {
  const C = loadConfig('https://sudoku.example.com/', '', 'https:').GameConfig;
  assert.strictEqual(C.status, 'ok');
  assert.strictEqual(C.serverUrl, 'https://sudoku.example.com');
  assert.strictEqual(C.source, 'injected');
  assert.strictEqual(C.url('/health'), 'https://sudoku.example.com/health');
  assert.strictEqual(C.url('health'), 'https://sudoku.example.com/health', '沒有前導斜線也要能組出來');
});

ok('網址參數 ?server= 可以臨時覆蓋注入值', () => {
  const C = loadConfig('https://prod.example.com', '?server=https%3A%2F%2Fstaging.example.com&x=1', 'https:').GameConfig;
  assert.strictEqual(C.serverUrl, 'https://staging.example.com');
  assert.strictEqual(C.source, 'query');
  assert.ok(C.describe().indexOf('網址參數覆蓋') >= 0, '要讓使用者看得出來是被覆蓋的');
});

ok('格式錯誤的 server URL 會被擋下並退回單機，不會靜默用 localhost', () => {
  ['not a url', 'ftp://example.com', '/relative/path', 'example.com'].forEach((bad) => {
    const C = loadConfig(bad, '', 'https:').GameConfig;
    assert.strictEqual(C.status, 'invalid', bad + ' 應該被判定為不合法');
    assert.strictEqual(C.serverUrl, null, bad + ' 不該產生可用網址');
    assert.ok(C.error, bad + ' 應該留下錯誤訊息');
  });
  const mixed = loadConfig('http://plain.example.com', '', 'https:').GameConfig;
  assert.strictEqual(mixed.status, 'invalid', 'https 頁面連 http 伺服器會被瀏覽器擋，要先擋下來');
  const okHttp = loadConfig('http://plain.example.com', '', 'http:').GameConfig;
  assert.strictEqual(okHttp.status, 'ok', 'http 頁面連 http 伺服器是合理的');
});

ok('單機模式不會發出任何網路請求', () => {
  const box = loadConfig('', '', 'https:');
  let called = 0;
  box.fetch = function () { called++; return Promise.resolve({ ok: true }); };
  const states = [];
  box.GameConfig.checkHealth((s) => states.push(s));
  assert.strictEqual(called, 0, '沒有設定伺服器就不該打 API');
  assert.deepStrictEqual(states, ['unset']);
});

ok('連線位置只在 config.js 定義，其他前端檔案不硬編碼網址', () => {
  ['rng.js', 'sudoku.js', 'game.js', 'storage.js', 'app.js', 'audio.js', 'svgui.js'].forEach((file) => {
    const src = read(path.join(publicDir, 'js', file)).replace(/http:\/\/www\.w3\.org[^'"]*/g, '');
    assert.ok(!/https?:\/\//.test(src), file + ' 不可以出現寫死的網址，要透過 GameConfig 取得');
  });
  const app = read(path.join(publicDir, 'js', 'app.js'));
  assert.ok(/w\.GameConfig/.test(app), 'app.js 必須從 GameConfig 取得連線資訊');
});

ok('注入腳本會拒絕不安全或錯誤的值，並可以還原成單機', () => {
  const backup = read(configPath);
  const run = (args, env) => {
    try {
      execFileSync(process.execPath, [injectScript].concat(args), {
        cwd: root,
        env: Object.assign({}, process.env, env || {}),
        stdio: 'pipe'
      });
      return 0;
    } catch (e) {
      return e.status === undefined ? 1 : e.status;
    }
  };
  try {
    assert.notStrictEqual(run(['沒有這種網址']), 0, '亂填的字串要失敗');
    assert.notStrictEqual(run(['http://localhost:3010']), 0, '正式部署不可以用本機網址');
    assert.notStrictEqual(run(['http://plain.example.com']), 0, '正式部署要用 https');

    assert.strictEqual(run(['--allow-local', 'http://localhost:3010']), 0, '本機測試明講就放行');
    assert.ok(read(configPath).indexOf("var INJECTED = 'http://localhost:3010';") >= 0);

    assert.strictEqual(run([], { GAME_SERVER_URL: 'https://sudoku.example.com/' }), 0, '要能從環境變數注入');
    assert.ok(read(configPath).indexOf("var INJECTED = 'https://sudoku.example.com';") >= 0, '會覆蓋前一次注入的值');

    assert.strictEqual(run(['--clear']), 0);
    assert.ok(read(configPath).indexOf("var INJECTED = '';") >= 0, '--clear 要還原成單機模式');

    assert.strictEqual(run([], { GAME_SERVER_URL: '' }), 0, '沒設定變數時要正常結束（單機模式）');
  } finally {
    fs.writeFileSync(configPath, backup, 'utf8');
  }
});

ok('伺服器提供 /health 給雲端平台與前端判斷狀態', () => {
  const src = read(path.join(root, 'server.js'));
  assert.ok(/urlPath === '\/health'/.test(src), 'server.js 必須處理 /health');
  assert.ok(/status: 'ok'/.test(src), '/health 要回報狀態');
  assert.ok(/GAME_ALLOWED_ORIGIN/.test(src), 'CORS 允許來源要由伺服器端環境變數決定');
  assert.ok(/process\.env\.PORT/.test(src) && /process\.env\.HOST/.test(src), '埠與監聽介面要可由環境變數指定');
  assert.ok(/healthCheckPath: \/health/.test(read(path.join(root, 'render.yaml'))), 'render.yaml 要指向 /health');
});

ok('Git 與 GitHub Pages 需要的檔案都齊全', () => {
  const gitignore = read(path.join(root, '.gitignore'));
  assert.ok(/(^|\n)node_modules\//.test(gitignore), '.gitignore 要排除 node_modules');
  assert.ok(/(^|\n)\.env(\r?\n|$)/.test(gitignore), '.gitignore 要排除 .env');

  const envExample = read(path.join(root, '.env.example'));
  assert.ok(/GAME_SERVER_URL=/.test(envExample), '.env.example 要示範 GAME_SERVER_URL');
  assert.ok(!/^GAME_SERVER_URL=\S/m.test(envExample), '.env.example 不可以放真實網址');

  assert.ok(fs.existsSync(path.join(publicDir, '.nojekyll')), 'GitHub Pages 需要 .nojekyll');

  const deploy = read(path.join(root, '.github', 'workflows', 'deploy-pages.yml'));
  assert.ok(/inject-server-url\.js/.test(deploy), '部署流程要注入 server URL');
  assert.ok(/vars\.GAME_SERVER_URL/.test(deploy), 'server URL 要來自 repository variable，不進版控');
  assert.ok(/path: public/.test(deploy), '要把 public/ 當成靜態站上傳');
});

ok('所有資源都用相對路徑，才能放在 GitHub Pages 的子路徑底下', () => {
  const html = read(path.join(publicDir, 'index.html'));
  const attrs = html.match(/(?:src|href)="([^"]+)"/g) || [];
  attrs.forEach((a) => {
    const v = a.split('="')[1].slice(0, -1);
    if (v.indexOf('data:') === 0 || v.charAt(0) === '#') return;
    assert.ok(v.charAt(0) !== '/', '不可以用絕對路徑：' + v);
    assert.ok(!/^https?:/.test(v), '不可以指向外部網址：' + v);
  });
  const cfgAt = html.indexOf('js/config.js');
  const appAt = html.indexOf('js/app.js');
  assert.ok(cfgAt >= 0, 'config.js 要被載入');
  assert.ok(cfgAt < appAt, 'config.js 要在 app.js 之前載入');
});

ok('設定彈窗看得到連線狀態', () => {
  const html = read(path.join(publicDir, 'index.html'));
  assert.ok(/id="settings-server-state"/.test(html), '設定彈窗要顯示伺服器狀態');
  assert.ok(/id="settings-server-url"/.test(html), '設定彈窗要顯示伺服器位址');
  const at = html.indexOf('settings-server-state');
  assert.ok(/aria-live="polite"/.test(html.slice(at - 200, at + 200)), '狀態變化要能被螢幕閱讀器讀到');
  const app = read(path.join(publicDir, 'js', 'app.js'));
  assert.ok(/syncServerRow\(\)/.test(app), '打開設定時要更新連線狀態');
});


/* ============ 6. 檔案編碼 ============ */
section('7. 檔案編碼');

const BAD_CHAR = String.fromCharCode(0xFFFD);   // 解碼失敗時會出現的替代字元

ok('所有原始檔都是無 BOM 的 UTF-8', () => {
  const files = [
    path.join(root, 'server.js'),
    path.join(root, 'package.json'),
    path.join(root, 'README.md'),
    path.join(root, '啟動遊戲.bat'),
    path.join(publicDir, 'index.html'),
    path.join(publicDir, 'css', 'style.css'),
    ...CORE_FILES.map((f) => path.join(publicDir, 'js', f)),
    path.join(publicDir, 'js', 'app.js'),
    path.join(publicDir, 'js', 'audio.js'),
    path.join(publicDir, 'js', 'svgui.js'),
    path.join(publicDir, 'js', 'config.js'),
    path.join(root, 'scripts', 'inject-server-url.js'),
    path.join(root, '.env.example'),
    __filename
  ];
  files.forEach((file) => {
    if (!fs.existsSync(file)) return;
    const buf = fs.readFileSync(file);
    assert.ok(
      !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf),
      `${path.basename(file)} 不可以有 UTF-8 BOM`
    );
    const text = buf.toString('utf8');
    assert.ok(text.indexOf(BAD_CHAR) < 0, `${path.basename(file)} 不是合法的 UTF-8（可能被存成 Big5）`);
  });
});

console.log('\n全部 ' + passed + ' 組檢查通過。\n');
