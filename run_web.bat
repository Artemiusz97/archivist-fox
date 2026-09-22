@echo off
title Archivist Fox Web UI
cd /d "%~dp0"

echo ====================================
echo      Starting Archivist Fox Web UI
echo ====================================
echo.

set NODE_OPTIONS=--use-system-ca
npm run web

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Web UI stopped with an error (Code: %ERRORLEVEL%).
)

echo.
echo Press any key to exit...
pause > nul
