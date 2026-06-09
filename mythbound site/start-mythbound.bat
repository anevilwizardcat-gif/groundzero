@echo off
cd /d "%~dp0"
echo Starting MYTHBOUND server...
echo Once it boots, open http://localhost:3000 in your browser.
echo (Close this window or press Ctrl+C to stop the server.)
echo.
node server.js
pause
