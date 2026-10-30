const MODEL_ID = "robg/speako-phoneme-recognizer";
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";
let recognizerPromise = null;

export async function loadRecognizer(onProgress = () => {}) {
  if (!recognizerPromise) {
    recognizerPromise = import(TRANSFORMERS_URL).then(({ pipeline, env }) => {
      env.allowLocalModels = false;
      return pipeline("automatic-speech-recognition", MODEL_ID, {
        dtype: "q8",
        device: "wasm",
        progress_callback: onProgress,
      });
    }).catch((error) => {
      recognizerPromise = null;
      throw new Error(`Failed to load the ONNX phoneme model: ${error.message}`);
    });
  }
  return recognizerPromise;
}

export async function recognizePhonemes(float32, onProgress) {
  const recognizer = await loadRecognizer(onProgress);
  const result = await recognizer(float32);
  return result.text || "";
}
