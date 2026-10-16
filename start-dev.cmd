@echo off
setlocal
cd /d "%~dp0"
title Ai - Cz  ::  Dev Server

echo ============================================
echo   Ai - Cz  -  starting local server
echo ============================================
echo.

if not exist "node_modules" (
  echo [1/2] Installing dependencies for the first time...
  call corepack pnpm@10.4.1 install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Dependencies already installed.
)

echo.
echo [2/2] Starting server...
echo   Site  : http://localhost:3000/
echo   Admin : http://localhost:3000/admin
echo.
echo   Press Ctrl + C in this window to stop the server.
echo.

start "" http://localhost:3000/
call corepack pnpm@10.4.1 run dev

echo.
echo Server stopped.
pause
