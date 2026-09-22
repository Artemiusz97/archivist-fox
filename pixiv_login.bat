@echo off
title Archivist Fox - Pixiv Login Setup
cd /d "%~dp0"

echo ==============================================================================
echo                 Archivist Fox - Pixiv Login Authorization
echo ==============================================================================
echo.
echo Starting Pixiv authentication helper...
echo (If you need help, open PIXIV_LOGIN_GUIDE.txt)
echo.

python scripts/pixiv_auth.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Pixiv authorization failed or was canceled (Code: %ERRORLEVEL%).
    echo     Please check PIXIV_LOGIN_GUIDE.txt for step-by-step help.
)

echo.
echo Press any key to close this window...
pause > nul
