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
 * 線上觀戰房間（伺服器權威）
 * 這一節直接 require lib/rooms.js，用注入的時鐘測寬限期與回收，不必真的等。
 * ========================================================== */
section('6. 線上觀戰房間與留言');

const Rooms = require(path.join(root, 'lib', 'rooms.js'));

/* 造一個結構合法的盤面快照：前 30 格是題目給的，其他留空 */
function makeSnapshot(extra) {
  let puzzle = '';
  for (let i = 0; i < 81; i++) puzzle += i < 30 ? String((i % 9) + 1) : '0';
  return Object.assign({
    puzzle,
    values: puzzle,
    notes: [],
    selected: 40,
    elapsedMs: 0,
    hintsUsed: 0,
    mistakes: 0,
    status: 'playing'
  }, extra || {});
}

/* 每個測試自己建一個 store，彼此不干擾；clock 可以往前撥 */
function makeStore(options) {
  const clock = { t: 1700000000000 };
  const store = Rooms.createStore(Object.assign({ now: () => clock.t }, options || {}));
  return { store, clock, advance: (ms) => { clock.t += ms; } };
}

function openRoom(store, extra) {
  const res = store.createRoom(Object.assign({
    hostName: '小明', difficulty: 'medium', label: '普通', seed: 'ABC', snapshot: makeSnapshot()
  }, extra || {}));
  assert.ok(res.ok, '開房應該成功：' + JSON.stringify(res));
  return res;
}

ok('開房會給房號、主持人 token 與邀請 token，房號不含容易看錯的字元', () => {
  const { store } = makeStore();
  const res = openRoom(store);
  assert.strictEqual(res.code.length, Rooms.CODE_LENGTH);
  assert.ok(/^[A-Z0-9]{4}$/.test(res.code), '房號要是 4 個大寫英數字：' + res.code);
  assert.ok(!/[IO01]/.test(res.code), '房號不可以出現 I／O／0／1：' + res.code);
  assert.ok(!/[IO01]/.test(Rooms.CODE_ALPHABET), '房號字母表不該包含容易看錯的字元');
  assert.ok(res.hostToken && res.hostToken.length >= 24, '主持人 token 要夠長、不可猜測');
  assert.ok(res.inviteToken && res.inviteToken.length >= 24, '邀請 token 要夠長、不可猜測');
  assert.notStrictEqual(res.hostToken, res.inviteToken, '兩個 token 不可以是同一個');

  const list = store.listRooms();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].code, res.code);
  assert.strictEqual(list[0].viewers, 0);
  assert.strictEqual(list[0].status, 'live');
  assert.strictEqual(list[0].total, 51, '空格數要從快照算出來');
  assert.strictEqual(list[0].hostName, '小明');
  assert.ok(!('hostToken' in list[0]), '房間列表不可以外洩 token');
  assert.ok(!('inviteToken' in list[0]), '房間列表不可以外洩邀請 token');
});

ok('盤面快照會被結構驗證：格式錯、竄改題目、換題目都擋下來', () => {
  const { store } = makeStore();
  assert.strictEqual(store.createRoom({ snapshot: null }).ok, false, '沒有快照不能開房');
  assert.strictEqual(store.createRoom({ snapshot: { puzzle: '123', values: '123' } }).ok, false, '長度不對要擋');

  const res = openRoom(store);
  const base = makeSnapshot();

  /* 竄改題目原本就給的格子 */
  const tampered = makeSnapshot({ values: '9' + base.values.slice(1) });
  const bad = store.updateState(res.code, res.hostToken, tampered);
  assert.strictEqual(bad.ok, false, '題目給的格子被改掉要擋');
  assert.strictEqual(bad.status, 400);

  /* 中途換一份完全不同的題目 */
  const swapped = makeSnapshot();
  swapped.puzzle = '0'.repeat(81);
  swapped.values = '0'.repeat(81);
  assert.strictEqual(store.updateState(res.code, res.hostToken, swapped).ok, false, '不可以中途換題目');

  /* 合法更新：填一格空格 */
  const filled = makeSnapshot({ values: base.values.slice(0, 40) + '7' + base.values.slice(41) });
  const good = store.updateState(res.code, res.hostToken, filled);
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.version, 2, '版本號要單調遞增');
  assert.strictEqual(good.state.board.filled, 1);

  /* 超出範圍的數值會被夾住，不會信任用戶端 */
  const wild = makeSnapshot({ selected: 999, elapsedMs: -5, hintsUsed: 1e9, mistakes: -3 });
  const clamped = store.updateState(res.code, res.hostToken, wild);
  assert.strictEqual(clamped.ok, true);
  assert.strictEqual(clamped.state.board.selected, -1);
  assert.strictEqual(clamped.state.board.elapsedMs, 0);
  assert.ok(clamped.state.board.hintsUsed <= 999);
  assert.strictEqual(clamped.state.board.mistakes, 0);
});

