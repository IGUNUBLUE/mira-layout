// The Changes panel: source control for the focused terminal's repository.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { exec, watchFolder, theme, run, panes, focused, shared, openOverlay, nextCommand } from "herdr";
import * as G from "./git.js";
import { diffPathspec, requestBody, cleanMessage } from "./prompt.js";
import { parseResponseStream, describe } from "./sse.js";
import { location, locationKey, git, gitResult, sh, network, touched, tick, iconButton, textButton, statusColor, splitPath, anchorPane, ICON, SIWC, GitFailure } from "./ui.js";

const ROW = 26;
const RESPONSES = "https://api.openai.com/v1/responses";

export class Panel {
  init(cx) {
    this.state = { conflicts: [], staged: [], unstaged: [] };
    this.stats = { staged: {}, unstaged: {} };
    this.info = { branch: null, upstream: null, ahead: 0, behind: 0, oid: null };
    this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
    this.historyHeight = Number(localStorage.getItem("historyHeight") ?? 220);
    this.log = []; this.expanded = null; this.commitFiles = {};
    this.hover = null; this.busy = null; this.note = null; this.undo = null; this.confirm = null;
    this.menu = null; this.account = null; this.accountOpen = false; this.models = null;
    this.handle = cx.focus_handle(); this.confirmHandle = cx.focus_handle();
    this.input = TextareaState.new({ placeholder: "Message (Ctrl+Enter to commit)", rows: 1 });
    this.input.set_auto_grow(1, 8);
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message?.trim());
      this.message = this.input.value();
      if (this.generating && !this.generating.writing) this.generating = null; // typing wins over a pending ✦
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (e, cx) => { if (e.secondary) this.commit(cx); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.message = "";
    this.seenTick = tick()?.at ?? 0;
    this.seenFocus = shared("mira-changes.focus") ?? 0;
    this.refresh(cx);
    this.refreshAccount(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // keys.json: "mira-changes.<command>" (only while the panel shows).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const commands = {
          commit: () => this.commit(cx), generate: () => this.generate(cx), refresh: () => this.refresh(cx),
          "stage-all": () => this.stage(cx, [...this.state.conflicts, ...this.state.unstaged], "section-unstaged"),
          "unstage-all": () => this.unstage(cx, this.state.staged, "section-staged"),
          push: () => this.push(cx), pull: () => this.pull(cx), branches: () => this.openBranches(),
          "discard-all": () => this.askDiscard(cx, this.state.unstaged, "section-unstaged"),
          "undo-commit": () => this.askUndoCommit(cx), "undo-discard": () => this.askUndoDiscard(cx), focus: () => this.input.focus(),
        };
        commands[c]?.();
        cx.notify();
      }
    });
  }

  // ---------- data ----------

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  reset() {
    this.root = null; this.state = { conflicts: [], staged: [], unstaged: [] }; this.stats = { staged: {}, unstaged: {} };
    this.info = { branch: null, upstream: null, ahead: 0, behind: 0, oid: null };
    this.log = []; this.expanded = null; this.commitFiles = {}; this.note = null; this.undo = null; this.confirm = null; this.menu = null;
    this.error = null; this.watched = null; this.message = ""; this.input.set_value("");
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = locationKey();
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!cwd) { cx.notify(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await gitResult(cwd, on, ["rev-parse", "--show-toplevel"]);
        if (locationKey() !== context) return;
        if (top.code !== 0) { this.reset(); this.error = "not-a-repo"; this.folder = cwd; this.on = on; return; }
        const root = top.stdout.trim();
        const [status, header, unstaged, staged] = await Promise.all([
          git(root, on, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { read: true }),
          git(root, on, ["status", "--porcelain=v2", "--branch", "--untracked-files=no", "--ignore-submodules=all"], { read: true }),
          git(root, on, ["diff", "--numstat", "-z"], { read: true }),
          git(root, on, ["diff", "--cached", "--numstat", "-z", "-M"], { read: true }),
        ]);
        if (locationKey() !== context) return;
        const entries = G.parseStatus(status);
        this.root = root; this.on = on; this.error = null;
        this.state = G.sections(entries.slice(0, 2000));
        this.limited = entries.length > 2000;
        this.stats = { unstaged: G.parseNumstat(unstaged), staged: G.parseNumstat(staged) };
        this.info = G.parseBranchHeader(header);
        this.watch(root, cx);
        if (!this.collapsed.has("history")) await this.loadLog(cx);
      } catch (e) { if (locationKey() === context) this.error = e.message; }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  async loadLog() {
    if (!this.root || !this.info.oid) { this.log = []; return; }
    const out = await git(this.root, this.on, ["log", "-n", "80", `--format=${G.LOG_FORMAT}`], { read: true });
    this.log = G.parseLog(out);
  }

  refreshAccount(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("node", [SIWC(), "status"]).catch((e) => ({ code: 1, stderr: String(e) }));
      try { this.account = r.code === 0 ? JSON.parse(r.stdout) : { signedIn: false, error: (r.stderr || "").trim() }; }
      catch { this.account = { signedIn: false }; }
      cx.notify();
    });
  }

  // ---------- actions ----------

  /** Runs one git action with a spinner on `key`, then refreshes everything. */
  act(cx, key, label, fn, { quiet = false } = {}) {
    if (this.busy || !this.root) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = { key, label }; if (!quiet) this.note = null;
    cx.spawn(async (cx) => {
      try {
        const result = await fn(root, on);
        if (this.context === context && typeof result === "string") this.note = { level: "info", text: result };
      } catch (e) {
        if (this.context === context) this.note = { level: "error", text: `${label} failed: ${e.message}`, detail: e.output, command: e.args ? `git ${e.args.join(" ")}` : null };
      } finally {
        this.busy = null; touched(root); this.refresh(cx); cx.notify();
      }
    });
    cx.notify();
  }

  stage(cx, entries, key) {
    const paths = entries.flatMap((e) => (e.orig && e.status === "R" ? [e.orig, e.path] : [e.path]));
    this.act(cx, key, "Stage", (root, on) => git(root, on, ["add", "-A", "--", ...paths]), { quiet: true });
  }

  unstage(cx, entries, key) {
    const paths = entries.flatMap((e) => (e.orig ? [e.orig, e.path] : [e.path]));
    this.act(cx, key, "Unstage", (root, on) => this.info.oid ? git(root, on, ["restore", "--staged", "--", ...paths]) : git(root, on, ["rm", "--cached", "-r", "-q", "--", ...paths]), { quiet: true });
  }

  /** Discard asks first, snapshots the working tree, then offers Undo. */
  askDiscard(cx, entries, key) {
    if (!entries.length) return;
    const fresh = entries.filter((e) => e.untracked).length;
    this.ask(cx, {
      title: entries.length === 1 ? `Discard changes in ${splitPath(entries[0].path).name}?` : `Discard ${entries.length} changes?`,
      detail: fresh ? `${fresh} new (untracked) ${fresh === 1 ? "file is" : "files are"} deleted. You can undo this right after.` : "Your edits go back to the last staged or committed version. You can undo this right after.",
      files: entries.map((e) => e.path),
      action: "Discard", danger: true,
      run: (cx) => this.act(cx, key, "Discard", async (root, on) => {
        const snapshot = (await sh(root, on, G.SNAPSHOT_SCRIPT)).trim();
        for (const args of G.discardCommands(entries)) await git(root, on, args);
        this.undo = { root, snapshot, paths: entries.map((e) => e.path), label: entries.length === 1 ? splitPath(entries[0].path).name : `${entries.length} files` };
      }),
    });
  }

  askUndoDiscard(cx) {
    const u = this.undo;
    if (!u) return;
    this.ask(cx, {
      title: "Restore the discarded changes?",
      detail: "These files go back to how they were before Discard. Edits made to them since then are replaced.",
      files: u.paths, action: "Restore",
      run: (cx) => this.act(cx, "undo", "Restore", async (root, on) => {
        await git(root, on, G.restoreArgs(u.snapshot, u.paths));
        this.undo = null;
        return `Restored ${u.label}.`;
      }),
    });
  }

  canCommit() {
    return Boolean(this.root && this.message.trim() && !this.busy && !this.state.conflicts.length && (this.state.staged.length || this.state.unstaged.length));
  }

  commit(cx) {
    if (!this.canCommit()) return;
    const message = this.message.trim(), all = !this.state.staged.length;
    this.act(cx, "commit", "Commit", async (root, on) => {
      if (all) await git(root, on, ["add", "-A"]);
      try { await git(root, on, ["commit", "-m", message]); }
      catch (e) { if (all) await gitResult(root, on, this.info.oid ? ["reset", "-q"] : ["rm", "--cached", "-r", "-q", "."]); throw e; }
      this.message = ""; this.input.set_value(""); this.undo = null;
    });
  }

  pull(cx) {
    if (!this.info.upstream) { this.note = { level: "error", text: "This branch has no tracking branch to pull from. Push it first." }; cx.notify(); return; }
    this.act(cx, "pull", "Pull", async (root, on) => {
      const r = await network(root, on, ["pull", "--ff-only"]);
      if (r.code !== 0) throw new GitFailure(r, ["pull", "--ff-only"]);
      return "Pulled.";
    });
  }

  push(cx) {
    if (!this.info.branch) { this.note = { level: "error", text: "HEAD is detached: check out a branch to push." }; cx.notify(); return; }
    if (this.info.upstream) {
      this.act(cx, "push", "Push", async (root, on) => {
        const r = await network(root, on, ["push"]);
        if (r.code !== 0) throw new GitFailure(r, ["push"]);
        return "Pushed.";
      });
      return;
    }
    // Publish: choose the remote explicitly.
    const root = this.root, on = this.on, branch = this.info.branch;
    cx.spawn(async (cx) => {
      const remotes = (await git(root, on, ["remote"]).catch(() => "")).split("\n").filter(Boolean);
      if (!remotes.length) { this.note = { level: "error", text: "This repository has no remote. Add one with git remote add." }; cx.notify(); return; }
      this.ask(cx, {
        title: `Publish branch ${branch}`,
        detail: "Pushes the branch and sets it to track the remote one.",
        choices: remotes, choice: remotes.includes("origin") ? "origin" : remotes[0], action: "Publish",
        run: (cx, remote) => this.act(cx, "push", "Publish", async (root, on) => {
          const r = await network(root, on, ["push", "-u", remote, branch]);
          if (r.code !== 0) throw new GitFailure(r, ["push", "-u", remote, branch]);
          return `Published ${branch} to ${remote}.`;
        }),
      });
    });
  }

  openBranches() {
    if (!this.root) return;
    openOverlay({ mod: "mira-branches", kind: "popup", width: 360, height: 420, props: { root: this.root, on: this.on } });
  }

  // ---------- commit message ✦ ----------

  generate(cx) {
    if (this.generating) { // cancel: the old text comes back
      const prev = this.generating.prev;
      this.generating = null; this.input.set_value(prev); this.message = prev; cx.notify();
      return;
    }
    if (!this.root) return;
    const root = this.root, on = this.on, staged = this.state.staged.length > 0, hasHead = Boolean(this.info.oid);
    const job = { prev: this.message, writing: false };
    this.generating = job; this.note = null;
    cx.spawn(async (cx) => {
      const alive = () => this.generating === job;
      try {
        const token = await exec("node", [SIWC(), "token"]);
        if (token.code === 3 || token.code === 4) { this.signInNote(token.code === 4); return; }
        if (token.code !== 0) throw new Error((token.stderr || "Cannot read the ChatGPT session").trim());
        const model = await this.model();
        const base = staged ? ["--cached"] : hasHead ? ["HEAD"] : ["--cached"];
        const numstat = G.parseNumstat(await git(root, on, ["diff", ...base, "--numstat", "-z", "-M"], { read: true }));
        let stat = await git(root, on, ["diff", ...base, "--stat=100", "-M"], { read: true });
        const diff = await git(root, on, ["diff", ...base, "--no-color", "--no-ext-diff", "-M", ...diffPathspec(numstat)], { read: true });
        if (!staged) {
          const untracked = this.state.unstaged.filter((e) => e.untracked).map((e) => e.path);
          if (untracked.length) stat += `\nNew files:\n${untracked.slice(0, 100).map((p) => ` ${p}`).join("\n")}\n`;
        }
        if (!stat.trim() && !diff.trim()) throw new Error("There is nothing to describe.");
        const recent = hasHead ? (await git(root, on, ["log", "-n", "8", "--format=%s"], { read: true }).catch(() => "")).split("\n").filter(Boolean) : [];
        if (!alive()) return;
        const response = await fetch(RESPONSES, {
          method: "POST",
          headers: { Authorization: `Bearer ${token.stdout.trim()}`, "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(requestBody({ model, stat, diff, recent })),
        });
        const text = await response.text();
        if (!alive()) return;
        if (!response.ok) {
          let code; try { code = JSON.parse(text)?.error?.code; } catch {}
          if (response.status === 401) { this.signInNote(true); return; }
          throw new Error(describe(code, response.status));
        }
        const result = parseResponseStream(text);
        if (!result.ok) throw new Error(result.message);
        const message = cleanMessage(result.text);
        if (!message) throw new Error("The model returned an empty message.");
        job.writing = true; this.input.set_value(message); this.message = message; job.writing = false;
      } catch (e) {
        if (alive()) this.note = { level: "error", text: `Commit message: ${e.message}` };
      } finally {
        if (alive()) this.generating = null;
        cx.notify();
      }
    });
    cx.notify();
  }

  async model() {
    const status = JSON.parse((await exec("node", [SIWC(), "status"])).stdout || "{}");
    if (status.model) return status.model;
    const r = await exec("node", [SIWC(), "models"]);
    if (r.code !== 0) throw new Error((r.stderr || "Cannot list your plan's models").trim());
    const list = JSON.parse(r.stdout);
    if (!list.length) throw new Error("Your ChatGPT plan lists no models for apps.");
    await exec("node", [SIWC(), "model", list[0].slug]);
    if (this.account) this.account.model = list[0].slug;
    return list[0].slug;
  }

  signInNote(expired) {
    this.note = { level: "info", text: expired ? "Your ChatGPT session expired. Sign in again to write commit messages." : "Sign in with ChatGPT to write commit messages with your plan.", signIn: true };
  }

  signIn() {
    const pane = anchorPane();
    run("pane.split", { direction: "down", ...(pane ? { pane } : {}), argv: ["sh", "-c", `node "$1" login; printf '\\nPress Enter to close. '; read _`, "sh", SIWC()] });
  }

  loadModels(cx) {
    this.models = "loading";
    cx.spawn(async (cx) => {
      const r = await exec("node", [SIWC(), "models"]);
      try { this.models = r.code === 0 ? JSON.parse(r.stdout) : { error: (r.stderr || "").trim() }; } catch { this.models = { error: "Cannot read the model list." }; }
      cx.notify();
    });
  }

  setModel(cx, slug) {
    cx.spawn(async (cx) => { await exec("node", [SIWC(), "model", slug]); this.refreshAccount(cx); });
    if (this.account) this.account.model = slug;
    cx.notify();
  }

  askSignOut(cx) {
    this.ask(cx, {
      title: "Sign out of ChatGPT?",
      detail: "Commit messages need you to sign in again. The app stays registered with your account.",
      action: "Sign out",
      run: (cx) => cx.spawn(async (cx) => { await exec("node", [SIWC(), "logout"]); this.accountOpen = false; this.refreshAccount(cx); }),
    });
  }

  // ---------- history ----------

  toggleCommit(cx, c) {
    if (this.expanded === c.hash) { this.expanded = null; cx.notify(); return; }
    this.expanded = c.hash;
    if (!this.commitFiles[c.hash]) {
      const root = this.root, on = this.on;
      cx.spawn(async (cx) => {
        try {
          const out = c.parents.length
            ? await git(root, on, ["diff", "--name-status", "-z", "-M", `${c.hash}^1`, c.hash], { read: true })
            : await git(root, on, ["diff-tree", "--root", "--no-commit-id", "-r", "-z", "-M", "--name-status", c.hash], { read: true });
          this.commitFiles[c.hash] = G.parseNameStatus(out);
        } catch (e) { this.commitFiles[c.hash] = { error: e.message }; }
        cx.notify();
      });
    }
    cx.notify();
  }

  askUndoCommit(cx) {
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      let refusal;
      try {
        const head = this.log[0];
        const ops = await sh(root, on, 'g=$(git rev-parse --absolute-git-dir); for f in MERGE_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do [ -e "$g/$f" ] && echo "$f"; done; true');
        const remote = await git(root, on, ["branch", "-r", "--contains", "HEAD"], { read: true }).catch(() => "");
        refusal = G.undoCommitRefusal({ hasHead: Boolean(this.info.oid && head), detached: !this.info.branch, parents: head?.parents, operation: G.operationFrom(ops.split("\n")), onRemote: Boolean(remote.trim()) });
        if (refusal) { this.note = { level: "error", text: `Undo Last Commit: ${refusal}` }; cx.notify(); return; }
        this.ask(cx, {
          title: "Undo the last commit?",
          detail: `“${head.subject}” is removed from ${this.info.branch}. Its changes stay staged and your files aren't touched (git reset --soft). Git's reflog keeps the old commit.`,
          action: "Undo commit",
          run: (cx) => this.act(cx, "undo-commit", "Undo Last Commit", async (root, on) => {
            await git(root, on, ["reset", "--soft", "HEAD~1"]);
            if (!this.message.trim()) { const text = head.body ? `${head.subject}\n\n${head.body}` : head.subject; this.input.set_value(text); this.message = text; }
            return `Undid “${head.subject}”.`;
          }),
        });
      } catch (e) { this.note = { level: "error", text: `Undo Last Commit: ${e.message}` }; cx.notify(); }
    });
  }

  // ---------- opening diffs and files ----------

  openDiff(entry, mode, list, extra = {}) {
    const spec = {
      root: this.root, on: this.on, path: entry.path, orig: entry.orig ?? null, untracked: Boolean(entry.untracked), mode,
      list: list.map((e) => ({ path: e.path, orig: e.orig ?? null, untracked: Boolean(e.untracked) })), ...extra,
    };
    const tab = focused()?.tab;
    for (const p of panes()) if (p.tab === tab && p.mod === "mira-changes") run("pane.close", { pane: p.pane });
    const pane = anchorPane();
    run("pane.split", { direction: "right", ...(pane ? { pane } : {}), mod: "mira-changes", props: { diff: spec } });
  }

  openFile(path) {
    const pane = anchorPane();
    run("pane.split", { direction: "right", ...(pane ? { pane } : {}), mod: "mira-files", props: { file: path, root: this.root, on: this.on } });
  }

  // ---------- confirm ----------

  ask(cx, spec) { this.confirm = { ...spec, selected: 0 }; this.confirmHandle.focus(); cx.notify(); }
  answer(cx, yes) {
    const c = this.confirm; this.confirm = null;
    if (yes && c) c.run(cx, c.choice);
    this.handle.focus(); cx.notify();
  }

  // ---------- render ----------

  render(cx) {
    if (locationKey() !== this.context) this.refresh(cx);
    const t = tick();
    if (t && t.at > this.seenTick) { this.seenTick = t.at; if (t.root === this.root) this.refresh(cx); }
    const f = shared("mira-changes.focus") ?? 0;
    if (f > this.seenFocus) { this.seenFocus = f; cx.spawn(async () => this.input.focus()); }
    const th = theme();
    return v_flex().id("mira-changes").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(th.background).border_1().border_color(th.border)
      .text_color(th.foreground).text_size(13).track_focus(this.handle)
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        this.historyHeight = Math.max(80, Math.min(900, this.drag.height - (e.position.y - this.drag.y)));
        cx.notify();
      })
      .on_mouse_up("left", () => { if (this.drag) { this.drag = null; localStorage.setItem("historyHeight", String(this.historyHeight)); } })
      .on_key_down((e, cx) => {
        if ((e.keystroke === "ctrl-enter" || e.keystroke === "cmd-enter") && this.typing) { this.commit(cx); cx.stop_propagation(); }
        else if (e.key === "escape" && this.menu) { this.menu = null; cx.notify(); cx.stop_propagation(); }
        else if (e.key === "escape" && this.accountOpen) { this.accountOpen = false; cx.notify(); cx.stop_propagation(); }
      })
      .child(this.header(th))
      .when(this.error === "not-a-repo", (e) => e.child(this.notRepo(th)))
      .when(Boolean(this.root), (e) => e.child(this.commitBox(th)).child(this.body(th)))
      .when(!this.root && this.error !== "not-a-repo", (e) => e.child(div().p(14).text_color(th.dim).child(this.error ?? (this.loading ? "Loading changes…" : "No folder"))))
      .when(this.accountOpen, (e) => e.child(this.accountMenu(th)))
      .when(Boolean(this.confirm), (e) => e.child(this.confirmCard(th)));
  }

  header(t) {
    const n = this.state.conflicts.length + this.state.staged.length + this.state.unstaged.length;
    const { branch, ahead, behind, upstream } = this.info;
    const busy = (k) => this.busy?.key === k;
    return h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().pl(4).font_semibold().child("Changes"))
      .when(n > 0, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(n))))
      .child(div().flex_1())
      .when(Boolean(this.root), (e) => e
        .child(h_flex().id("branch").h(24).px(6).gap(4).min_w(0).max_w(150).items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover))
          .tooltip(upstream ? `${branch} → ${upstream}` : branch ? `${branch} (no tracking branch)` : "Detached HEAD")
          .on_click(() => this.openBranches())
          .child(svg(ICON("branch")).size(13).flex_none()).child(div().truncate().child(branch ?? (this.info.oid ? this.info.oid.slice(0, 7) : "no commits"))))
        .when(behind > 0, (e) => e.child(div().text_size(11).text_color(t.muted).child(`↓${behind}`)))
        .when(ahead > 0, (e) => e.child(div().text_size(11).text_color(t.muted).child(`↑${ahead}`)))
        .child(iconButton(t, "pull", "pull", (_e, cx) => this.pull(cx), { title: "Pull (fast-forward only)", spin: busy("pull"), disabled: Boolean(this.busy) && !busy("pull") }))
        .child(iconButton(t, "push", upstream || !branch ? "push" : "upload", (_e, cx) => this.push(cx), { title: upstream ? "Push" : "Publish branch", spin: busy("push"), disabled: Boolean(this.busy) && !busy("push") }))
        .child(iconButton(t, "refresh", "refresh", (_e, cx) => { this.refresh(cx); this.refreshAccount(cx); }, { title: "Refresh" }))
        .child(iconButton(t, "account", "user", (_e, cx) => { this.accountOpen = !this.accountOpen; if (this.accountOpen && this.account?.signedIn && !Array.isArray(this.models)) this.loadModels(cx); cx.notify(); },
          { title: this.account?.signedIn ? `ChatGPT: ${this.account.email ?? "signed in"}` : "ChatGPT: not signed in", active: Boolean(this.account?.signedIn) })));
  }

  notRepo(t) {
    return v_flex().p(14).gap(10).text_color(t.muted).child("This folder isn't a git repository.")
      .child(textButton(t, "init", "Initialize repository", (_e, cx) => {
        const folder = this.folder, on = this.on;
        cx.spawn(async (cx) => {
          const r = await exec("git", ["init"], { cwd: folder, on });
          this.note = r.code === 0 ? null : { level: "error", text: G.gitError(r) };
          this.context = null; this.refresh(cx); cx.notify();
        });
      }, { kind: "solid" }));
  }

  commitBox(t) {
    const all = !this.state.staged.length, count = this.state.unstaged.length;
    const enabled = this.canCommit();
    const label = this.busy?.key === "commit" ? "Committing…" : all && count ? `Commit all (${count})` : "Commit";
    const gen = Boolean(this.generating);
    return v_flex().flex_none().p(10).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_start()
        .child(div().id("commit-message").flex_1().min_w(0).min_h(32).px(10).py(6).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.input).w_full().text_size(12).text_color(t.foreground)))
        .child(div().pt(4).child(iconButton(t, "generate", "sparkles", (_e, cx) => this.generate(cx), {
          title: gen ? "Stop, and get back what you had" : this.state.staged.length ? "Write a message for the staged changes" : "Write a message for all changes",
          spin: gen, color: t.accent,
        }))))
      .when(this.state.conflicts.length > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child("Resolve and stage the merge conflicts to commit.")))
      .child(h_flex().gap(6)
        .child(textButton(t, "commit", label, (_e, cx) => this.commit(cx), { kind: "solid", disabled: !enabled, busy: this.busy?.key === "commit",
          title: all && count ? `Stages every change first (${this.state.unstaged.filter((x) => x.untracked).length} new files)` : "Ctrl+Enter" }).flex_1()));
  }

  body(t) {
    const { conflicts, staged, unstaged } = this.state;
    const history = !this.collapsed.has("history") && this.info.oid;
    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.note), (e) => e.child(this.noteBar(t)))
      .when(Boolean(this.undo), (e) => e.child(h_flex().flex_none().mx(8).mt(8).px(10).h(30).gap(8).items_center().rounded(7).bg(t.raised).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`Discarded ${this.undo.label}`))
        .child(div().id("undo-discard").text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.askUndoDiscard(cx)).child("Undo"))
        .child(iconButton(t, "undo-dismiss", "x", (_e, cx) => { this.undo = null; cx.notify(); }, { size: 20 }))))
      .child(v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(conflicts.length > 0, (e) => e.child(this.section(t, "conflicts", "Merge conflicts", conflicts)))
        .when(staged.length > 0, (e) => e.child(this.section(t, "staged", "Staged changes", staged)))
        .child(this.section(t, "unstaged", "Changes", unstaged))
        .when(this.limited, (e) => e.child(div().px(8).py(4).text_size(11).text_color(t.dim).child("Showing the first 2,000 changed files"))))
      .when(Boolean(this.info.oid), (e) => e
        .child(div().id("history-divider").h(5).flex_none().cursor_row_resize().border_t(1).border_color(t.border).hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (ev, cx) => { cx.stop_propagation(); if (history) this.drag = { y: ev.position.y, height: this.historyHeight }; }))
        .child(this.history(t, history)));
  }

  noteBar(t) {
    const n = this.note;
    const color = n.level === "error" ? t.ansi1 : t.muted;
    return v_flex().flex_none().mx(8).mt(8).px(10).py(6).gap(6).rounded(7).bg(t.raised).text_size(12)
      .child(h_flex().gap(8).items_start()
        .child(div().flex_1().min_w(0).text_color(color).child(n.text))
        .child(iconButton(t, "note-dismiss", "x", (_e, cx) => { this.note = null; cx.notify(); }, { size: 20 })))
      .when(Boolean(n.signIn), (e) => e.child(h_flex().child(textButton(t, "sign-in", "Continue with ChatGPT", () => { this.note = null; this.signIn(); }, { kind: "solid" }))))
      .when(Boolean(n.detail || n.command), (e) => e.child(h_flex().gap(10).text_size(11)
        .when(Boolean(n.detail), (e) => e.child(div().id("copy-detail").text_color(t.accent).cursor_pointer().tooltip(n.detail.slice(0, 2000)).on_click((_e, cx) => cx.write_to_clipboard(`${n.text}\n\n${n.detail}`)).child("Copy details")))
        .when(Boolean(n.command), (e) => e.child(div().id("copy-command").text_color(t.accent).cursor_pointer().on_click((_e, cx) => cx.write_to_clipboard(n.command)).child("Copy command")))
        .when(Boolean(n.command) && /push|pull/.test(n.command) && !/ipv4/.test(n.command), (e) => e.child(div().id("retry-ipv4").text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => {
            const args = n.command.replace(/^git /, "").split(" ");
            this.act(cx, args[0], `${args[0]} via IPv4`, async (root, on) => {
              const r = await network(root, on, [args[0], "--ipv4", ...args.slice(1)]);
              if (r.code !== 0) throw new GitFailure(r, [args[0], "--ipv4", ...args.slice(1)]);
              return "Done.";
            });
          }).child("Retry via IPv4")))));
  }

  section(t, id, title, entries) {
    const open = !this.collapsed.has(id);
    const busy = this.busy?.key === `section-${id}`;
    const toggle = (_e, cx) => { open ? this.collapsed.add(id) : this.collapsed.delete(id); localStorage.setItem("collapsed", JSON.stringify([...this.collapsed])); cx.notify(); };
    const hovered = this.hover === `section-${id}`;
    const actions = h_flex().gap(1)
      .when(entries.length > 0 && id !== "conflicts", (e) => e.child(iconButton(t, `review-${id}`, "compare", () => this.openDiff(entries[0], id, entries), { title: "Review: open the first diff, ‹ › walk the section", size: 22 })))
      .when(id === "unstaged" && entries.length > 0, (e) => e.child(iconButton(t, `discard-all-${id}`, "discard", (_e, cx) => this.askDiscard(cx, entries, `section-${id}`), { title: "Discard all changes", size: 22 })))
      .when(id === "staged", (e) => e.child(iconButton(t, `unstage-all`, "minus", (_e, cx) => this.unstage(cx, entries, `section-${id}`), { title: "Unstage all", size: 22, spin: busy })))
      .when(id !== "staged" && entries.length > 0, (e) => e.child(iconButton(t, `stage-all-${id}`, "plus", (_e, cx) => this.stage(cx, entries, `section-${id}`), { title: id === "conflicts" ? "Mark all resolved (stage)" : "Stage all", size: 22, spin: busy })));
    return v_flex().flex_none()
      .child(h_flex().id(`section-${id}`).h(ROW).flex_none().px(4).gap(4).items_center().rounded(6).cursor_pointer().text_size(11).font_semibold().text_color(id === "conflicts" ? t.ansi1 : t.muted)
        .hover((s) => s.bg(t.hover)).on_hover((h, cx) => { this.hover = h ? `section-${id}` : this.hover === `section-${id}` ? null : this.hover; cx.notify(); }).on_click(toggle)
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).flex_none())
        .child(div().flex_1().child(`${title.toUpperCase()}`))
        .when(hovered || busy, (e) => e.child(actions))
        .child(div().px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(entries.length))))
      .when(open, (e) => e.children(entries.map((x) => this.row(t, id, x, entries)))
        .when(!entries.length && id === "unstaged", (e) => e.child(div().px(24).py(4).text_size(12).text_color(t.dim).child(this.state.staged.length ? "Nothing else changed" : "No changes"))));
  }

  row(t, section, entry, list) {
    const key = `${section}:${entry.path}`, hovered = this.hover === key, busy = this.busy?.key === key;
    const { dir, name } = splitPath(entry.path);
    const stat = (section === "staged" ? this.stats.staged : this.stats.unstaged)[entry.path];
    return h_flex().id(`row-${key}`).h(ROW).flex_none().pl(22).pr(4).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_hover((h, cx) => { this.hover = h ? key : this.hover === key ? null : this.hover; cx.notify(); })
      .on_click(() => section === "conflicts" ? this.openFile(entry.path) : this.openDiff(entry, section, list))
      .child(h_flex().flex_1().min_w(0).gap(6).items_baseline()
        .child(div().flex_none().max_w(220).truncate().text_color(entry.status === "D" ? t.muted : t.foreground).child(name))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(entry.orig && entry.status === "R" ? `${entry.orig} → ${dir}` : dir)))
      .when(hovered || busy, (e) => e.child(h_flex().gap(1)
        .when(entry.status !== "D", (e) => e.child(iconButton(t, `open-${key}`, "file", () => this.openFile(entry.path), { title: "Open file", size: 22 })))
        .when(section === "unstaged", (e) => e.child(iconButton(t, `discard-${key}`, "discard", (_e, cx) => this.askDiscard(cx, [entry], key), { title: "Discard changes", size: 22 })))
        .when(section === "staged", (e) => e.child(iconButton(t, `unstage-${key}`, "minus", (_e, cx) => this.unstage(cx, [entry], key), { title: "Unstage", size: 22, spin: busy })))
        .when(section !== "staged", (e) => e.child(iconButton(t, `stage-${key}`, "plus", (_e, cx) => this.stage(cx, [entry], key), { title: section === "conflicts" ? "Mark resolved (stage)" : "Stage", size: 22, spin: busy })))))
      .when(!hovered && !busy && Boolean(stat) && !stat?.binary, (e) => e
        .when(stat.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${stat.add}`)))
        .when(stat.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${stat.del}`))))
      .child(div().w(14).flex_none().text_right().text_size(11).font_semibold().text_color(statusColor(t, entry.status)).child(entry.untracked ? "U" : entry.status));
  }

  history(t, open) {
    const toggle = (_e, cx) => {
      if (open) this.collapsed.add("history"); else this.collapsed.delete("history");
      localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
      if (!open) cx.spawn(async (cx) => { await this.loadLog().catch(() => {}); cx.notify(); });
      cx.notify();
    };
    return v_flex().flex_none().h(open ? this.historyHeight : 32).min_h(0)
      .child(h_flex().id("history-header").h(28).flex_none().px(10).gap(4).items_center().cursor_pointer().text_size(11).font_semibold().text_color(t.muted).on_click(toggle)
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).flex_none())
        .child(div().flex_1().child("HISTORY"))
        .when(open, (e) => e.child(iconButton(t, "undo-commit", "undo", (_e, cx) => this.askUndoCommit(cx), { title: "Undo Last Commit (keeps its changes staged)", size: 22, spin: this.busy?.key === "undo-commit" }))))
      .when(open, (e) => e.child(v_flex().id("history-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(6).relative()
        .children(this.log.map((c) => this.commitRow(t, c)))
        .when(!this.log.length, (e) => e.child(div().px(10).text_size(12).text_color(t.dim).child("No commits")))));
  }

  commitRow(t, c) {
    const open = this.expanded === c.hash, menu = this.menu === c.hash;
    const files = this.commitFiles[c.hash];
    return v_flex().flex_none()
      .child(h_flex().id(`commit-${c.hash}`).h(ROW).flex_none().px(6).gap(8).items_center().rounded(6).cursor_pointer().bg(open ? t.selected : t.background).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.menu = null; this.toggleCommit(cx, c); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu = menu ? null : c.hash; cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().child(c.subject))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(G.timeAgo(c.date))))
      .when(menu, (e) => e.child(h_flex().flex_none().flex_wrap().mx(6).my(2).p(4).gap(2).rounded(7).border_1().border_color(t.border).bg(t.popover).text_size(12)
        .on_mouse_down_out((_e, cx) => { if (this.menu === c.hash) { this.menu = null; cx.notify(); } })
        .children([
          ["View changes", (cx) => { if (this.expanded !== c.hash) this.toggleCommit(cx, c); }],
          ["Copy hash", (cx) => cx.write_to_clipboard(c.hash)],
          ["Copy short hash", (cx) => cx.write_to_clipboard(c.hash.slice(0, 7))],
          ["Copy subject", (cx) => cx.write_to_clipboard(c.subject)],
        ].map(([label, fn], i) => div().id(`menu-${c.hash}-${i}`).px(8).py(3).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { fn(cx); this.menu = null; cx.notify(); }).child(label)))))
      .when(open, (e) => e.child(v_flex().flex_none().pl(14).pr(6).py(4).gap(2).text_size(12)
        .child(div().text_color(t.muted).child(`${c.author} · ${new Date(c.date).toLocaleString()} · ${c.short}`))
        .when(Boolean(c.body), (e) => e.child(div().py(2).text_color(t.foreground).child(c.body)))
        .when(!files, (e) => e.child(div().text_color(t.dim).child("Loading files…")))
        .when(Boolean(files?.error), (e) => e.child(div().text_color(t.ansi1).child(files.error)))
        .when(Array.isArray(files), (e) => e.children(files.map((f) => {
          const { dir, name } = splitPath(f.path);
          return h_flex().id(`cf-${c.hash}-${f.path}`).h(24).flex_none().px(6).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click(() => this.openDiff(f, "commit", files, { commit: c.hash, parent: c.parents[0] ?? null, subject: c.subject }))
            .child(div().flex_none().max_w(200).truncate().child(name))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
            .child(div().w(14).flex_none().text_right().text_size(11).font_semibold().text_color(statusColor(t, f.status)).child(f.status));
        })))));
  }

  accountMenu(t) {
    const a = this.account ?? {};
    const models = this.models;
    return v_flex().id("account-menu").absolute().top(40).right(8).w(260).p(8).gap(6).rounded(9).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12)
      .on_mouse_down_out((_e, cx) => { this.accountOpen = false; cx.notify(); })
      .child(div().font_semibold().child("Commit messages"))
      .when(!a.signedIn, (e) => e
        .child(div().text_color(t.muted).child("✦ writes Conventional Commits with your ChatGPT plan (Sign in with ChatGPT). Only the diff is sent, when you click it."))
        .child(textButton(t, "account-sign-in", "Continue with ChatGPT", (_e, cx) => { this.accountOpen = false; this.signIn(); cx.notify(); }, { kind: "solid" })))
      .when(Boolean(a.signedIn), (e) => e
        .child(div().text_color(t.muted).child(`Signed in${a.email ? ` as ${a.email}` : ""}`))
        .child(div().text_size(11).text_color(t.dim).child("Model"))
        .child(v_flex().id("models").max_h(180).overflow_y_scrollbar().gap(1)
          .when(models === "loading" || models === null, (e) => e.child(div().text_color(t.dim).child("Loading models…")))
          .when(Boolean(models?.error), (e) => e.child(div().text_color(t.ansi1).child(models.error)))
          .when(Array.isArray(models), (e) => e.children(models.map((m) => h_flex().id(`model-${m.slug}`).h(24).px(6).gap(6).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.setModel(cx, m.slug))
            .child(div().w(12).child(a.model === m.slug ? svg(ICON("check")).size(12) : ""))
            .child(div().flex_1().truncate().child(m.display_name))))))
        .child(h_flex().justify_end().child(textButton(t, "sign-out", "Sign out", (_e, cx) => this.askSignOut(cx)))));
  }

  confirmCard(t) {
    const c = this.confirm;
    const buttons = [["Cancel", false], [c.action, true]];
    return div().id("confirm-scrim").absolute().inset_0().bg(t.background + "cc").flex().items_center().justify_center().p(14)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.answer(cx, false); })
      .child(v_flex().id("confirm").w_full().max_w(340).max_h(360).p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .track_focus(this.confirmHandle)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => {
          if (e.key === "escape") this.answer(cx, false);
          else if (e.key === "tab" || e.key === "left" || e.key === "right") { c.selected = 1 - c.selected; cx.notify(); }
          else if (e.key === "enter") this.answer(cx, c.selected === 1);
          else return;
          cx.stop_propagation();
        })
        .child(div().text_size(14).font_semibold().child(c.title))
        .child(div().text_size(12).text_color(t.muted).child(c.detail ?? ""))
        .when(Boolean(c.files?.length), (e) => e.child(v_flex().id("confirm-files").max_h(120).overflow_y_scrollbar().px(8).py(4).rounded(6).bg(t.raised).text_size(11)
          .children(c.files.slice(0, 200).map((p) => div().truncate().child(p)))
          .when(c.files.length > 200, (e) => e.child(div().text_color(t.dim).child(`… and ${c.files.length - 200} more`)))))
        .when(Boolean(c.choices), (e) => e.child(h_flex().flex_wrap().gap(4).children(c.choices.map((r) =>
          div().id(`choice-${r}`).px(8).py(3).rounded(6).border_1().border_color(c.choice === r ? t.accent : t.border).cursor_pointer().text_size(12)
            .on_click((_e, cx) => { c.choice = r; cx.notify(); }).child(r)))))
        .child(h_flex().justify_end().gap(8).children(buttons.map(([label, yes], i) =>
          textButton(t, `confirm-${i}`, label, (_e, cx) => this.answer(cx, yes), { kind: yes ? (c.danger ? "danger" : "solid") : "plain", selected: c.selected === i })))));
  }
}
