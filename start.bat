@echo off
title WhatsApp CRM Pro - Launcher
echo ============================================
echo  WhatsApp CRM Pro - Starting
echo ============================================
echo.

:: Navigate to project directory
cd /d "%~dp0"

:: Create logs dir if missing
if not exist "logs" mkdir logs

:: Kill any previous PM2 processes for this app
echo [1/3] Stopping old processes...
call pm2 delete whatsapp-crm 2>nul

:: Start server via PM2
echo [2/3] Starting WhatsApp CRM server...
call pm2 start ecosystem.config.js

:: Wait for server to be ready
echo [3/3] Waiting for server to start...
timeout /t 5 /nobreak >nul

echo.
call pm2 list
echo.
echo ============================================
echo  Server running at: http://localhost:3000
echo ============================================
echo.
echo  Other useful commands:
echo    pm2 logs whatsapp-crm  - View server logs
echo    pm2 restart whatsapp-crm - Restart server
echo    pm2 stop whatsapp-crm  - Stop server
echo.
pause
