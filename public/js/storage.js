/* ===== storage.js — localStorage 讀寫（設定、進度、最佳紀錄） =====
 * 所有 I/O 都包在 try/catch 裡，就算瀏覽器停用儲存空間，遊戲仍然完整可玩，只是不會續玩。
 */
(function (w) {
  'use strict';

  var KEY_OPT = 'sd_opt';
  var KEY_SAVE = 'sd_save';
  var KEY_BEST = 'sd_best';
  var KEY_LAST = 'sd_last';

  var DEFAULT_OPTIONS = {
    markMistakes: true,     // 填錯時立刻標紅
    highlightSame: true,    // 高亮同一個數字
    highlightUnits: true,   // 高亮同列／行／宮
    autoClearNotes: true,   // 填入數字後自動清掉相關筆記
    showRemaining: true,    // 數字盤顯示剩餘數量
    motion: true            // 動畫效果（關閉＝減少動態）
  };

  var available = (function () {
    try {
      var k = '__sd_test__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  })();

  function readJSON(key, fallback) {
    if (!available) return fallback;
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    if (!available) return false;
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function remove(key) {
    if (!available) return;
    try { localStorage.removeItem(key); } catch (e) {}
  }

  /* ---------- 遊戲選項 ---------- */
  function loadOptions() {
    var saved = readJSON(KEY_OPT, {});
    var out = {};
    for (var k in DEFAULT_OPTIONS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, k)) continue;
      out[k] = (typeof saved[k] === 'boolean') ? saved[k] : DEFAULT_OPTIONS[k];
    }
    return out;
  }
  function saveOptions(opt) { return writeJSON(KEY_OPT, opt); }
  function defaultOptions() {
    var out = {};
    for (var k in DEFAULT_OPTIONS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, k)) out[k] = DEFAULT_OPTIONS[k];
    }
    return out;
  }

  /* ---------- 進行中的題目 ---------- */
  function loadGame() { return readJSON(KEY_SAVE, null); }
  function saveGame(data) { return writeJSON(KEY_SAVE, data); }
  function clearGame() { remove(KEY_SAVE); }

  /* ---------- 最佳紀錄 ---------- */
  function loadBest() { return readJSON(KEY_BEST, {}); }
  /* 回傳 { best: 毫秒, isNew: 是否破紀錄 } */
  function recordWin(difficulty, elapsedMs, extra) {
    var all = loadBest();
    var prev = all[difficulty];
    var isNew = !prev || elapsedMs < prev.ms;
    if (isNew) {
      all[difficulty] = {
        ms: elapsedMs,
        at: Date.now(),
        hints: (extra && extra.hints) || 0,
        mistakes: (extra && extra.mistakes) || 0,
        seed: (extra && extra.seed) || ''
      };
    }
    all[difficulty + '_count'] = ((all[difficulty + '_count'] || 0) | 0) + 1;
    writeJSON(KEY_BEST, all);
    return { best: all[difficulty] ? all[difficulty].ms : elapsedMs, isNew: isNew, count: all[difficulty + '_count'] };
  }
  function clearBest() { remove(KEY_BEST); }

  /* ---------- 是否看過教學（第一次進來時才主動提示） ---------- */
  function hasSeenHelp() { return readJSON('sd_seen_help', false) === true; }
  function markHelpSeen() { writeJSON('sd_seen_help', true); }

  /* ---------- 上次選的難度 ---------- */
  function loadLastDifficulty() {
    var v = readJSON(KEY_LAST, null);
    return (typeof v === 'string') ? v : null;
  }
  function saveLastDifficulty(d) { writeJSON(KEY_LAST, d); }

  w.Store = {
    available: available,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    defaultOptions: defaultOptions,
    loadOptions: loadOptions, saveOptions: saveOptions,
    loadGame: loadGame, saveGame: saveGame, clearGame: clearGame,
    loadBest: loadBest, recordWin: recordWin, clearBest: clearBest,
    hasSeenHelp: hasSeenHelp, markHelpSeen: markHelpSeen,
    loadLastDifficulty: loadLastDifficulty, saveLastDifficulty: saveLastDifficulty
  };
})(typeof window !== 'undefined' ? window : globalThis);
