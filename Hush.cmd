@echo off
setlocal
cd /d "%~dp0"
title Hush - Private Vault

call npm.cmd run dev
set "HUSH_EXIT_CODE=%ERRORLEVEL%"

if not "%HUSH_EXIT_CODE%"=="0" (
  echo.
  echo Hush could not start. Make sure Node.js is installed and run npm.cmd install once.
  pause
)

exit /b %HUSH_EXIT_CODE%
