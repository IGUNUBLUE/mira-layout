// A side-by-side diff of one file, as a pane beside the terminal. ‹ › walk the list it came with.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readTextFile, watchFolder, theme, settings, run, focused } from "herdr";
import { parseFileDiff, hunkPatch, applyScript } from "./hunk.js";
import { sideBySide, newFileHunk } from "./sbs.js";
import * as G from "./git.js";
import { git, sh, touched, tick, iconButton, textButton, splitPath, anchorPane, ICON } from "./ui.js";

// Rows are plain children (hunk bars carry buttons, which virtual lists don't allow), so they are capped.
// Each column is half the pane; long lines are cut (Open file shows them whole).
const LINE = 20, BAR = 30, MAX_BYTES = 8 * 1024 * 1024, MAX_ROWS = 4000;
const MODE = { unstaged: "Changes", staged: "Staged", commit: "Commit" };
const show = (text) => text.replace(/\t/g, "    ");

export class DiffPane {
  constructor(spec) {
    this.spec = spec;
    this.list = spec.list?.length ? spec.list : [{ path: spec.path, orig: spec.orig, untracked: spec.untracked }];
    this.index = Math.max(0, this.list.findIndex((e) => e.path === spec.path));
  }

  init(cx) {
    this.rows = []; this.view = 0; this.note = null; this.confirm = null; this.undo = null; this.busy = null;
    this.handle = cx.focus_handle();
    this.seenTick = tick()?.at ?? 0;
    this.load(cx);
    if (!this.spec.on && this.spec.mode !== "commit") {
      const root = this.spec.root;
      cx.spawn(async (cx) => {
        try { for (;;) { await watchFolder(root); this.load(cx); } } catch {}
      });
    }
  }

  get entry() { return this.list[this.index]; }

  load(cx) {
    const { root, on, mode, commit, parent } = this.spec, entry = this.entry, token = {};
    this.loading = token;
    cx.spawn(async (cx) => {
      try {
        let diff;
        if (mode === "unstaged" && entry.untracked) {
          const text = await readTextFile(`${root}/${entry.path}`, { on });
          if (text === null) diff = { header: [], hunks: [], message: "This file is no longer there." };
          else if (text.includes("\0")) diff = { header: [], hunks: [], message: "Binary file · no text diff" };
          else if (text.length > MAX_BYTES) diff = { header: [], hunks: [], message: "This file is over 8 MB; not diffed." };
          else diff = { header: [], hunks: text ? [newFileHunk(text)] : [], fresh: true };
        } else {
          const paths = entry.orig ? [entry.orig, entry.path] : [entry.path];
          const base = ["--no-color", "--no-ext-diff", "-M"];
          const args = mode === "staged" ? ["diff", "--cached", ...base, "--", ...paths]
            : mode === "commit" ? (parent ? ["diff", ...base, parent, commit, "--", ...paths] : ["diff-tree", "-p", "--root", "--no-commit-id", ...base, commit, "--", ...paths])
            : ["diff", ...base, "--", ...paths];
          const out = await git(root, on, args, { read: true });
          if (out.length > MAX_BYTES) diff = { header: [], hunks: [], message: "This diff is over 8 MB; not shown." };
          else {
            diff = parseFileDiff(out);
            if (diff.binary) diff.message = "Binary file changed";
            else if (!diff.hunks.length) diff.message = mode === "commit" ? "No text changes" : "No changes left in this file";
          }
        }
        if (this.loading !== token) return;
        this.diff = diff;
        let rows = sideBySide(diff.hunks);
        this.truncated = rows.length > MAX_ROWS;
        if (this.truncated) rows = rows.slice(0, MAX_ROWS);
        this.rows = rows;
        let longest = 0;
        for (const r of rows) longest = Math.max(longest, show(r.left?.text ?? "").length, show(r.right?.text ?? "").length);
        this.longest = longest;
        this.add = 0; this.del = 0;
        for (const r of rows) if (r.hunk !== undefined) { this.add += r.add; this.del += r.del; }
        this.error = null;
      } catch (e) { if (this.loading === token) { this.error = e.message; this.rows = []; } }
      finally { if (this.loading === token) this.loading = null; cx.notify(); }
    });
  }

  go(cx, step) {
    const next = this.index + step;
    if (next < 0 || next >= this.list.length) return;
    this.index = next; this.note = null; this.undo = null; this.rows = [];
    this.load(cx); cx.notify();
  }

