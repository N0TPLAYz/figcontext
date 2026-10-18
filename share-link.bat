@echo off
REM ============================================================
REM  oc mcp - PUBLIC share link (for Claude / ChatGPT in browser).
REM  Turns your local bridge into a public https link via Cloudflare.
REM  Needs: start-bridge.bat running + Figma plugin running.
REM  NOTE: Claude in a browser can READ the link. Changing the file
REM  still needs the local bridge + a coding CLI (opencode/Claude Code).
REM ============================================================
title oc mcp public share link
setlocal

cd /d "%~dp0"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [share] cloudflared NOT found - one-time install needed:
  echo   1. Open: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  echo   2. Download cloudflared for Windows (64-bit), put cloudflared.exe
  echo      somewhere on PATH or in THIS folder, then run this again.
  echo.
  echo   Tip: if cloudflared.exe is in this folder, this just works.
  if exist "%~dp0cloudflared.exe" (
    echo   Found local cloudflared.exe - continuing...
  ) else (
    pause
    exit /b 1
  )
)

set PORT=3055
set /p PORT="Bridge port? [3055]: "
if "%PORT%"=="" set PORT=3055

echo [share] Checking local bridge on %PORT%...
curl -s -o nul http://localhost:%PORT%/health
if errorlevel 1 (
  echo [share] Bridge is NOT running. Start it first:
  echo   Double-click start-bridge.bat and keep it open, then run this again.
  pause
  exit /b 1
)
echo [share] Bridge OK. Also make sure the Figma plugin is running
echo   (it shows your FIG-XXXX code).
echo.
echo [share] Starting public tunnel - keep this window OPEN.
echo   When you see 'Your quick Tunnel has been created' with a URL like
echo   https://something.trycloudflare.com
echo   your share link is:  THAT-URL/file/FIG-XXXX
echo   (replace FIG-XXXX with the code from your Figma plugin window)
echo.
echo   Paste that link to Claude/ChatGPT in the browser with what you want.
echo   Stop sharing any time: close this window (link dies instantly).
echo.

if exist "%~dp0cloudflared.exe" (
  "%~dp0cloudflared.exe" tunnel --url http://localhost:%PORT%
) else (
  cloudflared tunnel --url http://localhost:%PORT%
)
pause
