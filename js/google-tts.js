const MAX_CHUNK_LENGTH = 110;
const RETRY_DELAY_MS = 900;
let activeAudio = null;
let cancelActive = null;
let pauseActive = null;
let resumeActive = null;
let activeRate = 1;

function clampRate(rate) {
  const value = Number(rate);
  return Number.isFinite(value) ? Math.max(0.5, Math.min(1.5, value)) : 1;
}

export function setGoogleSpeechRate(rate) {
  activeRate = clampRate(rate);
  if (activeAudio) {
    activeAudio.defaultPlaybackRate = activeRate;
    activeAudio.playbackRate = activeRate;
  }
}

function splitText(text) {
  let rest = String(text || "").trim();
  const chunks = [];
  while (rest.length > MAX_CHUNK_LENGTH) {
    let splitAt = -1;
    for (const delimiter of [". ", "! ", "? ", ", ", " "]) {
      const index = rest.lastIndexOf(delimiter, MAX_CHUNK_LENGTH);
      if (index > 0) { splitAt = index + delimiter.length; break; }
    }
    if (splitAt < 0) splitAt = MAX_CHUNK_LENGTH;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function requestUrl(text, retry) {
  const retryQuery = retry ? `&retry=${Date.now()}-${retry}` : "";
  return `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en-US&q=${encodeURIComponent(text)}${retryQuery}`;
}

export function stopGoogleSpeech() {
  pauseActive = null;
  resumeActive = null;
  cancelActive?.();
  cancelActive = null;
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.onstalled = null;
    activeAudio.pause();
    activeAudio.removeAttribute("src");
    activeAudio.load();
    activeAudio = null;
  }
}

export function speakGoogleAmerican(text, { rate = 1 } = {}) {
  stopGoogleSpeech();
  activeRate = clampRate(rate);
  const chunks = splitText(text);
  if (!chunks.length) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let cancelled = false;
    let finished = false;
    let timer = null;
    let chunkIndex = 0;
    let retries = 0;
    let retryScheduled = false;
    const audio = new Audio();
    audio.defaultPlaybackRate = activeRate;
    audio.playbackRate = activeRate;
    activeAudio = audio;
    audio.referrerPolicy = "no-referrer";
    audio.setAttribute("referrerpolicy", "no-referrer");
    audio.preload = "auto";

    const clearTimer = () => { clearTimeout(timer); timer = null; };
    const settle = (error) => {
      if (finished) return;
      finished = true;
      clearTimer();
      if (activeAudio === audio) activeAudio = null;
      if (cancelActive === cancel) cancelActive = null;
      pauseActive = null;
      resumeActive = null;
      if (error) reject(error); else resolve();
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      clearTimer();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      settle();
    };
    cancelActive = cancel;

    const playChunk = () => {
      if (cancelled) return;
      if (chunkIndex >= chunks.length) { settle(); return; }
      const chunk = chunks[chunkIndex];
      const expectedMs = Math.min(45000, Math.max(10000, Math.ceil(((chunk.length / 12) * 1000 + 6000) / activeRate)));
      clearTimer();
      retryScheduled = false;
      timer = setTimeout(retry, expectedMs);
      resumeActive = () => {
        if (cancelled || finished) return;
        clearTimer();
        timer = setTimeout(retry, expectedMs);
        audio.play().catch(retry);
      };
      audio.src = requestUrl(chunk, retries);
      audio.defaultPlaybackRate = activeRate;
      audio.playbackRate = activeRate;
      audio.play().catch(retry);
    };
    pauseActive = () => { clearTimer(); audio.pause(); };
    const retry = () => {
      if (cancelled || finished || retryScheduled) return;
      clearTimer();
      if (retries >= 5) {
        settle(new Error("Google TTS is temporarily unavailable. Try again or switch to a browser voice."));
        return;
      }
      retries += 1;
      retryScheduled = true;
      audio.pause();
      timer = setTimeout(() => { retryScheduled = false; playChunk(); }, RETRY_DELAY_MS);
    };

    audio.onended = () => {
      clearTimer();
      chunkIndex += 1;
      retries = 0;
      retryScheduled = false;
      playChunk();
    };
    audio.onerror = retry;
    audio.onstalled = retry;
    playChunk();
  });
}

export function pauseGoogleSpeech() { pauseActive?.(); }

export function resumeGoogleSpeech() {
  if (activeAudio?.paused) return resumeActive?.();
  return Promise.resolve();
}
