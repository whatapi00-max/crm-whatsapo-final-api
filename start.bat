@echo off
title WhatsApp CRM Pro - Launcher
echo ============================================
echo  WhatsApp CRM Pro - Starting All Services
echo ============================================
echo.

:: Navigate to project directory
cd /d "%~dp0"

:: Create logs dir if missing
if not exist "logs" mkdir logs

:: Kill any previous PM2 processes for this app
echo [1/4] Stopping old processes...
call pm2 delete whatsapp-crm 2>nul
call pm2 delete cloudflare-tunnel 2>nul

:: Start everything via PM2
echo [2/4] Starting WhatsApp CRM server via PM2...
call pm2 start ecosystem.config.js

:: Wait for server to be ready
echo [3/4] Waiting for server to start...
timeout /t 5 /nobreak >nul

:: Show status
echo [4/4] All services running!
echo.
call pm2 list

echo.
echo ============================================
echo  IMPORTANT: Check tunnel logs for your URL:
echo    pm2 logs cloudflare-tunnel --lines 20
echo.
echo  Your public Cloudflare URL will appear as:
echo    https://xxxxx-xxxxx-xxxxx.trycloudflare.com
echo ============================================
echo.
echo  Other useful commands:
echo    pm2 logs              - View all logs
echo    pm2 logs whatsapp-crm - View CRM logs only
echo    pm2 monit             - Live monitoring
echo    pm2 restart all       - Restart everything
echo    pm2 stop all          - Stop everything
echo.
pause
