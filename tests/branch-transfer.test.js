import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { transferBranch } from "../mods/mira-branches/transfer.js";

test("moves a clean branch and refuses dirty worktrees", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mira-branch-")), root = join(dir, "repo"), worktree = join(dir, "other");
  const git = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const exec = async (cmd, args, { cwd }) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  try {
    git(dir, "init", "-b", "main", root);
    git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "file"), "initial\n"); git(root, "add", "file"); git(root, "commit", "-m", "initial");
    git(root, "worktree", "add", "-b", "feature/test", worktree);
    writeFileSync(join(worktree, "new"), "pending");
    const args = { root, worktree, branch: "feature/test" };
    assert.match((await transferBranch(exec, args)).error, /uncommitted or untracked/);
    assert.equal(git(worktree, "branch", "--show-current"), "feature/test");
    rmSync(join(worktree, "new"));
    assert.equal((await transferBranch(exec, args)).ok, true);
    assert.equal(git(root, "branch", "--show-current"), "feature/test");
    assert.equal(git(worktree, "branch", "--show-current"), "");
    git(root, "switch", "main"); git(worktree, "switch", "feature/test");
    const failSwitch = async (cmd, argv, opts) => opts.cwd === root && argv[0] === "switch"
      ? { code: 1, stdout: "", stderr: "simulated failure" } : exec(cmd, argv, opts);
    assert.match((await transferBranch(failSwitch, args)).error, /branch was restored/);
    assert.equal(git(worktree, "branch", "--show-current"), "feature/test");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
