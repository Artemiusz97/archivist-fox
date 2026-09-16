@echo off
title Archivist Fox Bot
cd /d "%~dp0"

echo ====================================
echo      Starting Archivist Fox Bot
echo ====================================
echo.

set NODE_OPTIONS=--use-system-ca
npm start

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Bot stopped with an error (Code: %ERRORLEVEL%).
)

echo.
echo Press any key to exit...
pause > nul
