import { ENDPOINTS, MODELS } from "../config.js";
import {
  AppError,
  ErrorCode,
  classifyHttpError,
  fetchWithTimeout,
  readErrorBody,
  ERROR_MESSAGES,
} from "../errors.js";

const MODEL_CACHE_TTL = 5 * 60 * 1000;
let cachedModels = [];
let cachedModelsForKey = "";
let cachedModelsAt = 0;

function providerMessage(raw) {
  try {
    const data = JSON.parse(raw);
    return data?.error?.message || data?.message || raw;
  } catch {
    return raw;
  }
}

async function listGroqModels(apiKey, { refresh = false } = {}) {
  if (!refresh && cachedModelsForKey === apiKey && Date.now() - cachedModelsAt < MODEL_CACHE_TTL && cachedModels.length) return cachedModels;
  const response = await fetchWithTimeout(
    ENDPOINTS.groqModels,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    20000
  );
  if (!response.ok) {
    const raw = await readErrorBody(response);
    const code = classifyHttpError(response.status, raw);
    throw new AppError(code, `${ERROR_MESSAGES[code] || "Groq model discovery failed."} ${providerMessage(raw)}`, { status: response.status, raw });
  }
  const data = await response.json();
  const models = (data.data || [])
    .filter((model) => model.active !== false && model.id && Number(model.context_window) > 0)
    .sort((a, b) => {
      const score = (model) => Math.min(Number(model.context_window) || 0, 2_000_000) * 100 + Math.min(Number(model.max_completion_tokens) || 0, 100_000);
      return score(b) - score(a);
    });
  if (!models.length) throw new AppError(ErrorCode.UNSUPPORTED, "No active Groq models support text completion.");
  cachedModels = models;
  cachedModelsForKey = apiKey;
  cachedModelsAt = Date.now();
  return models;
}

function canTryNextModel(error) {
  const status = error?.details?.status;
  const raw = String(error?.details?.raw || error?.message || "").toLowerCase();
  const invalidKey = /api.?key|unauthenticated|invalid credential/i.test(raw);
  const modelAccessDenied = status === 403 && !invalidKey && /model|permission|access|tier|billing|not available|not enabled/i.test(raw);
  const modelQuota = status === 429 && /model|quota|rate.?limit/i.test(raw);
  return status === 404 || (status >= 500 && status <= 599) || modelAccessDenied || modelQuota || (status === 400 && /model|json|response.?format|unsupported/i.test(raw)) || error?.code === ErrorCode.VALIDATION;
}

function finalModelError(error) {
  if (!error) return new AppError(ErrorCode.UNSUPPORTED, "No compatible Groq model could process this analysis.");
  const detail = String(error.details?.raw ? providerMessage(error.details.raw) : error.message).slice(0, 600);
  return new AppError(error.code || ErrorCode.UNKNOWN, `No available Groq model could process this analysis. Last provider error: ${detail}`, error.details);
}

const AUDIO_EXT = {
  "audio/webm": "webm",
  "audio/webm;codecs=opus": "webm",
  "audio/ogg": "ogg",
  "audio/ogg;codecs=opus": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

export async function testGroq(apiKey) {
  const models = await listGroqModels(apiKey, { refresh: true });
  return { ok: true, provider: "groq", modelCount: models.length };
}

export async function groqGenerateJson(apiKey, { system, user, timeoutMs = 90000 }) {
  const models = await listGroqModels(apiKey);
  let lastError;
  for (const model of models) {
    try {
      const response = await fetchWithTimeout(
        ENDPOINTS.groqChat,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model.id,
            temperature: 0.2,
            max_tokens: Math.min(8192, Number(model.max_completion_tokens) || 8192),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
        },
        timeoutMs
      );
      if (!response.ok) {
        const raw = await readErrorBody(response);
        const code = classifyHttpError(response.status, raw);
        const error = new AppError(code, ERROR_MESSAGES[code] || raw, { status: response.status, raw });
        lastError = error;
        if (canTryNextModel(error)) continue;
        throw error;
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new AppError(ErrorCode.VALIDATION, ERROR_MESSAGES[ErrorCode.VALIDATION]);
      try {
        return JSON.parse(content);
      } catch {
        const match = String(content).match(/\{[\s\S]*\}/);
        if (!match) throw new AppError(ErrorCode.VALIDATION, ERROR_MESSAGES[ErrorCode.VALIDATION]);
        return JSON.parse(match[0]);
      }
    } catch (error) {
      lastError = error;
      if (!canTryNextModel(error)) throw error;
    }
  }
  throw finalModelError(lastError);
}

export async function groqTranscribe(apiKey, blob, mimeType, { language = "en" } = {}) {
  const type = mimeType || blob.type || "audio/webm";
  const ext = AUDIO_EXT[type] || (type.includes("webm") ? "webm" : type.includes("mp4") ? "m4a" : "webm");
  const allowed = ["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"];
  if (!allowed.includes(ext)) {
    throw new AppError(ErrorCode.UNSUPPORTED_AUDIO, ERROR_MESSAGES[ErrorCode.UNSUPPORTED_AUDIO]);
  }
  const file = new File([blob], `recording.${ext}`, { type: type.split(";")[0] });
  const form = new FormData();
  form.append("file", file);
  form.append("model", MODELS.groqWhisper);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  form.append("language", language.startsWith("en") ? "en" : language);
  const response = await fetchWithTimeout(
    ENDPOINTS.groqTranscriptions,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
    120000
  );
  if (!response.ok) {
    const raw = await readErrorBody(response);
    if (response.status === 400) {
      try {
        const retryForm = new FormData();
        retryForm.append("file", new File([blob], `recording.${ext}`, { type: type.split(";")[0] }));
        retryForm.append("model", MODELS.groqWhisper);
        retryForm.append("response_format", "json");
        retryForm.append("language", language.startsWith("en") ? "en" : language);
        const retry = await fetchWithTimeout(
          ENDPOINTS.groqTranscriptions,
          { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: retryForm },
          120000
        );
        if (retry.ok) {
          const data = await retry.json();
          return { text: data.text || "", words: [], timestampsAvailable: false, model: data.model || MODELS.groqWhisper };
        }
      } catch { /* fall through to the original transcription error */ }
    }
    const code = classifyHttpError(response.status, raw);
    throw new AppError(code, ERROR_MESSAGES[code]);
  }
  const data = await response.json();
  const words = Array.isArray(data.words)
    ? data.words.map((item) => ({
        word: item.word,
        start: typeof item.start === "number" ? item.start : null,
        end: typeof item.end === "number" ? item.end : null,
        confidence: typeof item.probability === "number" ? item.probability : null,
      }))
    : [];
  return {
    text: data.text || "",
    words,
    timestampsAvailable: words.some((w) => w.start != null && w.end != null),
    model: data.model || MODELS.groqWhisper,
  };
}
