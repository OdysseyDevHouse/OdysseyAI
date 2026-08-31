@echo off
REM ============================================================
REM  update.bat  -  DOUBLE-CLICK THIS ON THE SERVER (the VM)
REM ------------------------------------------------------------
REM  Deploys the staged build into C:\inetpub\odyssey_ai and
REM  restarts the app. Run it from inside the 'staged' folder
REM  you copied across.
REM ============================================================
echo.
echo === OdysseyAI: updating server ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-on-server.ps1"
echo.
pause
