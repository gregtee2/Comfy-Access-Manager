@echo off
title Comfy Asset Manager — Installer
color 0B
setlocal EnableDelayedExpansion

:: ─── Guard: Detect running from inside a ZIP (temp path) ───
set "SCRIPT_DIR=%~dp0"
echo "%SCRIPT_DIR%" | findstr /i /c:"\Temp" /c:"\AppData\Local\Temp" /c:".zip" >nul 2>&1
if not errorlevel 1 (
    color 0C
    echo.
    echo  ============================================================
    echo    ERROR: Running from inside a ZIP file!
    echo  ============================================================
    echo.
    echo  Windows is running this from a temporary folder.
    echo  Nothing installed here will be kept.
    echo.
    echo  PLEASE DO THIS FIRST:
    echo    1. Close this window
    echo    2. Right-click the downloaded .zip file
    echo    3. Choose "Extract All..." to a permanent folder
    echo       ^(e.g., C:\Comfy-Asset-Manager^)
    echo    4. Open the extracted folder
    echo    5. THEN double-click install.bat
    echo.
    pause
    exit /b 1
)

:: ─── Guard: Detect protected paths (Program Files, Windows, etc.) ───
echo "%SCRIPT_DIR%" | findstr /i /c:"\Program Files" /c:"\Program Files (x86)" /c:"\Windows" >nul 2>&1
if not errorlevel 1 (
    color 0E
    echo.
    echo  ============================================================
    echo    WARNING: Installed in a protected folder!
    echo  ============================================================
    echo.
    echo  You extracted to: %SCRIPT_DIR%
    echo.
    echo  Windows blocks writes to Program Files without admin rights.
    echo  This will cause npm, FFmpeg, and RV downloads to FAIL.
    echo.
    echo  RECOMMENDED: Extract to a simpler location like:
    echo    C:\Comfy-Asset-Manager
    echo    or your Desktop / Documents folder
    echo.
    echo  Or press any key to try anyway with admin elevation...
    echo.
    pause
    :: Try to re-launch as admin
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b 0
)

echo.
echo  =============================================
echo    Comfy Asset Manager (CAM) — One-Click Installer
echo  =============================================
echo.
echo  This installer handles everything for you.
echo  Just sit back — it will install all dependencies
echo  automatically if they are not already present.
echo.

cd /d "%~dp0"
if not exist "tools" mkdir tools

:: ─── [1/5] Check / Install Node.js ───
echo  [1/5] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo         Node.js not found. Installing automatically...
    echo.

    :: Detect architecture
    set "NODE_URL=https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
    if "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
        set "NODE_URL=https://nodejs.org/dist/v22.14.0/node-v22.14.0-arm64.msi"
    )

    echo         Downloading Node.js v22 LTS...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "try { " ^
        "  Invoke-WebRequest -Uri '!NODE_URL!' -OutFile 'tools\node-installer.msi'; " ^
        "  Write-Host '         Download complete.'; " ^
        "} catch { " ^
        "  Write-Host ('         ERROR: ' + $_.Exception.Message); " ^
        "}"

    if not exist "tools\node-installer.msi" (
        echo.
        echo  ERROR: Failed to download Node.js installer.
        echo  Please install manually from: https://nodejs.org/
        echo  Then re-run this installer.
        echo.
        pause
        exit /b 1
    )

    echo         Installing Node.js (this may take a minute^)...
    msiexec /i "tools\node-installer.msi" /passive /norestart
    del "tools\node-installer.msi" 2>nul

    :: Refresh PATH so node is available in this session
    for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYSPATH=%%B"
    for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USRPATH=%%B"
    set "PATH=!SYSPATH!;!USRPATH!"

    where node >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  ERROR: Node.js installation may have failed.
        echo  Please install manually from: https://nodejs.org/
        echo  Then re-run this installer.
        echo.
        pause
        exit /b 1
    )
    for /f "tokens=*" %%v in ('node --version') do echo         Node.js %%v installed successfully!
) else (
    for /f "tokens=*" %%v in ('node --version') do echo         Found Node.js %%v
)

