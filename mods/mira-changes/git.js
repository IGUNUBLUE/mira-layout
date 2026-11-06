// Pure git helpers: parsers and argument builders. No herdr or gpui-kit imports,
// so tests run them with plain Node (tests/git.test.js).

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * `git status --porcelain=v1 -z --untracked-files=all` (renames on) into entries.
 * Each entry: { path, orig?, x, y }. A rename/copy carries its source as `orig`.
 */
export function parseStatus(z) {
  const fields = z.split("\0"), out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const x = f[0], y = f[1], path = f.slice(3), entry = { path, x, y };
    if (x === "R" || x === "C" || y === "R" || y === "C") entry.orig = fields[++i];
    out.push(entry);
  }
  return out;
}

/** Splits status entries into the three sections the panel shows. */
export function sections(entries) {
  const conflicts = [], staged = [], unstaged = [];
  for (const e of entries) {
    const xy = e.x + e.y;
    if (CONFLICTS.has(xy)) { conflicts.push({ ...e, status: "U" }); continue; }
    if (xy === "??") { unstaged.push({ ...e, status: "A", untracked: true }); continue; }
    if (xy === "!!") continue;
    if (e.x !== " ") staged.push({ ...e, status: letter(e.x) });
    if (e.y !== " ") unstaged.push({ ...e, status: letter(e.y), orig: e.y === "R" ? e.orig : undefined });
  }
  const byPath = (a, b) => a.path.localeCompare(b.path);
  return { conflicts: conflicts.sort(byPath), staged: staged.sort(byPath), unstaged: unstaged.sort(byPath) };
}

function letter(c) {
  if (c === "A") return "A";
  if (c === "D") return "D";
  if (c === "R") return "R";
  if (c === "C") return "C";
  if (c === "T") return "M";
  return "M";
}

/** `git diff --numstat -z` into { [path]: { add, del, binary } }. Handles renames (-z: "a\td\t\0old\0new\0"). */
export function parseNumstat(z) {
  const fields = z.split("\0"), out = {};
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(f);
    if (!m) continue;
    let path = m[3];
    if (path === "") { i++; path = fields[++i]; } // rename: old, then new
    const old = out[path] ?? { add: 0, del: 0, binary: false };
    out[path] = { add: old.add + (Number(m[1]) || 0), del: old.del + (Number(m[2]) || 0), binary: old.binary || m[1] === "-" };
  }
  return out;
}

/** `git status --porcelain=v2 --branch` header lines into { branch, upstream, ahead, behind, oid }. */
export function parseBranchHeader(text) {
  const info = { branch: null, upstream: null, ahead: 0, behind: 0, oid: null };
  for (const line of text.split("\n")) {
    if (!line.startsWith("# branch.")) continue;
    const [key, ...rest] = line.slice(9).split(" ");
    const value = rest.join(" ");
    if (key === "head") info.branch = value === "(detached)" ? null : value;
    else if (key === "oid") info.oid = value === "(initial)" ? null : value;
    else if (key === "upstream") info.upstream = value;
    else if (key === "ab") {
      const m = /^\+(\d+) -(\d+)$/.exec(value);
      if (m) { info.ahead = Number(m[1]); info.behind = Number(m[2]); }
    }
  }
  return info;
}

export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s%x1f%b%x1e";

/** `git log --format=LOG_FORMAT` into commits. */
export function parseLog(text) {
  return text.split("\x1e").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
    const [hash, short, author, email, at, parents, subject, body] = r.split("\x1f");
    return { hash, short, author, email, date: Number(at) * 1000, parents: parents ? parents.split(" ") : [], subject: subject ?? "", body: (body ?? "").trim() };
  });
}

/** `git diff-tree --name-status -z -r -M` (or `diff --name-status -z`) into [{ status, path, orig? }]. */
export function parseNameStatus(z) {
  const fields = z.split("\0").filter((f, i, a) => !(f === "" && i === a.length - 1)), out = [];
  for (let i = 0; i < fields.length; i++) {
    const s = fields[i];
    if (!/^[ACDMRTUXB]\d*$/.test(s)) continue;
    const kind = s[0];
    if (kind === "R" || kind === "C") { out.push({ status: kind, orig: fields[i + 1], path: fields[i + 2] }); i += 2; }
    else { out.push({ status: kind === "T" ? "M" : kind, path: fields[i + 1] }); i += 1; }
  }
  return out;
}

export const REF_FORMAT = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(objectname:short)%00%(committerdate:unix)%00%(HEAD)%00%(worktreepath)";

