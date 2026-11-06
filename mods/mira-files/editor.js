// One file as a pane: an editor with autosave that never overwrites a file changed on disk,
// or an image viewer (scroll to zoom, drag to pan). SVGs open as text with a Preview.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { readTextFile, writeTextFile, watchFolder, exec, theme, settings, run, focused, appHome, nextCommand, setShared } from "herdr";
import * as fs from "fs/promises";
import { ext, isImage, imageSize, onDisk, mayAutosave, zoomStep } from "./logic.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", yml: "yaml", md: "markdown", sh: "bash", zsh: "bash", py: "python", rs: "rust", svg: "xml" };
const MAX_TEXT = 2_000_000;

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function base64ToBytes(text) {
  const map = new Uint8Array(128);
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => { map[c.charCodeAt(0)] = i; });
  const clean = text.replace(/[^A-Za-z0-9+/]/g, ""), out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (map[clean.charCodeAt(i)] << 18) | (map[clean.charCodeAt(i + 1)] << 12) | (map[clean.charCodeAt(i + 2)] << 6) | map[clean.charCodeAt(i + 3)];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length && i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (o < out.length && i + 3 < clean.length) out[o++] = n & 255;
  }
  return out;
}

export class EditorPane {
  constructor(spec) {
    this.root = spec.root ?? null; this.on = spec.on ?? null;
    this.path = spec.file.startsWith("/") ? spec.file : `${this.root}/${spec.file}`;
    this.rel = this.root && this.path.startsWith(this.root + "/") ? this.path.slice(this.root.length + 1) : this.path;
    this.readonly = Boolean(this.on); // writeTextFile writes on this computer only
  }

