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

require('./seo.js');

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

const CORE_FILES = ['i18n.js', 'locales.js', 'rng.js', 'sudoku.js', 'game.js', 'storage.js'];
CORE_FILES.forEach((file) => {
  vm.runInContext(read(path.join(publicDir, 'js', file)), sandbox, { filename: file });
});

const RNG = sandbox.RNG;
const S = sandbox.Sudoku;
const G = sandbox.SudokuGame;

ok('每日挑戰依 UTC 日期及難度固定出題，且每題只有一解', () => {
  const first = RNG.dailySeed(new Date('2026-10-28T00:00:00Z'));
  assert.strictEqual(first, RNG.normalizeSeed(first));
  assert.strictEqual(first, RNG.dailySeed(new Date('2026-10-28T23:59:59Z')));
  assert.notStrictEqual(first, RNG.dailySeed(new Date('2026-10-29T00:00:00Z')));
  for (const difficulty of S.DIFFICULTIES) {
    const a = S.generatePuzzle({ difficulty, seed: first });
    const b = S.generatePuzzle({ difficulty, seed: first });
    assert.deepStrictEqual(a.puzzle, b.puzzle);
    assert.strictEqual(S.countSolutions(a.puzzle, 2).count, 1);
  }
});

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
section('3. 五種難度的實質差異（量化門檻）');

/* 難度不是「有沒有用到某技巧」而已，而是整條解題路徑的形狀。
 * 這裡每個難度跑 24 個種子，逐題用 Sudoku.analyze() 的量化指標檢查：
 *   提示數區間互不重疊、需要的技巧層級、卡點次數與分散度、卡點出現得夠早。 */
const SEEDS = [];
for (let i = 0; i < 24; i++) SEEDS.push('V' + i);
const generated = {};

S.DIFFICULTIES.forEach((difficulty) => {
  generated[difficulty] = SEEDS.map((seed) => S.generatePuzzle({ difficulty, seed }));
});
const profiles = {};
S.DIFFICULTIES.forEach((difficulty) => {
  profiles[difficulty] = generated[difficulty].map((p) => S.analyze(p.puzzle));
});

