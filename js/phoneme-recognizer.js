const MODEL_ID = "robg/speako-phoneme-recognizer";
// Modern browsers run the model in-page. Browsers without WebAssembly SIMD
// use the local native server, avoiding the browser's 32-bit WASM heap limit.
const SIMD_TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";
const LOCAL_SERVER_URL = "http://127.0.0.1:8765";
let recognizerPromise = null;
let useLocalServer = false;

function supportsWasmSimd() {
  if (typeof WebAssembly === "undefined" || typeof WebAssembly.validate !== "function") return false;
  // Minimal module containing a v128.const instruction. Older engines safely
  // return false when they cannot parse SIMD opcodes.
  const simdProbe = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b,
  ]);
  try { return WebAssembly.validate(simdProbe); } catch { return false; }
}

export async function loadRecognizer(onProgress = () => {}) {
  if (!recognizerPromise) {
    const useSimd = supportsWasmSimd();
    useLocalServer = !useSimd;
    const initialize = useSimd
      ? import(SIMD_TRANSFORMERS_URL).then(({ pipeline, env }) => {
        env.allowLocalModels = false;
        return pipeline("automatic-speech-recognition", MODEL_ID, {
          dtype: "q8",
          device: "wasm",
          progress_callback: onProgress,
        });
      })
      : fetch(`${LOCAL_SERVER_URL}/health`).then(async (response) => {
        if (!response.ok) throw new Error(`Local model server returned HTTP ${response.status}.`);
        const health = await response.json();
        if (!health.ready) throw new Error(health.error || "The local model server is not ready.");
        return { localServer: true };
      });
    recognizerPromise = initialize.catch((error) => {
      recognizerPromise = null;
      const runtime = useSimd ? "SIMD" : "local server";
      console.error(`ONNX phoneme model failed with the ${runtime} runtime:`, error);
      throw new Error(`Failed to load the ONNX phoneme model using the ${runtime} runtime: ${error.message}`);
    });
  }
  return recognizerPromise;
}

export async function recognizePhonemes(float32, onProgress) {
  const recognizer = await loadRecognizer(onProgress);
  if (useLocalServer) {
    const audio = float32 instanceof Float32Array ? float32 : new Float32Array(float32);
    const body = new ArrayBuffer(4 + 4 + audio.byteLength);
    const view = new DataView(body);
    view.setUint32(0, 1, true); // one segment in this request
    view.setUint32(4, audio.length, true);
    new Uint8Array(body, 8).set(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength));
    const response = await fetch(`${LOCAL_SERVER_URL}/recognize`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Local model server returned HTTP ${response.status}.`);
    return result.text || "";
  }
  const result = await recognizer(float32);
  return result.text || "";
}
