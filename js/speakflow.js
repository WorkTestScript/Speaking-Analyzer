import { initConfig, getSettings, updateSettings, MODELS } from "./config.js";
import { transcribeAudio } from "./api/provider.js";
import { speakGoogleAmerican, stopGoogleSpeech, setGoogleSpeechRate } from "./google-tts.js?v=tts-rate-fix-1";

const $ = (id) => document.getElementById(id);
const LIST_KEY = "speakflow.phrases.v1";
const PROGRESS_KEY = "speakflow.progress.v1";
const AUTO_NEXT_KEY = "speakflow.auto-next.v1";
const THEME_KEY = "speaking-analyzer-theme";
let phrases = [];
let index = 0;
let stream = null;
let mediaRecorder = null;
let audioChunks = [];
let recording = false;
let typingIntent = false;
let ttsBusy = false;
let advancePending = false;
let advanceTimer = null;
let autoAdvance = true;
let audioUrl = null;
let answerPlayback = null;
let silenceContext = null;
let silenceAnalyser = null;
let silenceFrame = 0;
let silenceSince = 0;
let silenceStopTriggered = false;
let speechDetected = false;
let recordingStartedAt = 0;

function setAnswerPlaybackIcon(playing) {
  const button = $("play-answer-recording");
  button.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  button.setAttribute("aria-label", playing ? "Stop recorded answer" : "Play recorded answer");
  button.title = playing ? "Stop recorded answer" : "Play recorded answer";
}

function stopSilenceMonitor() {
  if (silenceFrame) cancelAnimationFrame(silenceFrame);
  silenceFrame = 0; silenceAnalyser = null; silenceSince = 0; silenceStopTriggered = false; speechDetected = false;
  if (silenceContext) { void silenceContext.close().catch(() => {}); silenceContext = null; }
}

async function monitorSilence() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !stream) return;
    silenceContext ||= new AudioContextClass();
    if (silenceContext.state !== "running") await silenceContext.resume();
    if (!recording || !stream) return;
    silenceAnalyser = silenceContext.createAnalyser();
    silenceAnalyser.fftSize = 2048;
    // Ignore low-frequency room and mains hum when deciding whether speech is present.
    // The filter is only used by the silence monitor; the recorded audio stays untouched.
    const speechFilter = silenceContext.createBiquadFilter();
    speechFilter.type = "highpass";
    speechFilter.frequency.value = 120;
    speechFilter.Q.value = 0.707;
    silenceContext.createMediaStreamSource(stream).connect(speechFilter).connect(silenceAnalyser);
    const samples = new Uint8Array(silenceAnalyser.fftSize);
    const check = () => {
      if (!recording || !silenceAnalyser || silenceStopTriggered) return;
      silenceAnalyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) { const value = (sample - 128) / 128; sum += value * value; }
      const rms = Math.sqrt(sum / samples.length);
      const now = Date.now();
      if (rms >= 0.006) { speechDetected = true; silenceSince = 0; }
      else if (speechDetected && !silenceSince) silenceSince = now;
      const silenceDuration = autoAdvance ? 1000 : 2000;
      const silenceExpired = speechDetected
        ? silenceSince > 0 && now - silenceSince >= silenceDuration
        : now - recordingStartedAt >= 6000;
      if (silenceExpired) {
        silenceStopTriggered = true; silenceFrame = 0;
        announce("Silence detected. Transcribing…");
        void recordAnswer();
        return;
      }
      silenceFrame = requestAnimationFrame(check);
    };
    silenceFrame = requestAnimationFrame(check);
  } catch { stopSilenceMonitor(); }
}

