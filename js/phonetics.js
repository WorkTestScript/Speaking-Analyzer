const cache = new Map();

function pickPhonetic(entry, dialect) {
  const phonetics = Array.isArray(entry?.phonetics) ? entry.phonetics : [];
  const want = dialect === "en-GB" ? ["uk", "gb", "bri"] : ["us", "am"];
  const scored = phonetics.map((item) => {
    const audio = String(item.audio || "").toLowerCase();
    const text = item.text || entry.phonetic || "";
    const match = want.some((token) => audio.includes(token));
    return { text, audio: item.audio || "", score: match ? 2 : item.audio ? 1 : text ? 0 : -1 };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0] || { text: entry?.phonetic || "", audio: "" };
  const meaning = entry?.meanings?.[0];
  const definition = meaning?.definitions?.[0];
  return {
    ipa: best.text || "",
    audioUrl: best.audio || "",
    example: definition?.example || "",
    definition: definition?.definition || "",
  };
}

export async function lookupWord(word, dialect = "en-US") {
  const key = `${dialect}:${word.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const result = {
    word,
    ipa: "",
    audioUrl: "",
    example: "",
    definition: "",
    source: "dictionaryapi.dev",
  };
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!response.ok) {
      cache.set(key, result);
      return result;
    }
    const data = await response.json();
    if (Array.isArray(data) && data[0]) Object.assign(result, pickPhonetic(data[0], dialect));
  } catch {
    /* network */
  }
  cache.set(key, result);
  return result;
}

export function speakWord(word, { dialect = "en-US", voiceURI = "" } = {}) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve(false);
      return;
    }
    const utter = new SpeechSynthesisUtterance(word);
    const voices = speechSynthesis.getVoices();
    const wantedLang = dialect === "en-GB" ? "en-GB" : "en-US";
    const selected =
      voices.find((v) => v.voiceURI === voiceURI) ||
      voices.find((v) => v.lang === wantedLang) ||
      voices.find((v) => v.lang.startsWith(wantedLang.slice(0, 2)));
    if (selected) utter.voice = selected;
    utter.lang = selected?.lang || wantedLang;
    utter.onend = () => resolve(true);
    utter.onerror = () => resolve(false);
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);
  });
}

export function listEnglishVoices() {
  if (!window.speechSynthesis) return [];
  return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
}
