@echo off
title TechTalent Portal Server
echo.
echo  =========================================
echo   TechTalent Portal - Local Server
echo  =========================================
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed!
  echo Please install from: https://nodejs.org
  pause
  exit /b 1
)

echo  Starting server on http://localhost:4747
echo  Data stored in: E:\ResumePortal\data\
echo  Press Ctrl+C to stop.
echo.

cd /d "%~dp0"
node server.js

if errorlevel 1 (
  echo.
  echo [ERROR] Server failed to start.
  pause
)
