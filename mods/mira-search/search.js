// Pure: ripgrep arguments, its --json output, and line-by-line replacement. Tested with Node.

export const MAX_MATCHES = 5000;

/** ripgrep args for a query. opts: { matchCase, word, regex }. Respects .gitignore (rg's default). */
export function rgArgs(query, { matchCase = false, word = false, regex = false } = {}) {
  return ["--json", "--max-columns", "400", "--max-columns-preview", "--max-filesize", "4M", "--hidden", "--glob", "!.git",
    matchCase ? "--case-sensitive" : "--ignore-case", ...(word ? ["--word-regexp"] : []), ...(regex ? [] : ["--fixed-strings"]), "--", query, "."];
}

/** The string index of a UTF-8 byte offset (no TextEncoder in Herdr's runtime). */
export function charIndex(str, byte) {
  let bytes = 0, i = 0;
  while (i < str.length && bytes < byte) {
    const c = str.codePointAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    i += c > 0xffff ? 2 : 1;
  }
  return i;
}

const text = (v) => v?.text ?? (v?.bytes ? "" : "");

/** `rg --json` output into [{ path, matches: [{ line, text, ranges: [[start, end]] }] }], capped. */
export function parseRg(output, max = MAX_MATCHES) {
  const files = new Map();
  let count = 0, truncated = false;
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "match") continue;
    if (count >= max) { truncated = true; break; }
    const d = event.data, path = text(d.path).replace(/^\.\//, "");
    const body = text(d.lines).replace(/\r?\n$/, "");
    // rg's offsets are UTF-8 bytes; convert to string indices.
    const ranges = (d.submatches ?? []).map((m) => [charIndex(body, m.start), charIndex(body, m.end)]);
    if (!files.has(path)) files.set(path, { path, matches: [] });
    files.get(path).matches.push({ line: d.line_number, text: body, ranges });
    count += Math.max(1, ranges.length);
  }
  return { files: [...files.values()], count, truncated };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The JavaScript RegExp equivalent used for replacing (global). Throws on an invalid pattern. */
export function buildRegex(query, { matchCase = false, word = false, regex = false } = {}) {
  let source = regex ? query : escape(query);
  if (word) source = `\\b(?:${source})\\b`;
  return new RegExp(source, `g${matchCase ? "" : "i"}u`);
}

/**
 * Replaces matches only on the given 1-based line numbers, as the results show them.
 * In regex mode `$1` etc. refer to groups; otherwise the replacement is literal.
 * Returns { text, count }. Line endings (\n or \r\n) are kept.
 */
export function replaceLines(source, lines, re, replacement, { regex = false } = {}) {
  const wanted = new Set(lines), parts = source.split(/(\r?\n)/);
  let count = 0;
  for (let i = 0, n = 1; i < parts.length; i += 2, n++) {
    if (!wanted.has(n)) continue;
    re.lastIndex = 0;
    parts[i] = parts[i].replace(re, (...m) => {
      count++;
      if (!regex) return replacement;
      const groups = m.slice(1, -2);
      return replacement.replace(/\$(\d+|&)/g, (_s, g) => (g === "&" ? m[0] : groups[Number(g) - 1] ?? ""));
    });
  }
  return { text: parts.join(""), count };
}
