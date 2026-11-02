import {
  initConfig,
  getSettings,
  updateSettings,
  PROVIDERS,
} from "./config.js";
import { loadDraft, saveDraft, saveAnalysisSnapshot, loadAnalysisSnapshot, deleteAnalysisSnapshot } from "./storage.js";
import { AudioRecorder, recordingSupported } from "./audio.js";
import { analyzeText, applySpanFix, shiftIssues } from "./text-analysis.js?v=gemini-timeout-fallback-20261030";
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
  retainedLevel: null,
  retainedLevelText: null,
  selectedIssue: null,
  busy: { text: false, test: false },
};

const recorder = new AudioRecorder();
const modalScrollPositions = new WeakMap();
let messageResolver = null;
let historyAudioUrl = null;

function showLoadedRecordingPlayer() {
  const blob = recorder.current?.blob;
  if (!blob) return;
  const player = $("history-audio-player");
  const waveform = $("waveform");
  player.pause();
  if (historyAudioUrl) URL.revokeObjectURL(historyAudioUrl);
  historyAudioUrl = URL.createObjectURL(blob);
  player.src = historyAudioUrl;
  player.hidden = false;
  waveform.hidden = true;
}

function hideLoadedRecordingPlayer() {
  const player = $("history-audio-player");
  const waveform = $("waveform");
  player.pause();
  player.removeAttribute("src");
  player.load();
  player.hidden = true;
  waveform.hidden = false;
  if (historyAudioUrl) URL.revokeObjectURL(historyAudioUrl);
  historyAudioUrl = null;
}

function setRecordButtonState(recording) {
  const button = $("btn-record");
  button.setAttribute("aria-pressed", String(recording));
  button.setAttribute("aria-label", recording ? "Stop recording" : "Start recording");
  button.title = recording ? "Stop recording" : "Start recording";
}

function setPlayButtonState(playing) {
  const button = $("btn-play");
  button.setAttribute("aria-label", playing ? "Stop playback" : "Play recording");
  button.title = playing ? "Stop playback" : "Play recording";
  button.dataset.playing = String(playing);
}

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
  }, 2100);
}

function wordCount(text) {
  return (text.trim().match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length;
}

function updateCounts() {
  const text = $("source-text").value;
  $("stat-words").textContent = String(wordCount(text));
  const currentAnalysis = state.analysis?.source === text ? state.analysis : null;
  if (state.retainedLevelText !== text) {
    state.retainedLevel = null;
    state.retainedLevelText = null;
  }
  if ($("stat-level")) $("stat-level").textContent = currentAnalysis?.cefr.overall || state.retainedLevel || "—";
  if ($("analysis-success")) {
    const issues = currentAnalysis
      ? [...currentAnalysis.grammarErrors, ...currentAnalysis.sentenceStructure, ...currentAnalysis.vocabulary]
      : [];
    const correctedText = currentAnalysis?.correctedText?.trim();
    const hasCorrection = Boolean(correctedText && correctedText !== currentAnalysis?.source?.trim());
    $("analysis-success").hidden = !currentAnalysis || issues.length > 0 || hasCorrection;
  }
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
  const isSvgElement = tag === "svg" || tag === "path";
  const node = isSvgElement
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.setAttribute("class", value);
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === false || value == null) continue;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function wordDiff(original, suggested) {
  const wordPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  const originalWords = [...original.matchAll(wordPattern)];
  const suggestedWords = [...suggested.matchAll(wordPattern)];
  const originalChanged = new Set();
  const suggestedChanged = new Set();
  const n = originalWords.length;
  const m = suggestedWords.length;

  if (n * m <= 1_000_000) {
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i][j] = originalWords[i][0] === suggestedWords[j][0]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (originalWords[i][0] === suggestedWords[j][0]) {
        i += 1;
        j += 1;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        originalChanged.add(i++);
      } else {
        suggestedChanged.add(j++);
      }
    }
    while (i < n) originalChanged.add(i++);
    while (j < m) suggestedChanged.add(j++);
  } else {
    originalWords.forEach((_, index) => originalChanged.add(index));
    suggestedWords.forEach((_, index) => suggestedChanged.add(index));
  }

  return { originalWords, suggestedWords, originalChanged, suggestedChanged };
}

function renderDiffText(text, words, changed, className) {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  words.forEach((word, index) => {
    const start = word.index;
    const end = start + word[0].length;
    fragment.append(text.slice(cursor, start));
    if (changed.has(index)) fragment.append(el("span", { class: className, text: word[0] }));
    else fragment.append(word[0]);
    cursor = end;
  });
  fragment.append(text.slice(cursor));
  return fragment;
}

