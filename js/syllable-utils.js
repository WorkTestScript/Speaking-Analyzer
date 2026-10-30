const VOWEL_PHONEMES = new Set(["i", "ɪ", "e", "ɛ", "æ", "ɑ", "ɔ", "ʌ", "ʊ", "u", "ə", "ɝ", "aɪ", "aʊ", "eɪ", "ɔɪ", "oʊ"]);

export function splitOrthographicSyllables(word) {
  const text = String(word || "");
  const nuclei = [...text.matchAll(/[aeiouy]+/gi)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  if (nuclei.length < 2) return [{ start: 0, end: text.length }];

  const ranges = [];
  let syllableStart = 0;
  for (let i = 0; i < nuclei.length - 1; i += 1) {
    const current = nuclei[i];
    const next = nuclei[i + 1];
    const consonants = text.slice(current.end, next.start);
    if (!consonants) continue;
    // Keep a single intervocalic consonant with the following vowel; split
    // longer clusters after the first consonant as a practical spelling heuristic.
    const splitAt = current.end + (consonants.length > 1 ? 1 : 0);
    if (splitAt > syllableStart && splitAt < next.end) {
      ranges.push({ start: syllableStart, end: splitAt });
      syllableStart = splitAt;
    }
  }
  ranges.push({ start: syllableStart, end: text.length });
  return ranges.filter((range) => range.end > range.start);
}

export function mapPhonemeErrorsToSyllables(word, expectedPhones, edits) {
  const ranges = splitOrthographicSyllables(word);
  if (ranges.length < 2 || !edits?.length) return [];

  const phoneSyllables = [];
  let syllableIndex = 0;
  let hasSeenNucleus = false;
  for (const phone of expectedPhones) {
    const isNucleus = VOWEL_PHONEMES.has(phone);
    if (isNucleus && hasSeenNucleus) syllableIndex += 1;
    phoneSyllables.push(Math.min(syllableIndex, ranges.length - 1));
    if (isNucleus) hasSeenNucleus = true;
  }

  const affected = new Set();
  for (const edit of edits) {
    const index = Number.isInteger(edit.expectedIndex) ? edit.expectedIndex : edit.anchorIndex;
    if (Number.isInteger(index) && phoneSyllables.length) {
      affected.add(phoneSyllables[Math.max(0, Math.min(index, phoneSyllables.length - 1))]);
    }
  }
  return [...affected].sort((a, b) => a - b).map((index) => ranges[index]);
}
