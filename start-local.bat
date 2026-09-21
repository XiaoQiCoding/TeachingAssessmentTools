@echo off
setlocal
title Teaching Evaluation - Local Launcher

set "APP_DIR=%~dp0webapp"
set "APP_URL=http://127.0.0.1:4174/"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

echo Building the local website...
pushd "%APP_DIR%"
call node build.mjs
if errorlevel 1 (
  popd
  echo [ERROR] Build failed. Keep this window open for troubleshooting.
  pause
  exit /b 1
)
popd

echo Refreshing the local service...
powershell.exe -NoProfile -Command "$connections = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue; foreach ($connection in $connections) { $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $connection.OwningProcess); if ($process -and $process.CommandLine -match 'backend[\\/]local-server\.mjs') { Stop-Process -Id $process.ProcessId -Force } }"

echo Starting the local service. Keep this window open...
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%APP_URL%'"
pushd "%APP_DIR%"
call node backend/local-server.mjs
popd
exit /b
