/**
 * Hook for a future specialized pronunciation API
 * (phonemes, stress, articulation). Whisper/Gemini transcription
 * is not a phonetic assessment.
 */
export async function assessPronunciation() {
  return {
    available: false,
    engine: null,
    note: "No specialized pronunciation-assessment API is connected. Current results compare the original text with a speech-to-text transcript only.",
  };
}