function renderTextAnalysis() {
  const root = $("text-results");
  const panel = root.closest(".analysis-panel");
  const analysis = state.analysis;
  if (!analysis) {
    panel.hidden = true;
    root.replaceChildren();
    $("text-actions").hidden = true;
    $("stat-level").textContent = state.retainedLevelText === $("source-text").value ? state.retainedLevel || "—" : "—";
    $("analysis-success").hidden = true;
    return;
  }
  root.replaceChildren();

  $("stat-level").textContent = analysis.cefr.overall;
  const issues = [...analysis.grammarErrors, ...analysis.sentenceStructure, ...analysis.vocabulary];
  const correctedText = analysis.correctedText?.trim();
  const hasCorrection = Boolean(correctedText && correctedText !== analysis.source?.trim());
  const hasReport = issues.length > 0 || hasCorrection;
  panel.hidden = !hasReport;
  $("analysis-success").hidden = hasReport;
  $("text-actions").hidden = !hasReport;
  $("btn-apply-all").disabled = !hasCorrection;
  if (issues.length) root.append(el("h2", { class: "report-heading", text: "Errors found" }));
  issues.forEach((issue) => root.append(el("button", {
    class: "issue-item analysis-issue", type: "button", onclick: () => selectIssue(issue),
  }, [el("strong", { text: issue.original }), el("span", { text: `${issue.corrected} · ${issue.explanation}` })])));
  if (hasCorrection) {
    const diff = wordDiff(analysis.source || "", correctedText);
    const comparison = el("div", { class: "correction-comparison" });
    comparison.append(
      el("p", { class: "diff-label", text: "Your text" }),
      el("p", { class: "corrected-text diff-text" }, [renderDiffText(analysis.source || "", diff.originalWords, diff.originalChanged, "diff-removed")]),
      el("p", { class: "diff-label", text: "Suggested correction" }),
      el("p", { class: "corrected-text diff-text" }, [renderDiffText(correctedText, diff.suggestedWords, diff.suggestedChanged, "diff-added")]),
    );
    root.append(el("h3", { class: "report-heading", text: "Corrected text" }), comparison);
  }
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
    renderTextAnalysis();
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
  const correctedText = state.analysis.correctedText;
  state.retainedLevel = state.analysis.cefr.overall;
  state.retainedLevelText = correctedText;
  $("source-text").value = correctedText;
  state.analysis = null;
  if ($("issue-panel").open) $("issue-panel").close();
  updateCounts();
  renderTextAnalysis();
  toast("Corrected text applied.", "ok");
}

async function clearTextAnalysis() {
  state.analysis = null;
  state.retainedLevel = null;
  state.retainedLevelText = null;
  if ($("issue-panel").open) $("issue-panel").close();
  setStatus($("text-status"), "");
  renderTextAnalysis();
  await deleteAnalysisSnapshot("text");
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
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
              showLoadedRecordingPlayer();
              await clearTextAnalysis();
              $("btn-play").disabled = false;
              $("btn-delete-rec").disabled = false;
              $("btn-download").disabled = false;
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
            showLoadedRecordingPlayer();
            await clearTextAnalysis();
            $("source-text").value = row.transcript;
            updateCounts();
            $("btn-play").disabled = false;
            $("btn-delete-rec").disabled = false;
            $("btn-download").disabled = false;
            toast("Transcript inserted.", "ok");
          },
        }),
        el("button", {
          type: "button",
          class: "btn btn-ghost icon-only delete-history-btn",
          "aria-label": "Delete recording",
          title: "Delete recording",
          onclick: async () => {
            if (!(await showMessage("Delete this recording?", { title: "Confirm deletion", confirm: true }))) return;
            const id = Number(row.id);
            const clearsCurrent = recorder.current?.id === id;
            await recorder.remove(row.id);
            if (clearsCurrent) {
              hideLoadedRecordingPlayer();
              $("btn-play").disabled = true;
              $("btn-delete-rec").disabled = true;
              $("btn-download").disabled = true;
            }
            await refreshHistory();
          },
        }, [el("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, [el("path", { d: "M5 7h14M10 4h4m-7 3 1 13h8l1-13M10 10v7m4-7v7" })])]),
      ]),
    ]);
    list.append(item);
  });
}