  hunkAction(cx, index, action) {
    if (this.busy) return;
    const { root, on } = this.spec, diff = this.diff, entry = this.entry;
    let patch;
    try { patch = hunkPatch(diff, index); } catch (e) { this.note = e.message; cx.notify(); return; }
    if (patch.length > 120000) { this.note = "This change is too large to apply by itself; use the file's stage or discard."; cx.notify(); return; }
    const runIt = (cx) => {
      this.busy = `${action}-${index}`; this.note = null;
      cx.spawn(async (cx) => {
        try {
          if (action === "discard") {
            const snapshot = (await sh(root, on, G.SNAPSHOT_SCRIPT)).trim();
            this.undo = { snapshot, path: entry.path };
          }
          await sh(root, on, applyScript(action), patch);
        } catch (e) { this.note = `${action[0].toUpperCase() + action.slice(1)} failed: ${e.message}`; }
        finally { this.busy = null; touched(root); this.load(cx); cx.notify(); }
      });
      cx.notify();
    };
    if (action === "discard") {
      this.confirm = { title: "Discard this change?", detail: "The lines go back to the staged version. You can undo this right after.", action: "Discard", run: runIt, selected: 0 };
      this.handle.focus(); cx.notify();
    } else runIt(cx);
  }

  fileAction(cx, action) {
    const { root, on } = this.spec, entry = this.entry;
    const paths = entry.orig ? [entry.orig, entry.path] : [entry.path];
    this.busy = action;
    cx.spawn(async (cx) => {
      try {
        if (action === "stage") await git(root, on, ["add", "-A", "--", ...paths]);
        else await git(root, on, ["restore", "--staged", "--", ...paths]);
        this.note = action === "stage" ? "Staged. It's in Staged changes now." : "Unstaged. It's in Changes now.";
      } catch (e) { this.note = e.message; }
      finally { this.busy = null; touched(root); this.load(cx); cx.notify(); }
    });
    cx.notify();
  }

  undoDiscard(cx) {
    const { root, on } = this.spec, u = this.undo;
    this.undo = null;
    cx.spawn(async (cx) => {
      try { await git(root, on, G.restoreArgs(u.snapshot, [u.path])); this.note = "Restored."; }
      catch (e) { this.note = `Restore failed: ${e.message}`; }
      finally { touched(root); this.load(cx); cx.notify(); }
    });
  }

  answer(cx, yes) {
    const c = this.confirm; this.confirm = null;
    if (yes && c) c.run(cx);
    cx.notify();
  }

