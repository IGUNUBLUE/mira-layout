import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../mods/mira-changes/git.js";
import { parseFileDiff, hunkPatch, applyScript } from "../mods/mira-changes/hunk.js";
import { sideBySide, intraLine } from "../mods/mira-changes/sbs.js";
import { diffPathspec, capDiff, requestBody, cleanMessage } from "../mods/mira-changes/prompt.js";
import { parseResponseStream } from "../mods/mira-changes/sse.js";

test("parseStatus and sections: staged, unstaged, untracked, renames, conflicts, odd names", () => {
  const z = ["M  staged.txt", " M work.txt", "MM both.txt", "?? new file.txt", "R  new.js", "old.js", "UU clash.txt", "AA added-both.txt", " D gone.txt", "A  tab\there.txt", ""].join("\x00");
  const s = git.sections(git.parseStatus(z));
  assert.deepEqual(s.conflicts.map((e) => e.path), ["added-both.txt", "clash.txt"]);
  assert.deepEqual(s.staged.map((e) => [e.path, e.status]), [["both.txt", "M"], ["new.js", "R"], ["staged.txt", "M"], ["tab\there.txt", "A"]]);
  assert.equal(s.staged.find((e) => e.path === "new.js").orig, "old.js");
  assert.deepEqual(s.unstaged.map((e) => [e.path, e.status, Boolean(e.untracked)]), [["both.txt", "M", false], ["gone.txt", "D", false], ["new file.txt", "A", true], ["work.txt", "M", false]]);
});

test("parseNumstat handles renames and binaries", () => {
  const z = ["3\t1\ta.txt", "-\t-\timg.png", "2\t0\t", "old.js", "new.js", ""].join("\x00");
  assert.deepEqual(git.parseNumstat(z), { "a.txt": { add: 3, del: 1, binary: false }, "img.png": { add: 0, del: 0, binary: true }, "new.js": { add: 2, del: 0, binary: false } });
});

test("parseBranchHeader", () => {
  const info = git.parseBranchHeader("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... x");
  assert.deepEqual(info, { branch: "main", upstream: "origin/main", ahead: 2, behind: 1, oid: "abc" });
  assert.equal(git.parseBranchHeader("# branch.oid (initial)\n# branch.head (detached)").branch, null);
});

test("parseLog, parseNameStatus, parseRefs", () => {
  const log = git.parseLog("h1\x1fs1\x1fAda\x1fa@x\x1f100\x1fp1\x1ffeat: one\x1fbody\n\x1e\nh2\x1fs2\x1fBob\x1fb@x\x1f50\x1f\x1finit\x1f\x1e");
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], { hash: "h1", short: "s1", author: "Ada", email: "a@x", date: 100000, parents: ["p1"], subject: "feat: one", body: "body" });
  assert.deepEqual(log[1].parents, []);
  const ns = git.parseNameStatus(["M", "a.txt", "R100", "old", "new", "A", "b c.txt", ""].join("\x00"));
  assert.deepEqual(ns, [{ status: "M", path: "a.txt" }, { status: "R", orig: "old", path: "new" }, { status: "A", path: "b c.txt" }]);
  const refs = git.parseRefs(["refs/heads/main\x00main\x00origin/main\x00abc\x00100\x00*\x00", "refs/remotes/origin/HEAD\x00origin\x00\x00abc\x00100\x00 \x00", "refs/remotes/origin/feat/x\x00origin/feat/x\x00\x00def\x00200\x00 \x00"].join("\n"));
  assert.deepEqual(refs.map((r) => [r.name, r.remote, r.current]), [["main", false, true], ["origin/feat/x", true, false]]);
  assert.deepEqual(git.splitRemote("origin/feat/x", ["origin", "up"]), { remote: "origin", local: "feat/x" });
  assert.deepEqual(git.filterBranches(refs, "feat").map((r) => r.name), ["origin/feat/x"]);
});