:: ─── [2/5] Check / Install Git ───
echo  [2/5] Checking Git...
where git >nul 2>&1
if errorlevel 1 (
    echo         Git not found. Installing automatically...
    echo.

    set "GIT_URL=https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe"
    echo         Downloading Git for Windows...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "try { " ^
        "  Invoke-WebRequest -Uri '!GIT_URL!' -OutFile 'tools\git-installer.exe'; " ^
        "  Write-Host '         Download complete.'; " ^
        "} catch { " ^
        "  Write-Host ('         ERROR: ' + $_.Exception.Message); " ^
        "}"

    if exist "tools\git-installer.exe" (
        echo         Installing Git (silent install^)...
        start "" /wait "tools\git-installer.exe" /VERYSILENT /NORESTART /NOCANCEL /SP-
        del "tools\git-installer.exe" 2>nul

        :: Refresh PATH
        for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYSPATH=%%B"
        for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USRPATH=%%B"
        set "PATH=!SYSPATH!;!USRPATH!"

        where git >nul 2>&1
        if errorlevel 1 (
            echo         NOTE: Git installed but not on PATH yet.
            echo         Close and re-open this terminal for Git to work.
        ) else (
            for /f "tokens=*" %%v in ('git --version') do echo         %%v installed successfully!
        )
    ) else (
        echo         WARNING: Git download failed. You can install it later from:
        echo         https://git-scm.com/
        echo         (Git is only needed for pulling future updates.^)
    )
) else (
    for /f "tokens=*" %%v in ('git --version') do echo         Found %%v
)

:: ─── [3/5] Install npm packages ───
echo  [3/5] Installing npm packages...
call npm install --no-audit --no-fund
echo         Done.

:: ─── [4/5] Download FFmpeg ───
echo  [4/5] Checking FFmpeg...

:: Check if FFmpeg is already on PATH
where ffmpeg >nul 2>&1
if not errorlevel 1 (
    echo         FFmpeg already on PATH — skipping download.
    goto :done_ffmpeg
)

:: Check if we already downloaded it locally
if exist "tools\ffmpeg\bin\ffmpeg.exe" (
    echo         FFmpeg already in tools\ — skipping download.
    goto :done_ffmpeg
)

echo         FFmpeg not found. Downloading portable build...
if not exist "tools" mkdir tools

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference = 'SilentlyContinue'; " ^
    "Write-Host '         Downloading FFmpeg (this may take a minute)...'; " ^
    "try { " ^
    "  Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile 'tools\ffmpeg.zip'; " ^
    "  Write-Host '         Extracting...'; " ^
    "  Expand-Archive -Path 'tools\ffmpeg.zip' -DestinationPath 'tools\ffmpeg-temp' -Force; " ^
    "  if (Test-Path 'tools\ffmpeg') { Remove-Item 'tools\ffmpeg' -Recurse -Force }; " ^
    "  $src = Get-ChildItem 'tools\ffmpeg-temp' -Directory | Select-Object -First 1; " ^
    "  Move-Item -Path $src.FullName -Destination 'tools\ffmpeg' -Force; " ^
    "  Remove-Item 'tools\ffmpeg-temp' -Recurse -Force -ErrorAction SilentlyContinue; " ^
    "  Remove-Item 'tools\ffmpeg.zip' -Force; " ^
    "  Write-Host '         FFmpeg installed to tools\ffmpeg\'; " ^
    "} catch { " ^
    "  Write-Host ('         ERROR: ' + $_.Exception.Message); " ^
    "}"

if exist "tools\ffmpeg\bin\ffmpeg.exe" (
    echo         FFmpeg installed successfully!
) else (
    echo         WARNING: FFmpeg download may have failed.
    echo         You can install it manually from https://ffmpeg.org/download.html
    echo         or place ffmpeg.exe in tools\ffmpeg\bin\
)

:done_ffmpeg

