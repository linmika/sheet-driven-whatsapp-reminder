@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js not found. Unzip the Node.js "Windows Binary (.zip)" into a folder named "node" inside this folder. See README.md
  pause
  exit /b 1
)
node setup.js %*
pause
