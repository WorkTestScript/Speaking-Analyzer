import {
  initConfig,
  getSettings,
  updateSettings,
  PROVIDERS,
} from "./config.js";
import { loadDraft, saveDraft, saveAnalysisSnapshot, loadAnalysisSnapshot, deleteAnalysisSnapshot } from "./storage.js";
import { AudioRecorder, recordingSupported, playSlice } from "./audio.js";
import { analyzeText, applySpanFix, shiftIssues } from "./text-analysis.js?v=gemini-timeout-fallback-20261030";
import { wordDetails } from "./pronunciation.js";
import { analyzePhonemes } from "./phoneme-assessment.js?v=syllable-highlight-20261030";
import { listEnglishVoices, speakWord } from "./phonetics.js";
import { speakGoogleAmerican, stopGoogleSpeech } from "./google-tts.js";
import { testConnection, transcribeAudio } from "./api/provider.js?v=gemini-timeout-fallback-20261030";
import { messageFor } from "./errors.js";

const $ = (id) => document.getElementById(id);
const THEME_STORAGE_KEY = "speaking-analyzer-theme";

function applyTheme(theme) {
  const selected = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selected;
  try { localStorage.setItem(THEME_STORAGE_KEY, selected); } catch { /* theme still applies for this session */ }
  const toggle = $("theme-toggle");
  if (toggle) {
    const label = selected === "dark" ? "Switch to light theme" : "Switch to dark theme";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    toggle.setAttribute("aria-pressed", String(selected === "dark"));
  }
}

const state = {
  analysis: null,
  textAnalysisHidden: false,
  pronunciation: null,
  selectedIssue: null,
  selectedWord: null,
  busy: { text: false, pronunciation: false, test: false },
};

const recorder = new AudioRecorder();
const modalScrollPositions = new WeakMap();
let messageResolver = null;

function showDialog(dialog) {
  modalScrollPositions.set(dialog, { x: window.scrollX, y: window.scrollY });
  dialog.showModal();
  const position = modalScrollPositions.get(dialog);
  requestAnimationFrame(() => window.scrollTo(position.x, position.y));
}

function showMessage(message, { title = "Message", confirm = false } = {}) {
  const dialog = $("message-modal");
  $("message-title").textContent = title;
  $("message-body").textContent = message;
  $("message-cancel").hidden = !confirm;
  $("message-accept").textContent = confirm ? "Delete" : "OK";
  showDialog(dialog);
  return new Promise((resolve) => { messageResolver = resolve; });
}

function resolveMessage(result) {
  if (!messageResolver) return;
  const resolve = messageResolver;
  messageResolver = null;
  $("message-modal").close();
  resolve(result);
}

function setStatus(node, text, kind = "") {
  node.textContent = text || "";
  node.dataset.kind = kind;
}

