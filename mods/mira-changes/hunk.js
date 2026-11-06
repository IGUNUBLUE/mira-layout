// Pure: one file's unified diff into hunks, and the patch for a single hunk.

/**
 * Parses `git diff -- <path>` output for one file.
 * Returns { header: string[] (diff --git ... +++ b/...), hunks: [{ header, oldStart, oldLines, newStart, newLines, lines }], binary }.
 */
export function parseFileDiff(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  const header = [], hunks = [];
  let current = null, binary = false;
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      current = { header: line, oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      if (/^Binary files .* differ$/.test(line) || line.startsWith("GIT binary patch")) binary = true;
      header.push(line);
    }
  }
  return { header, hunks, binary };
}

/** A patch that `git apply` accepts containing only hunk `index`. Ends with a newline. */
export function hunkPatch(diff, index) {
  const hunk = diff.hunks[index];
  if (!hunk) throw new Error("No such hunk");
  const header = diff.header;
  if (!header.some((l) => l.startsWith("--- ")) || !header.some((l) => l.startsWith("+++ "))) throw new Error("This diff has no file header");
  return [...header, hunk.header, ...hunk.lines].join("\n") + "\n";
}

/**
 * Git args (run through `sh -c`) to apply a single-hunk patch passed as $1.
 * action: "stage" (unstaged diff → index), "unstage" (staged diff → back out of index),
 * "discard" (unstaged diff → back out of the working tree).
 */
export function applyScript(action) {
  const flags = action === "stage" ? "--cached" : action === "unstage" ? "--cached -R" : "-R";
  return `printf '%s' "$1" | git apply ${flags} --whitespace=nowarn --recount -`;
}

/** Counts of added and removed lines in a hunk. */
export function hunkStats(hunk) {
  let add = 0, del = 0;
  for (const l of hunk.lines) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
  return { add, del };
}