async function stopRecording() {
  const button = $("btn-record");
  button.disabled = true;
  try {
    const rec = await recorder.stop();
    $("rec-indicator").dataset.on = "false";
    setRecordButtonState(false);
    button.disabled = false;
    $("btn-play").disabled = !rec;
    $("btn-delete-rec").disabled = !rec;
    $("btn-download").disabled = !rec;
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
  } catch (error) {
    $("rec-indicator").dataset.on = "false";
    setRecordButtonState(false);
    toast(messageFor(error), "error");
  } finally {
    button.disabled = false;
  }
}

function fillSettingsForm() {
  const s = getSettings();
  $("setting-provider").value = s.provider;
  $("setting-gemini").value = s.geminiApiKey;
  $("setting-groq").value = s.groqApiKey;
}

function saveSettingsFromForm() {
  updateSettings({
    provider: $("setting-provider").value,
    geminiApiKey: $("setting-gemini").value.trim(),
    groqApiKey: $("setting-groq").value.trim(),
  });
  refreshProviderBadge();
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
      void clearTextAnalysis();
    }
  });
  $("btn-clear").addEventListener("click", async () => {
    $("source-text").value = "";
    await clearTextAnalysis();
    updateCounts();
  });
  $("btn-copy-text").addEventListener("click", async () => {
    const area = $("source-text");
    if (!area.value) {
      toast("There is no text to copy.");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(area.value);
      } else {
        const start = area.selectionStart;
        const end = area.selectionEnd;
        area.select();
        if (!document.execCommand("copy")) throw new Error("Clipboard access is unavailable.");
        area.setSelectionRange(start, end);
      }
      toast("Text copied to clipboard.", "ok");
    } catch (error) {
      toast(error.message || "Could not copy the text.", "error");
    }
  });
  $("btn-hide-analysis").addEventListener("click", () => { void clearTextAnalysis(); });
  $("btn-analyze").addEventListener("click", runTextAnalysis);
  $("btn-apply-fix").addEventListener("click", applySelectedFix);
  $("btn-apply-all").addEventListener("click", applyFullCorrection);

  recorder.onState = () => {};

  $("btn-record").addEventListener("click", async () => {
    if (recorder.mediaRecorder?.state === "recording") {
      await stopRecording();
      return;
    }
    const button = $("btn-record");
    button.disabled = true;
    hideLoadedRecordingPlayer();
    try {
      await recorder.start($("source-text").value);
      $("rec-indicator").dataset.on = "true";
      setRecordButtonState(true);
    } catch (error) {
      toast(messageFor(error), "error");
    } finally {
      button.disabled = false;
    }
  });
  $("btn-play").addEventListener("click", () => {
    const player = $("history-audio-player");
    if (player.hidden) showLoadedRecordingPlayer();
    if (player.paused) player.play().catch((error) => toast(error.message || "Could not play the recording.", "error"));
    else player.pause();
  });
  $("history-audio-player").addEventListener("play", () => setPlayButtonState(true));
  $("history-audio-player").addEventListener("pause", () => setPlayButtonState(false));
  $("history-audio-player").addEventListener("ended", () => setPlayButtonState(false));
  $("btn-delete-rec").addEventListener("click", async () => {
    if (!recorder.current) return;
    if (!(await showMessage("Delete the current recording? Other recordings in history will remain.", { title: "Confirm deletion", confirm: true }))) return;
    const deletedId = recorder.current.id;
    await recorder.remove(deletedId);
    recorder.current = null;
    hideLoadedRecordingPlayer();
    $("btn-play").disabled = true;
    $("btn-delete-rec").disabled = true;
    $("btn-download").disabled = true;
    await refreshHistory();
  });
  $("btn-download").addEventListener("click", () => recorder.download());
  $("btn-close-issue").addEventListener("click", () => $("issue-panel").close());
  $("message-close").addEventListener("click", () => resolveMessage(false));
  $("message-cancel").addEventListener("click", () => resolveMessage(false));
  $("message-accept").addEventListener("click", () => resolveMessage(true));

  $("open-settings").addEventListener("click", () => {
    fillSettingsForm();
    showDialog($("settings-modal"));
  });
  $("close-settings").addEventListener("click", () => $("settings-modal").close());
  ["setting-gemini", "setting-groq"]
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

  restoreSnapshots();
  refreshHistory();
}

async function restoreSnapshots() {
  await deleteAnalysisSnapshot("pronunciation");
  const textSnap = await loadAnalysisSnapshot("text");
  if (textSnap?.payload?.source === $("source-text").value) {
    state.analysis = textSnap.payload;
    renderTextAnalysis();
  } else {
    renderTextAnalysis();
  }
}

document.addEventListener("DOMContentLoaded", bind);
