@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\stop.ps1" %*
set "result=%ERRORLEVEL%"
echo.
pause
exit /b %result%