  init(cx) {
    this.mode = isImage(this.path) ? "image" : "text";
    this.dirty = false; this.conflict = false; this.saving = false; this.note = null; this.gen = 0; this.view = { width: 600, height: 400 };
    this.scale = null; this.offset = { x: 0, y: 0 };
    if (this.mode === "image") this.loadImage(cx); else this.loadText(cx);
    if (!this.on) {
      const dir = this.path.slice(0, this.path.lastIndexOf("/")) || "/";
      cx.spawn(async (cx) => { try { for (;;) { await watchFolder(dir); this.checkDisk(cx); } } catch {} });
    }
    // Git-ignored folders aren't watched on Linux, and remote files can't be: look now and then too.
    cx.timer.every(4000, (cx) => this.checkDisk(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save") { if (this.conflict) this.note = "The file changed on disk: choose Reload or Overwrite."; else if (this.dirty) await this.save(cx); }
        cx.notify();
      }
    });
  }

  // ---------- text ----------

  loadText(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.path, { on: this.on });
        if (text === null) { this.error = "This file is no longer there."; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text view"; return; }
        if (text.length > MAX_TEXT) { this.error = "This file is over 2 MB; open it in a terminal editor."; return; }
        this.expected = text;
        const t = theme(), e = ext(this.path);
        this.state = EditorState.new({
          language: LANG[e] ?? (e || "text"), value: text, readonly: this.readonly,
          font_family: settings().font_family, font_size: 13,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi1, operator: t.muted, punctuation: t.muted },
        });
        this.state.on("change", (_e, cx) => this.changed(cx));
        this.error = null;
      } catch (e) { this.error = `Cannot open this file: ${e.message ?? e}`; }
      finally { cx.notify(); }
    });
  }

  changed(cx) {
    if (this.setting) return;
    const dirty = this.state.value() !== this.expected;
    if (dirty === this.dirty && !dirty) return;
    this.dirty = dirty;
    const gen = ++this.gen;
    if (dirty) cx.timer.after(1000, (cx) => { if (gen === this.gen && mayAutosave(this)) this.save(cx); });
    cx.notify();
  }

  replace(text) {
    this.setting = true;
    try { this.state.set_value(text); } finally { this.setting = false; }
    this.expected = text; this.dirty = false; this.conflict = false;
  }

  async save(cx, { force = false } = {}) {
    if (!this.state || this.readonly || this.saving) return;
    const text = this.state.value();
    this.saving = true; cx.notify();
    try {
      let expected = this.expected;
      if (force) expected = await readTextFile(this.path, { on: this.on });
      await writeTextFile(this.path, text, expected);
      this.expected = text; this.conflict = false; this.note = null;
      this.dirty = this.state.value() !== text;
      if (this.root) setShared("mira-changes.tick", { root: this.root, at: Date.now() });
    } catch (e) {
      const disk = await readTextFile(this.path, { on: this.on }).catch(() => null);
      if (disk === text) { this.expected = text; this.dirty = this.state.value() !== text; }
      else if (disk !== this.expected) { this.conflict = true; this.note = null; }
      else this.note = `Couldn't save: ${e.message ?? e}`;
    } finally { this.saving = false; cx.notify(); }
  }

  checkDisk(cx) {
    if (this.checking || this.saving) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      try {
        if (this.mode === "image") {
          const stamp = await this.stamp();
          if (stamp && this.imageStamp && stamp !== this.imageStamp) this.loadImage(cx);
          return;
        }
        if (!this.state) return;
        const disk = await readTextFile(this.path, { on: this.on });
        if (disk === null) { this.note = "This file was deleted on disk. Saving creates it again."; cx.notify(); return; }
        const what = onDisk({ disk, expected: this.expected, dirty: this.dirty });
        if (what === "reload") { this.replace(disk); this.note = null; cx.notify(); }
        else if (what === "conflict" && !this.conflict) { this.conflict = true; cx.notify(); }
      } catch {} finally { this.checking = false; }
    });
  }

  // ---------- images ----------

  async stamp() {
    const r = await exec("stat", ["-c", "%s-%Y", this.path], { on: this.on }).catch(() => null);
    return r?.code === 0 ? r.stdout.trim() : null;
  }

  loadImage(cx) {
    cx.spawn(async (cx) => {
      try {
        // image() only reads under the app's home: show a copy kept in .cache (hidden, so mods don't reload).
        const stamp = await this.stamp();
        const name = `${hash(this.path)}-${hash(stamp ?? String(Date.now()))}.${ext(this.path)}`;
        const rel = `.cache/mira-files/${name}`, abs = `${appHome()}/${rel}`;
        await exec("mkdir", ["-p", `${appHome()}/.cache/mira-files`]);
        if (this.on) {
          const r = await exec("base64", ["-w0", this.path], { on: this.on });
          if (r.code !== 0) throw new Error((r.stderr || "cannot read it").trim());
          await fs.writeFile(abs, base64ToBytes(r.stdout));
        } else {
          const r = await exec("cp", [this.path, abs]);
          if (r.code !== 0) throw new Error((r.stderr || "cannot read it").trim());
        }
        let size = null;
        try { size = imageSize(new Uint8Array(await fs.readFile(abs))); } catch {}
        if (!size) {
          const r = await exec("file", ["-b", abs]).catch(() => null);
          const m = /(\d+)\s*x\s*(\d+)/.exec(r?.stdout ?? "");
          size = m ? { width: +m[1], height: +m[2] } : { width: 512, height: 512 };
        }
        if (this.image && this.image.abs !== abs) exec("rm", ["-f", this.image.abs]);
        this.image = { rel, abs, ...size, bytes: stamp ? Number(stamp.split("-")[0]) : null };
        this.imageStamp = stamp;
        this.error = null;
      } catch (e) { this.error = `Cannot show this image: ${e.message ?? e}`; }
      finally { cx.notify(); }
    });
  }

  fit() {
    if (!this.image) return 1;
    return Math.min(1, (this.view.width - 32) / this.image.width, (this.view.height - 32) / this.image.height);
  }

  zoom(cx, scale) {
    const old = this.scale ?? this.fit();
    this.offset = { x: this.offset.x * (scale / old), y: this.offset.y * (scale / old) };
    this.scale = scale; cx.notify();
  }

  async close() {
    if (this.mode === "text" && this.state && mayAutosave(this)) await writeTextFile(this.path, this.state.value(), this.expected).catch(() => {});
    if (this.image) await exec("rm", ["-f", this.image.abs]).catch(() => {});
  }

  // ---------- render ----------

  render() {
    const t = theme(), name = this.path.split("/").pop(), dir = this.rel.includes("/") ? this.rel.slice(0, this.rel.lastIndexOf("/") + 1) : "";
    const status = this.readonly ? "Read-only (remote)" : this.conflict ? "Changed on disk" : this.saving ? "Saving…" : this.dirty ? "Edited" : this.state ? "Saved" : "";
    const isSvg = ext(this.path) === "svg";
    const button = (id, label, onClick, active = false) => div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .bg(active ? t.selected : t.background).border_1().border_color(t.border).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(onClick).child(label);
    return v_flex().id("mira-editor").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.view = { width: size.width, height: size.height - 36 }; cx.notify(); })
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().flex_1().min_w(0).gap(6).items_baseline().overflow_hidden()
          .child(div().min_w(0).max_w(320).truncate().font_semibold().child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir)))
        .when(this.mode === "image" && Boolean(this.image), (e) => e
          .child(div().text_size(11).text_color(t.dim).child(`${this.image.width}×${this.image.height} · ${Math.round((this.scale ?? this.fit()) * 100)}%`))
          .child(button("fit", "Fit", (_e, cx) => { this.scale = null; this.offset = { x: 0, y: 0 }; cx.notify(); }))
          .child(button("actual", "100%", (_e, cx) => this.zoom(cx, 1))))
        .when(isSvg, (e) => e.child(button("preview", this.mode === "image" ? "Text" : "Preview", (_e, cx) => {
          if (this.mode === "image") this.mode = "text";
          else { this.mode = "image"; if (!this.image) this.loadImage(cx); }
          cx.notify();
        }, this.mode === "image")))
        .when(this.mode === "text" && Boolean(status), (e) => e.child(div().text_size(11).text_color(this.conflict ? t.ansi1 : this.dirty ? t.blocked : t.dim).child(status)))
        .child(div().id("close").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { const p = focused()?.pane; if (p) run("pane.close", { pane: p }); }).child(svg("mods/mira-files/x.svg").size(14))))
      .when(this.conflict && this.mode === "text", (e) => e.child(h_flex().flex_none().px(12).py(6).gap(8).items_center().bg(t.raised).text_size(12)
        .child(div().flex_1().min_w(0).text_color(t.ansi1).child("This file changed on disk while you were editing it (an agent?). Autosave is paused."))
        .child(button("reload", "Reload from disk", (_e, cx) => cx.spawn(async (cx) => { const disk = await readTextFile(this.path, { on: this.on }); if (disk !== null) this.replace(disk); cx.notify(); })))
        .child(button("overwrite", "Overwrite", (_e, cx) => cx.spawn(async (cx) => { await this.save(cx, { force: true }); })))))
      .when(Boolean(this.note), (e) => e.child(div().flex_none().px(12).py(4).bg(t.raised).text_size(12).text_color(t.muted).child(this.note)))
      .child(this.error ? div().p(16).text_color(t.dim).child(this.error)
        : this.mode === "image" ? this.imageView(t)
        : this.state ? Editor.new(this.state).flex_1().min_h(0)
        : div().p(16).text_color(t.dim).child("Loading…"));
  }

  imageView(t) {
    if (!this.image) return div().p(16).text_color(t.dim).child("Loading image…");
    const s = this.scale ?? this.fit(), w = this.image.width * s, h = this.image.height * s;
    const left = (this.view.width - w) / 2 + this.offset.x, top = (this.view.height - h) / 2 + this.offset.y;
    return div().id("image-view").flex_1().min_h(0).relative().overflow_hidden().bg(t.raised).cursor_grab()
      .on_scroll_wheel((e, cx) => { if (Math.abs(e.delta.y) >= 1) this.zoom(cx, zoomStep(s, e.delta.y)); })
      .on_mouse_down("left", (e, cx) => { this.drag = { x: e.position.x, y: e.position.y, ox: this.offset.x, oy: this.offset.y }; cx.notify(); })
      .on_mouse_move((e, cx) => { if (!this.drag) return; this.offset = { x: this.drag.ox + e.position.x - this.drag.x, y: this.drag.oy + e.position.y - this.drag.y }; cx.notify(); })
      .on_mouse_up("left", () => { this.drag = null; })
      .child(image(this.image.rel).absolute().left(left).top(top).w(w).h(h));
  }
}
