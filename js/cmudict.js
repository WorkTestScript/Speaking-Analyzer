const CMUDICT_URL = "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict";

export const ARPA_TO_IPA = {
  AA:"ɑ", AE:"æ", AH:"ʌ", AO:"ɔ", AW:"aʊ", AY:"aɪ", B:"b", CH:"tʃ", D:"d", DH:"ð", EH:"ɛ", ER:"ɝ", EY:"eɪ",
  F:"f", G:"ɡ", HH:"h", IH:"ɪ", IY:"i", JH:"dʒ", K:"k", L:"l", M:"m", N:"n", NG:"ŋ", OW:"oʊ", OY:"ɔɪ",
  P:"p", R:"ɹ", S:"s", SH:"ʃ", T:"t", TH:"θ", UH:"ʊ", UW:"u", V:"v", W:"w", Y:"j", Z:"z", ZH:"ʒ",
};

let dictionaryPromise = null;

export function stripStress(phones) {
  return phones.map((phone) => phone.replace(/[012]$/, ""));
}

export function stressPattern(phones) {
  return phones.filter((phone) => /[012]$/.test(phone)).map((phone) => phone.slice(-1));
}

export async function loadCmuDict(url = CMUDICT_URL) {
  if (!dictionaryPromise) {
    dictionaryPromise = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Failed to load CMUdict (${response.status}).`);
      return response.text();
    }).then((text) => {
      const dict = new Map();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(";;;")) continue;
        const [entry, ...phones] = trimmed.split(/\s+/);
        if (!entry || !phones.length) continue;
        const key = entry.replace(/\(\d+\)$/, "").toLowerCase();
        if (!dict.has(key)) dict.set(key, []);
        dict.get(key).push(phones);
      }
      return dict;
    }).catch((error) => { dictionaryPromise = null; throw error; });
  }
  return dictionaryPromise;
}