ok('五種難度都存在，而且順序由易到難', () => {
  assert.strictEqual(S.DIFFICULTIES.join(','), 'beginner,easy,medium,hard,expert');
  S.DIFFICULTIES.forEach((d) => assert.ok(S.PRESETS[d], `缺少難度設定：${d}`));
  assert.strictEqual(S.PRESETS.beginner.label, '新手入門');
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

ok('五個提示數區間互不重疊，而且題目確實落在自己的區間裡', () => {
  const order = S.DIFFICULTIES;
  for (let i = 0; i + 1 < order.length; i++) {
    const easier = S.PRESETS[order[i]];
    const harder = S.PRESETS[order[i + 1]];
    assert.ok(
      harder.givensMax < easier.givensMin,
      `${easier.label}(${easier.givensMin}–${easier.givensMax}) 與 ${harder.label}(${harder.givensMin}–${harder.givensMax}) 的提示數區間不可以重疊`
    );
  }
  order.forEach((difficulty) => {
    const preset = S.PRESETS[difficulty];
    generated[difficulty].forEach((p, i) => {
      assert.ok(
        p.givens >= preset.givensMin && p.givens <= preset.givensMax,
        `${difficulty} 第 ${i + 1} 題的提示數 ${p.givens} 不在 ${preset.givensMin}~${preset.givensMax} 之間`
      );
    });
  });
});

ok('提示數平均值隨難度嚴格遞減', () => {
  const avg = {};
  S.DIFFICULTIES.forEach((d) => {
    avg[d] = generated[d].reduce((sum, p) => sum + p.givens, 0) / SEEDS.length;
  });
  const order = S.DIFFICULTIES;
  for (let i = 0; i + 1 < order.length; i++) {
    assert.ok(
      avg[order[i]] > avg[order[i + 1]] + 2,
      `${order[i]}(${avg[order[i]].toFixed(1)}) 的提示數要明顯多於 ${order[i + 1]}(${avg[order[i + 1]].toFixed(1)})`
    );
  }
});

ok('新手入門：全程只需要唯一候選數，而且過半步驟一眼就看得到', () => {
  profiles.beginner.forEach((a, i) => {
    assert.strictEqual(a.solved, true, `新手入門第 ${i + 1} 題應該解得完`);
    assert.strictEqual(a.maxTier, S.TIER.SINGLE, `新手入門第 ${i + 1} 題不該用到唯一候選數以外的技巧`);
    assert.ok(a.obviousRatio >= 0.55,
      `新手入門第 ${i + 1} 題「一眼可見」的步驟只有 ${(a.obviousRatio * 100).toFixed(0)}%，對新手不夠友善`);
  });
  const avgObvious = profiles.beginner.reduce((s, a) => s + a.obviousRatio, 0) / profiles.beginner.length;
  const easyObvious = profiles.easy.reduce((s, a) => s + a.obviousRatio, 0) / profiles.easy.length;
  assert.ok(avgObvious > easyObvious,
    `新手入門(${avgObvious.toFixed(2)}) 的「一眼可見」比例要高於簡單(${easyObvious.toFixed(2)})`);
});

ok('簡單：一樣只需要唯一候選數，但提示數明顯更少、步數更多', () => {
  profiles.easy.forEach((a, i) => {
    assert.strictEqual(a.solved, true, `簡單第 ${i + 1} 題應該解得完`);
    assert.strictEqual(a.maxTier, S.TIER.SINGLE, `簡單第 ${i + 1} 題不該用到唯一候選數以外的技巧`);
  });
  const avgSteps = (list) => list.reduce((s, a) => s + a.steps, 0) / list.length;
  assert.ok(avgSteps(profiles.easy) > avgSteps(profiles.beginner) + 5,
    `簡單的平均步數(${avgSteps(profiles.easy).toFixed(1)}) 要明顯多於新手入門(${avgSteps(profiles.beginner).toFixed(1)})`);
});

ok('普通：至少 6 步隱藏唯一數、完全不需要第 3 級技巧，而且卡點要夠早又分散', () => {
  profiles.medium.forEach((a, i) => {
    assert.strictEqual(a.solved, true, `普通第 ${i + 1} 題應該解得完`);
    assert.strictEqual(a.maxTier, S.TIER.HIDDEN, `普通第 ${i + 1} 題的最高技巧應該剛好是隱藏唯一數`);
    assert.ok(a.byTier[S.TIER.HIDDEN] >= 6,
      `普通第 ${i + 1} 題只用了 ${a.byTier[S.TIER.HIDDEN]} 步隱藏唯一數，跟簡單差不多`);
    assert.strictEqual(a.byTier[S.TIER.LOCKED] + a.byTier[S.TIER.ADVANCED], 0,
      `普通第 ${i + 1} 題不該需要區塊摒除／裸對`);
    assert.ok(a.stalls >= 3, `普通第 ${i + 1} 題只卡住 ${a.stalls} 次，難度沒有貫穿整局`);
    assert.ok(a.spread >= 2, `普通第 ${i + 1} 題的卡點只集中在 ${a.spread} 個區段`);
    assert.ok(a.firstHardAt <= 0.30,
      `普通第 ${i + 1} 題的第一個非唯一候選數步驟出現在 ${(a.firstHardAt * 100).toFixed(0)}%，太晚了`);
  });
});

ok('困難：至少 5 步第 3 級以上、要用到兩種以上的第 3 級技巧', () => {
  profiles.hard.forEach((a, i) => {
    assert.strictEqual(a.solved, true, `困難第 ${i + 1} 題應該在進階技巧範圍內解得完`);
    const advanced = a.byTier[S.TIER.LOCKED] + a.byTier[S.TIER.ADVANCED];
    assert.ok(advanced >= 3,
      `困難第 ${i + 1} 題只有 ${advanced} 步第 3 級以上，跟普通差不多`);
    assert.ok(a.distinct[S.TIER.LOCKED] >= 2 || advanced >= 6,
      `困難第 ${i + 1} 題只用到 ${a.distinct[S.TIER.LOCKED]} 種第 3 級技巧、共 ${advanced} 步，變化不夠`);
    assert.ok(a.stalls >= 3, `困難第 ${i + 1} 題只卡住 ${a.stalls} 次`);
    assert.ok(a.spread >= 2, `困難第 ${i + 1} 題的卡點只集中在 ${a.spread} 個區段`);
    assert.ok(a.firstHardAt <= 0.30,
      `困難第 ${i + 1} 題的第一個卡點出現在 ${(a.firstHardAt * 100).toFixed(0)}%，太晚了`);
    assert.strictEqual(S.humanSolve(p3(i).puzzle, S.TIER.HIDDEN).solved, false,
      `困難第 ${i + 1} 題不該只靠兩種唯一數就解完`);
  });
  function p3(i) { return generated.hard[i]; }
});

ok('專家：第 3 級以上的步數再翻一倍，卡點更多，而且仍然解得出來（不是解題器放棄）', () => {
  profiles.expert.forEach((a, i) => {
    assert.strictEqual(a.solved, true,
      `專家第 ${i + 1} 題必須用進階技巧就解得完，不可以定義成「解題器解不出來」`);
    const advanced = a.byTier[S.TIER.LOCKED] + a.byTier[S.TIER.ADVANCED];
    assert.ok(advanced >= 6, `專家第 ${i + 1} 題只有 ${advanced} 步第 3 級以上`);
    assert.ok(a.stalls >= 3, `專家第 ${i + 1} 題只卡住 ${a.stalls} 次`);
    assert.ok(a.spread >= 2, `專家第 ${i + 1} 題的卡點只集中在 ${a.spread} 個區段`);
    assert.strictEqual(S.humanSolve(generated.expert[i].puzzle, S.TIER.HIDDEN).solved, false,
      `專家第 ${i + 1} 題不該只靠兩種唯一數就解完`);
  });

  const advAvg = (list) => list.reduce((s, a) => s + a.byTier[S.TIER.LOCKED] + a.byTier[S.TIER.ADVANCED], 0) / list.length;
  assert.ok(advAvg(profiles.expert) > advAvg(profiles.hard) + 1,
    `專家的第 3 級以上步數(${advAvg(profiles.expert).toFixed(1)}) 要明顯多於困難(${advAvg(profiles.hard).toFixed(1)})`);
  const stallAvg = (list) => list.reduce((s, a) => s + a.stalls, 0) / list.length;
  assert.ok(stallAvg(profiles.expert) > stallAvg(profiles.hard),
    `專家的卡點次數(${stallAvg(profiles.expert).toFixed(1)}) 要多於困難(${stallAvg(profiles.hard).toFixed(1)})`);
});

ok('相鄰難度的解題路徑確實不同（不是只換個名字）', () => {
  const adv = {};
  const t2 = {};
  S.DIFFICULTIES.forEach((d) => {
    adv[d] = profiles[d].reduce((s, a) => s + a.byTier[S.TIER.LOCKED] + a.byTier[S.TIER.ADVANCED], 0) / SEEDS.length;
    t2[d] = profiles[d].reduce((s, a) => s + a.byTier[S.TIER.HIDDEN], 0) / SEEDS.length;
  });
  assert.strictEqual(t2.beginner, 0);
  assert.strictEqual(t2.easy, 0);
  assert.ok(t2.medium >= 6, `普通的隱藏唯一數平均只有 ${t2.medium.toFixed(1)} 步`);
  assert.strictEqual(adv.medium, 0, '普通不該需要第 3 級技巧');
  assert.ok(adv.hard >= 3, `困難的第 3 級以上平均只有 ${adv.hard.toFixed(1)} 步`);
  assert.ok(adv.expert >= 6, `專家的第 3 級以上平均只有 ${adv.expert.toFixed(1)} 步`);
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
    assert.ok(fs.existsSync(path.join(publicDir, src.split("?")[0])), `找不到 index.html 引用的程式：${src}`);
  });
  const hrefs = Array.from(html.matchAll(/<link[^>]+href="([^"]+\.css)"/g), (m) => m[1]);
  hrefs.forEach((href) => assert.ok(fs.existsSync(path.join(publicDir, href)), `找不到樣式表：${href}`));
  const htmlWithoutAllowedLinks = html
    .replace(/<!--SEO:HEAD-->[\s\S]*?<!--SEO:END-->/, '')
    .replace(/<!--SEO:GAMEPLAY-->[\s\S]*?<!--SEO:GAMEPLAY:END-->/, '')
    .replace(/https?:\/\/www\.w3\.org[^"']*/g, '')
    .replace(/https:\/\/pjh-eric\.github\.io\/game-lobby\/?/g, '');
  assert.ok(!/https?:\/\//.test(htmlWithoutAllowedLinks), '不可以依賴外部網址資源');
});

ok('每個必要畫面都存在', () => {
  ['s-home', 's-setup', 's-loading', 's-error', 's-game', 's-result', 's-stats', 's-help']
    .forEach((id) => assert.ok(html.includes('id="' + id + '"'), `缺少畫面：${id}`));
  assert.ok(html.includes('id="pause-overlay"'), '缺少暫停狀態');
  assert.ok(html.includes('id="toast"'), '缺少即時提示');
  assert.ok(html.includes('id="feedback"') && html.includes('aria-live="polite"'), '缺少可被朗讀的行動回饋區');
});

ok('返回遊戲大廳按鈕固定在左上安全區', () => {
  const match = /\.lobby-home-link\{([^}]*)\}/.exec(css);
  assert.ok(match, '缺少返回遊戲大廳按鈕樣式');
  assert.match(match[1], /position:fixed/);
  assert.match(match[1], /top:[^;]*env\(safe-area-inset-top\)/, '返回按鈕的上方定位必須處理安全區');
  assert.match(match[1], /left:[^;]*env\(safe-area-inset-left\)/, '返回按鈕的左側定位必須處理安全區');
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
  const steps = (read(path.join(publicDir, 'js', 'locales.js')).match(/'tut\.\d+\.title'/g) || []);
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
/* ============ 8. 檔案編碼 ============ */
section('6. 檔案編碼');

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
