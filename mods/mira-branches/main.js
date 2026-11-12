// Switch branches: local ones and cached remote ones, searchable, Up/Down + Enter.
// Opened as a popup with props { root, on } by mira-changes and mira-status. Never fetches.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, props, closeOverlay, theme, setShared } from "herdr";
import { transferBranch } from "./transfer.js";

const FORMAT = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(committerdate:unix)%00%(HEAD)%00%(worktreepath)";

function parseRefs(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [ref, name, upstream, date, head, worktree] = line.split("\0");
    return { ref, name, remote: ref.startsWith("refs/remotes/"), upstream: upstream || null, date: Number(date) * 1000, current: head === "*", worktree: worktree || null };
  }).filter((b) => !b.ref.endsWith("/HEAD"));
}

export default class Branches extends View {
  init(_props, cx) {
    this.list = []; this.remotes = []; this.at = 0; this.error = null; this.busy = null; this.confirm = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Switch to branch…" });
    this.input.on("change", (_e, cx) => { this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => { const b = this.shown()[this.at]; if (b) this.pick(cx, b); });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    const { root, on } = props() ?? {};
    if (!root) { this.error = "No repository given."; return; }
    cx.spawn(async (cx) => {
      const [refs, remotes] = await Promise.all([
        exec("git", ["for-each-ref", `--format=${FORMAT}`, "refs/heads", "refs/remotes"], { cwd: root, on }),
        exec("git", ["remote"], { cwd: root, on }),
      ]);
      if (refs.code !== 0) this.error = (refs.stderr || "Cannot list branches").trim();
      else {
        const worktree = root.replace(/\/$/, "");
        this.list = parseRefs(refs.stdout).map((b) => ({ ...b, elsewhere: Boolean(b.worktree && b.worktree !== worktree) }));
      }
      this.remotes = remotes.stdout.split("\n").filter(Boolean);
      cx.notify();
    });
  }

  close() { const id = props()?.overlay; if (id) closeOverlay(id); }

  shown() {
    const q = this.input.value().trim().toLowerCase();
    return this.list.filter((b) => !q || b.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || b.date - a.date);
  }

  pick(cx, b) {
    if (this.busy || b.current) { if (b.current) this.close(); return; }
    if (b.elsewhere) { this.confirm = b; this.error = null; cx.notify(); return; }
    const { root, on } = props();
    let args;
    if (b.remote) {
      const remote = [...this.remotes].sort((x, y) => y.length - x.length).find((r) => b.name.startsWith(r + "/"));
      const local = remote ? b.name.slice(remote.length + 1) : b.name;
      const existing = this.list.find((x) => !x.remote && x.name === local);
      if (existing) {
        if (existing.upstream !== b.name) { this.error = `A local branch ${local} already exists (tracking ${existing.upstream ?? "nothing"}); switch to it instead.`; cx.notify(); return; }
        if (existing.elsewhere) { this.confirm = existing; this.error = null; cx.notify(); return; }
        args = ["switch", local];
      } else args = ["switch", "--track", "-c", local, b.name];
    } else args = ["switch", b.name];
    this.busy = b.name; this.error = null;
    cx.spawn(async (cx) => {
      const r = await exec("git", args, { cwd: root, on });
      this.busy = null;
      if (r.code === 0) { setShared("mira-changes.tick", { root, at: Date.now() }); this.close(); return; }
      const text = (r.stderr || r.stdout).trim();
      this.error = /would be overwritten|Please commit your changes or stash/.test(text)
        ? "Your changes conflict with that branch. Commit or stash them in a shell first."
        : text.split("\n").find((l) => /^(fatal|error):/.test(l))?.replace(/^(fatal|error):\s*/, "") ?? text;
      cx.notify();
    });
    cx.notify();
  }

  move(cx) {
    if (!this.confirm || this.busy) return;
    const b = this.confirm, { root, on } = props();
    this.busy = b.name; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await transferBranch(exec, { root, worktree: b.worktree, branch: b.name, on });
        this.busy = null;
        if (result.ok) { setShared("mira-changes.tick", { root, at: Date.now() }); this.close(); return; }
        this.error = result.error;
      } catch (err) {
        this.busy = null;
        this.error = `Transfer interrupted: ${String(err)}. Check both worktrees before retrying.`;
      }
      cx.notify();
    });
  }

  render() {
    const t = theme(), shown = this.shown();
    if (this.confirm) return v_flex().id("branches-confirm").track_focus(this.handle).w_full().p(16).gap(12).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(div().text_size(15).child("Move branch to this worktree?"))
      .child(div().child(this.confirm.name))
      .child(div().text_size(12).text_color(t.muted).child(`The other worktree will be left detached at its current commit: ${this.confirm.worktree}`))
      .child(div().text_size(12).text_color(t.muted).child("Both worktrees must be clean. Any session in the other worktree will see detached HEAD."))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8)
        .child(div().id("cancel-move").px(10).py(6).rounded(6).bg(t.hover).cursor_pointer().on_click((_e, cx) => { if (!this.busy) { this.confirm = null; this.error = null; cx.notify(); } }).child("Cancel"))
        .child(div().id("confirm-move").px(10).py(6).rounded(6).bg(t.selected).cursor_pointer().on_click((_e, cx) => this.move(cx)).child(this.busy ? "Moving…" : "Move branch here")));
    if (this.at >= shown.length) this.at = Math.max(0, shown.length - 1);
    return v_flex().id("branches").track_focus(this.handle).w_full().p(12).gap(8).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); return; }
        if (e.key === "down") this.at = Math.min(shown.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else if (e.key === "enter") { const b = shown[this.at]; if (b) this.pick(cx, b); }
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/mira-branches/search.svg").size(14).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5)))
      .when(Boolean(this.error), (e) => e.child(div().px(4).text_size(12).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("branch-list").h(Math.min(330, Math.max(40, shown.length * 31))).flex_none().overflow_y_scrollbar().gap(1).children(shown.slice(0, 300).map((b, i) =>
        h_flex().id(`b-${b.ref}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .bg(i === this.at ? t.selected : t.popover).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pick(cx, b))
          .child(svg("mods/mira-branches/branch.svg").size(13).flex_none().text_color(b.remote ? t.dim : t.muted))
          .child(div().flex_1().min_w(0).truncate().text_color(b.elsewhere ? t.dim : t.foreground).child(b.name))
          .when(b.current, (e) => e.child(div().text_size(11).text_color(t.accent).child("current")))
          .when(b.elsewhere, (e) => e.child(div().text_size(11).text_color(t.dim).child("other worktree")))
          .when(this.busy === b.name, (e) => e.child(div().text_size(11).text_color(t.dim).child("switching…")))
          .when(b.remote && !b.current && this.busy !== b.name, (e) => e.child(div().text_size(11).text_color(t.dim).child("remote")))))
        .when(!shown.length, (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child(this.list.length ? "No branch matches" : "Loading branches…"))))
      .child(div().text_size(11).text_color(t.dim).child("Enter switches branch · other worktrees require confirmation"));
  }
}