ok('主持人身分靠 token：別人不能改盤面、關房或換連結', () => {
  const { store } = makeStore();
  const res = openRoom(store);
  const fake = 'f'.repeat(32);

  const push = store.updateState(res.code, fake, makeSnapshot());
  assert.strictEqual(push.ok, false);
  assert.strictEqual(push.status, 403);

  assert.strictEqual(store.closeRoom(res.code, fake).ok, false, '別人不能關房');
  assert.strictEqual(store.rotateInvite(res.code, fake).ok, false, '別人不能換邀請連結');
  assert.strictEqual(store.attachHost(res.code, fake).ok, false, '別人不能冒充主持人連線');

  assert.ok(store.getRoom(res.code), '被擋下來之後房間要還在');
  assert.strictEqual(store.attachHost(res.code, res.hostToken).ok, true, '正牌主持人可以連線');
});

ok('觀戰者加入／離開會更新人數，房間滿了會被擋下', () => {
  const { store } = makeStore({ maxViewersPerRoom: 2 });
  const res = openRoom(store);

  const a = store.addViewer(res.code, { name: '觀眾甲' });
  const b = store.addViewer(res.code, { name: '觀眾乙' });
  assert.ok(a.ok && b.ok);
  assert.notStrictEqual(a.viewerToken, b.viewerToken, '每個觀戰者的 token 要不一樣');
  assert.strictEqual(store.getRoom(res.code).viewers.size, 2);

  const c = store.addViewer(res.code, { name: '觀眾丙' });
  assert.strictEqual(c.ok, false, '房間滿了要擋');
  assert.strictEqual(c.status, 409);

  store.removeViewer(res.code, a.viewerId);
  assert.strictEqual(store.getRoom(res.code).viewers.size, 1, '離開就釋放名額');
  assert.strictEqual(store.addViewer(res.code, { name: '觀眾丙' }).ok, true);

  /* 名字沒填會給預設值，過長會被截斷 */
  const { store: s2 } = makeStore();
  const r2 = openRoom(s2);
  assert.strictEqual(s2.addViewer(r2.code, {}).name, '路過的觀眾');
  assert.strictEqual(s2.addViewer(r2.code, { name: '這是一個超級無敵長的暱稱應該要被截斷' }).name.length,
    Rooms.DEFAULTS.maxNameLength);
});

ok('邀請連結：帶錯 token 會被擋，換連結之後舊的立刻失效，房號仍可直接加入', () => {
  const { store } = makeStore();
  const res = openRoom(store);

  assert.strictEqual(store.addViewer(res.code, { invite: res.inviteToken }).ok, true, '正確的邀請 token 要放行');
  const bad = store.addViewer(res.code, { invite: 'nope' });
  assert.strictEqual(bad.ok, false, '錯誤的邀請 token 要擋');
  assert.strictEqual(bad.status, 403);
  assert.ok(/失效/.test(bad.message), '要說明是連結失效，而不是含糊的錯誤');

  const rotated = store.rotateInvite(res.code, res.hostToken);
  assert.strictEqual(rotated.ok, true);
  assert.notStrictEqual(rotated.inviteToken, res.inviteToken, '換連結要產生新的 token');
  assert.strictEqual(store.addViewer(res.code, { invite: res.inviteToken }).ok, false, '舊連結要立刻失效');
  assert.strictEqual(store.addViewer(res.code, { invite: rotated.inviteToken }).ok, true, '新連結可以用');
  assert.strictEqual(store.addViewer(res.code, {}).ok, true, '房間是公開的，用房號直接加入不需要邀請 token');
});

