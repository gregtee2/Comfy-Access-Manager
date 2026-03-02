@echo off
title MediaVault Auto-Restart Watchdog
color 0E

echo.
echo  ============================================
echo    MediaVault Auto-Restart Watchdog
echo  ============================================
echo.
echo  Keeps MediaVault running 24/7 for ComfyUI.
echo  If the server crashes, it restarts within
echo  30 seconds so Save nodes keep working.
echo.
echo  Press Ctrl+C to stop the watchdog.
echo.

cd /d "%~dp0"

:loop
echo [%date% %time%] Starting MediaVault server...

:: Kill any stale processes on port 7700
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :7700 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 2 /nobreak >nul

:: Start the server (blocks until it exits/crashes)
node src\server.js

:: If we get here, the server exited
echo.
echo [%date% %time%] !! Server exited. Restarting in 30 seconds...
echo                     (Press Ctrl+C to stop)
echo.
timeout /t 30

goto loop
