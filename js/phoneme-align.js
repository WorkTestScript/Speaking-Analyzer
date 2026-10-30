const SIMILAR = [
  ["ɪ", "i"], ["ʊ", "u"], ["ɛ", "e"], ["æ", "ɛ"], ["ɑ", "ɔ"], ["ʌ", "ə"], ["s", "θ"], ["z", "ð"],
];

export function substitutionCost(a, b) {
  if (a === b) return 0;
  return SIMILAR.some(([x, y]) => (a === x && b === y) || (a === y && b === x)) ? 0.5 : 1;
}

export function alignPhonemes(expected, heard) {
  const n = expected.length;
  const m = heard.length;
  const d = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
  const back = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) { d[i][0] = i; back[i][0] = 1; }
  for (let j = 1; j <= m; j++) { d[0][j] = j; back[0][j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const options = [
        [d[i - 1][j] + 1, 1],
        [d[i][j - 1] + 1, 2],
        [d[i - 1][j - 1] + substitutionCost(expected[i - 1], heard[j - 1]), 3],
      ];
      options.sort((a, b) => a[0] - b[0]);
      [d[i][j], back[i][j]] = options[0];
    }
  }
  const edits = [];
  let i = n, j = m;
  while (i || j) {
    const op = back[i][j];
    if (op === 3) {
      const cost = substitutionCost(expected[i - 1], heard[j - 1]);
      if (cost) edits.push({ type: "substitution", expected: expected[i - 1], heard: heard[j - 1], expectedIndex: i - 1, heardIndex: j - 1, similar: cost < 1 });
      i--; j--;
    } else if (op === 1) {
      edits.push({ type: "omission", expected: expected[i - 1], expectedIndex: i - 1 }); i--;
    } else {
      edits.push({ type: "addition", heard: heard[j - 1], anchorIndex: Math.max(0, Math.min(i, n - 1)), heardIndex: j - 1 }); j--;
    }
  }
  edits.reverse();
  return { distance: d[n][m], edits };
}

export function classifyPhonemeResult({ expected, heard, edits, duration }) {
  if (duration < 0.12) return { status: "needs_review", label: "Needs review" };
  if (edits.length === 0) return { status: "no_issue", label: "No issues detected" };
  if (edits.length === 1 && edits[0].type === "substitution" && edits[0].similar) {
    return { status: "needs_review", label: "Needs review" };
  }
  return { status: "possible_error", label: "Possible pronunciation error" };
}