ok('聊天：長度上限、頻率限制、訊息淨化，而且只有房內成員能發言', () => {
  const { store, advance } = makeStore();
  const res = openRoom(store);
  const viewer = store.addViewer(res.code, { name: '觀眾甲' });

  /* 不在房裡的人不能發言 */
  const stranger = store.chat(res.code, 'x'.repeat(32), '哈囉');
  assert.strictEqual(stranger.ok, false);
  assert.strictEqual(stranger.status, 403);

  /* 空訊息 */
  assert.strictEqual(store.chat(res.code, viewer.viewerToken, '   ').ok, false, '空白訊息不送出');

  /* 淨化：控制字元、零寬字元、雙向覆寫字元都要清掉，但一般標點（含 < >）保留原樣 */
  const dirty = 'ab' + '\u200B' + 'c' + '\u202D' + 'd \u0007<b>5 > 3</b> e';
  const cleaned = store.chat(res.code, viewer.viewerToken, dirty);
  assert.strictEqual(cleaned.ok, true);
  assert.ok(cleaned.message.text.indexOf('\u0007') < 0, '控制字元要被清掉');
  assert.ok(cleaned.message.text.indexOf('\u200B') < 0, '零寬字元要被清掉');
  assert.ok(cleaned.message.text.indexOf('\u202D') < 0, '雙向覆寫字元要被清掉');
  assert.ok(cleaned.message.text.indexOf('<b>5 > 3</b>') >= 0, '一般文字要原樣保留（前端用 textContent 顯示）');
  assert.strictEqual(cleaned.message.role, 'viewer');
  assert.strictEqual(cleaned.message.name, '觀眾甲');

  /* 頻率限制：太快 */
  const tooFast = store.chat(res.code, viewer.viewerToken, '再一句');
  assert.strictEqual(tooFast.ok, false);
  assert.strictEqual(tooFast.code, 'toofast');
  assert.strictEqual(tooFast.status, 429);

  /* 長度上限 */
  advance(Rooms.DEFAULTS.chatMinIntervalMs + 10);
  const tooLong = store.chat(res.code, viewer.viewerToken, 'ㄅ'.repeat(Rooms.DEFAULTS.maxTextLength + 1));
  assert.strictEqual(tooLong.ok, false);
  assert.strictEqual(tooLong.code, 'toolong');

  /* 觀察窗內講太多句 */
  let blocked = null;
  for (let i = 0; i < Rooms.DEFAULTS.chatMaxPerWindow + 3; i++) {
    advance(Rooms.DEFAULTS.chatMinIntervalMs + 10);
    const r = store.chat(res.code, viewer.viewerToken, '第 ' + i + ' 句');
    if (!r.ok) { blocked = r; break; }
  }
  assert.ok(blocked, '短時間講太多句要被擋下來');
  assert.strictEqual(blocked.code, 'toomany');

  /* 等觀察窗過去就能再講 */
  advance(Rooms.DEFAULTS.chatWindowMs + 100);
  assert.strictEqual(store.chat(res.code, viewer.viewerToken, '我回來了').ok, true);

  /* 主持人的顯示名稱不能被觀戰者冒充 */
  advance(Rooms.DEFAULTS.chatMinIntervalMs + 10);
  const impersonate = store.chat(res.code, viewer.viewerToken, '我是主持人', '小明');
  assert.strictEqual(impersonate.ok, true);
  assert.strictEqual(impersonate.message.role, 'viewer', '角色由 token 決定，不看送過來的名字');
});

