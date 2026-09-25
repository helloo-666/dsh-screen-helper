@echo off
rem dsbox launcher: forwards all args to the PowerShell implementation
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0dsbox.ps1" %*
