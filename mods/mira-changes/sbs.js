// Pure: side-by-side rows from hunks, with intra-line (word) highlights.

const TOKEN = /\w+|\s+|[^\w\s]/gu;
const MAX_TOKENS = 400;

/** Splits two lines into spans [{ text, changed }] for each side, by an LCS over word tokens. */
export function intraLine(a, b) {
  const x = a.match(TOKEN) ?? [], y = b.match(TOKEN) ?? [];
  if (x.length > MAX_TOKENS || y.length > MAX_TOKENS) return { left: [{ text: a, changed: true }], right: [{ text: b, changed: true }] };
  const n = x.length, m = y.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const left = [], right = [];
  const push = (list, text, changed) => {
    const last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text; else list.push({ text, changed });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push(left, x[i], false); push(right, y[j], false); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push(left, x[i++], true);
    else push(right, y[j++], true);
  }
  while (i < n) push(left, x[i++], true);
  while (j < m) push(right, y[j++], true);
  // Whitespace-only "changes" between unchanged words read as noise: keep them plain.
  for (const list of [left, right]) for (const s of list) if (s.changed && !s.text.trim()) s.changed = false;
  return { left, right };
}

/**
 * Rows for a two-column view. Each row is either
 *   { hunk: index, header, add, del }  — a hunk bar
 *   { left: Cell | null, right: Cell | null } where Cell = { number, text, kind: " " | "-" | "+", spans? }
 * A run of removed lines followed by added lines is paired line by line.
 */
export function sideBySide(hunks, { intra = true } = {}) {
  const rows = [];
  hunks.forEach((h, index) => {
    let add = 0, del = 0;
    for (const l of h.lines) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
    rows.push({ hunk: index, header: h.header, add, del });
    let old = h.oldStart, next = h.newStart, removed = [], added = [];
    const flush = () => {
      const count = Math.max(removed.length, added.length);
      for (let k = 0; k < count; k++) {
        const l = removed[k] ?? null, r = added[k] ?? null;
        if (l && r && intra) {
          const s = intraLine(l.text, r.text);
          l.spans = s.left; r.spans = s.right;
        }
        rows.push({ left: l, right: r });
      }
      removed = []; added = [];
    };
    for (const line of h.lines) {
      const kind = line[0], text = line.slice(1);
      if (kind === "-") removed.push({ number: old++, text, kind });
      else if (kind === "+") added.push({ number: next++, text, kind });
      else if (kind === "\\") continue; // "\ No newline at end of file"
      else { flush(); rows.push({ left: { number: old++, text, kind: " " }, right: { number: next++, text, kind: " " } }); }
    }
    flush();
  });
  return rows;
}

/** A whole new file (untracked) as one hunk, so it renders like any other diff. */
export function newFileHunk(text, limit = 5000) {
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, limit);
  return { header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: shown.map((l) => "+" + l) };
}
