# Local phoneme server for Windows 7 (32-bit)

The browser app uses the ONNX model directly when WebAssembly SIMD is available. If SIMD is unavailable, it sends each 16 kHz audio segment to this server at `127.0.0.1:8765`. The model stays on the laptop and is downloaded to `%LOCALAPPDATA%` on the first start.

## Build a standalone server for Windows 7 (32-bit)

1. Install **Python 3.8.10, 32-bit** on the build computer. Python 3.8 is the final Python line with official Windows 7 support.
2. Run `build-standalone-win7-32bit.bat`. It creates `dist/SpeakingAnalyzerPhonemeServer/` with the server executable and its runtime files.
3. Copy that whole folder to the Windows 7 laptop. Start `SpeakingAnalyzerPhonemeServer.exe` and leave its window open. Python does not need to be installed on the laptop to run this packaged folder.
4. First start downloads the model (about 355 MB); later starts reuse the local copy.
5. Open the GitHub Pages app in Chrome. When SIMD is unavailable, the app checks the local server and uses it for phoneme recognition.

The server listens only on `127.0.0.1`; it is not exposed to other computers on the network. It accepts browser requests from GitHub Pages origins and localhost.

## Compatibility note

This is an experimental legacy setup: ONNX Runtime 1.14.0 has a CPython 3.8 Windows x86 package, but Windows 7 and this model/runtime combination must still be confirmed on the target laptop. The model is large, and 32-bit Windows has limited address space. If model initialization fails, the server prints the underlying error in its console. The standalone package must be built with 32-bit Python on Windows; this workspace does not currently have that build environment installed.