  render(cx) {
    const tk = tick();
    if (tk && tk.at > this.seenTick) { this.seenTick = tk.at; if (tk.root === this.spec.root && this.spec.mode !== "commit") this.load(cx); }
    const t = theme(), entry = this.entry, { dir, name } = splitPath(entry.path), mode = this.spec.mode;
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().id("mira-diff").size_full().min_h(0).relative().bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.view) > 1) { this.view = size.width; cx.notify(); } })
      .on_key_down((e, cx) => {
        if (this.confirm) {
          if (e.key === "escape") this.answer(cx, false);
          else if (e.key === "tab" || e.key === "left" || e.key === "right") { this.confirm.selected = 1 - this.confirm.selected; cx.notify(); }
          else if (e.key === "enter") this.answer(cx, this.confirm.selected === 1);
          else return;
          cx.stop_propagation();
        }
      })
      .child(h_flex().h(36).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(iconButton(t, "prev", "chevron-left", (_e, cx) => this.go(cx, -1), { title: "Previous file", disabled: this.index === 0 }))
        .child(div().text_size(11).text_color(t.dim).child(`${this.index + 1}/${this.list.length}`))
        .child(iconButton(t, "next", "chevron-right", (_e, cx) => this.go(cx, 1), { title: "Next file", disabled: this.index >= this.list.length - 1 }))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(6).px(4).items_baseline()
          .child(div().min_w(0).max_w(280).truncate().font_semibold().child(name))
          .when(this.view > 560, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(entry.orig ? `${entry.orig} → ${dir}` : dir))))
        .when(this.view > 480, (e) => e.child(div().flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(mode === "commit" ? `${MODE.commit} ${this.spec.commit.slice(0, 7)}` : entry.untracked ? "New file" : MODE[mode])))
        .when(this.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${this.add}`)))
        .when(this.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${this.del}`)))
        .when(mode !== "commit", (e) => e.child(iconButton(t, "open-file", "file", () => {
          const pane = anchorPane();
          run("pane.split", { direction: "down", ...(pane ? { pane } : {}), mod: "mira-files", props: { file: entry.path, root: this.spec.root, on: this.spec.on } });
        }, { title: "Open file" })))
        .when(mode === "unstaged", (e) => e.child(iconButton(t, "stage-file", "plus", (_e, cx) => this.fileAction(cx, "stage"), { title: "Stage file", spin: this.busy === "stage" })))
        .when(mode === "staged", (e) => e.child(iconButton(t, "unstage-file", "minus", (_e, cx) => this.fileAction(cx, "unstage"), { title: "Unstage file", spin: this.busy === "unstage" })))
        .child(iconButton(t, "close", "x", () => { const p = focused()?.pane; if (p) run("pane.close", { pane: p }); }, { title: "Close" })))
      .when(Boolean(this.note) || Boolean(this.undo), (e) => e.child(h_flex().flex_none().px(12).h(28).gap(10).items_center().bg(t.raised).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.note ?? "Change discarded."))
        .when(Boolean(this.undo), (e) => e.child(div().id("undo").text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.undoDiscard(cx)).child("Undo")))
        .child(iconButton(t, "dismiss", "x", (_e, cx) => { this.note = null; this.undo = null; cx.notify(); }, { size: 20 }))))
      .child(this.diff?.message || this.error
        ? div().p(16).text_color(t.dim).child(this.error ?? this.diff.message)
        : div().id("diff-body").flex_1().min_h(0).relative().font_family(mono).text_size(12)
          .child(div().id("diff-y").size_full().overflow_y_scrollbar()
            .child(v_flex().w_full().children(this.rows.map((row) => this.row(t, row, mono)))))
          .when(this.loading && !this.rows.length, (e) => e.child(div().absolute().top(8).left(12).text_color(t.dim).child("Loading diff…"))))
      .when(this.truncated, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_ROWS.toLocaleString()} rows`)))
      .when(Boolean(this.confirm), (e) => e.child(this.confirmCard(t)));
  }

  row(t, row, mono) {
    if (row.hunk !== undefined) {
      const mode = this.spec.mode, tracked = !this.entry.untracked, busy = (a) => this.busy === `${a}-${row.hunk}`;
      const hunkButton = (action, label) => div().id(`${action}-${row.hunk}`).px(8).h(22).flex().items_center().rounded(5).text_size(11).font_family(settings().ui_font ?? "Geist")
        .text_color(action === "discard" ? t.ansi1 : t.foreground).bg(t.background).border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.hunkAction(cx, row.hunk, action)).child(busy(action) ? "…" : label);
      return h_flex().w_full().h(BAR).flex_none().px(12).gap(6).items_center().bg(t.raised).border_t(1).border_b(1).border_color(t.border)
        .when(mode === "unstaged" && tracked && !this.diff?.fresh, (e) => e.child(hunkButton("stage", "Stage")).child(hunkButton("discard", "Discard")))
        .when(mode === "staged", (e) => e.child(hunkButton("unstage", "Unstage")))
        .child(div().flex_1().min_w(0).pl(4).truncate().text_color(t.dim).child(row.header));
    }
    return h_flex().w_full().h(LINE).flex_none().child(this.cell(t, row.left, "-")).child(this.cell(t, row.right, "+").border_l(1).border_color(t.border));
  }

  cell(t, cell, side) {
    if (!cell) return div().w_1_2().flex_none().h_full().bg(t.raised + "66");
    const changed = cell.kind !== " ";
    const tint = side === "-" ? t.ansi1 : t.ansi2;
    const text = cell.spans
      ? h_flex().flex_1().min_w(0).overflow_hidden().children(cell.spans.map((s) => div().flex_none().whitespace_nowrap().when(s.changed, (e) => e.bg(tint + "55").rounded(2)).child(show(s.text))))
      : div().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().child(show(cell.text) || " ");
    return h_flex().w_1_2().flex_none().overflow_hidden().h_full().gap(8).items_center().when(changed, (e) => e.bg(tint + "1c"))
      .child(div().w(44).flex_none().text_right().pr(2).text_color(t.dim).child(String(cell.number)))
      .child(div().w(10).flex_none().text_color(changed ? tint : t.dim).child(changed ? cell.kind : ""))
      .child(text);
  }

  confirmCard(t) {
    const c = this.confirm;
    return div().id("confirm-scrim").absolute().inset_0().bg(t.background + "cc").flex().items_center().justify_center()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.answer(cx, false); })
      .child(v_flex().id("confirm").w(340).p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().text_size(14).font_semibold().child(c.title))
        .child(div().text_size(12).text_color(t.muted).child(c.detail))
        .child(h_flex().justify_end().gap(8)
          .child(textButton(t, "confirm-0", "Cancel", (_e, cx) => this.answer(cx, false), { selected: c.selected === 0 }))
          .child(textButton(t, "confirm-1", c.action, (_e, cx) => this.answer(cx, true), { kind: "danger", selected: c.selected === 1 }))));
  }
}
