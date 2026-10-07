@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
node unlink.js
pause