test("undoCommitRefusal rules", () => {
  const ok = { hasHead: true, detached: false, parents: ["p"], operation: null, onRemote: false };
  assert.equal(git.undoCommitRefusal(ok), null);
  assert.match(git.undoCommitRefusal({ ...ok, detached: true }), /detached/);
  assert.match(git.undoCommitRefusal({ ...ok, parents: [] }), /first commit/);
  assert.match(git.undoCommitRefusal({ ...ok, operation: "rebase" }), /rebase/);
  assert.match(git.undoCommitRefusal({ ...ok, onRemote: true }), /remote/);
  assert.match(git.undoCommitRefusal({ ...ok, parents: ["a", "b"] }), /merge/);
  assert.equal(git.operationFrom(["HEAD", "MERGE_HEAD"]), "merge");
});

test("gitError picks the line that matters", () => {
  assert.equal(git.gitError({ code: 1, stderr: "hint: x\nerror: failed to push some refs\n" }), "failed to push some refs");
  assert.equal(git.gitError({ code: 128, stderr: "", stdout: "" }), "git exited with 128");
});

test("intraLine marks changed words only", () => {
  const { left, right } = intraLine("const a = 1;", "const b = 1;");
  assert.deepEqual(left.filter((s) => s.changed).map((s) => s.text), ["a"]);
  assert.deepEqual(right.filter((s) => s.changed).map((s) => s.text), ["b"]);
});

const DIFF = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -8,2 +8,3 @@ ctx
 eight
+eight and a half
 nine
