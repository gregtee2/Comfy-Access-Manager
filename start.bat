@echo off
title Comfy Asset Manager
color 0B
setlocal

echo.
echo  ========================================
echo       Comfy Asset Manager - Starting
echo  ========================================
echo.

cd /d "%~dp0"

:: [1/4] Kill any existing instance on port 7700
echo  [1/4] Clearing port 7700...
netstat -ano > "%TEMP%\mv_port.tmp" 2>nul
findstr /C:":7700 " "%TEMP%\mv_port.tmp" | findstr LISTENING > "%TEMP%\mv_port2.tmp" 2>nul
for /f "tokens=5" %%a in (%TEMP%\mv_port2.tmp) do (
    echo         Stopping PID %%a...
    taskkill /PID %%a /F >nul 2>&1
)
del "%TEMP%\mv_port.tmp" 2>nul
del "%TEMP%\mv_port2.tmp" 2>nul

:: Small delay to let port clear
timeout /t 2 /nobreak >nul

:: [2/4] Check if node_modules exists
echo  [2/4] Checking dependencies...
if not exist "node_modules" (
    echo         First run - installing npm packages...
    call npm install
    echo.
)

:: [3/4] Create directories if needed
echo  [3/4] Checking directories...
if not exist "data" mkdir data
if not exist "thumbnails" mkdir thumbnails

:: [4/4] Start server
echo.
echo  Starting Comfy Asset Manager on http://localhost:7700 ...
echo.
node src/server.js

echo.
echo  ========================================
echo   Server stopped. Press any key to exit.
echo  ========================================
echo.
pause >nul