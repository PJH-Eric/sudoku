# 數獨小學堂

可愛風格的 9×9 單機數獨遊戲，提供五種難度與唯一解謎題。免帳號、免安裝；設定、進度與紀錄保存在目前裝置的瀏覽器。

## 遊戲功能

- 新手入門、簡單、普通、困難、專家五種難度。
- 每日挑戰與題目種子；同一種子和難度會產生相同題目。
- 候選數筆記、提示、偷看答案、復原與重做。
- 暫停、計時、填錯提示、個人紀錄與續玩進度。
- 可調整音樂、音效、觸控震動、動畫、筆記整理與盤面高亮。
- 支援繁體中文、簡體中文和英文；適用手機、平板與桌機。

## 操作方式

| 操作 | 觸控／滑鼠 | 鍵盤 |
| --- | --- | --- |
| 選格子 | 點格子 | 方向鍵 |
| 填入數字 | 點數字盤 | `1`–`9` |
| 筆記模式 | 點「筆記」 | `N` |
| 清除 | 點「清除」 | `Backspace`、`Delete` 或 `0` |
| 復原／重做 | 點工具列 | `Z`／`Y` |
| 提示 | 點「提示」 | `H` |
| 暫停 | 點「暫停」 | `Esc` |
| 設定 | 點右上角齒輪 | `Esc` 關閉彈窗 |

## 啟動

直接用瀏覽器開啟 `public/index.html` 即可遊玩。也可以在專案目錄執行：

```bash
npm start
```

本機頁面會開在 `http://localhost:3010`。`server.js` 只提供靜態遊戲檔案，並只監聽本機回送介面。

## 專案結構

```text
sudoku/
├─ server.js                 本機靜態檔案伺服器
├─ 啟動遊戲.bat              Windows 一鍵啟動
├─ public/
│  ├─ index.html             遊戲畫面
│  ├─ css/style.css          主題與 RWD 樣式
│  └─ js/
│     ├─ locales.js          繁中、簡中與英文介面文字
│     ├─ sudoku.js           數獨規則、解題與出題
│     ├─ game.js             單局狀態與操作
│     ├─ storage.js          本機設定、進度與紀錄
│     ├─ audio.js            音樂與音效
│     └─ app.js              畫面、輸入與遊戲流程
├─ tests/                    規則、介面與語系檢查
└─ scripts/                  瀏覽器檢查與 SEO 工具
```

`public/` 是可部署的靜態網站。GitHub Pages 部署由 `.github/workflows/deploy-pages.yml` 管理。

## 常用指令

```bash
npm start
npm test
npm run test:browser
npm run verify
```

數獨規則與單局狀態分別位於 `public/js/sudoku.js` 和 `public/js/game.js`；兩者不操作 DOM。所有本機資料皆存放在瀏覽器的 `localStorage`。
