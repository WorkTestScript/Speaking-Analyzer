@echo off
setlocal
cd /d "%~dp0.."

py -3.8-32 --version >nul 2>nul
if errorlevel 1 (
  echo Python 3.8 32-bit was not found.
  echo Install Python 3.8.10 32-bit to build this package.
  pause
  exit /b 1
)

py -3.8-32 -m pip install "pip<25"
py -3.8-32 -m pip install -r server\requirements-win32.txt "pyinstaller==5.13.2"
if errorlevel 1 (
  echo Dependency installation failed.
  pause
  exit /b 1
)

py -3.8-32 -m PyInstaller --clean --noconfirm --onedir --console --name SpeakingAnalyzerPhonemeServer --collect-all onnxruntime --collect-all numpy server\phoneme_server.py
if errorlevel 1 (
  echo Packaging failed.
  pause
  exit /b 1
)

echo.
echo Standalone server created in dist\SpeakingAnalyzerPhonemeServer.
echo You can copy that whole folder to the laptop and run SpeakingAnalyzerPhonemeServer.exe.
pause
