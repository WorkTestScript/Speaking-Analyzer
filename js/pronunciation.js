import { transcribeAudio } from "./api/provider.js";
import { lookupWord } from "./phonetics.js";
import { assessPronunciation } from "./pronunciation-assessment.js";
import { getSettings } from "./config.js";

export function tokenizeWithOffsets(text) {
  const tokens = [];
  const re = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
  let match;
  while ((match = re.exec(text))) {
    tokens.push({
      text: match[0],
      norm: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function levenshtein(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i <= n; i += 1) dp[i][0] = i;
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[n][m];
}

function similarity(a, b) {
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length, 1);
}

export function alignTokens(originalTokens, recognizedTokens) {
  const n = originalTokens.length;
  const m = recognizedTokens.length;
  const MATCH = 4;
  const MIS = -1;
  const GAP = -2;
  const score = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  const ptr = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    score[i][0] = i * GAP;
    ptr[i][0] = 1;
  }
  for (let j = 1; j <= m; j += 1) {
    score[0][j] = j * GAP;
    ptr[0][j] = 2;
  }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const same = originalTokens[i - 1].norm === recognizedTokens[j - 1].norm;
      const d = score[i - 1][j - 1] + (same ? MATCH : MIS);
      const u = score[i - 1][j] + GAP;
      const l = score[i][j - 1] + GAP;
      if (d >= u && d >= l) {
        score[i][j] = d;
        ptr[i][j] = 0;
      } else if (u >= l) {
        score[i][j] = u;
        ptr[i][j] = 1;
      } else {
        score[i][j] = l;
        ptr[i][j] = 2;
      }
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const p = i === 0 ? 2 : j === 0 ? 1 : ptr[i][j];
    if (p === 0) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (p === 1) {
      pairs.push([i - 1, null]);
      i -= 1;
    } else {
      pairs.push([null, j - 1]);
      j -= 1;
    }
  }
  return pairs.reverse();
}

function classifyPair(orig, rec) {
  if (orig && rec && orig.norm === rec.norm) {
    return {
      status: "no_issue",
      label: "Correct / No issue detected",
      kind: "match",
      ukrainian:
        "The word was recognized as written. This is not a phonetic assessment of stress or articulation.",
    };
  }
  if (orig && rec) {
    const sim = similarity(orig.norm, rec.norm);
    if (sim >= 0.45) {
      return {
        status: "possible_error",
        label: "Possible Pronunciation Error",
        kind: "substitution",
        ukrainian: `Recognized as “${rec.text}” instead of “${orig.text}”. This may indicate a pronunciation issue, but it is only a transcript comparison.`,
      };
    }
    return {
      status: "needs_review",
      label: "Needs Review",
      kind: "substitution",
      ukrainian: `Expected “${orig.text}”, recognized “${rec.text}”. Further review is needed.`,
    };
  }
  if (orig && !rec) {
    return {
      status: "needs_review",
      label: "Needs Review",
      kind: "omission",
      ukrainian: `“${orig.text}” was not found in the transcript. It may have been omitted or unclear.`,
    };
  }
  return {
    status: "needs_review",
    label: "Needs Review",
    kind: "addition",
    ukrainian: `The transcript contains an extra word: “${rec.text}”.`,
  };
}

export async function analyzePronunciation({ blob, mimeType, originalText }) {
  const settings = getSettings();
  const transcript = await transcribeAudio(blob, mimeType, { language: settings.dialect || "en-US" });
  const originalTokens = tokenizeWithOffsets(originalText);
  const recognizedTokens = (transcript.words?.length
    ? transcript.words.map((w, index) => ({
        text: String(w.word || "").replace(/[.,!?;:]+$/g, ""),
        norm: String(w.word || "").toLowerCase().replace(/[.,!?;:]+$/g, ""),
        start: w.start,
        end: w.end,
        confidence: w.confidence,
        index,
      }))
    : tokenizeWithOffsets(transcript.text || "")
  ).filter((t) => t.norm);

  const pairs = alignTokens(originalTokens, recognizedTokens);
  const originalWords = originalTokens.map((token) => ({
    ...token,
    status: "needs_review",
    label: "Needs Review",
    recognized: null,
    timestamps: null,
    confidenceAvailable: false,
  }));
  const added = [];

  for (const [oi, ri] of pairs) {
    const orig = oi == null ? null : originalTokens[oi];
    const rec = ri == null ? null : recognizedTokens[ri];
    const info = classifyPair(orig, rec);
    const timestamps =
      rec && rec.start != null && rec.end != null && transcript.timestampsAvailable
        ? { start: rec.start, end: rec.end }
        : null;
    if (orig) {
      originalWords[oi] = {
        ...orig,
        status: info.status,
        label: info.label,
        kind: info.kind,
        ukrainian: info.ukrainian,
        recognized: rec ? rec.text : null,
        timestamps,
        confidence: rec?.confidence ?? null,
        confidenceAvailable: typeof rec?.confidence === "number",
      };
    } else if (rec) {
      added.push({
        text: rec.text,
        status: info.status,
        label: info.label,
        kind: info.kind,
        ukrainian: info.ukrainian,
        timestamps,
      });
    }
  }

  const specialized = await assessPronunciation();
  return {
    originalText,
    recognizedText: transcript.text || "",
    timestampsAvailable: Boolean(transcript.timestampsAvailable),
    originalWords,
    added,
    specialized,
  };
}

export async function wordDetails(word, dialect) {
  const data = await lookupWord(word, dialect);
  return {
    word,
    ipa: data.ipa || "",
    ipaSource: data.ipa ? "dictionaryapi.dev" : "",
    audioUrl: data.audioUrl || "",
    example: data.example || "",
    definition: data.definition || "",
  };
}
