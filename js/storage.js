const SETTINGS_KEY = "esa.settings.v1";
const DRAFT_KEY = "esa.draft.v1";
const PAD_VERSION = 2;
const DB_NAME = "english-analyzer";
const DB_VERSION = 1;
const RECORDINGS = "recordings";
const ANALYSES = "analyses";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDINGS)) {
        const store = db.createObjectStore(RECORDINGS, { keyPath: "id", autoIncrement: true });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(ANALYSES)) {
        db.createObjectStore(ANALYSES, { keyPath: "id" });
      }
    };
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (Object.hasOwn(parsed, "azureRegion") || Object.hasOwn(parsed, "azureSpeechKey")) {
      delete parsed.azureRegion;
      delete parsed.azureSpeechKey;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
    }
    return {
      provider: parsed.provider || "gemini",
      geminiApiKey: typeof parsed.geminiApiKey === "string" ? parsed.geminiApiKey : "",
      groqApiKey: typeof parsed.groqApiKey === "string" ? parsed.groqApiKey : "",
      // Pads saved before padVersion 2 used the old 25/0 ms defaults; reset them to the new ones once.
      slicePadBeforeMs: parsed.padVersion === PAD_VERSION && Number.isFinite(Number(parsed.slicePadBeforeMs)) ? Math.max(0, Math.min(200, Number(parsed.slicePadBeforeMs))) : 40,
      slicePadAfterMs: parsed.padVersion === PAD_VERSION && Number.isFinite(Number(parsed.slicePadAfterMs)) ? Math.max(0, Math.min(200, Number(parsed.slicePadAfterMs))) : 80,
      dialect: "en-US",
      ttsEngine: parsed.ttsEngine === "browser" ? "browser" : "google",
      ttsVoiceURI: typeof parsed.ttsVoiceURI === "string" ? parsed.ttsVoiceURI : "",
    };
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  const current = loadSettings();
  const next = {
    provider: settings.provider ?? current.provider ?? "gemini",
    geminiApiKey: settings.geminiApiKey ?? current.geminiApiKey ?? "",
    groqApiKey: settings.groqApiKey ?? current.groqApiKey ?? "",
    slicePadBeforeMs: settings.slicePadBeforeMs ?? current.slicePadBeforeMs ?? 40,
    slicePadAfterMs: settings.slicePadAfterMs ?? current.slicePadAfterMs ?? 80,
    padVersion: PAD_VERSION,
    dialect: "en-US",
    ttsEngine: settings.ttsEngine ?? current.ttsEngine ?? "google",
    ttsVoiceURI: settings.ttsVoiceURI ?? current.ttsVoiceURI ?? "",
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

export function clearApiKeys() {
  const current = loadSettings();
  saveSettings({ ...current, geminiApiKey: "", groqApiKey: "" });
}

export function loadDraft() {
  try {
    return localStorage.getItem(DRAFT_KEY) || "";
  } catch {
    return "";
  }
}

export function saveDraft(text) {
  try {
    localStorage.setItem(DRAFT_KEY, text ?? "");
  } catch {
    /* quota */
  }
}

export async function saveRecording(record) {
  const db = await openDb();
  const tx = db.transaction(RECORDINGS, "readwrite");
  const store = tx.objectStore(RECORDINGS);
  const payload = {
    blob: record.blob,
    mimeType: record.mimeType,
    duration: record.duration,
    text: record.text,
    transcript: record.transcript || "",
    createdAt: record.createdAt || Date.now(),
    textFingerprint: fingerprint(record.text),
  };
  const id = await new Promise((resolve, reject) => {
    const req = store.add(payload);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  db.close();
  return id;
}

export async function listRecordings() {
  const db = await openDb();
  const tx = db.transaction(RECORDINGS, "readonly");
  const store = tx.objectStore(RECORDINGS);
  const rows = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rows
    .map((row) => ({
      id: row.id,
      mimeType: row.mimeType,
      duration: row.duration,
      text: row.text,
      transcript: row.transcript || "",
      createdAt: row.createdAt,
      textFingerprint: row.textFingerprint,
      blob: row.blob,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRecording(id) {
  const db = await openDb();
  const tx = db.transaction(RECORDINGS, "readonly");
  const row = await new Promise((resolve, reject) => {
    const req = tx.objectStore(RECORDINGS).get(Number(id));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return row;
}

export async function saveRecordingTranscript(id, transcript) {
  const db = await openDb();
  const tx = db.transaction(RECORDINGS, "readwrite");
  const store = tx.objectStore(RECORDINGS);
  const row = await new Promise((resolve, reject) => {
    const req = store.get(Number(id));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (!row) {
    db.close();
    throw new Error("Recording not found.");
  }
  row.transcript = String(transcript || "");
  store.put(row);
  await txDone(tx);
  db.close();
  return row.transcript;
}

export async function deleteRecording(id) {
  const db = await openDb();
  const tx = db.transaction(RECORDINGS, "readwrite");
  tx.objectStore(RECORDINGS).delete(Number(id));
  await txDone(tx);
  db.close();
}

export async function saveAnalysisSnapshot(kind, payload) {
  const db = await openDb();
  const tx = db.transaction(ANALYSES, "readwrite");
  tx.objectStore(ANALYSES).put({
    id: kind,
    savedAt: Date.now(),
    payload,
  });
  await txDone(tx);
  db.close();
}

export async function loadAnalysisSnapshot(kind) {
  const db = await openDb();
  const tx = db.transaction(ANALYSES, "readonly");
  const row = await new Promise((resolve, reject) => {
    const req = tx.objectStore(ANALYSES).get(kind);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return row;
}

export async function deleteAnalysisSnapshot(kind) {
  const db = await openDb();
  const tx = db.transaction(ANALYSES, "readwrite");
  tx.objectStore(ANALYSES).delete(kind);
  await txDone(tx);
  db.close();
}

export function fingerprint(text) {
  let hash = 2166136261;
  const value = String(text ?? "");
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
