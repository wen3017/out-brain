@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\setup.ps1"
set "setupExit=%ERRORLEVEL%"
if not "%setupExit%"=="0" echo Setup failed. See the error above.
pause
exit /b %setupExit%
