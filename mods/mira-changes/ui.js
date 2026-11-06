// Shared by the panel and the diff pane: where we are, running git, small controls.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, exec, setShared, shared, appHome } from "herdr";
import { READ, gitError } from "./git.js";

export const ICON = (name) => `mods/mira-changes/${name}.svg`;
export const SIWC = () => `${appHome()}/mods/mira-changes/siwc.mjs`;

let last = null;
/**
 * The folder Changes follows: the focused terminal's live folder. While a mod pane
 * (this diff, an editor) has the keyboard, the previous terminal's folder stays.
 */
export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && pane.terminal === null && last && last.space === space?.id) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || (!pane && last && last.space === space?.id ? last.cwd : null) || space?.folder;
  last = { cwd, on, space: space?.id };
  return last;
}
export const locationKey = () => { const l = location(); return JSON.stringify([l.cwd, l.on]); };

export class GitFailure extends Error {
  constructor(r, args) { super(gitError(r)); this.output = ((r.stderr || "") + (r.stdout || "")).trim(); this.args = args; }
}

/** Runs git in a repo (on its machine) and returns stdout; throws GitFailure on a non-zero exit. */
export async function git(root, on, args, { read = false, allow = [] } = {}) {
  const full = read ? [...READ, ...args] : args;
  const r = await exec("git", full, { cwd: root, on });
  if (r.code !== 0 && !allow.includes(r.code)) throw new GitFailure(r, args);
  return r.stdout;
}
export const gitResult = (root, on, args, read = false) => exec("git", read ? [...READ, ...args] : args, { cwd: root, on });

/** `sh -c script sh ...args` in a repo; throws GitFailure on failure. */
export async function sh(root, on, script, ...args) {
  const r = await exec("sh", ["-c", script, "sh", ...args], { cwd: root, on });
  if (r.code !== 0) throw new GitFailure(r, ["sh", "-c", script]);
  return r.stdout;
}

/** Network git (push/pull/fetch): never prompts, and plain OpenSSH gives up on a dead address. */
export const NETWORK = 'export GIT_TERMINAL_PROMPT=0; if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -z "${GIT_SSH:-}" ] && [ -z "$(git config core.sshCommand)" ]; then export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=8"; fi; exec git "$@"';
export const network = (root, on, args) => exec("sh", ["-c", NETWORK, "sh", ...args], { cwd: root, on });

/** Every copy of Changes, Files and the diff panes re-reads after a git change in `root`. */
export const touched = (root) => setShared("mira-changes.tick", { root, at: Date.now() });
export const tick = () => shared("mira-changes.tick");

/** A square icon button. Stops the press so window-drag areas and rows don't take it. */
export function iconButton(t, id, icon, onClick, { title, active = false, disabled = false, spin = false, size = 24, color } = {}) {
  const glyph = svg(ICON(spin ? "spinner" : icon)).size(14).flex_none().text_color(color ?? (disabled ? t.dim : active ? t.foreground : t.muted));
  return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(6)
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
    .when(Boolean(title), (e) => e.tooltip(title))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { cx.stop_propagation(); if (!disabled) onClick(e, cx); })
    .child(spin ? glyph.spin(900) : glyph);
}

/** A text button; `kind`: "solid" (primary), "danger" or "plain". */
export function textButton(t, id, label, onClick, { kind = "plain", disabled = false, selected = false, busy = false, title } = {}) {
  const bg = disabled ? t.raised : kind === "solid" ? t.solid : kind === "danger" ? t.ansi1 : t.raised;
  const fg = disabled ? t.dim : kind === "solid" ? t.solid_foreground : kind === "danger" ? "#ffffff" : t.foreground;
  return h_flex().id(id).h(28).px(12).gap(6).flex_none().items_center().justify_center().rounded(7).text_size(12).bg(bg).text_color(fg)
    .border_1().border_color(selected ? t.accent : kind === "plain" ? t.border : bg)
    .when(!disabled && !busy, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)))
    .when(Boolean(title), (e) => e.tooltip(title))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { cx.stop_propagation(); if (!disabled && !busy) onClick(e, cx); })
    .when(busy, (e) => e.child(svg(ICON("spinner")).size(12).spin(900)))
    .child(label);
}

export const statusColor = (t, s) => s === "A" ? t.ansi2 : s === "D" || s === "U" ? t.ansi1 : s === "R" || s === "C" ? t.ansi4 : t.blocked;

export function splitPath(path) {
  const parts = path.split("/"), name = parts.pop();
  return { dir: parts.length ? parts.join("/") + "/" : "", name };
}

/** The terminal pane a new pane should split from: the focused one in the shown tab, else its first. */
export function anchorPane() {
  const f = focused(), list = panes().filter((p) => p.tab === f?.tab);
  return (list.find((p) => p.pane === f?.pane) ?? list.find((p) => p.terminal) ?? list[0])?.pane;
}
