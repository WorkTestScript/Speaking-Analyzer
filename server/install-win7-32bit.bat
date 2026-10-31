@echo off
setlocal
py -3.8-32 --version >nul 2>nul
if errorlevel 1 (
  echo Python 3.8 32-bit was not found.
  echo Install Python 3.8.10 32-bit, then run this file again.
  pause
  exit /b 1
)
py -3.8-32 -m pip install "pip<25"
py -3.8-32 -m pip install -r "%~dp0requirements-win32.txt"
if errorlevel 1 (
  echo Dependency installation failed.
  pause
  exit /b 1
)
echo Setup complete. Run start-win7-32bit.bat to start the local model server.
pause
