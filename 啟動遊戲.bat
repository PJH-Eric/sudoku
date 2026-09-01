@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 找不到 Node.js
  echo 請先到 https://nodejs.org/ 安裝 Node.js LTS 之後再執行一次。
  echo.
  pause
  exit /b 1
)

echo ================================================
echo   數獨小學堂 - 遊戲伺服器
echo ================================================
echo.
echo   本機開啟： http://localhost:3010
echo   （同一個 Wi-Fi 的平板可用下方顯示的區網網址開啟）
echo.
echo   要停止伺服器請按 Ctrl+C 或直接關掉這個視窗。
echo.

start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:3010"

node server.js
echo.
echo 伺服器已停止。
pause