/** `git for-each-ref --format=REF_FORMAT refs/heads refs/remotes` into branches. */
export function parseRefs(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [ref, short, upstream, oid, date, head, worktree] = line.split("\0");
    if (ref.endsWith("/HEAD")) continue;
    const remote = ref.startsWith("refs/remotes/");
    out.push({ ref, name: short, remote, upstream: upstream || null, oid, date: Number(date) * 1000, current: head === "*", worktree: worktree || null });
  }
  return out;
}

/** For a remote branch "origin/feat/x": the local name "feat/x" and the remote "origin". */
export function splitRemote(name, remotes) {
  const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => name.startsWith(r + "/"));
  return remote ? { remote, local: name.slice(remote.length + 1) } : null;
}

/** Filters and orders branches for the selector: current first, then local, then remote; by recency. */
export function filterBranches(list, query) {
  const q = query.trim().toLowerCase();
  return list.filter((b) => !q || b.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || b.date - a.date);
}

/**
 * Why "Undo Last Commit" is refused, or null when allowed.
 * state: { detached, parents (of HEAD), operation (merge/rebase/... in progress), onRemote (HEAD contained in remote refs) }
 */
export function undoCommitRefusal({ detached, parents, operation, onRemote, hasHead }) {
  if (!hasHead) return "There is no commit to undo.";
  if (detached) return "HEAD is detached; check out a branch first.";
  if (operation) return `A ${operation} is in progress; finish or abort it first.`;
  if (!parents || parents.length === 0) return "The first commit of a repository can't be undone here.";
  if (parents.length > 1) return "The last commit is a merge; undo it in a shell.";
  if (onRemote) return "The last commit is already on a remote branch; use git revert in a shell.";
  return null;
}

/** Which operation is in progress, from the git dir entries that exist. */
export function operationFrom(existing) {
  if (existing.includes("MERGE_HEAD")) return "merge";
  if (existing.includes("rebase-merge") || existing.includes("rebase-apply")) return "rebase";
  if (existing.includes("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (existing.includes("REVERT_HEAD")) return "revert";
  if (existing.includes("BISECT_LOG")) return "bisect";
  return null;
}

/**
 * Shell script that snapshots the whole working tree (tracked + untracked, not ignored)
 * into a commit under refs/herdr/snapshots without touching the real index. Prints the commit.
 */
export const SNAPSHOT_SCRIPT = [
  "set -e",
  // Snapshot commits are never shared: give them an identity so repos without user.email work.
  "export GIT_AUTHOR_NAME=mira GIT_AUTHOR_EMAIL=mira@localhost GIT_COMMITTER_NAME=mira GIT_COMMITTER_EMAIL=mira@localhost",
  'idx=$(mktemp "${TMPDIR:-/tmp}/mira-snapshot.XXXXXX")',
  'trap \'rm -f "$idx"\' EXIT',
  'real=$(git rev-parse --git-path index)',
  'if [ -f "$real" ]; then cp "$real" "$idx"; else rm -f "$idx"; fi',
  'GIT_INDEX_FILE="$idx" git add -A',
  'tree=$(GIT_INDEX_FILE="$idx" git write-tree)',
  'if head=$(git rev-parse -q --verify HEAD); then c=$(git commit-tree "$tree" -p "$head" -m "mira snapshot"); else c=$(git commit-tree "$tree" -m "mira snapshot"); fi',
  'git update-ref "refs/herdr/snapshots/$(date +%s)-$$" "$c"',
  'printf %s "$c"',
].join("\n");

/** Args for exec: run the snapshot script in a repo. */
export const snapshotArgs = () => ["-c", SNAPSHOT_SCRIPT, "mira-snapshot"];

/**
 * The commands that discard the given unstaged entries. Tracked files go back to the index;
 * untracked ones are deleted. Returns arrays of git args.
 */
export function discardCommands(entries) {
  const tracked = entries.filter((e) => !e.untracked).map((e) => e.path);
  const untracked = entries.filter((e) => e.untracked).map((e) => e.path);
  const cmds = [];
  if (tracked.length) cmds.push(["restore", "--worktree", "--", ...tracked]);
  if (untracked.length) cmds.push(["clean", "-f", "-q", "--", ...untracked]);
  return cmds;
}

/** Args that put the given paths back as they were in a snapshot commit. */
export const restoreArgs = (snapshot, paths) => ["restore", `--source=${snapshot}`, "--worktree", "--", ...paths];

/** Paths a commit touches, filtered to those under `prefix` (repo-relative folder, "" for all). */
export const underPrefix = (files, prefix) => !prefix ? files : files.filter((f) => f.path.startsWith(prefix) || f.orig?.startsWith(prefix));

/** The first line of git's error output that says something. */
export function gitError(r) {
  const text = (r.stderr || r.stdout || "").trim();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):/.test(l))?.replace(/^(fatal|error):\s*/, "") ?? lines[0] ?? `git exited with ${r.code}`;
}

export const timeAgo = (ms, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
};