ok('共享格子留言：同一格可持續新增多則，玩家與所有觀戰者都能收到', () => {
  const { store, advance } = makeStore();
  const res = openRoom(store);
  const a = store.addViewer(res.code, { name: '觀眾甲' });
  const b = store.addViewer(res.code, { name: '觀眾乙' });
  const events = [];
  store.on((event) => { if (event.type === 'note') events.push(event.payload); });

  const first = store.updateCellNote(res.code, a.viewerToken, 80, '可能是7', '觀眾甲');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.notes.length, 1);
  assert.strictEqual(first.notes[0].text, '可能是7');
  assert.strictEqual(first.notes[0].authorId, a.viewerId);
  assert.ok(JSON.stringify(first).indexOf(a.viewerToken) < 0, '共享留言不可以外洩 viewer token');

  const second = store.updateCellNote(res.code, b.viewerToken, 80, '先看宮', '觀眾乙');
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.notes.length, 2, '不同觀戰者的留言要並存');
  assert.strictEqual(events.length, 2, '每次留言都要廣播 note 事件');
  assert.strictEqual(store.stateEvent(store.getRoom(res.code)).cellNotes[80].length, 2,
    '新的觀戰者初始 state 要拿到共享留言');

  advance(Rooms.DEFAULTS.noteMinIntervalMs + 1);
  const another = store.updateCellNote(res.code, a.viewerToken, 80, '答案7', '觀眾甲');
  assert.strictEqual(another.ok, true);
  assert.strictEqual(another.notes.length, 3, '同一人再次送出也要新增一則留言');
  assert.deepStrictEqual(another.notes.map((note) => note.text), ['可能是7', '先看宮', '答案7']);
  assert.strictEqual(events.length, 3, '同一人再次送出也要廣播新的 note 事件');

  advance(Rooms.DEFAULTS.noteMinIntervalMs + 1);
  const empty = store.updateCellNote(res.code, a.viewerToken, 80, '', '觀眾甲');
  assert.strictEqual(empty.ok, false, '空白內容不應產生沒有文字的留言');
  assert.strictEqual(empty.code, 'empty');
  assert.strictEqual(store.stateEvent(store.getRoom(res.code)).cellNotes[80].length, 3,
    '拒絕空白後既有留言要保留');

  const tooLong = store.updateCellNote(res.code, b.viewerToken, 80, '一二三四五六七八九十 一', '觀眾乙');
  assert.strictEqual(tooLong.ok, false);
  assert.strictEqual(tooLong.code, 'toolong');
  const stranger = store.updateCellNote(res.code, 'x'.repeat(32), 80, '不能寫', '陌生人');
  assert.strictEqual(stranger.ok, false);
  assert.strictEqual(stranger.status, 403);

  advance(Rooms.DEFAULTS.noteMinIntervalMs + 1);
  const hostNote = store.updateCellNote(res.code, res.hostToken, 0, '主持人提示', '冒充名稱');
  assert.strictEqual(hostNote.ok, true, '主持人也能留下共享留言');
  assert.strictEqual(hostNote.notes[0].role, 'host');
  assert.strictEqual(hostNote.notes[0].name, '小明');
  assert.strictEqual(store.stateEvent(store.getRoom(res.code)).cellNotes[0][0].text, '主持人提示');
});

ok('新加入的人看得到最近的歷史訊息，而且訊息總數有上限', () => {
  const { store, advance } = makeStore({ maxMessages: 6, historyForNewViewer: 4 });
  const res = openRoom(store);
  const a = store.addViewer(res.code, { name: '甲' });
  for (let i = 0; i < 10; i++) {
    advance(Rooms.DEFAULTS.chatWindowMs + 10);   // 避開頻率限制，這裡測的是保留數量
    store.chat(res.code, a.viewerToken, '訊息 ' + i);
  }
  const room = store.getRoom(res.code);
  assert.strictEqual(room.messages.length, 6, '房內保留的訊息數要有上限');
  const b = store.addViewer(res.code, { name: '乙' });
  assert.strictEqual(b.history.length, 4, '新加入的人拿到最近 N 則');
  assert.strictEqual(b.history[b.history.length - 1].text, '訊息 9', '最後一則要是最新的');
  assert.ok(b.state && b.state.board, '加入時要一併拿到目前盤面');
});

ok('房間總數有上限，滿了會回絕而不是無限開下去', () => {
  const { store } = makeStore({ maxRooms: 3 });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push(openRoom(store).code);
  assert.strictEqual(new Set(codes).size, 3, '房號不可以重複');
  const full = store.createRoom({ snapshot: makeSnapshot() });
  assert.strictEqual(full.ok, false);
  assert.strictEqual(full.code, 'full');
  assert.strictEqual(store.roomCount(), 3);
});

