@echo off
setlocal
set "PSModulePath="
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\windows\configure-services-gui.ps1"
endlocal
