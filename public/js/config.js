/* ===== config.js — 全站唯一的 server URL 設定入口 =====
 * 數獨小學堂本身是純單機遊戲：沒有設定 server URL 時，所有功能照常運作。
 * 但只要之後要接伺服器（排行榜、雲端存檔、連線對戰），連線位置一律從這裡拿，
 * 不可以散落在 app.js、測試或其他檔案裡硬編碼。
 *
 * 解析優先序：
 *   1. 網址參數 ?server=https://example.com   （臨時覆蓋，方便測試 staging）
 *   2. 建置時注入（scripts/inject-server-url.js 會改寫下面 INJECTED 那一行）
 *   3. 都沒有 → null，代表單機模式
 *
 * 規則：必須是 http/https 的絕對網址；頁面走 https 時不接受 http（瀏覽器會擋混合內容）。
 * 格式不合會被擋下並記錄在 Config.error，不會靜默回退到 localhost 或任何寫死的網域。
 */
(function (w) {
  'use strict';

  /* GAME_SERVER_URL:BEGIN 這一行由 scripts/inject-server-url.js 改寫，請勿更動格式 */
  var INJECTED = '';
  /* GAME_SERVER_URL:END */

  /* 純函式：給定三個輸入，決定最後要用哪個 server URL。測試直接呼叫這一支。 */
  function resolve(injected, queryValue, pageProtocol) {
    var raw = String(queryValue || injected || '').trim();
    if (!raw) return { url: null, source: 'none', status: 'unset', error: null };

    var source = queryValue ? 'query' : 'injected';
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      return { url: null, source: source, status: 'invalid', error: '不是合法的絕對網址：' + raw };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { url: null, source: source, status: 'invalid', error: '只接受 http 或 https：' + raw };
    }
    if (pageProtocol === 'https:' && parsed.protocol === 'http:') {
      return { url: null, source: source, status: 'invalid', error: 'https 頁面不能連 http 伺服器（混合內容會被瀏覽器擋掉）：' + raw };
    }
    return {
      url: parsed.origin + parsed.pathname.replace(/\/+$/, ''),
      source: source,
      status: 'ok',
      error: null
    };
  }

  function queryParam(search) {
    var m = /[?&]server=([^&]*)/.exec(search || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  var loc = (typeof w.location === 'object' && w.location) ? w.location : { search: '', protocol: '' };
  var r = resolve(INJECTED, queryParam(loc.search), loc.protocol);

  if (r.status === 'invalid' && typeof console !== 'undefined' && console.warn) {
    console.warn('[config] server URL 設定有問題，改用單機模式：' + r.error);
  }

  var Config = {
    /* 已驗證過的 server URL；單機模式是 null */
    serverUrl: r.url,
    /* 'unset' 單機 ｜ 'ok' 已設定 ｜ 'invalid' 設定錯誤（已當成單機） */
    status: r.status,
    /* 'none' ｜ 'injected'（建置注入） ｜ 'query'（網址參數覆蓋） */
    source: r.source,
    error: r.error,
    isOnlineEnabled: function () { return r.status === 'ok'; },

    /* 組出完整 API 網址；單機模式回 null，呼叫端就知道該跳過 */
    url: function (path) {
      if (!Config.serverUrl) return null;
      var p = String(path || '');
      if (p && p.charAt(0) !== '/') p = '/' + p;
      return Config.serverUrl + p;
    },

    /* 給人看的一行說明，設定彈窗直接用 */
    describe: function () {
      if (Config.status === 'invalid') return '設定有誤（已改用單機）';
      if (!Config.serverUrl) return '未設定（單機模式）';
      var host = Config.serverUrl.replace(/^https?:\/\//, '');
      return host + (Config.source === 'query' ? '（網址參數覆蓋）' : '');
    },

    /* 打 /health 確認伺服器活著。單機模式不會發任何請求。
     * cb(state)：'unset' ｜ 'invalid' ｜ 'checking' ｜ 'ok' ｜ 'fail'
     * 免費雲端服務常常在睡覺，冷啟動可能要十幾秒，所以逾時放寬到 8 秒。 */
    checkHealth: function (cb) {
      if (!Config.isOnlineEnabled()) return cb(Config.status);
      if (typeof w.fetch !== 'function') return cb('fail');
      cb('checking');
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; cb('fail'); } }, 8000);
      w.fetch(Config.url('/health'), { method: 'GET', cache: 'no-store' })
        .then(function (res) { return res.ok ? 'ok' : 'fail'; })
        .catch(function () { return 'fail'; })
        .then(function (state) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cb(state);
        });
    },

    /* 測試用：不依賴瀏覽器環境也能驗證解析規則 */
    _resolve: resolve
  };

  w.GameConfig = Config;
}(typeof window !== 'undefined' ? window : this));
