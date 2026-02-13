@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bookmark-sorter-menu.ps1" %*
set "exitCode=%errorlevel%"

exit /b %exitCode%
