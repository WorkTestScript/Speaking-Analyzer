export async function decodeTo16kMono(blob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const OfflineContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineContextClass) throw new Error("This browser does not support audio processing for phoneme analysis.");
  const ctx = new AudioContextClass();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); }
  finally { await ctx.close(); }
  const length = Math.ceil(decoded.duration * 16000);
  const offline = new OfflineContextClass(1, length, 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

const SAMPLE_RATE = 16000;
const FADE_MS = 10;

// Returns {from, to} in seconds. Padding never crosses the midpoint of the gap
// to the neighbouring word, so a large pad can't pull in the adjacent word.
export function wordRange(duration, start, end, padBefore, padAfter, { prevEnd = null, nextStart = null } = {}) {
  let from = start - padBefore;
  let to = end + padAfter;
  if (prevEnd != null) from = Math.max(from, Math.min(start, (prevEnd + start) / 2));
  if (nextStart != null) to = Math.min(to, Math.max(end, (end + nextStart) / 2));
  return { from: Math.max(0, from), to: Math.min(duration, to) };
}

export function sliceWord(audio, start, end, padBefore = 0.04, padAfter = 0.08, neighbors = {}) {
  const { from, to } = wordRange(audio.length / SAMPLE_RATE, start, end, padBefore, padAfter, neighbors);
  const a = Math.floor(from * SAMPLE_RATE);
  const b = Math.ceil(to * SAMPLE_RATE);
  const out = audio.slice(a, b); // copy, so the fade doesn't alter the original samples
  const fade = Math.min(Math.floor((FADE_MS * SAMPLE_RATE) / 1000), out.length >> 1);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  return out;
}