function toast(message, kind = "info") {
  const el = $("toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

function wordCount(text) {
  return (text.trim().match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length;
}

function updateCounts() {
  const text = $("source-text").value;
  $("stat-words").textContent = String(wordCount(text));
  if ($("stat-level")) $("stat-level").textContent = state.analysis?.source === text ? state.analysis.cefr.overall : "—";
  saveDraft(text);
}

function providerLabel() {
  return getSettings().provider === PROVIDERS.groq ? "Groq" : "Gemini";
}

function refreshProviderBadge() {
  $("provider-badge").textContent = providerLabel();
  $("provider-badge").dataset.provider = getSettings().provider;
}

function empty(container, title, body) {
  container.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const h = document.createElement("strong");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = body;
  wrap.append(h, p);
  container.append(wrap);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === false || value == null) continue;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function renderTextAnalysis() {
  const root = $("text-results");
  const panel = root.closest(".analysis-panel");
  const analysis = state.analysis;
  if (!analysis) {
    panel.hidden = true;
    root.replaceChildren();
    $("text-actions").hidden = true;
    $("stat-level").textContent = "—";
    return;
  }
  panel.hidden = state.textAnalysisHidden;
  $("text-actions").hidden = false;
  root.replaceChildren();

  $("stat-level").textContent = analysis.cefr.overall;
  root.replaceChildren(el("h2", { text: "Errors found" }));
  const issues = [...analysis.grammarErrors, ...analysis.sentenceStructure, ...analysis.vocabulary];
  if (!issues.length) root.append(el("p", { text: "No errors found." }));
  issues.forEach((issue) => root.append(el("button", {
    class: "issue-item analysis-issue", type: "button", onclick: () => selectIssue(issue),
  }, [el("strong", { text: issue.original }), el("span", { text: `${issue.corrected} · ${issue.explanation}` })])));
  root.append(el("h3", { text: "Corrected text" }), el("p", { class: "corrected-text", text: analysis.correctedText }));
}

function metric(label, value) {
  return el("div", { class: "metric" }, [
    el("span", { class: "metric-label", text: label }),
    el("span", { class: "metric-value", text: value }),
  ]);
}

function issueGroup(title, items, kind) {
  const section = el("section", { class: "result-block" }, [el("h3", { text: title })]);
  if (!items.length) {
    section.append(el("p", { class: "muted", text: "No issues in this category." }));
    return section;
  }
  const list = el("ul", { class: "issue-list" });
  items.forEach((issue, index) => {
    const btn = el("button", {
      class: "issue-item",
      type: "button",
      onclick: () => selectIssue({ ...issue, kind, index }),
    }, [
      el("strong", { text: issue.original }),
      el("span", { text: issue.explanation }),
    ]);
    list.append(el("li", {}, [btn]));
  });
  section.append(list);
  return section;
}

function repeatGroup(items) {
  const section = el("section", { class: "result-block" }, [el("h3", { text: "Repeated Words" })]);
  if (!items.length) {
    section.append(el("p", { class: "muted", text: "No problematic repetitions detected." }));
    return section;
  }
  const list = el("ul", { class: "issue-list" });
  items.forEach((item) => {
    const first = item.occurrences[0];
    const btn = el("button", {
      class: "issue-item",
      type: "button",
      onclick: () =>
        selectIssue({
          ...item,
          start: first.start,
          end: first.end,
          original: first.original,
          corrected: item.b2Alternative || first.original,
          kind: "repeat",
        }),
    }, [
      el("strong", { text: `${item.word} × ${item.count}` }),
      el("span", { text: item.explanation }),
    ]);
    list.append(el("li", {}, [btn]));
  });
  section.append(list);
  return section;
}

function selectIssue(issue) {
  state.selectedIssue = issue;
  const panel = $("issue-panel");
  panel.hidden = false;
  $("issue-original").textContent = issue.original;
  $("issue-explanation").textContent = issue.explanation || "";
  $("issue-corrected").textContent = issue.corrected || "";
  $("issue-b2").textContent = issue.b2Alternative || "—";
  const area = $("source-text");
  area.setSelectionRange(issue.start, issue.end);
  showDialog(panel);
}

async function runTextAnalysis() {
  if (state.busy.text) return;
  const text = $("source-text").value;
  state.busy.text = true;
  state.textAnalysisHidden = false;
  $("text-results").closest(".analysis-panel").hidden = false;
  $("btn-analyze").disabled = true;
  $("text-progress").hidden = false;
  setStatus($("text-status"), "Analyzing with " + providerLabel() + "…", "busy");
  try {
    const analysis = await analyzeText(text);
    state.analysis = analysis;
    await saveAnalysisSnapshot("text", analysis);
    renderTextAnalysis();
    setStatus($("text-status"), "");
  } catch (error) {
    setStatus($("text-status"), messageFor(error), "error");
    toast(messageFor(error), "error");
  } finally {
    state.busy.text = false;
    $("btn-analyze").disabled = false;
    $("text-progress").hidden = true;
  }
}

function applySelectedFix() {
  const issue = state.selectedIssue;
  if (!issue || issue.corrected == null) return;
  const area = $("source-text");
  area.value = applySpanFix(area.value, issue.start, issue.end, issue.corrected);
  if (state.analysis) {
    for (const key of ["grammarErrors", "sentenceStructure", "vocabulary"]) {
      state.analysis[key] = shiftIssues(state.analysis[key], issue.start, issue.end, issue.corrected);
    }
    state.analysis.repeatedWords = state.analysis.repeatedWords
      .map((item) => ({
        ...item,
        occurrences: shiftIssues(item.occurrences, issue.start, issue.end, issue.corrected),
      }))
      .filter((item) => item.occurrences.length);
    state.analysis.source = area.value;
  }
  state.selectedIssue = null;
  if ($("issue-panel").open) $("issue-panel").close();
  updateCounts();
  renderTextAnalysis();
  toast("Correction applied. Re-analyze after larger edits.", "ok");
}

function applyFullCorrection() {
  if (!state.analysis?.correctedText) return;
  $("source-text").value = state.analysis.correctedText;
  state.analysis = null;
  if ($("issue-panel").open) $("issue-panel").close();
  updateCounts();
  renderTextAnalysis();
  toast("Corrected text applied.", "ok");
}

function renderPronunciation() {
  const root = $("pronunciation-results");
  const data = state.pronunciation;
  if (!data) {
    empty(root, "No pronunciation check yet", "Record your reading of the current text, then press Analyze Pronunciation.");
    return;
  }
  root.replaceChildren();
  const board = el("p", { class: "word-board", "aria-label": "Original text with pronunciation flags" });
  const source = data.originalText;
  let cursor = 0;
  data.originalWords.forEach((word, index) => {
    if (word.start > cursor) board.append(source.slice(cursor, word.start));
    const span = el("button", {
      type: "button",
      class: `word-chip status-${word.status}`,
      onclick: () => openWord(index),
    });
    const syllables = word.syllableErrors || [];
    if (syllables.length) {
      let wordCursor = 0;
      for (const range of syllables) {
        span.append(word.text.slice(wordCursor, range.start));
        const mark = el("span", { class: "mispronounced-syllable" });
        mark.textContent = word.text.slice(range.start, range.end);
        span.append(mark);
        wordCursor = range.end;
      }
      span.append(word.text.slice(wordCursor));
      span.title = "Likely affected syllable; select for details";
    } else {
      span.textContent = word.text;
    }
    board.append(span);
    cursor = word.end;
  });
  if (cursor < source.length) board.append(source.slice(cursor));
  root.append(board);
  if (data.added.length) {
    const extra = el("section", { class: "result-block" }, [el("h3", { text: "Added in recognition" })]);
    data.added.forEach((item) => extra.append(el("p", { text: `${item.text} — ${item.label}` })));
    root.append(extra);
  }
}

async function openWord(index) {
  const word = state.pronunciation.originalWords[index];
  state.selectedWord = word;
  showDialog($("word-panel"));
  $("word-value").textContent = word.text;
  $("word-status").textContent = word.label;
  $("word-status").dataset.status = word.status;
  const editText = (word.phonemeEdits || []).map((edit) => edit.type === "omission"
    ? `missing ${edit.expected}`
    : edit.type === "addition" ? `extra sound ${edit.heard}` : `${edit.expected} → ${edit.heard}`).join(", ");
  const stressText = word.expectedStress?.length
    ? ` · CMUdict stress: ${word.expectedStress.map((stress, index) => `syllable ${index + 1} (${stress})`).join(", ")}`
    : "";
  $("word-uk").textContent = word.referencePhonemes
    ? `${editText ? `Differences: ${editText}. ` : "No issues detected."}${stressText}`
    : word.ukrainian || "";
  $("word-recognized").textContent = word.spokenPhonemes || word.recognized || "—";
  const affectedSyllables = (word.syllableErrors || []).map(({ start, end }) => word.text.slice(start, end)).filter(Boolean);
  $("word-syllables-row").hidden = !affectedSyllables.length;
  $("word-syllables").textContent = affectedSyllables.join(", ");
  $("word-ipa").previousElementSibling.textContent = word.referencePhonemes ? "Reference phonemes" : "IPA";
  $("word-recognized").previousElementSibling.textContent = word.spokenPhonemes ? "User pronunciation" : "Recognized as";
  const details = word.referencePhonemes ? { ipa: "", audioUrl: "", example: "", definition: "" } : await wordDetails(word.text, "en-US");
  $("word-ipa").textContent = word.referencePhonemes || details.ipa || "Pronunciation unavailable.";
  $("word-definition").textContent = details.definition || "";
  $("word-definition").hidden = Boolean(word.referencePhonemes);
  $("btn-play-ref").hidden = false;
  $("btn-play-user-word").disabled = !(word.timestamps && state.pronunciation.timestampsAvailable && recorder.current?.blob);
}

async function clearPronunciationAnalysis() {
  state.pronunciation = null;
  state.selectedWord = null;
  if ($("word-panel").open) $("word-panel").close();
  setStatus($("pronunciation-status"), "");
  renderPronunciation();
  await deleteAnalysisSnapshot("pronunciation");
}

async function clearTextAnalysis() {
  state.analysis = null;
  state.textAnalysisHidden = false;
  if ($("issue-panel").open) $("issue-panel").close();
  renderTextAnalysis();
  await deleteAnalysisSnapshot("text");
}

async function runPronunciation() {
  if (state.busy.pronunciation) return;
  if (!recorder.current?.blob) {
    toast("Record audio first.", "error");
    return;
  }
  state.busy.pronunciation = true;
  $("btn-analyze-pronunciation").disabled = true;
  $("pronunciation-progress").hidden = false;
  $("pronunciation-progress").max = 100;
  $("pronunciation-progress").value = 0;
  let analysisCompleted = false;
  setStatus($("pronunciation-status"), "Loading the model, transcript, and CMUdict…", "busy");
  try {
    const result = await analyzePhonemes({
      blob: recorder.current.blob,
      mimeType: recorder.current.mimeType,
      originalText: $("source-text").value,
      onProgress: (update) => {
        if (typeof update === "string") setStatus($("pronunciation-status"), update, "busy");
        else if (update?.message) setStatus($("pronunciation-status"), update.message, "busy");
        else if (typeof update?.progress === "number") {
          const value = update.progress <= 1 ? update.progress * 100 : update.progress;
          $("pronunciation-progress").value = Math.max(0, Math.min(100, value));
          setStatus($("pronunciation-status"), update.file ? `Downloading model: ${update.file}` : "Downloading ONNX model…", "busy");
        } else if (update?.file || update?.status) {
          setStatus($("pronunciation-status"), `${update.file || "ONNX model"}: ${update.status || "downloading"}`, "busy");
        }
      },
    });
    state.pronunciation = { ...result, recordingId: recorder.current.id ?? null };
    await saveAnalysisSnapshot("pronunciation", {
      ...state.pronunciation,
      blobSkipped: true,
    });
    renderPronunciation();
    setStatus($("pronunciation-status"), "");
    analysisCompleted = true;
  } catch (error) {
    setStatus($("pronunciation-status"), messageFor(error), "error");
    toast(messageFor(error), "error");
  } finally {
    state.busy.pronunciation = false;
    $("btn-analyze-pronunciation").disabled = false;
    $("pronunciation-progress").hidden = true;
    if (analysisCompleted) centerPronunciationResult();
  }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function drawLevel(level, samples = []) {
  const canvas = $("waveform");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;
  ctx.clearRect(0, 0, w, h);
  const styles = getComputedStyle(canvas);
  ctx.fillStyle = styles.backgroundColor;
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.strokeStyle = styles.getPropertyValue("--canvas-line").trim();
  ctx.lineWidth = 1;
  ctx.stroke();
  if (!samples.length) return;
  const amplitude = Math.max(0.08, Math.min(1, level * 2.2));
  ctx.beginPath();
  samples.forEach((sample, index) => {
    const x = (index / (samples.length - 1)) * w;
    const y = mid + ((sample - 128) / 128) * (h * 0.43) * Math.max(0.15, amplitude);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = styles.getPropertyValue("--accent").trim();
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

function centerPronunciationResult() {
  const panel = $("pronunciation-panel");
  const board = $("pronunciation-results").querySelector(".word-board");
  if (!panel || !board) return;
  requestAnimationFrame(() => {
    // Leave room after the analysis panel so it can be scrolled above the
    // bottom edge instead of being stranded at the end of the document.
    panel.style.marginBottom = `${Math.ceil(window.innerHeight * 0.65)}px`;
    requestAnimationFrame(() => {
      const rect = board.getBoundingClientRect();
      const targetTop = Math.max(24, window.innerHeight * 0.24);
      const targetScroll = Math.max(0, window.scrollY + rect.top - targetTop);
      window.scrollTo({ top: targetScroll, behavior: "smooth" });
    });
  });
}

async function refreshHistory() {
  const rows = await recorder.history();
  const list = $("history-list");
  list.replaceChildren();
  if (!rows.length) {
    list.append(el("p", { class: "muted", text: "No recordings saved yet." }));
    return;
  }
  rows.forEach((row) => {
    const item = el("div", { class: "history-item" }, [
      el("div", {}, [
        el("strong", { text: new Date(row.createdAt).toLocaleString() }),
        el("p", { class: "muted", text: `${formatDuration(row.duration)} · ${(row.transcript || row.text || "").slice(0, 80)}` }),
      ]),
      el("div", { class: "row-actions" }, [
        el("button", {
          type: "button",
          class: "btn btn-ghost",
          text: "Load",
          onclick: async () => {
            try {
              const recording = await recorder.load(row.id);
              if (!recording) throw new Error("Recording not found.");
              await clearPronunciationAnalysis();
              await clearTextAnalysis();
              $("btn-play").disabled = false;
              $("btn-pause-play").disabled = false;
              $("btn-delete-rec").disabled = false;
              $("btn-download").disabled = false;
              $("btn-analyze-pronunciation").disabled = false;
              let transcript = recording.transcript;
              if (!transcript) {
                toast("Recording loaded. Transcribing it now…");
                const result = await transcribeAudio(recording.blob, recording.mimeType, { language: "en-US" });
                transcript = result.text?.trim();
                if (!transcript) throw new Error("Could not transcribe the recording.");
                await recorder.saveTranscript(transcript, recording.id);
                await refreshHistory();
              }
              $("source-text").value = transcript;
              updateCounts();
              toast("Recording loaded and its transcript inserted.", "ok");
            } catch (error) {
              await showMessage(messageFor(error), { title: "Could not load transcript" });
            }
          },
        }),
        el("button", {
          type: "button",
          class: "btn btn-ghost",
          text: "Insert text",
          disabled: !row.transcript,
          onclick: async (event) => {
            await recorder.load(row.id);
            await clearPronunciationAnalysis();
            await clearTextAnalysis();
            $("source-text").value = row.transcript;
            updateCounts();
            $("btn-play").disabled = false;
            $("btn-pause-play").disabled = false;
            $("btn-delete-rec").disabled = false;
            $("btn-download").disabled = false;
            $("btn-analyze-pronunciation").disabled = false;
            toast("Transcript inserted.", "ok");
          },
        }),
        el("button", {
          type: "button",
          class: "btn btn-ghost danger",
          text: "Delete",
          onclick: async () => {
            if (!(await showMessage("Delete this recording?", { title: "Confirm deletion", confirm: true }))) return;
            const id = Number(row.id);
            const clearsAnalysis = recorder.current?.id === id || state.pronunciation?.recordingId === id;
            await recorder.remove(row.id);
            if (clearsAnalysis) {
              await clearPronunciationAnalysis();
              $("btn-play").disabled = true;
              $("btn-pause-play").disabled = true;
              $("btn-delete-rec").disabled = true;
              $("btn-download").disabled = true;
              $("btn-analyze-pronunciation").disabled = true;
            }
            await refreshHistory();
          },
        }),
      ]),
    ]);
    list.append(item);
  });
}

function fillSettingsForm() {
  const s = getSettings();
  $("setting-provider").value = s.provider;
  $("setting-gemini").value = s.geminiApiKey;
  $("setting-groq").value = s.groqApiKey;
  $("setting-pad-before").value = String(s.slicePadBeforeMs);
  $("setting-pad-after").value = String(s.slicePadAfterMs);
  $("tts-engine").value = s.ttsEngine || "google";
  fillVoices();
  if (s.ttsVoiceURI && [...$("tts-voice").options].some((option) => option.value === s.ttsVoiceURI)) $("tts-voice").value = s.ttsVoiceURI;
  $("setting-pad-before-value").textContent = `${s.slicePadBeforeMs} ms`;
  $("setting-pad-after-value").textContent = `${s.slicePadAfterMs} ms`;
}

function saveSettingsFromForm() {
  updateSettings({
    provider: $("setting-provider").value,
    geminiApiKey: $("setting-gemini").value.trim(),
    groqApiKey: $("setting-groq").value.trim(),
    slicePadBeforeMs: Number($("setting-pad-before").value),
    slicePadAfterMs: Number($("setting-pad-after").value),
    dialect: "en-US",
    ttsEngine: $("tts-engine").value,
    ttsVoiceURI: $("tts-voice").value,
  });
  refreshProviderBadge();
}

function fillVoices() {
  const select = $("tts-voice");
  const current = select.value || getSettings().ttsVoiceURI;
  const googleSelected = $("tts-engine").value === "google";
  $("tts-voice-control").hidden = googleSelected;
  if (googleSelected) {
    select.replaceChildren(el("option", { value: "google-en-US", text: "Google American English" }));
    return;
  }
  const voices = listEnglishVoices();
  select.replaceChildren(el("option", { value: "", text: voices.length ? "Automatic US English" : "No browser voices available" }));
  voices.forEach((v) => select.append(el("option", { value: v.voiceURI, text: `${v.name} (${v.lang})` })));
  if (current && [...select.options].some((option) => option.value === current)) select.value = current;
  else select.selectedIndex = 0;
}

function bind() {
  initConfig();
  applyTheme(document.documentElement.dataset.theme || "light");
  $("theme-toggle").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  refreshProviderBadge();
  $("source-text").value = loadDraft();
  updateCounts();

  if (!recordingSupported()) {
    $("recording-unsupported").hidden = false;
    $("btn-record").disabled = true;
  }

  $("source-text").addEventListener("input", () => {
    updateCounts();
    if (!$("source-text").value.trim()) {
      void clearPronunciationAnalysis();
      void clearTextAnalysis();
    }
  });
  $("btn-clear").addEventListener("click", async () => {
    $("source-text").value = "";
    await clearPronunciationAnalysis();
    await clearTextAnalysis();
    updateCounts();
  });
  $("btn-hide-analysis").addEventListener("click", () => {
    state.textAnalysisHidden = true;
    $("text-results").closest(".analysis-panel").hidden = true;
  });
  $("btn-analyze").addEventListener("click", runTextAnalysis);
  $("btn-apply-fix").addEventListener("click", applySelectedFix);
  $("btn-apply-all").addEventListener("click", applyFullCorrection);

  recorder.onDuration = (ms) => {
    $("rec-duration").textContent = formatDuration(ms);
  };
  recorder.onLevel = (level, samples) => drawLevel(level, samples);
  recorder.onState = () => {};

  $("btn-record").addEventListener("click", async () => {
    try {
      await recorder.start($("source-text").value);
      $("rec-indicator").dataset.on = "true";
      $("btn-stop-rec").disabled = false;
      $("btn-record").disabled = true;
    } catch (error) {
      toast(messageFor(error), "error");
    }
  });
  $("btn-stop-rec").addEventListener("click", async () => {
    const rec = await recorder.stop();
    $("rec-indicator").dataset.on = "false";
    $("btn-record").disabled = false;
    $("btn-stop-rec").disabled = true;
    $("btn-play").disabled = !rec;
    $("btn-pause-play").disabled = !rec;
    $("btn-delete-rec").disabled = !rec;
    $("btn-download").disabled = !rec;
    $("btn-analyze-pronunciation").disabled = !rec;
    updateCounts();
    await refreshHistory();
    if (!rec?.blob) return;
    toast("Recording saved. Transcribing it for the history…");
    try {
      const result = await transcribeAudio(rec.blob, rec.mimeType, { language: "en-US" });
      const transcript = result.text?.trim();
      if (!transcript) throw new Error("Could not transcribe the recording.");
      await recorder.saveTranscript(transcript, rec.id);
      await refreshHistory();
      toast("Transcript saved with the recording. Use Insert text when you want to compare against it.", "ok");
    } catch (error) {
      await refreshHistory();
      await showMessage(`The recording was saved and your text was kept. Transcription failed: ${messageFor(error)}`, { title: "Transcription error" });
    }
  });
  $("btn-play").addEventListener("click", () => {
    if (recorder.playback?.audio?.paused) recorder.resumePlayback();
    else recorder.play();
  });
  $("btn-pause-play").addEventListener("click", () => recorder.pausePlayback());
  $("btn-delete-rec").addEventListener("click", async () => {
    if (!recorder.current) return;
    if (!(await showMessage("Delete the current recording? Other recordings in history will remain.", { title: "Confirm deletion", confirm: true }))) return;
    const deletedId = recorder.current.id;
    await recorder.remove(deletedId);
    recorder.current = null;
    await clearPronunciationAnalysis();
    $("btn-play").disabled = true;
    $("btn-pause-play").disabled = true;
    $("btn-delete-rec").disabled = true;
    $("btn-download").disabled = true;
    $("btn-analyze-pronunciation").disabled = true;
    await refreshHistory();
  });
  $("btn-download").addEventListener("click", () => recorder.download());
  $("btn-analyze-pronunciation").addEventListener("click", runPronunciation);

  $("btn-play-user-word").addEventListener("click", async () => {
    const word = state.selectedWord;
    if (!word?.timestamps || !recorder.current?.blob) {
      recorder.play();
      return;
    }
    const range = word.sliceRange;
    if (range) {
      // Same fragment that was sent to the ONNX model.
      await playSlice(recorder.current.blob, range.from, range.to, 0, 0);
      return;
    }
    const settings = getSettings();
    await playSlice(recorder.current.blob, word.timestamps.start, word.timestamps.end, settings.slicePadBeforeMs / 1000, settings.slicePadAfterMs / 1000);
  });
  $("btn-play-ref").addEventListener("click", () => {
    const word = state.selectedWord;
    if (!word) return;
    if ($("tts-engine").value === "google") {
      window.speechSynthesis?.cancel();
      speakGoogleAmerican(word.text).catch((error) => toast(error.message || String(error), "error"));
      return;
    }
    stopGoogleSpeech();
    speakWord(word.text, { dialect: "en-US", voiceURI: $("tts-voice").value });
  });
  $("btn-close-word").addEventListener("click", () => $("word-panel").close());
  $("btn-close-issue").addEventListener("click", () => $("issue-panel").close());
  $("message-close").addEventListener("click", () => resolveMessage(false));
  $("message-cancel").addEventListener("click", () => resolveMessage(false));
  $("message-accept").addEventListener("click", () => resolveMessage(true));

  $("open-settings").addEventListener("click", () => {
    fillSettingsForm();
    showDialog($("settings-modal"));
  });
  $("close-settings").addEventListener("click", () => $("settings-modal").close());
  ["setting-gemini", "setting-groq", "setting-pad-before", "setting-pad-after"]
    .forEach((id) => $(id).addEventListener("input", saveSettingsFromForm));
  ["setting-provider"].forEach((id) => $(id).addEventListener("change", saveSettingsFromForm));
  $("btn-test-connection").addEventListener("click", async () => {
    const provider = $("setting-provider").value;
    const apiKey = provider === PROVIDERS.groq ? $("setting-groq").value.trim() : $("setting-gemini").value.trim();
    $("test-result").textContent = "Testing…";
    try {
      await testConnection(provider, apiKey);
      $("test-result").textContent = `${provider === "groq" ? "Groq" : "Gemini"} connection succeeded.`;
      $("test-result").dataset.kind = "ok";
    } catch (error) {
      $("test-result").textContent = messageFor(error);
      $("test-result").dataset.kind = "error";
    }
  });

  $("tts-engine").value = getSettings().ttsEngine;
  $("tts-engine").addEventListener("change", () => {
    fillVoices();
    saveSettingsFromForm();
  });
  $("tts-voice").addEventListener("change", saveSettingsFromForm);
  [["setting-pad-before", "setting-pad-before-value"], ["setting-pad-after", "setting-pad-after-value"]].forEach(([rangeId, outputId]) => {
    $(rangeId).addEventListener("input", () => {
      $(outputId).textContent = `${$(rangeId).value} ms`;
      saveSettingsFromForm();
    });
  });

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("close", () => {
      if (dialog.id === "message-modal" && messageResolver) {
        const resolve = messageResolver;
        messageResolver = null;
        resolve(false);
      }
      const position = modalScrollPositions.get(dialog);
      if (position) requestAnimationFrame(() => window.scrollTo(position.x, position.y));
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && dialog.open) dialog.close();
    });
  });

  window.speechSynthesis?.addEventListener("voiceschanged", fillVoices);
  fillVoices();
  restoreSnapshots();
  refreshHistory();
}

async function restoreSnapshots() {
  const textSnap = await loadAnalysisSnapshot("text");
  if (textSnap?.payload?.source === $("source-text").value) {
    state.analysis = textSnap.payload;
    renderTextAnalysis();
  } else {
    renderTextAnalysis();
  }
  renderPronunciation();
}

document.addEventListener("DOMContentLoaded", bind);