`;

test("parseFileDiff and sideBySide pair removed/added lines", () => {
  const d = parseFileDiff(DIFF);
  assert.equal(d.hunks.length, 2);
  assert.equal(d.header[0], "diff --git a/f.txt b/f.txt");
  const rows = sideBySide(d.hunks);
  assert.deepEqual(rows[0], { hunk: 0, header: "@@ -1,3 +1,3 @@", add: 1, del: 1 });
  const changed = rows.find((r) => r.left?.kind === "-");
  assert.equal(changed.left.number, 2);
  assert.equal(changed.right.number, 2);
  assert.equal(changed.right.text, "TWO");
  const added = rows.find((r) => r.right?.text === "eight and a half");
  assert.equal(added.left, null);
  assert.equal(added.right.number, 9);
  assert.match(hunkPatch(d, 1), /^diff --git[\s\S]*\+\+\+ b\/f.txt\n@@ -8,2 \+8,3 @@ ctx\n eight\n\+eight and a half\n nine\n$/);
});

test("prompt: pathspec drops lockfiles and huge files; cap; body; clean", () => {
  const spec = diffPathspec({ "big.sql": { add: 3000, del: 0 }, "a.js": { add: 1, del: 1 } });
  assert.ok(spec.includes(":(exclude,glob)**/package-lock.json"));
  assert.ok(spec.includes(":(exclude,literal)big.sql"));
  assert.ok(!spec.some((s) => s.includes("a.js")));
  const capped = capDiff("line\n".repeat(5000), 100);
  assert.ok(capped.length < 130 && capped.endsWith("(diff truncated)\n"));
  const body = requestBody({ model: "m", stat: " a | 1 +", diff: "d", recent: ["feat: x"] });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.match(body.input[0].content[0].text, /feat: x/);
  assert.equal(cleanMessage("```\nfeat: x\n```"), "feat: x");
  assert.equal(cleanMessage('"fix: y"'), "fix: y");
});

const sse = (...events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("parseResponseStream: completed, deltas, failures, interrupted", () => {
  const done = sse({ type: "response.output_text.delta", delta: "feat: " }, { type: "response.output_text.delta", delta: "x" },
    { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "feat: x" }] }] } });
  assert.deepEqual(parseResponseStream(done), { ok: true, text: "feat: x" });
  const onlyDeltas = sse({ type: "response.output_text.delta", delta: "fix: y" }, { type: "response.completed", response: { status: "completed", output: [] } });
  assert.deepEqual(parseResponseStream(onlyDeltas), { ok: true, text: "fix: y" });
  const quota = sse({ type: "response.output_text.delta", delta: "f" }, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } });
  const r = parseResponseStream(quota);
  assert.equal(r.ok, false);
  assert.equal(r.code, "subscription_sharing_usage_limit_exceeded");
  assert.match(r.message, /usage limit/);
  assert.equal(parseResponseStream(sse({ type: "response.output_text.delta", delta: "f" })).code, "interrupted");
  assert.equal(parseResponseStream("data: {nope\n\n").code, "invalid_event");
});

// Integration: the shell snippets the panel runs, against a real temporary repository.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "mira-test-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  run("init", "-q", "-b", "main");
  return { dir, run, sh: (script, ...args) => execFileSync("sh", ["-c", script, "sh", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }) };
}

test("snapshot, discard and restore round-trip without touching the index", () => {
  const { dir, run } = repo();
  try {
    writeFileSync(join(dir, "kept.txt"), "v1\n");
    run("add", "."); run("commit", "-qm", "init");
    writeFileSync(join(dir, "kept.txt"), "v2\n");
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    writeFileSync(join(dir, "staged.txt"), "s\n"); run("add", "staged.txt");
    const before = run("diff", "--cached", "--name-only");
    // No identity in the environment, and none in the repo: the snapshot brings its own.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const snap = execFileSync("sh", git.snapshotArgs(), { cwd: dir, encoding: "utf8", env: { ...env, HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
    assert.match(snap, /^[0-9a-f]{40}$/);
    assert.equal(run("diff", "--cached", "--name-only"), before, "index untouched");
    assert.ok(run("for-each-ref", "refs/herdr/snapshots").includes(snap));
    const entries = git.sections(git.parseStatus(run("status", "--porcelain=v1", "-z", "--untracked-files=all"))).unstaged;
    for (const args of git.discardCommands(entries)) run(...args);
    assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "v1\n");
    assert.ok(!existsSync(join(dir, "new.txt")));
    run(...git.restoreArgs(snap, entries.map((e) => e.path)));
    assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "v2\n");
    assert.equal(readFileSync(join(dir, "new.txt"), "utf8"), "fresh\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("single-hunk stage, unstage and discard apply cleanly", () => {
  const { dir, run, sh } = repo();
  try {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, "f.txt"), lines.join("\n") + "\n");
    run("add", "."); run("commit", "-qm", "init");
    const edited = [...lines]; edited[1] = "LINE 2"; edited[17] = "LINE 18";
    writeFileSync(join(dir, "f.txt"), edited.join("\n") + "\n");
    let d = parseFileDiff(run("diff", "--no-color", "--", "f.txt"));
    assert.equal(d.hunks.length, 2);
    sh(applyScript("stage"), hunkPatch(d, 1));
    assert.match(run("diff", "--cached", "--no-color"), /\+LINE 18/);
    assert.doesNotMatch(run("diff", "--cached", "--no-color"), /LINE 2\b/);
    const staged = parseFileDiff(run("diff", "--cached", "--no-color", "--", "f.txt"));
    sh(applyScript("unstage"), hunkPatch(staged, 0));
    assert.equal(run("diff", "--cached", "--name-only"), "");
    d = parseFileDiff(run("diff", "--no-color", "--", "f.txt"));
    sh(applyScript("discard"), hunkPatch(d, 0));
    const now = readFileSync(join(dir, "f.txt"), "utf8");
    assert.match(now, /^line 2$/m);
    assert.match(now, /^LINE 18$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("diffPathspec really leaves lockfiles out of git diff", () => {
  const { dir, run } = repo();
  try {
    writeFileSync(join(dir, "a.js"), "1\n");
    run("add", "."); run("commit", "-qm", "init");
    writeFileSync(join(dir, "a.js"), "2\n");
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
    execFileSync("mkdir", ["-p", join(dir, "web")]);
    writeFileSync(join(dir, "web", "yarn.lock"), "x\n");
    run("add", ".");
    const names = run("diff", "--cached", "--name-only", ...diffPathspec({}));
    assert.equal(names.trim(), "a.js");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
