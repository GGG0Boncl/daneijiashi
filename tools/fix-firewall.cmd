@echo off
REM Allow inbound traffic for the family check-in hub on EVERY network profile.
REM
REM Why: Windows treats a phone hotspot (and many home WiFi networks) as "Public",
REM and on Public profiles it blocks inbound connections by default - the phone then
REM cannot reach the hub even though both are on the same LAN.
REM
REM Rules added (all profiles = Domain/Private/Public):
REM   TCP 8787  -> sync API + dashboard
REM   UDP 8788  -> auto discovery (probe reply + announce broadcast)
REM
REM Needs administrator rights; this script re-launches itself elevated (UAC prompt).
chcp 65001 >nul
setlocal

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo.
  echo   Asking for administrator rights ^(one-time firewall rule^) ...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

echo.
echo   Adding firewall rules for the check-in hub ...
netsh advfirewall firewall delete rule name="FamilyCheckinHub-TCP" >nul 2>&1
netsh advfirewall firewall delete rule name="FamilyCheckinHub-UDP" >nul 2>&1
netsh advfirewall firewall add rule name="FamilyCheckinHub-TCP" dir=in action=allow protocol=TCP localport=8787 profile=any
netsh advfirewall firewall add rule name="FamilyCheckinHub-UDP" dir=in action=allow protocol=UDP localport=8788 profile=any

echo.
echo   Verify:
netsh advfirewall firewall show rule name="FamilyCheckinHub-TCP" | findstr /i "FamilyCheckinHub"
netsh advfirewall firewall show rule name="FamilyCheckinHub-UDP" | findstr /i "FamilyCheckinHub"
echo.
echo   Done. This window closes itself in 8 seconds.
ping -n 9 127.0.0.1 >nul