ok('房間生命週期：主持人斷線有寬限期，逾時關房，觀戰者一併被釋放', () => {
  const { store, advance } = makeStore({ hostGraceMs: 60000 });
  const events = [];
  store.on((event) => events.push(event));
  const res = openRoom(store);
  store.attachHost(res.code, res.hostToken);
  store.addViewer(res.code, { name: '甲' });

  /* 斷線後在寬限期內憑 token 回來 */
  store.detachHost(res.code, res.hostToken);
  advance(30000);
  store.sweep();
  assert.ok(store.getRoom(res.code), '寬限期內房間要還在');
  assert.strictEqual(events.filter((event) => event.type === 'closed').length, 0, '寬限期內不能廣播關房');
  assert.strictEqual(store.attachHost(res.code, res.hostToken).ok, true, '主持人可以憑 token 回來');
  assert.strictEqual(store.getRoom(res.code).hostOnline, true);

  /* 這次不回來了 */
  store.detachHost(res.code, res.hostToken);
  advance(60001);
  const closedCount = store.sweep();
  assert.strictEqual(closedCount, 1);
  const closed = events.find((event) => event.type === 'closed');
  assert.ok(closed, '主持人斷線逾時要廣播 closed 事件');
  assert.strictEqual(closed.code, res.code);
  assert.strictEqual(closed.payload.reason, 'hostgone', '關房廣播要標示主持人斷線逾時');
  assert.strictEqual(store.getRoom(res.code), null, '逾時要關房');
  assert.strictEqual(store.listRooms().length, 0);
  assert.strictEqual(store.addViewer(res.code, {}).status, 404, '關掉的房間不能再加入');
});

ok('房間生命週期：閒置與完成後都會被回收', () => {
  const idle = makeStore({ idleCloseMs: 100000, hostGraceMs: 1e9 });
  const r1 = openRoom(idle.store);
  idle.store.attachHost(r1.code, r1.hostToken);
  idle.advance(100001);
  idle.store.sweep();
  assert.strictEqual(idle.store.getRoom(r1.code), null, '閒置太久要回收');

  const done = makeStore({ doneKeepMs: 50000, hostGraceMs: 1e9, idleCloseMs: 1e9 });
  const r2 = openRoom(done.store);
  done.store.attachHost(r2.code, r2.hostToken);
  const solvedSnapshot = makeSnapshot({ status: 'won' });
  done.store.updateState(r2.code, r2.hostToken, solvedSnapshot);
  assert.strictEqual(done.store.getRoom(r2.code).status, 'done', '解完要標記成已完成');
  done.advance(50001);
  done.store.sweep();
  assert.strictEqual(done.store.getRoom(r2.code), null, '完成後放太久也要回收');
});

ok('事件廣播：state／chat／presence／closed 都會送出，版本號單調遞增', () => {
  const { store } = makeStore();
  const events = [];
  store.on((e) => events.push(e.type + ':' + e.code));
  const res = openRoom(store);
  const viewer = store.addViewer(res.code, { name: '甲' });

  const base = makeSnapshot();
  const v1 = store.updateState(res.code, res.hostToken, makeSnapshot({ values: base.values.slice(0, 35) + '4' + base.values.slice(36) }));
  const v2 = store.updateState(res.code, res.hostToken, makeSnapshot({ values: base.values.slice(0, 35) + '4' + base.values.slice(36), elapsedMs: 1000 }));
  assert.ok(v2.version > v1.version, '版本號必須遞增');

  store.chat(res.code, viewer.viewerToken, '你好');
  store.closeRoom(res.code, res.hostToken);

  const kinds = events.map((e) => e.split(':')[0]);
  ['state', 'chat', 'presence', 'closed'].forEach((k) => {
    assert.ok(kinds.indexOf(k) >= 0, '缺少 ' + k + ' 事件');
  });
  assert.strictEqual(kinds[kinds.length - 2] || kinds[kinds.length - 1], 'closed', '關房事件要在最後送出');
});

