// Move a branch only when both checkouts are clean. Never force a checkout.
export async function transferBranch(exec, { root, worktree, branch, on }) {
  const git = (cwd, args) => exec("git", args, { cwd, on });
  const detail = (r) => (r.stderr || r.stdout || "Git command failed.").trim();
  for (const [path, label] of [[root, "Current worktree"], [worktree, "Other worktree"]]) {
    const status = await git(path, ["status", "--porcelain", "--untracked-files=normal"]);
    if (status.code !== 0) return { error: `${label}: ${detail(status)}` };
    if (status.stdout.trim()) return { error: `${label} has uncommitted or untracked changes. Commit, stash, or remove them before moving the branch.` };
  }
  const current = await git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current.code !== 0 || current.stdout.trim() !== branch) return { error: "The other worktree no longer has this branch checked out. Close and reopen the selector." };
  const head = await git(worktree, ["rev-parse", "HEAD"]);
  if (head.code !== 0) return { error: detail(head) };
  const detached = await git(worktree, ["switch", "--detach"]);
  if (detached.code !== 0) return { error: `Could not release the branch: ${detail(detached)}` };
  const switched = await git(root, ["switch", branch]);
  if (switched.code === 0) return { ok: true };
  // Restore only if nobody moved HEAD or changed files in the other worktree meanwhile.
  const [now, symbolic, status] = await Promise.all([
    git(worktree, ["rev-parse", "HEAD"]), git(worktree, ["symbolic-ref", "--quiet", "HEAD"]),
    git(worktree, ["status", "--porcelain", "--untracked-files=normal"]),
  ]);
  let restored = false;
  if (now.code === 0 && now.stdout.trim() === head.stdout.trim() && symbolic.code === 1 && status.code === 0 && !status.stdout.trim()) {
    restored = (await git(worktree, ["switch", branch])).code === 0;
  }
  return { error: `Could not switch the current worktree: ${detail(switched)}. ${restored ? "The branch was restored in the other worktree." : `The other worktree was left detached; check ${worktree} before continuing.`}` };
}
