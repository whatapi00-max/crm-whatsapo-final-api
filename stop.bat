@echo off
title WhatsApp CRM Pro - Stopping
echo Stopping all services...
call pm2 stop all
call pm2 delete all
echo All services stopped.
pause
