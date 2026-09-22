@echo off
title Archivist Fox Bot (No Auto-Scan)
cd /d "%~dp0"

echo ====================================
echo      Starting Archivist Fox Bot
echo     (Startup Auto-Scan: Disabled)
echo ====================================
echo.

set NODE_OPTIONS=--use-system-ca
set AUTO_SCAN_ON_STARTUP=false
npm start

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Bot stopped with an error (Code: %ERRORLEVEL%).
)

echo.
echo Press any key to exit...
pause > nul
