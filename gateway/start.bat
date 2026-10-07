@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
rem Let Node honour HTTPS_PROXY / system proxy variables on company networks.
set "NODE_USE_ENV_PROXY=1"
title WhatsApp Relay - KEEP THIS WINDOW OPEN
node gateway.js
echo.
echo Relay stopped.
pause