ok('觀戰快照就是主持人狀態的唯讀鏡像，而且不含答案', () => {
  const puzzle = S.generatePuzzle({ difficulty: 'easy', seed: 'MIRROR' });
  const state = G.fromPuzzle(puzzle, {});
  /* 主持人填一格、做一個筆記 */
  let idx = -1;
  for (let i = 0; i < 81; i++) if (!state.given[i]) { idx = i; break; }
  G.setValue(state, idx, state.solution[idx]);
  let noteIdx = -1;
  for (let i = 0; i < 81; i++) if (!state.given[i] && !state.values[i]) { noteIdx = i; break; }
  G.toggleNote(state, noteIdx, 5);
  state.elapsedMs = 12345;

  const snap = G.spectatorSnapshot(state, { selected: idx, paused: false });
  assert.ok(!('solution' in snap), '快照不可以包含答案');
  assert.strictEqual(JSON.stringify(snap).indexOf(G.gridToString(state.solution)), -1, '快照裡不該出現完整答案');

  /* 伺服器端的結構驗證要接受它 */
  const cleaned = Rooms.cleanSnapshot(snap, null);
  assert.ok(cleaned, '伺服器要接受規則核心產生的快照');
  assert.strictEqual(cleaned.filled, 1);

  /* 觀戰端還原之後要和主持人看到的一致 */
  const view = G.spectatorView(cleaned);
  assert.strictEqual(view.readOnly, true, '觀戰盤面必須標記成唯讀');
  assert.strictEqual(G.gridToString(view.values), G.gridToString(state.values));
  assert.strictEqual(view.notes[noteIdx], state.notes[noteIdx]);
  assert.strictEqual(view.selected, idx);
  assert.strictEqual(view.elapsedMs, 12345);
  assert.strictEqual(view.remaining, G.remaining(state));
  assert.ok(!view.solution, '還原出來的觀戰盤面不該有答案');
  /* 衝突用同一份規則核心算，不是伺服器算好再送 */
  assert.deepStrictEqual(
    Array.from(S.findConflicts(view.values)),
    Array.from(S.findConflicts(state.values)),
    '觀戰端算出來的衝突要和主持人一致'
  );
});

