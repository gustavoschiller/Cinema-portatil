@echo off
cd /d "%~dp0arquivos"
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0arquivos\painel.ps1"
