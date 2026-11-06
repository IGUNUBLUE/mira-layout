// Search & replace across the focused terminal's repository (or folder), with ripgrep.
// Respects .gitignore. Results open the file beside the terminal (mira-files).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, theme, run, shared, setShared } from "herdr";
import { rgArgs, parseRg, buildRegex, replaceLines } from "./search.js";

let last = null;
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && pane.terminal === null && last && last.space === space?.id) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  last = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
  return last;
}
const key = () => { const l = location(); return JSON.stringify([l.cwd, l.on]); };

export default class Search extends View {
  init(_props, cx) {
    this.opts = JSON.parse(localStorage.getItem("opts") ?? '{"matchCase":false,"word":false,"regex":false}');
    this.result = null; this.collapsed = new Set(); this.gen = 0; this.confirm = null; this.note = null;
    this.query = InputState.new({ placeholder: "Search" });
    this.replace = InputState.new({ placeholder: "Replace" });
    this.query.on("change", (_e, cx) => this.schedule(cx));
    this.query.on("submit", (_e, cx) => this.search(cx));
    this.replace.on("change", (_e, cx) => cx.notify());
    this.handle = cx.focus_handle(); this.confirmHandle = cx.focus_handle();
    this.seenFocus = shared("mira-search.focus") ?? 0;
    this.context = key();
  }

  async rootFor(cwd, on) {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
    return top?.code === 0 ? top.stdout.trim() : cwd;
  }

  schedule(cx) {
    const gen = ++this.gen;
    cx.timer.after(250, (cx) => { if (gen === this.gen) this.search(cx); });
  }

