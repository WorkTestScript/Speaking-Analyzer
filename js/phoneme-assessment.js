import { transcribeAudioWithWordTimes } from "./api/provider.js";
import { alignTokens, tokenizeWithOffsets } from "./pronunciation.js";
import { decodeTo16kMono, sliceWord, wordRange } from "./audio-utils.js";
import { ARPA_TO_IPA, loadCmuDict, stripStress, stressPattern } from "./cmudict.js";
import { alignPhonemes, classifyPhonemeResult } from "./phoneme-align.js";
import { loadRecognizer, recognizePhonemes } from "./phoneme-recognizer.js?v=simd-fallback-20261030";
import { getSettings } from "./config.js";
import { mapPhonemeErrorsToSyllables } from "./syllable-utils.js?v=syllable-highlight-20261030";

function phonemeTokens(text) {
  const symbols = String(text || "").toLowerCase().normalize("NFC")
    .replace(/[|\s]+/g, "").replace(/ʤ/g, "dʒ").replace(/ʧ/g, "tʃ").replace(/ɡ/g, "g")
    .match(/tʃ|dʒ|aɪ|aʊ|eɪ|ɔɪ|oʊ|[ɑæʌɔðɛɝɪŋʃθʊʒbdfghijklmnpɹstuvwzə]|[aeiou]/gu);
  return symbols || [];
}

export async function analyzePhonemes({ blob, mimeType, originalText, onProgress = () => {} }) {
  onProgress("Getting the transcript and word timestamps…");
  const transcript = await transcribeAudioWithWordTimes(blob, mimeType, { language: "en-US" });
  if (!transcript.timestampsAvailable || !transcript.words?.length) {
    throw new Error("The provider did not return word timestamps. Add a Groq API key in Settings or select Groq Whisper.");
  }
  onProgress("Loading the ONNX model and CMUdict…");
  const [dictionary, samples] = await Promise.all([loadCmuDict(), decodeTo16kMono(blob)]);
  await loadRecognizer(onProgress);
  onProgress("Converting the recording to 16 kHz mono…");
  const referenceTokens = tokenizeWithOffsets(originalText);
  const settings = getSettings();
  const spokenTokens = transcript.words.map((word, index) => ({
    text: String(word.word || "").replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, ""),
    norm: String(word.word || "").toLowerCase().replace(/[^a-z']/g, ""),
    start: Number(word.start), end: Number(word.end), index,
  })).filter((word) => word.norm && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  const pairs = alignTokens(referenceTokens, spokenTokens);
  const words = referenceTokens.map((token) => ({ ...token, status: "needs_review", label: "Needs review", timestamps: null }));

  for (const [referenceIndex, spokenIndex] of pairs) {
    if (referenceIndex == null) continue;
    const word = words[referenceIndex];
    const spoken = spokenIndex == null ? null : spokenTokens[spokenIndex];
    if (!spoken) { word.label = "Word not recognized"; word.kind = "omission"; continue; }
    word.recognized = spoken.text;
    word.timestamps = { start: spoken.start, end: spoken.end };
    if (word.norm !== spoken.norm) { word.label = `Recognized as: ${spoken.text}`; word.kind = "transcript_mismatch"; continue; }
    const variants = dictionary.get(word.norm);
    if (!variants?.length) { word.label = "Not found in CMUdict"; word.kind = "dictionary_missing"; continue; }
    const prev = spokenIndex > 0 ? spokenTokens[spokenIndex - 1] : null;
    const next = spokenTokens[spokenIndex + 1] || null;
    const neighbors = { prevEnd: prev?.end ?? null, nextStart: next?.start ?? null };
    const padBefore = settings.slicePadBeforeMs / 1000;
    const padAfter = settings.slicePadAfterMs / 1000;
    const audio = sliceWord(samples, spoken.start, spoken.end, padBefore, padAfter, neighbors);
    word.sliceRange = wordRange(samples.length / 16000, spoken.start, spoken.end, padBefore, padAfter, neighbors);
    if (audio.length < 800) { word.label = "Needs review"; word.kind = "uncertain"; continue; }
    const heard = phonemeTokens(await recognizePhonemes(audio));
    const ranked = variants.map((arpabet) => {
      const expected = stripStress(arpabet).map((phone) => ARPA_TO_IPA[phone]).filter(Boolean).flatMap(phonemeTokens);
      return { arpabet, expected, alignment: alignPhonemes(expected, heard) };
    }).sort((a, b) => a.alignment.distance - b.alignment.distance);
    const { arpabet, expected, alignment } = ranked[0];
    const classification = classifyPhonemeResult({ expected, heard, edits: alignment.edits, duration: spoken.end - spoken.start });
    word.referencePhonemes = expected.join(" ");
    word.spokenPhonemes = heard.join(" ");
    word.phonemeDifference = alignment.distance;
    word.phonemeEdits = alignment.edits;
    word.syllableErrors = mapPhonemeErrorsToSyllables(word.text, expected, alignment.edits);
    word.expectedStress = stressPattern(arpabet);
    word.status = classification.status;
    word.label = classification.label;
    word.kind = "phoneme_comparison";
    onProgress({ message: `Checked ${referenceIndex + 1} of ${referenceTokens.length} words…`, progress: null });
  }
  return {
    engine: "robg/speako-phoneme-recognizer",
    originalText,
    recognizedText: transcript.text || spokenTokens.map((word) => word.text).join(" "),
    timestampsAvailable: true,
    originalWords: words,
    added: [],
    specialized: { available: true, engine: "robg/speako-phoneme-recognizer", note: "This is an approximate phoneme comparison. The model does not assess stress; noise and timestamps can affect results." },
  };
}
