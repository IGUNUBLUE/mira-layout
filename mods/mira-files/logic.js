// Pure helpers for mira-files: icons, image sizes, autosave decisions. Tested with Node.

const EXT = {
  js: ["\ue74e", "ansi3", "js"], mjs: ["\ue74e", "ansi3", "js"], cjs: ["\ue74e", "ansi3", "js"], jsx: ["\ue7ba", "ansi6", "js"],
  ts: ["\ue628", "ansi4", "js"], mts: ["\ue628", "ansi4", "js"], cts: ["\ue628", "ansi4", "js"], tsx: ["\ue7ba", "ansi4", "js"],
  json: ["\ue60b", "ansi3", "json"], jsonc: ["\ue60b", "ansi3", "json"], md: ["\ue609", "ansi4", "markdown"], mdx: ["\ue609", "ansi4", "markdown"],
  py: ["\ue606", "ansi4", "python"], rs: ["\ue7a8", "ansi1", "rust"], go: ["\ue627", "ansi6", "go"], rb: ["\ue739", "ansi1", "ruby"],
  java: ["\ue738", "ansi1", "java"], kt: ["\ue634", "ansi5", "kotlin"], swift: ["\ue755", "ansi1", "swift"], c: ["\ue61e", "ansi4", "c"],
  h: ["\ue61e", "ansi5", "c"], cpp: ["\ue61d", "ansi4", "cpp"], hpp: ["\ue61d", "ansi5", "cpp"], cs: ["\uf81a", "ansi5", "csharp"],
  php: ["\ue73d", "ansi5", "php"], lua: ["\ue620", "ansi4", "lua"], html: ["\ue736", "ansi1", "html"], htm: ["\ue736", "ansi1", "html"],
  css: ["\ue749", "ansi4", "css"], scss: ["\ue749", "ansi5", "css"], vue: ["\ue6a0", "ansi2", "html"], svelte: ["\ue697", "ansi1", "html"],
  sh: ["\ue795", "ansi2", "bash"], bash: ["\ue795", "ansi2", "bash"], zsh: ["\ue795", "ansi2", "bash"], fish: ["\ue795", "ansi2", "bash"],
  yml: ["\ue6a8", "ansi5", "yaml"], yaml: ["\ue6a8", "ansi5", "yaml"], toml: ["\ue6b2", "ansi1", "toml"], ini: ["\ue615", "dim", "ini"],
  sql: ["\ue706", "ansi3", "sql"], graphql: ["\ue662", "ansi5", "graphql"], xml: ["\ue619", "ansi3", "xml"], txt: ["\uf15c", "muted", "text"],
  lock: ["\uf023", "dim", "text"], env: ["\uf462", "ansi3", "bash"], log: ["\uf18d", "dim", "text"], csv: ["\uf1c3", "ansi2", "text"],
  png: ["\uf1c5", "ansi5", null], jpg: ["\uf1c5", "ansi5", null], jpeg: ["\uf1c5", "ansi5", null], gif: ["\uf1c5", "ansi5", null],
  webp: ["\uf1c5", "ansi5", null], bmp: ["\uf1c5", "ansi5", null], ico: ["\uf1c5", "ansi5", null], svg: ["\uf1c5", "ansi3", "xml"],
  pdf: ["\uf1c1", "ansi1", null], zip: ["\uf410", "ansi3", null], gz: ["\uf410", "ansi3", null],
};
const NAMES = {
  "package.json": ["\ue71e", "ansi1", "json"], "package-lock.json": ["\ue71e", "dim", "json"], "dockerfile": ["\uf308", "ansi4", "bash"],
  "makefile": ["\ue779", "ansi3", "bash"], ".gitignore": ["\ue702", "ansi1", "text"], ".gitattributes": ["\ue702", "ansi1", "text"],
  ".gitmodules": ["\ue702", "ansi1", "text"], "license": ["\ue60a", "ansi3", "text"], "readme.md": ["\uf48a", "ansi4", "markdown"],
  "cargo.toml": ["\ue7a8", "ansi1", "toml"], "cargo.lock": ["\ue7a8", "dim", "toml"], "go.mod": ["\ue627", "ansi6", "text"],
};

/** { glyph (Nerd Font), color (theme key), language (Editor language or null) } for a file name. */
export function fileIcon(name) {
  const lower = name.toLowerCase();
  const hit = NAMES[lower] ?? (lower.startsWith(".env") ? EXT.env : EXT[lower.includes(".") ? lower.split(".").pop() : ""]);
  const [glyph, color, language] = hit ?? ["\uf15b", "muted", "text"];
  return { glyph, color, language };
}
export const folderIcon = (open) => ({ glyph: open ? "\ue5fe" : "\ue5ff", color: "ansi4" });

export const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
export const ext = (path) => { const n = path.split("/").pop().toLowerCase(); return n.includes(".") ? n.split(".").pop() : ""; };
export const isImage = (path) => IMAGE.has(ext(path));

/** Natural pixel size from the first bytes of PNG, GIF, JPEG, BMP, WebP or ICO; null if unknown. */
export function imageSize(b) {
  const u16 = (i) => b[i] | (b[i + 1] << 8), u16be = (i) => (b[i] << 8) | b[i + 1];
  const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const u32 = (i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32be(16), height: u32be(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16(6), height: u16(8) };
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: u32(18), height: Math.abs(u32(22) | 0) };
  if (b.length > 8 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { width: b[6] || 256, height: b[7] || 256 };
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { width: u16(26) & 0x3fff, height: u16(28) & 0x3fff };
    if (kind === "VP8L") { const bits = u32(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: u16be(i + 7), height: u16be(i + 5) };
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

/**
 * What to do when the file on disk is read again.
 * Returns "same" (nothing changed), "reload" (no unsaved edits: take the disk version),
 * or "conflict" (unsaved edits and the disk changed underneath: ask).
 */
export function onDisk({ disk, expected, dirty }) {
  if (disk === expected) return "same";
  return dirty ? "conflict" : "reload";
}

/** Whether autosave may write now. */
export const mayAutosave = ({ dirty, conflict, readonly }) => dirty && !conflict && !readonly;

/** Zoom by a wheel step, kept between 5% and 3200%, around 1 when close. */
export function zoomStep(scale, deltaY) {
  const next = scale * (deltaY > 0 ? 1 / 1.15 : 1.15);
  const clamped = Math.max(0.05, Math.min(32, next));
  return Math.abs(clamped - 1) < 0.04 ? 1 : clamped;
}
