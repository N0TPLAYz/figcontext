@echo off
REM ============================================================
REM  oc mcp - ONE-CLICK SETUP + RUN (3-step setup)
REM  Just double-click this file. No questions, no config.
REM  It installs what it needs, builds, configures opencode,
REM  installs the skill, and starts the bridge.
REM
REM  Keep this window OPEN while using Figma.
REM  Advanced: FIGMA_BRIDGE_PORT=4000 start-bridge.bat
REM            start-bridge.bat 4000
REM ============================================================
title oc mcp bridge
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo  ============================================
echo   oc mcp bridge - one-click setup
echo  ============================================
echo.

REM ---- 1. Node check ----
where node >nul 2>nul
if errorlevel 1 (
  echo  [x] Node.js NOT found.
  echo      Install LTS from https://nodejs.org then double-click this again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODEV=%%v
echo  [ok] Node %NODEV%

REM ---- 2. Port (default 3055, no question) ----
set PORT_FROM_ENV=0
if not "%FIGMA_BRIDGE_PORT%"=="" (
  set PORT=%FIGMA_BRIDGE_PORT%
  set PORT_FROM_ENV=1
) else (
  set PORT=3055
)
if not "%~1"=="" (
  set PORT=%~1
  set PORT_FROM_ENV=1
)
if "%PORT_FROM_ENV%"=="0" (
  if exist "%~dp0.bridge-port" (
    for /f "usebackq tokens=* delims=" %%p in ("%~dp0.bridge-port") do set PORT=%%p
  )
)
if "%PORT%"=="" set PORT=3055
set FIGMA_BRIDGE_PORT=%PORT%
>"%~dp0.bridge-port" echo %PORT%
echo  [ok] Port %PORT%  (override: set FIGMA_BRIDGE_PORT=xxxx or run: start-bridge.bat xxxx)

REM ---- 3. Bridge deps (auto-install first time only) ----
cd /d "%~dp0bridge"
if not exist "node_modules\ws" (
  echo  [..] Installing bridge deps - first run only...
  call npm.cmd install --no-audit --no-fund >nul 2>nul
  if errorlevel 1 (
    echo  [x] npm install failed. Check internet and double-click again.
    pause
    exit /b 1
  )
  echo  [ok] Bridge deps installed.
) else (
  echo  [ok] Bridge deps ready.
)

REM ---- 4. Plugin build (auto, only when needed) ----
cd /d "%~dp0"
set NEEDBUILD=0
if exist "code.js" goto :stale_check
set NEEDBUILD=1
echo  [..] Building Figma plugin - first run only...
goto :stale_done
:stale_check
powershell -noprofile -command "if ((Get-Item 'code.ts').LastWriteTime -gt (Get-Item 'code.js').LastWriteTime) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo  [ok] Plugin build ready.
) else (
  set NEEDBUILD=1
  echo  [..] Rebuilding Figma plugin - code.ts is newer...
)
:stale_done
if "%NEEDBUILD%"=="1" (
  if not exist "node_modules\typescript" (
    echo  [..] Installing build tools - first run only - no prompt...
    call npm.cmd install --no-audit --no-fund >nul 2>nul
    if errorlevel 1 (
      echo  [x] npm install failed.
      pause
      exit /b 1
    )
  )
  call npx.cmd tsc -p tsconfig.json
  if errorlevel 1 (
    echo  [x] Build failed. See errors above.
    pause
    exit /b 1
  )
  echo  [ok] Plugin built.
)

REM ---- 5. opencode + skill (auto, safe merge, no questions) ----
if exist "%~dp0setup-opencode.js" (
  echo  [..] Configuring opencode - global safe merge...
  node "%~dp0setup-opencode.js" >"%TEMP%\oc-setup.log" 2>&1
  if errorlevel 1 (
    echo  [!!] opencode config had an issue - details below. Bridge will still run.
    type "%TEMP%\oc-setup.log"
  ) else (
    echo  [ok] opencode configured. Restart opencode to load.
  )
) else (
  echo  [--] setup-opencode.js not found, skipping opencode config.
)
if exist "%~dp0skill\figma-bridge\SKILL.md" (
  mkdir "%USERPROFILE%\.config\opencode\skills\figma-bridge" 2>nul
  xcopy "%~dp0skill\figma-bridge" "%USERPROFILE%\.config\opencode\skills\figma-bridge\" /E /I /Y >nul 2>nul
  if errorlevel 1 (
    echo  [!!] Skill copy failed - you can still use the link flow.
  ) else (
    echo  [ok] Skill installed.
  )
) else (
  echo  [--] Skill not found, skipping.
)

REM ---- 6. run ----
echo.
echo  ============================================
echo   Starting bridge on ws://localhost:%PORT%
echo   Keep this window OPEN.
echo   Health: http://localhost:%PORT%/health  (should say ok)
echo  ============================================
echo.
echo   Figma: Plugins -^> Development -^> Import from manifest (first time)
echo          pick manifest.json in this folder, then run oc mcp
echo          it shows FIG-XXXX and turns green when connected.
echo.
cd /d "%~dp0bridge"
node server.js
echo.
echo  [bridge] Stopped.
pause
