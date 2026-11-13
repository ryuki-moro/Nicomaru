@echo off
rem Starts the Nicomaru AI demo (details: scripts/demo-launch.mjs, docs/presentation script).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org/ & pause & exit /b 1)
node scripts/demo-launch.mjs start
if errorlevel 1 pause
