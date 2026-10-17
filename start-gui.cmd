@echo off
rem Opens the dlna-cast desktop app. Closing the app window stops casting and quits.
cd /d "%~dp0"
node src\cli.mjs gui
if errorlevel 1 pause
