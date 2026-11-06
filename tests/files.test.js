import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIcon, folderIcon, isImage, imageSize, onDisk, mayAutosave, zoomStep } from "../mods/mira-files/logic.js";

test("fileIcon picks by name first, then extension, else a plain file", () => {
  assert.equal(fileIcon("package.json").color, "ansi1");
  assert.equal(fileIcon("index.ts").glyph, "\ue628");
  assert.equal(fileIcon("App.TSX").glyph, "\ue7ba");
  assert.equal(fileIcon(".env.local").glyph, fileIcon(".env").glyph);
  assert.deepEqual(fileIcon("weird.zzz"), { glyph: "\uf15b", color: "muted", language: "text" });
  assert.notEqual(folderIcon(true).glyph, folderIcon(false).glyph);
  assert.ok(isImage("a/b/Photo.JPG") && !isImage("x.svg"));
});

test("imageSize reads PNG, GIF, BMP, ICO, WebP and JPEG headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "mira-img-"));
  try {
    for (const [fmt, w, h] of [["png", 37, 21], ["gif", 12, 34], ["bmp", 9, 7], ["jpg", 64, 48], ["webp", 30, 20], ["ico", 32, 32]]) {
      const file = join(dir, `x.${fmt}`);
      execFileSync("magick", ["-size", `${w}x${h}`, "xc:#ff8800", file]);
      assert.deepEqual(imageSize(new Uint8Array(readFileSync(file))), { width: w, height: h }, fmt);
    }
    assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("onDisk: same, reload when clean, conflict when edited", () => {
  assert.equal(onDisk({ disk: "a", expected: "a", dirty: true }), "same");
  assert.equal(onDisk({ disk: "b", expected: "a", dirty: false }), "reload");
  assert.equal(onDisk({ disk: "b", expected: "a", dirty: true }), "conflict");
  assert.equal(mayAutosave({ dirty: true, conflict: false, readonly: false }), true);
  assert.equal(mayAutosave({ dirty: true, conflict: true, readonly: false }), false);
  assert.equal(mayAutosave({ dirty: true, conflict: false, readonly: true }), false);
});

test("zoomStep zooms out on positive delta, in on negative, and snaps near 100%", () => {
  assert.ok(zoomStep(1, 10) < 1);
  assert.ok(zoomStep(1, -10) > 1);
  assert.equal(zoomStep(1.15, 10), 1);
  assert.equal(zoomStep(0.05, 10), 0.05);
});
