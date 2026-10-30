const MODEL_ID = "robg/speako-phoneme-recognizer";
// Transformers.js 3.7.2 bundles a recent ONNX Runtime Web build that expects
// WebAssembly SIMD. The legacy build uses ONNX Runtime Web 1.14.0, which ships
// a baseline (non-SIMD) wasm binary for older browsers.
const SIMD_TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";
const LEGACY_TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
let recognizerPromise = null;

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
    const transformersUrl = useSimd ? SIMD_TRANSFORMERS_URL : LEGACY_TRANSFORMERS_URL;
    recognizerPromise = import(transformersUrl).then(({ pipeline, env }) => {
      env.allowLocalModels = false;
      const modelOptions = useSimd
        ? { dtype: "q8", device: "wasm" }
        : { quantized: true };
      return pipeline("automatic-speech-recognition", MODEL_ID, {
        ...modelOptions,
        progress_callback: onProgress,
      });
    }).catch((error) => {
      recognizerPromise = null;
      const runtime = useSimd ? "SIMD" : "non-SIMD (legacy)";
      console.error(`ONNX phoneme model failed with the ${runtime} runtime:`, error);
      throw new Error(`Failed to load the ONNX phoneme model using the ${runtime} runtime: ${error.message}`);
    });
  }
  return recognizerPromise;
}

export async function recognizePhonemes(float32, onProgress) {
  const recognizer = await loadRecognizer(onProgress);
  const result = await recognizer(float32);
  return result.text || "";
}
