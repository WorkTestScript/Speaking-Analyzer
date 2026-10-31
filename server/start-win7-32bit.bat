@echo off
py -3.8-32 "%~dp0phoneme_server.py"
if errorlevel 1 pause
