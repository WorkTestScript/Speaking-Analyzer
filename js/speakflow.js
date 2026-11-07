import { initConfig, getSettings, updateSettings, MODELS } from "./config.js";
import { transcribeAudioWithWordTimes } from "./api/provider.js?v=groq-400-fallback-1";
import { speakGoogleAmerican, stopGoogleSpeech, setGoogleSpeechRate } from "./google-tts.js?v=tts-rate-fix-1";

const $ = (id) => document.getElementById(id);
const LIST_KEY = "speakflow.phrases.v1";
const PROGRESS_KEY = "speakflow.progress.v1";
const AUTO_NEXT_KEY = "speakflow.auto-next.v1";
const FAVORITES_KEY = "speakflow.favorites.v1";
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
let answerWords = [];
let wordPlaybackTimer = null;
let wordPlaybackButton = null;
let replayRecording = false;
let autoRetryRecording = false;
let stopWasAutomatic = false;
let startingRecording = false;
let stoppingRecording = false;
let favorites = [];
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
function finishAutoReplay() {
  const shouldAdvance = replayRecording && autoAdvance && advancePending;
  const shouldRetry = autoRetryRecording && autoAdvance && !advancePending;
  replayRecording = false;
  autoRetryRecording = false;
  if (shouldAdvance) advancePhrase();
  else if (shouldRetry) void recordAnswer(true);
}
function replayAnswerRecording() {
  if (!answerPlayback) { finishAutoReplay(); return; }
  stopRecordingWordPlayback();
  answerPlayback.onended = () => { setAnswerPlaybackIcon(false); finishAutoReplay(); };
  answerPlayback.currentTime = 0;
  answerPlayback.play().then(() => setAnswerPlaybackIcon(true)).catch(() => { setAnswerPlaybackIcon(false); finishAutoReplay(); });
}
function stopRecordingWordPlayback() {
  if (!wordPlaybackTimer && !wordPlaybackButton) return;
  clearTimeout(wordPlaybackTimer); wordPlaybackTimer = null;
  if (wordPlaybackButton) { wordPlaybackButton.classList.remove("is-playing"); wordPlaybackButton = null; }
  if (answerPlayback) { answerPlayback.pause(); answerPlayback.currentTime = 0; }
  setAnswerPlaybackIcon(false);
}
function clearRecordingWords() {
  stopRecordingWordPlayback();
  answerWords = [];
  const list = $("recording-words-list");
  if (list) list.replaceChildren();
  const row = $("recording-words");
  if (row) row.hidden = true;
}
function renderRecordingWords() {
  const row = $("recording-words"); const list = $("recording-words-list");
  list.replaceChildren();
  row.hidden = !answerWords.length;
  answerWords.forEach((item, wordIndex) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "recording-word"; button.textContent = item.word;
    button.title = "Play this word from your recording";
    button.setAttribute("aria-label", `Play "${item.word}" from your recording`);
    button.addEventListener("click", () => playRecordingWord(wordIndex, button));
    list.append(button);
  });
}
function playRecordingWord(wordIndex, button) {
  const item = answerWords[wordIndex];
  if (!item || !answerPlayback) return;
  stopRecordingWordPlayback();
  replayRecording = false;
  autoRetryRecording = false;
  const start = Math.max(0, item.start - 0.04);
  const end = Math.max(start + 0.1, item.end + 0.04);
  const play = () => {
    try {
      answerPlayback.currentTime = start;
      wordPlaybackButton = button; button.classList.add("is-playing");
      answerPlayback.play().then(() => setAnswerPlaybackIcon(true)).catch(() => stopRecordingWordPlayback());
      const rate = answerPlayback.playbackRate || 1;
      wordPlaybackTimer = setTimeout(stopRecordingWordPlayback, Math.max(150, ((end - start) * 1000) / rate + 40));
    } catch { stopRecordingWordPlayback(); }
  };
  if (answerPlayback.readyState >= 1) play();
  else answerPlayback.addEventListener("loadedmetadata", play, { once: true });
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
        stopWasAutomatic = true;
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
const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/></svg>';
function favoriteKey(phrase) { return normalize(phrase?.en || "").join(" "); }
function loadFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    favorites = Array.isArray(saved) ? saved.filter((item) => item && typeof item.en === "string" && item.en.trim()).map(({ en, ua, example }) => ({
      en: en.trim(),
      ...(typeof ua === "string" && ua.trim() ? { ua: ua.trim() } : {}),
      ...(typeof example === "string" && example.trim() ? { example: example.trim() } : {}),
    })) : [];
  } catch { favorites = []; }
}
function saveFavorites() { try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch { /* favorites stay in memory if storage is unavailable */ } }
function favoriteIndex(phrase) { const key = favoriteKey(phrase); return favorites.findIndex((item) => favoriteKey(item) === key); }
function isFavorite(phrase) { return Boolean(phrase?.en) && favoriteIndex(phrase) >= 0; }
function updateFavoriteIndicators() {
  const current = phrases[index];
  const button = $("favorite-phrase");
  if (button) {
    const active = isFavorite(current);
    button.disabled = !current;
    button.dataset.active = String(active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? "Remove phrase from favorites" : "Add phrase to favorites");
    button.title = active ? "Remove phrase from favorites" : "Add phrase to favorites";
  }
  document.querySelectorAll(".favorite-toggle").forEach((el) => {
    const active = favorites.some((item) => favoriteKey(item) === el.dataset.favoriteKey);
    el.dataset.active = String(active);
    el.setAttribute("aria-pressed", String(active));
    el.setAttribute("aria-label", active ? "Remove phrase from favorites" : "Add phrase to favorites");
    el.title = active ? "Remove phrase from favorites" : "Add phrase to favorites";
  });
}
function toggleFavorite(phrase) {
  if (!phrase?.en) return;
  const at = favoriteIndex(phrase);
  if (at >= 0) favorites.splice(at, 1);
  else favorites.push({ en: phrase.en, ...(phrase.ua ? { ua: phrase.ua } : {}), ...(phrase.example ? { example: phrase.example } : {}) });
  saveFavorites(); updateFavoriteIndicators();
  toast(at >= 0 ? "Removed from favorites." : "Added to favorites.", "ok");
}
function downloadFavorites() {
  if (!favorites.length) { toast("No favorite phrases to download yet."); return; }
  const data = favorites.map(({ en, ua, example }) => ({ en, ua: ua || "", ...(example ? { example } : {}) }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = "favorite-phrases.json"; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const count = favorites.length;
  favorites = []; saveFavorites(); updateFavoriteIndicators();
  toast(`Downloaded ${count} favorite phrase${count === 1 ? "" : "s"}.`, "ok");
}
function loadFavoritesIntoApp() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"); }
  catch { stored = null; }
  if (!Array.isArray(stored) || !stored.length) { toast("No favorite phrases are saved in this browser yet."); return; }
  try {
    const list = validateList(stored);
    localStorage.setItem(LIST_KEY, JSON.stringify(list)); phrases = list; loadFavorites(); restoreProgress(); renderPhrase();
    $("list-status").textContent = `Loaded ${list.length} favorite phrase${list.length === 1 ? "" : "s"}.`;
    toast(`Loaded ${list.length} favorite phrase${list.length === 1 ? "" : "s"} into the app.`, "ok");
  } catch (error) { toast(`Could not load favorite phrases: ${error.message || "The saved list is invalid."}`); }
}
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
function advancePhrase(playPhrase = false) {
  clearRecordingWords();
  if (!phrases.length) return;
  index = index + 1 < phrases.length ? index + 1 : 0;
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify({ signature: listSignature(), index })); } catch { /* keep the current session usable if storage is unavailable */ }
  renderPhrase();
  if (autoAdvance || playPhrase) void playCurrentPhrase();
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
function cleanAudio() { replayRecording = false; autoRetryRecording = false; stopWasAutomatic = false; stopSilenceMonitor(); if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); mediaRecorder = null; audioChunks = []; recording = false; if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; } $("record-answer").dataset.recording = "false"; $("record-answer").setAttribute("aria-label", "Record answer"); $("record-answer").title = "Record answer"; if (answerPlayback) { answerPlayback.pause(); answerPlayback.removeAttribute("src"); answerPlayback.load(); answerPlayback = null; } if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; } $("play-answer-recording").disabled = true; setAnswerPlaybackIcon(false); }
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
      const main = document.createElement("button"); main.type = "button"; main.className = "phrase-row-main";
      main.innerHTML = `<span class="row-index">${phraseIndex + 1}</span><strong></strong>`; main.querySelector("strong").textContent = phrase.en;
      main.setAttribute("aria-label", `Show details for "${phrase.en}"`);
      main.addEventListener("click", () => openPhraseDetail(phrase));
      const star = document.createElement("button"); star.type = "button"; star.className = "favorite-toggle"; star.dataset.favoriteKey = favoriteKey(phrase); star.innerHTML = STAR_SVG;
      star.addEventListener("click", () => toggleFavorite(phrase));
      row.append(main, star); list.append(row);
    });
    $("phrase-count").textContent = `${phrases.length} phrase${phrases.length === 1 ? "" : "s"}`;
  }
  $("progress-badge").textContent = phrases.length ? `${Math.min(index + 1, phrases.length)} / ${phrases.length}` : "No phrase list";
  updateFavoriteIndicators();
}
function openPhraseDetail(phrase) {
  if (!phrase) return;
  $("phrase-detail-title").textContent = phrase.en || "";
  const ua = phrase.ua || ""; const example = phrase.example || "";
  $("phrase-detail-ua").textContent = ua; $("phrase-detail-ua").hidden = !ua;
  $("phrase-detail-example").textContent = example; $("phrase-detail-example").hidden = !example;
  $("phrase-detail-empty").hidden = Boolean(ua || example);
  $("phrase-detail-modal").showModal();
}
function renderPhrase() {
  clearTimeout(advanceTimer); advanceTimer = null;
  advancePending = false;
  updateAdvanceControls();
  $("answer-correct").hidden = true;
  cleanAudio(); clearRecordingWords(); stopGoogleSpeech(); ttsBusy = false;
  const phrase = phrases[index];
  renderPhraseWords(phrase?.en || "Load a phrase list to get started.");
  $("phrase-text").classList.add("is-hidden"); $("reveal-text").setAttribute("aria-label", "Show phrase"); $("reveal-text").title = "Show phrase";
  const translation = phrase?.ua || "";
  const example = phrase?.example || "";
  $("phrase-translation-text").textContent = translation; $("phrase-translation").hidden = !translation;
  $("phrase-example").hidden = !example; $("example-content").textContent = example;
  if ($("example-modal").open) $("example-modal").close();
  $("answer-text").value = ""; $("answer-highlight").replaceChildren(); $("answer-text").disabled = !phrase; $("record-answer").disabled = !phrase || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder; $("skip-phrase").disabled = !phrase;
  $("phrase-play").disabled = !phrase; setPhrasePlayState(false);
  announce(""); renderList();
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
  renderHighlights(expected);
  if (!expected.length || !actual.length) { announce(""); return false; }
  let mistakes = 0;
  actual.forEach((word, i) => { if (word !== expected[i]) mistakes++; });
  if (actual.length !== expected.length) mistakes += Math.abs(expected.length - actual.length);
  const correct = mistakes === 0 && actual.length === expected.length;
  if (correct && !advancePending) {
    advancePending = true;
    const completedIndex = index;
    $("answer-correct").hidden = false;
    $("answer-text").disabled = true;
    updateAdvanceControls();
    if (autoAdvance) {
      if (replayRecording) announce("✓ Correct! Replaying your recording…");
      else { announce("✓ Correct! Moving to the next phrase…"); scheduleAutomaticAdvance(completedIndex); }
    }
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
function nextPhrase() { advancePhrase(true); }
function validateList(data) {
  if (!Array.isArray(data) || !data.length) throw new Error("The JSON file must contain a non-empty array of phrase objects.");
  if (data.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof item.en !== "string" || !item.en.trim() || typeof item.ua !== "string" || !item.ua.trim() || ("example" in item && typeof item.example !== "string"))) throw new Error('Every item needs non-empty "en" and "ua" strings. The optional "example" value must be a string.');
  return data.map(({ en, ua, example }) => ({ en: en.trim(), ua: ua.trim(), ...(typeof example === "string" && example.trim() ? { example: example.trim() } : {}) }));
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
function resetRecordingSession() {
  stopSilenceMonitor();
  if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; }
  mediaRecorder = null; audioChunks = []; recording = false;
  const button = $("record-answer");
  button.dataset.recording = "false";
  button.disabled = !phrases[index] || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
  button.setAttribute("aria-label", "Record answer");
  button.title = "Record answer";
}
async function recordAnswer(automatic = false) {
  if (stoppingRecording || startingRecording) return;
  clearRecordingWords(); replayRecording = false; autoRetryRecording = false;
  if (recording) {
    stoppingRecording = true;
    const stoppedAutomatically = stopWasAutomatic; stopWasAutomatic = false;
    recording = false; stopSilenceMonitor(); $("record-answer").dataset.recording = "false"; $("record-answer").setAttribute("aria-label", "Transcribing answer"); $("record-answer").title = "Transcribing answer"; $("record-answer").disabled = true;
    try {
      const recorder = mediaRecorder; const capturedChunks = audioChunks;
      const blob = await new Promise((resolve, reject) => {
        const finish = () => resolve(new Blob(capturedChunks, { type: recorder.mimeType || "audio/webm" }));
        recorder.onstop = finish;
        recorder.onerror = () => reject(new Error("Microphone recording failed."));
        try { if (recorder.state === "inactive") finish(); else recorder.stop(); } catch (error) { reject(error); }
      });
      stream?.getTracks().forEach((track) => track.stop()); stream = null; mediaRecorder = null; audioChunks = [];
      if (!blob.size) throw new Error("No audio was captured.");
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(blob); answerPlayback = new Audio(audioUrl); $("play-answer-recording").disabled = false;
      answerPlayback.onended = () => setAnswerPlaybackIcon(false);
      const result = await transcribeAudioWithWordTimes(blob, blob.type || "audio/webm", { language: "en-US" });
      if (!result.text?.trim() || /^\s*\[?\s*blank[\s_-]*audio\s*\]?\s*$/i.test(result.text)) throw new Error("No speech detected. Start recording and speak clearly, or type your answer.");
      const timedWords = Array.isArray(result.words) ? result.words : [];
      answerWords = timedWords.filter((item) => item && typeof item.word === "string" && /[\p{L}\p{N}]/u.test(item.word) && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start).map((item) => ({ word: item.word.trim(), start: item.start, end: item.end }));
      lastRecognitionModel = result.model || ""; updateRecognitionModel();
      if (!typingIntent) {
        replayRecording = Boolean(answerPlayback);
        $("answer-text").value = result.text.trim();
        const correct = compare();
        if (!correct && autoAdvance && stoppedAutomatically) autoRetryRecording = true;
        renderRecordingWords();
        if (replayRecording) replayAnswerRecording();
        else finishAutoReplay();
      }
    } catch (error) {
      resetRecordingSession();
      announce(error.message || "Recording failed. Try again.", "error");
      toast(error.message || String(error));
    }
    finally {
      stoppingRecording = false;
      mediaRecorder = null; audioChunks = [];
      if (!recording) resetRecordingSession();
    }
    return;
  }
  if (automatic && typingIntent) return;
  startingRecording = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Microphone recording is not supported in this browser.");
    if (answerPlayback) { answerPlayback.pause(); answerPlayback.currentTime = 0; setAnswerPlaybackIcon(false); }
    $("answer-text").value = ""; $("answer-highlight").replaceChildren(); $("answer-correct").hidden = true; advancePending = false; clearTimeout(advanceTimer); advanceTimer = null; updateAdvanceControls(); clearRecordingWords();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) { silenceContext = new AudioContextClass(); if (silenceContext.state !== "running") await silenceContext.resume(); }
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (typingIntent) { stream.getTracks().forEach((track) => track.stop()); stream = null; announce("Recording stopped. Type your answer."); return; }
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); audioChunks = [];
    mediaRecorder.ondataavailable = (event) => { if (event.data?.size) audioChunks.push(event.data); };
    mediaRecorder.start(200); recording = true; recordingStartedAt = Date.now(); $("record-answer").dataset.recording = "true"; $("record-answer").disabled = false; $("record-answer").setAttribute("aria-label", "Stop recording and transcribe"); $("record-answer").title = "Stop recording and transcribe"; announce("Listening…"); void monitorSilence();
  } catch (error) { cleanAudio(); announce(error.message || "Could not start recording.", "error"); toast(error.message || String(error)); }
  finally { startingRecording = false; }
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
  $("download-favorites").addEventListener("click", downloadFavorites);
  $("upload-favorites").addEventListener("click", loadFavoritesIntoApp);
  $("favorite-phrase").addEventListener("click", () => toggleFavorite(phrases[index]));
  $("reveal-text").addEventListener("click", () => { const hidden = $("phrase-text").classList.toggle("is-hidden"); $("reveal-text").setAttribute("aria-label", hidden ? "Show phrase" : "Hide phrase"); $("reveal-text").title = hidden ? "Show phrase" : "Hide phrase"; });
  $("phrase-example").addEventListener("click", () => { const example = phrases[index]?.example; if (!example) return; $("example-content").textContent = example; $("example-modal").showModal(); });
  $("close-example").addEventListener("click", () => $("example-modal").close());
  $("example-modal").addEventListener("click", (event) => { if (event.target === $("example-modal")) $("example-modal").close(); });
  $("close-phrase-detail").addEventListener("click", () => $("phrase-detail-modal").close());
  $("phrase-detail-modal").addEventListener("click", (event) => { if (event.target === $("phrase-detail-modal")) $("phrase-detail-modal").close(); });
  $("phrase-play").addEventListener("click", () => { void playCurrentPhrase(); });
  $("phrase-text").addEventListener("click", async (event) => {
    const word = event.target.closest(".phrase-word")?.dataset.word; if (!word) return;
    ttsBusy = false; stopGoogleSpeech(); setPhrasePlayState(false);
    try { await speakGoogleAmerican(word, { rate: Number($("tts-rate").value) }); } catch (error) { toast(error.message || String(error)); }
  });
  $("answer-text").addEventListener("focus", stopRecordingForTyping);
  $("answer-text").addEventListener("input", () => { autoRetryRecording = false; clearRecordingWords(); if ($("answer-text").value.trim()) compare(); else { renderHighlights(); announce(""); } });
  $("answer-text").addEventListener("scroll", () => { $("answer-highlight").scrollTop = $("answer-text").scrollTop; });
  $("skip-phrase").addEventListener("click", nextPhrase); $("record-answer").addEventListener("click", () => { typingIntent = false; stopWasAutomatic = false; void recordAnswer(); });
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
    stopRecordingWordPlayback(); replayRecording = false; autoRetryRecording = false;
    if (!answerPlayback.paused) { answerPlayback.pause(); answerPlayback.currentTime = 0; setAnswerPlaybackIcon(false); return; }
    try { await answerPlayback.play(); setAnswerPlaybackIcon(true); } catch (error) { toast(error.message || "Could not play this recording."); }
  });
  $("open-settings").addEventListener("click", () => { applySettings(); $("settings-modal").showModal(); }); $("close-settings").addEventListener("click", () => $("settings-modal").close());
  ["setting-provider", "setting-gemini", "setting-groq"].forEach((id) => $(id).addEventListener(id === "setting-provider" ? "change" : "input", () => { saveSettings(); if (id === "setting-provider") { lastRecognitionModel = ""; updateRecognitionModel(); } }));
  $("settings-modal").addEventListener("click", (event) => { if (event.target === $("settings-modal")) $("settings-modal").close(); });
  try { phrases = validateList(JSON.parse(localStorage.getItem(LIST_KEY) || "[]")); restoreProgress(); $("list-status").textContent = phrases.length ? `${phrases.length} phrases loaded.` : "Open a JSON file with English phrases to begin."; } catch { phrases = []; index = 0; try { localStorage.removeItem(LIST_KEY); } catch {} }
  loadFavorites();
  renderPhrase();
}
document.addEventListener("DOMContentLoaded", bind);
