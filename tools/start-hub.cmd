@echo off
REM Family check-in hub launcher.
REM ASCII ONLY on purpose: cmd.exe parses .cmd files in the OEM codepage, and UTF-8 Chinese
REM bytes can contain 0x5C ("\") which silently breaks lines. All Chinese text is printed
REM by hub.mjs (Node, UTF-8), which is safe under chcp 65001.
chcp 65001 >nul
title Family Check-in Hub
setlocal

set "HUB_DIR=%~dp0..\hub"
if not exist "%HUB_DIR%\hub.mjs" (
  echo [error] hub.mjs not found: %HUB_DIR%\hub.mjs
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found. Please install Node.js 20 or newer.
  pause
  exit /b 1
)

REM ---------------------------------------------------------------
REM One-time firewall allow for TCP 8787 + UDP 8788 on ALL profiles.
REM Without it, a phone on a "Public" network (phone hotspot counts as
REM Public on Windows) cannot reach this PC at all.
REM ---------------------------------------------------------------
netsh advfirewall firewall show rule name="FamilyCheckinHub-TCP" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Firewall rule for the hub is missing.
  echo   Windows blocks incoming connections on "Public" networks, and a phone
  echo   hotspot is treated as Public - the phone would not be able to connect.
  echo   Asking for administrator rights once ...
  call "%~dp0fix-firewall.cmd"
  ping -n 6 127.0.0.1 >nul
  netsh advfirewall firewall show rule name="FamilyCheckinHub-TCP" >nul 2>&1
  if errorlevel 1 (
    echo   [warn] firewall rule still missing. Right-click tools\fix-firewall.cmd
    echo          and choose "Run as administrator", then start the hub again.
  ) else (
    echo   Firewall rule added. Phones can connect now.
  )
)

echo.
echo   Same home network is enough - any of these works:
echo     1) phone and PC on the same WiFi
echo     2) PC connected to the phone hotspot
echo     3) phone on WiFi + PC on Ethernet (same router)
echo.
echo   Dashboard : http://127.0.0.1:8787/
echo   Phones find this PC automatically (hub broadcasts every 5 seconds).
echo   If auto-find fails, type the LAN address printed below into the app,
echo   under: Settings ^(My tab^) / Hub address / Save / Test connection.
echo.
echo   Close this window to stop the hub. Phone data stays on the phone.
echo.

node "%HUB_DIR%\hub.mjs"
set "RC=%ERRORLEVEL%"

echo.
echo Hub exited with code %RC%.
pause