ok('伺服器的線上端點、CORS 與 SSE 標頭都設定正確', () => {
  const src = read(path.join(root, 'server.js'));
  ['/api/rooms', 'stream', 'state', 'note', 'chat', 'close', 'invite'].forEach((k) => {
    assert.ok(src.indexOf(k) >= 0, 'server.js 缺少端點：' + k);
  });
  assert.ok(/text\/event-stream/.test(src), 'SSE 要設對 Content-Type');
  assert.ok(/no-cache, no-store, no-transform/.test(src), 'SSE 要關掉快取與轉換');
  assert.ok(/X-Accel-Buffering/.test(src), 'SSE 要告訴反向代理不要緩衝');
  assert.ok(/': ping/.test(src), 'SSE 要定期送心跳註解');
  assert.ok(/Access-Control-Allow-Origin/.test(src), '跨來源要回 CORS 標頭');
  assert.ok(/Access-Control-Allow-Methods/.test(src) && /OPTIONS/.test(src), '要處理預檢請求');
  assert.ok(/Access-Control-Allow-Headers/.test(src), '預檢要允許 Content-Type');
  assert.ok(/originBlocked/.test(src), '來源不在白名單時要擋下來');
  assert.ok(/MAX_BODY/.test(src), 'POST 要有大小上限');
  assert.ok(/SIGTERM/.test(src), '要處理優雅關閉');

  const yaml = read(path.join(root, 'render.yaml'));
  assert.ok(/GAME_ALLOWED_ORIGIN/.test(yaml), 'render.yaml 要有 GAME_ALLOWED_ORIGIN');
});

ok('前端：連線層集中在 online.js，聊天一律用 textContent 顯示', () => {
  const online = read(path.join(publicDir, 'js', 'online.js'));
  assert.ok(/w\.GameConfig|C\.url/.test(online), 'online.js 要從 GameConfig 取得連線位置');
  assert.ok(/EventSource/.test(online), '下行要用 SSE');
  assert.ok(/sendNote/.test(online), '線上連線層要提供共享留言上行');
  assert.ok(/MAX_STREAM_RETRIES/.test(online), '重試要有上限，不可以無限轉圈');
  assert.ok(/disabledReason/.test(online), '線上功能沒啟用時要說明原因');

  /* 聊天與房間列表都放使用者輸入的文字，絕對不可以走 innerHTML */
  const chatBlock = appSource.slice(appSource.indexOf('function onChatMessage'), appSource.indexOf('function submitChat'));
  assert.ok(chatBlock.length > 200, '找不到聊天訊息的渲染程式');
  assert.ok(!/innerHTMLs*=/.test(chatBlock), '聊天訊息不可以用 innerHTML');
  assert.ok(/tx\.textContent = msg\.text/.test(chatBlock), '訊息內容必須用 textContent');
  assert.ok(/who\.textContent/.test(chatBlock), '暱稱必須用 textContent');
  assert.ok(/text\.textContent = note\.text/.test(appSource), '格子留言內容必須用 textContent');

  const cardBlock = appSource.slice(appSource.indexOf('function roomCard'), appSource.indexOf('function agoText'));
  assert.ok(!/innerHTMLs*=/.test(cardBlock), '房間卡片不可以用 innerHTML');
  assert.ok(/who\.textContent = room\.hostName/.test(cardBlock), '主持人暱稱必須用 textContent');
});

ok('線上相關畫面、狀態與設定都在 index.html 裡', () => {
  ['s-lobby', 's-watch', 'lobby-off', 'lobby-state', 'roomlist', 'watch-board',
    'watch-overlay', 'chat-panel', 'chat-log', 'chat-form', 'b-chat', 'chat-badge',
    'w-summary', 'watch-note-form', 'watch-note-input', 'watch-note-list', 'b-watch-note',
    'hostbar', 'host-codebox', 'h-code', 'b-copy-room-code', 'b-share', 'b-reinvite', 'b-close-room',
    'settings-nick', 'settings-chatcue']
    .forEach((id) => assert.ok(html.includes('id="' + id + '"'), '缺少線上模式的元素：' + id));
  assert.ok(html.includes('js/online.js'), 'index.html 要載入 online.js');
  const onlineAt = html.indexOf('js/online.js');
  const appAt = html.indexOf('js/app.js');
  assert.ok(onlineAt < appAt, 'online.js 要在 app.js 之前載入');
  assert.ok(/id="watch-board"[^>]*readonly|class="board readonly"/.test(html), '觀戰盤面要標示成唯讀');
  assert.ok(/aria-label="[^"]*唯讀[^"]*"/.test(html), '觀戰盤面要讓螢幕閱讀器知道是唯讀的');
  assert.ok(/maxlength="10"/.test(html), '共享格子留言要限制在 10 字內');
  assert.ok(html.includes('aria-label="主持人房號"'), '主持人房號要有清楚的可讀標籤');
  assert.ok(html.includes('複製主持人房號'), '主持人要能直接複製房號');
  assert.ok(html.includes('開房模式：出題後會自動開一間觀戰房'), '開始新題目要直接進入開房模式');
  assert.ok(!html.includes('id="b-open-room"'), '普通遊戲不需要額外的開放觀戰按鈕');
});

ok('觀戰者只能填格子留言與聊天：沒有數字盤、沒有遊戲提示', () => {
  const watchStart = html.indexOf('id="s-watch"');
  const watchEnd = html.indexOf('<!-- ============ 遊戲畫面', watchStart) >= 0
    ? html.indexOf('<!-- ============ 遊戲畫面', watchStart)
    : html.indexOf('</section>', html.indexOf('id="watch-overlay"'));
  const watchHtml = html.slice(watchStart, watchEnd > watchStart ? watchEnd : watchStart + 4000);
  assert.ok(watchHtml.indexOf('numpad') < 0, '觀戰畫面不可以有數字輸入盤');
  assert.ok(watchHtml.indexOf('b-hint') < 0, '觀戰畫面不可以有提示按鈕');
  assert.ok(watchHtml.indexOf('b-note') < 0, '觀戰畫面不可以有筆記按鈕');
  assert.ok(watchHtml.indexOf('b-watch-note') >= 0, '觀戰畫面要有共享留言送出入口');
  assert.ok(/cell-note-corner/.test(appSource), '每個格子要有右上角格子留言三角形');
  assert.ok(/selectWatchCell\(parseInt\(target\.getAttribute\('data-i'\), 10\), true, true\)/.test(appSource),
    '觀戰者點整個格子要和點留言三角形一樣展開留言');
  assert.ok(/selectCell\(parseInt\(target\.getAttribute\('data-i'\), 10\), true\)/.test(appSource),
    '玩家點整個格子要維持原本的數獨選格操作');
  /* 觀戰盤面的格子是 div，不是可以按的 button */
  assert.ok(/watchCells\.push\(cell\)/.test(appSource) && /D\.createElement\('div'\)/.test(appSource),
    '觀戰盤面的格子要用 div，不可以做成可點的按鈕');
});

ok('聊天室錨定左下角，操作 Summary 在寬版右半邊，都不會蓋住右上角設定', () => {
  assert.ok(/\.chat-fab\{[^}]*position:fixed/.test(css), '留言入口要固定在畫面上');
  assert.ok(/\.chat-fab\{[^}]*left:/.test(css) && /\.chat-fab\{[^}]*bottom:/.test(css), '留言入口要在左下角');
  assert.ok(/\.chat-panel\{[^}]*left:/.test(css), '留言面板要錨定左邊');
  assert.ok(/\.chat-fab\{[^}]*env\(safe-area-inset-left\)/.test(css), '留言入口要在安全區內');
  assert.ok(/\.chat-fab\.chat-fab-hidden\{display:none\}/.test(css), '留言面板展開時浮動入口不能覆蓋面板');
  assert.ok(/chat-fab-hidden/.test(appSource) && /q\('chat-close'\)\.focus\(\)/.test(appSource),
    '留言面板展開時要隱藏浮動入口並把焦點移到關閉鈕');
  /* z-index：設定按鈕 70、設定彈窗 100 都要高於留言板 */
  const zOf = (sel) => {
    const m = new RegExp('\\' + sel + '\\{[^}]*z-index:(\\d+)').exec(css);
    return m ? Number(m[1]) : -1;
  };
  const fabZ = zOf('.settings-fab'), modalZ = zOf('.settings-modal');
  const chatZ = zOf('.chat-panel'), chatFabZ = zOf('.chat-fab');
  assert.ok(fabZ > chatZ && fabZ > chatFabZ, '右上角設定按鈕必須在留言板之上');
  assert.ok(modalZ > fabZ, '設定彈窗要在最上層');
  assert.ok(/\.summary\{/.test(css), '缺少操作 Summary 的樣式');
  assert.ok(/\.summary\.collapsed \.sum-body\{display:none\}/.test(css), 'Summary 要可以收合');
});

ok('設定彈窗的捲動結構正確：只有中間會捲，標題與按鈕列固定', () => {
  assert.ok(html.includes('id="settings-body"'), '缺少獨立的捲動區');
  const bodyAt = html.indexOf('id="settings-body"');
  const footAt = html.indexOf('settings-foot');
  const headAt = html.indexOf('settings-head');
  assert.ok(headAt < bodyAt && bodyAt < footAt, '順序要是 標題列 → 捲動區 → 按鈕列');
  assert.ok(/\.settings-panel\{[^}]*display:flex/.test(css), '面板要用 flex 分成三段');
  assert.ok(/\.settings-panel\{[^}]*flex-direction:column/.test(css));
  assert.ok(/\.settings-panel\{[^}]*overflow:hidden/.test(css), '面板本身不可以是捲動容器');
  assert.ok(/\.settings-body\{[^}]*overflow-y:auto/.test(css), '中間才是捲動區');
  assert.ok(/\.settings-body\{[^}]*scrollbar-gutter:stable/.test(css), '要保留捲軸空間，避免內容左右跳動');
  assert.ok(/\.settings-body\{[^}]*overscroll-behavior:contain/.test(css), '捲到底不要帶動整頁');
  assert.ok(/\.settings-body::-webkit-scrollbar-thumb\{/.test(css), '捲軸要換成主題配色');
  assert.ok(/\.settings-body\{[^}]*scrollbar-width:thin/.test(css), 'Firefox 也要細捲軸');
  assert.ok(/\.settings-head\{[^}]*flex:0 0 auto/.test(css), '標題列要固定不捲');
  assert.ok(/\.settings-foot\{[^}]*flex:0 0 auto/.test(css), '按鈕列要固定不捲');
  assert.ok(/id="settings-reset" type="button"/.test(html) && /class="btn3d small settings-reset"/.test(html),
    '恢復預設要沿用專案的立體 SVG 按鈕');
  assert.ok(/class="btn3d small settings-done"/.test(html), '完成鈕要沿用專案的立體 SVG 按鈕');
  assert.ok(/w\.UI\.repaintAll\(q\('settings-panel'\)\)/.test(appSource), '彈窗打開後要補畫立體按鈕');
});

/* ============================================================
 * server URL 參數化 與 部署準備
 * ========================================================== */
section('7. server URL 參數化與部署準備');

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
  ['rng.js', 'sudoku.js', 'game.js', 'storage.js', 'app.js', 'audio.js', 'svgui.js', 'online.js'].forEach((file) => {
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


/* ============ 8. 檔案編碼 ============ */
section('8. 檔案編碼');

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
    path.join(publicDir, 'js', 'online.js'),
    path.join(root, 'lib', 'rooms.js'),
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
