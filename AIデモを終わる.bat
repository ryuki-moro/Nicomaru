@echo off
rem Stops the Nicomaru AI demo started by the other .bat file.
cd /d "%~dp0"
node scripts/demo-launch.mjs stop
if errorlevel 1 pause