:: ─── [5/5] Check RV / OpenRV ───
echo  [5/5] Checking RV / OpenRV...
set "RV_FOUND=0"
if exist "tools\rv\bin\rv.exe" set "RV_FOUND=1"
if exist "C:\OpenRV\_build\stage\app\bin\rv.exe" set "RV_FOUND=1"
for /d %%d in ("C:\Program Files\RV-*") do if exist "%%d\bin\rv.exe" set "RV_FOUND=1"
for /d %%d in ("C:\Program Files\Shotgun*") do if exist "%%d\bin\rv.exe" set "RV_FOUND=1"
if !RV_FOUND!==1 (
    echo         RV / OpenRV found.
    goto :done
)

echo.
echo         RV / OpenRV not found.
echo         RV provides professional A/B wipe comparison and EXR/HDR playback.
echo.
set /p INSTALL_RV="         Download and install OpenRV for Windows? (~420 MB) (Y/N): "
if /i not "!INSTALL_RV!"=="Y" (
    echo         Skipping. You can install RV later from Settings.
    goto :done
)

echo         Downloading OpenRV 3.1.0 for Windows...
if not exist "tools" mkdir tools
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference = 'SilentlyContinue'; " ^
    "try { " ^
    "  $url = 'https://github.com/LatentPixelLLC/Comfy-Access-Manager/releases/download/rv-3.1.0/OpenRV-3.1.0-win64-mediavault.zip'; " ^
    "  Write-Host '         Downloading (this may take a few minutes)...'; " ^
    "  Invoke-WebRequest -Uri $url -OutFile 'tools\rv.zip'; " ^
    "  Write-Host '         Extracting...'; " ^
    "  if (Test-Path 'tools\rv') { Remove-Item 'tools\rv' -Recurse -Force }; " ^
    "} catch { " ^
    "  Write-Host ('         ERROR: ' + $_.Exception.Message); " ^
    "}"
:: Use tar instead of Expand-Archive to avoid Windows 260-char path limit
:: ZIP contains bin/rv.exe at root (not rv/bin/rv.exe), so extract into tools\rv\
if exist "tools\rv.zip" (
    if not exist "tools\rv" mkdir "tools\rv"
    tar -xf "tools\rv.zip" -C "tools\rv" 2>nul
    if exist "tools\rv\bin\rv.exe" (
        del "tools\rv.zip" >nul 2>&1
        echo         OpenRV installed to tools\rv\
    ) else (
        :: Fallback: check if tar created a wrapper folder
        for /d %%D in (tools\rv\rv-*) do (
            if exist "%%D\bin\rv.exe" (
                for %%F in ("%%D\*") do move /y "%%F" "tools\rv\" >nul 2>&1
                for /d %%S in ("%%D\*") do move /y "%%S" "tools\rv\" >nul 2>&1
                rd "%%D" 2>nul
            )
        )
        del "tools\rv.zip" >nul 2>&1
    )
)

if exist "tools\rv\bin\rv.exe" (
    echo         OpenRV installed successfully!
) else (
    echo         WARNING: Download may have failed.
    echo         You can set a custom RV path in Settings after launch.
    echo         Or download manually from: https://github.com/AcademySoftwareFoundation/OpenRV/releases
)

:done
:: ─── Create app directories ───
if not exist "data" mkdir data
if not exist "thumbnails" mkdir thumbnails

:: ─── Initialize git repo (needed for auto-updater) ───
if not exist ".git" (
    where git >nul 2>&1
    if not errorlevel 1 (
        echo.
        echo  [Setup] Initializing git repo for auto-updates...
        git init >nul 2>&1
        git remote add origin https://github.com/LatentPixelLLC/Comfy-Access-Manager.git >nul 2>&1
        git fetch origin stable >nul 2>&1
        git reset --mixed origin/stable >nul 2>&1
        echo         Git repo initialized — auto-updater will work.
    ) else (
        echo.
        echo  NOTE: Git not available. Auto-updater will need Git to be installed.
    )
)

echo.
echo  =============================================
echo    Installation Complete!
echo  =============================================
echo.
echo  To start CAM, run:  start.bat
echo  Then open:  http://localhost:7700
echo.
pause