function announce(text, kind = "") { const el = $("answer-status"); el.textContent = text; el.dataset.kind = kind; }
let lastRecognitionModel = "";
function updateRecognitionModel(model = lastRecognitionModel) {
  const provider = getSettings().provider === "groq" ? "groq" : "gemini";
  const badge = $("recognition-model");
  const fallback = provider === "groq" ? MODELS.groqWhisper : "auto";
  const label = model || fallback;
  badge.dataset.provider = provider;
  badge.textContent = `${provider === "groq" ? "Groq" : "Gemini"} · ${label}`;
  badge.title = `Speech recognition model: ${provider === "groq" ? "Groq" : "Gemini"} ${label}`;
}
function toast(text, kind = "error") { const el = $("toast"); el.textContent = text; el.dataset.kind = kind; el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 2000); }
function normalize(text) { return String(text || "").normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []; }
function listSignature() {
  const value = JSON.stringify(phrases); let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
function restoreProgress() {
  try {
    const progress = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "null");
    if (progress?.signature === listSignature() && Number.isInteger(progress.index) && progress.index >= 0 && progress.index < phrases.length) index = progress.index;
    else index = 0;
  } catch { index = 0; }
}
function advancePhrase() {
  if (!phrases.length) return;
  index = index + 1 < phrases.length ? index + 1 : 0;
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify({ signature: listSignature(), index })); } catch { /* keep the current session usable if storage is unavailable */ }
  renderPhrase();
  if (autoAdvance) void playCurrentPhrase();
}
function updateAdvanceControls() {
  const button = $("toggle-auto-next");
  button.dataset.active = String(autoAdvance);
  button.setAttribute("aria-pressed", String(autoAdvance));
  button.setAttribute("aria-label", `Automatic next is ${autoAdvance ? "on" : "off"}`);
  button.title = autoAdvance ? "Turn automatic next off" : "Turn automatic next on";
  $("manual-next").hidden = autoAdvance;
  $("manual-next").disabled = !advancePending;
}
function scheduleAutomaticAdvance(phraseIndex) {
  clearTimeout(advanceTimer);
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    if (autoAdvance && advancePending && index === phraseIndex) advancePhrase();
  }, 1000);
}
function cleanAudio() { stopSilenceMonitor(); if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); mediaRecorder = null; audioChunks = []; recording = false; if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; } $("record-answer").dataset.recording = "false"; $("record-answer").setAttribute("aria-label", "Record answer"); $("record-answer").title = "Record answer"; if (answerPlayback) { answerPlayback.pause(); answerPlayback.removeAttribute("src"); answerPlayback.load(); answerPlayback = null; } if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; } $("play-answer-recording").disabled = true; setAnswerPlaybackIcon(false); }
function stopRecordingForTyping() {
  typingIntent = true;
  if (!recording) {
    if (silenceContext) { void silenceContext.close().catch(() => {}); silenceContext = null; }
    return;
  }
  recording = false; stopSilenceMonitor();
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.ondataavailable = null; mediaRecorder.onstop = null; mediaRecorder.stop();
  }
  mediaRecorder = null; audioChunks = [];
  if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; }
  $("record-answer").dataset.recording = "false"; $("record-answer").setAttribute("aria-label", "Record answer"); $("record-answer").title = "Record answer";
  announce("Recording stopped. Type your answer.");
}
function renderList() {
  const list = $("list-preview"); list.replaceChildren();
  if (!phrases.length) { list.innerHTML = '<div class="empty-state">Your validated phrase list will be saved in this browser.</div>'; $("phrase-count").textContent = "0 phrases"; }
  else {
    phrases.forEach((phrase, phraseIndex) => {
      const row = document.createElement("div"); row.className = "phrase-row"; row.dataset.current = String(phraseIndex === index);
      row.innerHTML = `<span class="row-index">${phraseIndex + 1}</span><strong></strong>`; row.querySelector("strong").textContent = phrase.en; list.append(row);
    });
    $("phrase-count").textContent = `${phrases.length} phrase${phrases.length === 1 ? "" : "s"}`;
  }
  $("progress-badge").textContent = phrases.length ? `${Math.min(index + 1, phrases.length)} / ${phrases.length}` : "No phrase list";
}
function renderPhrase() {
  clearTimeout(advanceTimer); advanceTimer = null;
  advancePending = false;
  updateAdvanceControls();
  $("answer-correct").hidden = true;
  cleanAudio(); stopGoogleSpeech(); ttsBusy = false;
  const phrase = phrases[index];
  renderPhraseWords(phrase?.en || "Load a phrase list to get started.");
  $("phrase-text").classList.add("is-hidden"); $("reveal-text").setAttribute("aria-label", "Show phrase"); $("reveal-text").title = "Show phrase";
  $("phrase-translation").textContent = phrase?.ua || ""; $("phrase-translation").hidden = !phrase?.ua;
  $("answer-text").value = ""; $("answer-highlight").replaceChildren(); $("answer-text").disabled = !phrase; $("record-answer").disabled = !phrase || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder; $("skip-phrase").disabled = !phrase;
  $("phrase-play").disabled = !phrase; setPhrasePlayState(false);
  $("word-feedback").replaceChildren(); announce(""); renderList();
}
function renderPhraseWords(text) {
  const target = $("phrase-text"); target.replaceChildren();
  const pattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu; let cursor = 0; let match;
  while ((match = pattern.exec(text))) {
    target.append(document.createTextNode(text.slice(cursor, match.index)));
    const word = document.createElement("button"); word.type = "button"; word.className = "phrase-word"; word.textContent = match[0]; word.dataset.word = match[0]; word.setAttribute("aria-label", `Play ${match[0]}`); target.append(word); cursor = match.index + match[0].length;
  }
  target.append(document.createTextNode(text.slice(cursor)));
}
function setPhrasePlayState(playing) {
  const button = $("phrase-play");
  button.innerHTML = playing ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  button.setAttribute("aria-label", playing ? "Stop phrase" : "Play phrase"); button.title = playing ? "Stop phrase" : "Play phrase";
}
async function playCurrentPhrase() {
  typingIntent = false;
  const phrase = phrases[index]; if (!phrase) return;
  if (ttsBusy) { ttsBusy = false; stopGoogleSpeech(); setPhrasePlayState(false); return; }
  stopGoogleSpeech(); ttsBusy = true; setPhrasePlayState(true);
  try { await speakGoogleAmerican(phrase.en, { rate: Number($("tts-rate").value) }); }
  catch (error) { if (ttsBusy) toast(error.message || String(error)); }
  finally { if (ttsBusy) { ttsBusy = false; setPhrasePlayState(false); if (autoAdvance && phrases[index] === phrase) void recordAnswer(true); } }
}
function compare() {
  const expected = normalize(phrases[index]?.en || ""); const actual = normalize($("answer-text").value);
  $("word-feedback").replaceChildren();
  renderHighlights(expected);
  if (!expected.length || !actual.length) { announce(""); return false; }
  const frag = document.createDocumentFragment(); let mistakes = 0;
  actual.forEach((word, i) => { if (i) frag.append(document.createTextNode(" ")); const span = document.createElement("span"); span.textContent = word; if (word !== expected[i]) { span.className = "word-error"; mistakes++; } frag.append(span); });
  if (actual.length !== expected.length) mistakes += Math.abs(expected.length - actual.length);
  $("word-feedback").append(frag);
  const correct = mistakes === 0 && actual.length === expected.length;
  if (correct && !advancePending) {
    advancePending = true;
    const completedIndex = index;
    $("answer-correct").hidden = false;
    $("answer-text").disabled = true;
    updateAdvanceControls();
    if (autoAdvance) { announce("✓ Correct! Moving to the next phrase…"); scheduleAutomaticAdvance(completedIndex); }
    else { announce("✓ Correct! Select Next phrase when you are ready."); $("answer-status").dataset.kind = "ok"; }
  }
  else if (!correct) { announce(actual.length === expected.length ? "Some words do not match yet." : `Word count: ${actual.length} of ${expected.length}.`); }
  return correct;
}
function renderHighlights(expected = normalize(phrases[index]?.en || "")) {
  const raw = $("answer-text").value; const output = $("answer-highlight"); output.replaceChildren();
  const tokenPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu; let last = 0; let i = 0; let match;
  while ((match = tokenPattern.exec(raw))) {
    output.append(document.createTextNode(raw.slice(last, match.index)));
    const span = document.createElement("span"); span.textContent = match[0];
    if (normalize(match[0])[0] !== expected[i]) span.className = "word-error";
    output.append(span); last = match.index + match[0].length; i++;
  }
  output.append(document.createTextNode(raw.slice(last) || (raw.endsWith("\n") ? "\u00a0" : "")));
  output.scrollTop = $("answer-text").scrollTop;
}
function nextPhrase() { advancePhrase(); }
function validateList(data) {
  if (!Array.isArray(data) || !data.length) throw new Error("The JSON file must contain a non-empty array of phrase objects.");
  if (data.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof item.en !== "string" || !item.en.trim() || ("ua" in item && typeof item.ua !== "string") || ("example" in item && typeof item.example !== "string"))) throw new Error('Every item needs a non-empty "en" string. Optional "ua" and "example" values must be strings.');
  return data.map(({ en, ua, example }) => ({ en: en.trim(), ...(typeof ua === "string" && ua.trim() ? { ua: ua.trim() } : {}), ...(typeof example === "string" && example.trim() ? { example: example.trim() } : {}) }));
}
async function importFile(file) {
  try {
    if (!file) return;
    const parsed = JSON.parse(await file.text()); const validated = validateList(parsed);
    localStorage.setItem(LIST_KEY, JSON.stringify(validated)); phrases = validated; restoreProgress(); renderPhrase();
    $("list-status").textContent = `Loaded from ${file.name}`; toast(`Loaded ${phrases.length} phrases.`, "ok");
  } catch (error) { toast(`Could not open phrase list: ${error.message || "The file is invalid."}`); }
  finally { $("json-file").value = ""; }
}
async function recordAnswer(automatic = false) {
  if (recording) {
    recording = false; stopSilenceMonitor(); $("record-answer").dataset.recording = "false"; $("record-answer").setAttribute("aria-label", "Transcribing answer"); $("record-answer").title = "Transcribing answer"; $("record-answer").disabled = true;
    try {
      const recorder = mediaRecorder; const capturedChunks = audioChunks;
      const blob = await new Promise((resolve, reject) => { recorder.onstop = () => resolve(new Blob(capturedChunks, { type: recorder.mimeType || "audio/webm" })); recorder.onerror = () => reject(new Error("Microphone recording failed.")); recorder.stop(); });
      stream?.getTracks().forEach((track) => track.stop()); stream = null; mediaRecorder = null; audioChunks = [];
      if (!blob.size) throw new Error("No audio was captured.");
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(blob); answerPlayback = new Audio(audioUrl); $("play-answer-recording").disabled = false;
      answerPlayback.onended = () => setAnswerPlaybackIcon(false);
      const result = await transcribeAudio(blob, blob.type || "audio/webm", { language: "en-US" });
      if (!result.text?.trim() || /^\s*\[?\s*blank[\s_-]*audio\s*\]?\s*$/i.test(result.text)) throw new Error("No speech detected. Start recording and speak clearly, or type your answer.");
      lastRecognitionModel = result.model || ""; updateRecognitionModel();
      if (!typingIntent) { $("answer-text").value = result.text.trim(); compare(); }
    } catch (error) { toast(error.message || String(error)); }
    finally { mediaRecorder = null; audioChunks = []; $("record-answer").disabled = !phrases[index] || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder; $("record-answer").setAttribute("aria-label", "Record answer"); $("record-answer").title = "Record answer"; }
    return;
  }
  if (automatic && typingIntent) return;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Microphone recording is not supported in this browser.");
    $("answer-text").value = ""; $("answer-highlight").replaceChildren(); $("word-feedback").replaceChildren(); $("answer-correct").hidden = true; advancePending = false; clearTimeout(advanceTimer); advanceTimer = null; updateAdvanceControls();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) { silenceContext = new AudioContextClass(); if (silenceContext.state !== "running") await silenceContext.resume(); }
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (typingIntent) { stream.getTracks().forEach((track) => track.stop()); stream = null; announce("Recording stopped. Type your answer."); return; }
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); audioChunks = [];
    mediaRecorder.ondataavailable = (event) => { if (event.data?.size) audioChunks.push(event.data); };
    mediaRecorder.start(200); recording = true; recordingStartedAt = Date.now(); $("record-answer").dataset.recording = "true"; $("record-answer").disabled = false; $("record-answer").setAttribute("aria-label", "Stop recording and transcribe"); $("record-answer").title = "Stop recording and transcribe"; announce("Listening…"); void monitorSilence();
  } catch (error) { cleanAudio(); toast(error.message || String(error)); }
}
function applySettings() { const settings = getSettings(); $("setting-provider").value = settings.provider; $("setting-gemini").value = settings.geminiApiKey; $("setting-groq").value = settings.groqApiKey; }
function saveSettings() { updateSettings({ provider: $("setting-provider").value, geminiApiKey: $("setting-gemini").value.trim(), groqApiKey: $("setting-groq").value.trim() }); }
function bind() {
  initConfig();
  try { const savedAutoNext = localStorage.getItem(AUTO_NEXT_KEY); autoAdvance = savedAutoNext === null ? true : savedAutoNext === "true"; } catch { autoAdvance = true; }
  updateAdvanceControls();
  updateRecognitionModel();
  $("tts-rate").addEventListener("change", () => setGoogleSpeechRate($("tts-rate").value));
  $("theme-toggle").addEventListener("click", () => { const dark = document.documentElement.dataset.theme !== "dark"; const theme = dark ? "dark" : "light"; document.documentElement.dataset.theme = theme; try { localStorage.setItem(THEME_KEY, theme); } catch {} $("theme-toggle").setAttribute("aria-pressed", String(dark)); $("theme-toggle").title = dark ? "Switch to light theme" : "Switch to dark theme"; });
  $("open-list").addEventListener("click", () => $("list-modal").showModal()); $("list-modal").addEventListener("click", (event) => { if (event.target === $("list-modal")) $("list-modal").close(); }); $("open-json").addEventListener("click", () => $("json-file").click()); $("json-file").addEventListener("change", (event) => importFile(event.target.files?.[0]));
  $("reveal-text").addEventListener("click", () => { const hidden = $("phrase-text").classList.toggle("is-hidden"); $("reveal-text").setAttribute("aria-label", hidden ? "Show phrase" : "Hide phrase"); $("reveal-text").title = hidden ? "Show phrase" : "Hide phrase"; });
  $("phrase-play").addEventListener("click", () => { void playCurrentPhrase(); });
  $("phrase-text").addEventListener("click", async (event) => {
    const word = event.target.closest(".phrase-word")?.dataset.word; if (!word) return;
    ttsBusy = false; stopGoogleSpeech(); setPhrasePlayState(false);
    try { await speakGoogleAmerican(word, { rate: Number($("tts-rate").value) }); } catch (error) { toast(error.message || String(error)); }
  });
  $("answer-text").addEventListener("focus", stopRecordingForTyping);
  $("answer-text").addEventListener("input", () => { if ($("answer-text").value.trim()) compare(); else { $("word-feedback").replaceChildren(); renderHighlights(); announce(""); } });
  $("answer-text").addEventListener("scroll", () => { $("answer-highlight").scrollTop = $("answer-text").scrollTop; });
  $("skip-phrase").addEventListener("click", nextPhrase); $("record-answer").addEventListener("click", () => { typingIntent = false; void recordAnswer(); });
  $("manual-next").addEventListener("click", () => { if (!autoAdvance && advancePending) advancePhrase(); });
  $("toggle-auto-next").addEventListener("click", () => {
    autoAdvance = !autoAdvance;
    try { localStorage.setItem(AUTO_NEXT_KEY, String(autoAdvance)); } catch { /* setting still applies for this session */ }
    updateAdvanceControls();
    if (advancePending) {
      if (autoAdvance) scheduleAutomaticAdvance(index);
      else { clearTimeout(advanceTimer); advanceTimer = null; announce("✓ Correct! Select Next phrase when you are ready."); $("answer-status").dataset.kind = "ok"; }
    }
  });
  $("play-answer-recording").addEventListener("click", async () => {
    if (!answerPlayback) return;
    if (!answerPlayback.paused) { answerPlayback.pause(); answerPlayback.currentTime = 0; setAnswerPlaybackIcon(false); return; }
    try { await answerPlayback.play(); setAnswerPlaybackIcon(true); } catch (error) { toast(error.message || "Could not play this recording."); }
  });
  $("open-settings").addEventListener("click", () => { applySettings(); $("settings-modal").showModal(); }); $("close-settings").addEventListener("click", () => $("settings-modal").close());
  ["setting-provider", "setting-gemini", "setting-groq"].forEach((id) => $(id).addEventListener(id === "setting-provider" ? "change" : "input", () => { saveSettings(); if (id === "setting-provider") { lastRecognitionModel = ""; updateRecognitionModel(); } }));
  $("settings-modal").addEventListener("click", (event) => { if (event.target === $("settings-modal")) $("settings-modal").close(); });
  try { phrases = validateList(JSON.parse(localStorage.getItem(LIST_KEY) || "[]")); restoreProgress(); $("list-status").textContent = phrases.length ? `${phrases.length} phrases loaded.` : "Open a JSON file with English phrases to begin."; } catch { phrases = []; index = 0; try { localStorage.removeItem(LIST_KEY); } catch {} }
  renderPhrase();
}
document.addEventListener("DOMContentLoaded", bind);