  search(cx) {
    const q = this.query.value(), { cwd, on } = location(), gen = ++this.gen, opts = { ...this.opts };
    if (!q.trim() || !cwd) { this.result = null; this.error = null; cx.notify(); return; }
    if (opts.regex) { try { buildRegex(q, opts); } catch (e) { this.error = `Invalid regular expression: ${e.message}`; cx.notify(); return; } }
    this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const root = await this.rootFor(cwd, on);
        const r = await exec("rg", rgArgs(q, opts), { cwd: root, on });
        if (gen !== this.gen) return;
        if (r.code !== 0 && r.code !== 1) throw new Error((r.stderr || "ripgrep failed").trim().split("\n")[0]);
        this.root = root; this.on = on; this.result = parseRg(r.stdout); this.error = null; this.resultQuery = { q, opts };
      } catch (e) {
        if (gen === this.gen) this.error = String(e.message ?? e).includes("program not found") ? "ripgrep (rg) isn't installed on this machine." : e.message ?? String(e);
      } finally { if (gen === this.gen) this.loading = false; cx.notify(); }
    });
  }

  toggle(cx, name) {
    this.opts = { ...this.opts, [name]: !this.opts[name] };
    localStorage.setItem("opts", JSON.stringify(this.opts));
    this.search(cx);
  }

  open(path, line) {
    const f = focused(), list = panes().filter((p) => p.tab === f?.tab);
    const pane = (list.find((p) => p.pane === f?.pane && p.terminal) ?? list.find((p) => p.terminal) ?? list[0])?.pane;
    run("pane.split", { direction: "right", ...(pane ? { pane } : {}), mod: "mira-files", props: { file: path, root: this.root, on: this.on, line } });
  }

  askReplaceAll(cx) {
    const r = this.result, rq = this.resultQuery;
    if (!r?.files.length || !rq) return;
    if (this.on) { this.note = "Replace works on this computer's files only."; cx.notify(); return; }
    if (r.truncated) { this.note = "There are more results than shown; narrow the search before replacing."; cx.notify(); return; }
    const replacement = this.replace.value();
    this.confirm = {
      title: `Replace ${r.count} ${r.count === 1 ? "match" : "matches"} in ${r.files.length} ${r.files.length === 1 ? "file" : "files"}?`,
      detail: `“${rq.q}” becomes “${replacement}”, line by line as listed. The files are rewritten on disk; Changes shows them afterwards.`,
      files: r.files.map((f) => f.path), selected: 0,
      run: (cx) => this.replaceAll(cx, rq, replacement),
    };
    this.confirmHandle.focus(); cx.notify();
  }

  replaceAll(cx, rq, replacement) {
    const root = this.root, files = this.result.files, re = buildRegex(rq.q, rq.opts);
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      let changed = 0, count = 0; const failed = [];
      for (const f of files) {
        const abs = `${root}/${f.path}`;
        try {
          const text = await readTextFile(abs);
          if (text === null) { failed.push(f.path); continue; }
          const out = replaceLines(text, f.matches.map((m) => m.line), re, replacement, { regex: rq.opts.regex });
          if (out.count && out.text !== text) { await writeTextFile(abs, out.text, text); changed++; count += out.count; }
        } catch { failed.push(f.path); }
      }
      this.busy = false;
      this.note = `Replaced ${count} in ${changed} ${changed === 1 ? "file" : "files"}.` + (failed.length ? ` Not changed (moved or edited meanwhile): ${failed.join(", ")}` : "");
      setShared("mira-changes.tick", { root, at: Date.now() });
      this.search(cx);
    });
  }

  answer(cx, yes) {
    const c = this.confirm; this.confirm = null;
    if (yes && c) c.run(cx);
    this.handle.focus(); cx.notify();
  }

  render(cx) {
    const f = shared("mira-search.focus") ?? 0;
    if (f > this.seenFocus) { this.seenFocus = f; cx.spawn(async () => this.query.focus()); }
    if (key() !== this.context) { this.context = key(); if (this.query.value().trim()) this.search(cx); }
    const t = theme(), r = this.result;
    const toggle = (id, label, title) => div().id(`opt-${id}`).h(22).min_w(24).px(4).flex().items_center().justify_center().rounded(5).text_size(11).font_semibold().cursor_pointer()
      .bg(this.opts[id] ? t.selected : t.background).text_color(this.opts[id] ? t.foreground : t.dim).border_1().border_color(this.opts[id] ? t.accent : t.background)
      .tooltip(title).on_click((_e, cx) => this.toggle(cx, id)).child(label);
    const field = (state, id, extra) => h_flex().id(id).h(32).flex_none().px(8).gap(4).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).flex_1().h_full().text_size(12.5)).when(Boolean(extra), (e) => e.child(extra));
    return v_flex().id("mira-search").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Search"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split("/").pop() ?? "")))
      .child(v_flex().flex_none().p(10).gap(6).border_b(1).border_color(t.border)
        .child(field(this.query, "query", h_flex().gap(2).child(toggle("matchCase", "Aa", "Match case")).child(toggle("word", "ab", "Whole word")).child(toggle("regex", ".*", "Regular expression"))))
        .child(h_flex().gap(6).child(div().flex_1().min_w(0).child(field(this.replace, "replace")))
          .child(div().id("replace-all").h(32).px(10).flex().items_center().rounded(8).text_size(12).border_1().border_color(t.border)
            .when(Boolean(r?.files.length) && !this.busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
            .text_color(r?.files.length ? t.foreground : t.dim)
            .on_click((_e, cx) => this.askReplaceAll(cx)).child(this.busy ? "Replacing…" : "Replace all")))
        .child(div().text_size(11).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? (this.loading ? "Searching…" : r ? `${r.count}${r.truncated ? "+" : ""} results in ${r.files.length} files` : "Ripgrep · respects .gitignore"))))
      .when(Boolean(this.note), (e) => e.child(h_flex().flex_none().mx(8).mt(8).px(10).py(6).gap(8).rounded(7).bg(t.raised).text_size(12)
        .child(div().flex_1().min_w(0).text_color(t.muted).child(this.note))
        .child(div().id("note-x").cursor_pointer().text_color(t.dim).on_click((_e, cx) => { this.note = null; cx.notify(); }).child("×"))))
      .child(v_flex().id("results").flex_1().min_h(0).overflow_y_scrollbar().p(6).children((r?.files ?? []).slice(0, 500).map((file) => this.fileRows(t, file))))
      .when(Boolean(this.confirm), (e) => e.child(this.confirmCard(t)));
  }

  fileRows(t, file) {
    const open = !this.collapsed.has(file.path), parts = file.path.split("/"), name = parts.pop();
    return v_flex().flex_none()
      .child(h_flex().id(`f-${file.path}`).h(26).flex_none().px(4).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { open ? this.collapsed.add(file.path) : this.collapsed.delete(file.path); cx.notify(); })
        .child(svg(`mods/mira-search/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().flex_none().max_w(200).truncate().font_semibold().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
        .child(div().px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(file.matches.length))))
      .when(open, (e) => e.children(file.matches.slice(0, 200).map((m, i) => {
        const spans = [], text = m.text;
        let at = 0;
        for (const [s, end] of m.ranges) { if (s > at) spans.push([text.slice(at, s), false]); spans.push([text.slice(s, end), true]); at = end; }
        if (at < text.length) spans.push([text.slice(at), false]);
        const first = m.ranges[0]?.[0] ?? 0, cut = first > 40 ? first - 30 : 0; // keep the match in view
        let skipped = 0;
        const shown = spans.map(([s, hit]) => {
          if (skipped < cut) { const drop = Math.min(s.length, cut - skipped); skipped += drop; s = s.slice(drop); }
          return [s.replace(/\t/g, "  "), hit];
        }).filter(([s]) => s.length);
        return h_flex().id(`m-${file.path}-${i}`).h(24).flex_none().pl(22).pr(4).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => this.open(file.path, m.line))
          .child(div().w(34).flex_none().text_right().text_size(11).text_color(t.dim).child(String(m.line)))
          .child(h_flex().flex_1().min_w(0).overflow_hidden().text_size(12)
            .when(cut > 0, (e) => e.child(div().flex_none().text_color(t.dim).child("…")))
            .children(shown.map(([s, hit]) => div().flex_none().whitespace_nowrap().when(hit, (e) => e.bg(t.accent + "33").rounded(3).text_color(t.foreground)).when(!hit, (e) => e.text_color(t.muted)).child(s))));
      })));
  }

  confirmCard(t) {
    const c = this.confirm;
    const btn = (i, label, yes) => div().id(`confirm-${i}`).h(28).px(12).flex().items_center().rounded(7).text_size(12).cursor_pointer()
      .border_1().border_color(c.selected === i ? t.accent : t.border).bg(yes ? t.solid : t.raised).text_color(yes ? t.solid_foreground : t.foreground)
      .on_click((_e, cx) => this.answer(cx, yes)).child(label);
    return div().id("confirm-scrim").absolute().inset_0().bg(t.background + "cc").flex().items_center().justify_center().p(14)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.answer(cx, false); })
      .child(v_flex().id("confirm").w_full().max_w(340).p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .track_focus(this.confirmHandle).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => {
          if (e.key === "escape") this.answer(cx, false);
          else if (e.key === "tab" || e.key === "left" || e.key === "right") { c.selected = 1 - c.selected; cx.notify(); }
          else if (e.key === "enter") this.answer(cx, c.selected === 1);
          else return;
          cx.stop_propagation();
        })
        .child(div().text_size(14).font_semibold().child(c.title))
        .child(div().text_size(12).text_color(t.muted).child(c.detail))
        .child(v_flex().id("confirm-files").max_h(120).overflow_y_scrollbar().px(8).py(4).rounded(6).bg(t.raised).text_size(11).children(c.files.slice(0, 200).map((p) => div().truncate().child(p))))
        .child(h_flex().justify_end().gap(8).child(btn(0, "Cancel", false)).child(btn(1, "Replace all", true))));
  }
}
