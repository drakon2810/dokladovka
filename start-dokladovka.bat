@echo off
rem Spustenie Dokladovky na lokalnom PC: API + web + IMAP poller.
rem Zatvorenie okien = zastavenie aplikacie.
cd /d "%~dp0"
start "Dokladovka API (server + AI worker)" cmd /k npm run dev:api
start "Dokladovka WEB (stranka)" cmd /k npm run dev
start "Dokladovka IMAP (posta)" cmd /k npm run dev:imap
echo Cakam na start serverov...
timeout /t 12 >nul
start http://localhost:5173
