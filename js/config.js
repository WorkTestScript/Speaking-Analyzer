import { loadSettings, saveSettings, clearApiKeys } from "./storage.js";

export const PROVIDERS = {
  gemini: "gemini",
  groq: "groq",
};

export const MODELS = {
  groqWhisper: "whisper-large-v3-turbo",
};

export const ENDPOINTS = {
  geminiGenerate: (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  geminiModels: "https://generativelanguage.googleapis.com/v1beta/models",
  groqChat: "https://api.groq.com/openai/v1/chat/completions",
  groqTranscriptions: "https://api.groq.com/openai/v1/audio/transcriptions",
  groqModels: "https://api.groq.com/openai/v1/models",
};

const DEFAULTS = {
  provider: PROVIDERS.gemini,
  geminiApiKey: "",
  groqApiKey: "",
};

let cache = { ...DEFAULTS };

export function getSettings() {
  return { ...cache };
}

export function getProviderId() {
  return cache.provider === PROVIDERS.groq ? PROVIDERS.groq : PROVIDERS.gemini;
}

export function getActiveApiKey() {
  return getProviderId() === PROVIDERS.groq ? cache.groqApiKey : cache.geminiApiKey;
}

export function hasActiveKey() {
  return Boolean(getActiveApiKey());
}

export function initConfig() {
  cache = { ...DEFAULTS, ...loadSettings() };
  if (cache.provider !== PROVIDERS.groq) cache.provider = PROVIDERS.gemini;
  return getSettings();
}

export function updateSettings(partial) {
  cache = { ...cache, ...partial };
  saveSettings({
    provider: cache.provider,
    geminiApiKey: cache.geminiApiKey,
    groqApiKey: cache.groqApiKey,
  });
  return getSettings();
}

export function wipeApiKeys() {
  cache.geminiApiKey = "";
  cache.groqApiKey = "";
  clearApiKeys();
  return getSettings();
}

export const STORAGE_WARNING =
  "API keys are stored in this browser’s localStorage. localStorage is not encrypted. Anyone with access to this device and browser profile can read the keys.";
