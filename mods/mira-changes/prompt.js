// Pure: what the commit-message model sees.

/** Files whose content never goes to the model (still listed in --stat). Git pathspec globs. */
export const EXCLUDE = [
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "go.sum",
  "flake.lock", "pubspec.lock", "mix.lock", "Podfile.lock", "deno.lock",
  "*.min.js", "*.min.css", "*.map", "*.snap",
];
export const MAX_DIFF_CHARS = 12000;
export const MAX_FILE_LINES = 2000;

/**
 * Pathspec for `git diff` that drops lockfiles and files with more than MAX_FILE_LINES changed lines.
 * numstat: { [path]: { add, del, binary } }.
 */
export function diffPathspec(numstat) {
  const big = Object.entries(numstat).filter(([, s]) => s.add + s.del > MAX_FILE_LINES).map(([p]) => p);
  return ["--", ".", ...EXCLUDE.map((g) => `:(exclude,glob)**/${g}`), ...big.map((p) => `:(exclude,literal)${p}`)];
}

/** Cuts the diff at a line boundary so it fits, saying so. */
export function capDiff(diff, max = MAX_DIFF_CHARS) {
  if (diff.length <= max) return diff;
  const cut = diff.lastIndexOf("\n", max);
  return diff.slice(0, cut > 0 ? cut : max) + "\n… (diff truncated)\n";
}

export const INSTRUCTIONS = [
  "You write git commit messages in the Conventional Commits format.",
  "Reply with the commit message only: no code fences, no quotes, no explanations.",
  "First line: <type>(<optional scope>): <summary>, imperative mood, lower case, no period, at most 72 characters.",
  "Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.",
  "Add a body (after a blank line) only when the change needs explaining; wrap it at 72 columns and use '-' bullets for several points.",
  "Mark breaking changes with '!' after the type and a 'BREAKING CHANGE:' footer.",
  "Write in the language of the existing commit subjects when they are given, else English.",
].join("\n");

/** The Responses API request body. `recent` is a few recent commit subjects (style hint). */
export function requestBody({ model, stat, diff, recent = [] }) {
  const input = [
    recent.length ? `Recent commit subjects in this repository:\n${recent.slice(0, 8).map((s) => `- ${s}`).join("\n")}\n` : "",
    `Changed files (git diff --stat):\n${stat.trim()}\n`,
    `Diff (lockfiles and very large files left out):\n${capDiff(diff)}`,
  ].filter(Boolean).join("\n");
  return {
    model,
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
    store: false,
    stream: true,
  };
}

/** Strips fences/quotes some models add anyway, and trailing blank lines. */
export function cleanMessage(text) {
  let t = text.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (/^".*"$/s.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1);
  return t.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
}
