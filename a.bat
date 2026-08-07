@echo off
cd /d "%~dp0"
start "" cmd /d /c python -m http.server 8000
timeout /t 1 /nobreak >nul
start "" "http://localhost:8000/index.html?ts=%RANDOM%"
exit