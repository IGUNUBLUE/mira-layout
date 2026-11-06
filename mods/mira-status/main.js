// The status bar: machine, branch (click: switch), ahead/behind, changed files (click: Changes),
// agents and who needs you (click: go there), and focus mode (Ctrl+Shift+M: only the terminals).
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, agents, theme, run, window, keys, exec, layout, shared, setShared, openOverlay, nextCommand } from "herdr";

const CHROME = ["sidebar", "tabs", "panel"];

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

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const hit = find(child, id); if (hit) return hit; }
  return null;
}

export default class Status extends View {
  init(_props, cx) {
    this.git = null; this.seenTick = shared("mira-changes.tick")?.at ?? 0;
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.toggleFocus();
        cx.notify();
      }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (!cwd) { this.git = null; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { cwd, on });
        if (key() !== context) return;
        if (r.code !== 0) { this.git = null; return; }
        const info = { branch: null, ahead: 0, behind: 0, upstream: null, changes: 0 };
        for (const f of r.stdout.split("\0")) {
          if (f.startsWith("# branch.head ")) info.branch = f.slice(14) === "(detached)" ? null : f.slice(14);
          else if (f.startsWith("# branch.oid ")) info.oid = f.slice(13);
          else if (f.startsWith("# branch.upstream ")) info.upstream = f.slice(18);
          else if (f.startsWith("# branch.ab ")) { const m = /\+(\d+) -(\d+)/.exec(f); if (m) { info.ahead = +m[1]; info.behind = +m[2]; } }
          else if (/^[12u?] /.test(f)) info.changes++;
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        info.root = top.stdout.trim(); info.on = on;
        this.git = info;
      } catch { this.git = null; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  toggleFocus() {
    const state = shared("mira-status.focus");
    if (state?.on) {
      for (const id of state.restore ?? []) run("layout.show", { id });
      setShared("mira-status.focus", { on: false });
    } else {
      const root = layout(), shown = CHROME.filter((id) => { const n = find(root, id); return n && !n.hidden; });
      for (const id of shown) run("layout.hide", { id });
      setShared("mira-status.focus", { on: true, restore: shown });
    }
  }

  hint(id, action) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => (k.section === "global" || k.section === "layout:mira") && k.action === action);
    return b ? b.keys.split("-").map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : null;
  }

  render(cx) {
    const tick = shared("mira-changes.tick");
    if (tick && tick.at > this.seenTick) { this.seenTick = tick.at; this.refresh(cx); }
    if (key() !== this.lastKey) { this.lastKey = key(); this.refresh(cx); }
    const t = theme(), space = spaces().find((s) => s.active), list = agents(), g = this.git;
    const blocked = list.filter((a) => a.status === "blocked"), working = list.filter((a) => a.status === "working").length;
    const focusMode = Boolean(shared("mira-status.focus")?.on);
    const item = (id, children, onClick, title) => h_flex().id(id).h(22).px(6).gap(5).items_center().rounded(5)
      .when(Boolean(onClick), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick))
      .when(Boolean(title), (e) => e.tooltip(title)).children(children);
    const icon = (name) => svg(`mods/mira-status/${name}.svg`).size(13).flex_none();
    const focusKey = this.hint("focus", "mira-status.focus"), paletteKey = this.hint("palette", "app.palette");
    return h_flex().size_full().px(8).gap(4).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(item("machine", [icon(space?.machine ? "server" : "monitor"), space?.machine ?? "This computer"]))
      .when(Boolean(g), (e) => e
        .child(item("branch", [icon("branch"), g.branch ?? (g.oid ? g.oid.slice(0, 7) : "no commits")],
          () => openOverlay({ mod: "mira-branches", kind: "popup", width: 360, height: 420, props: { root: g.root, on: g.on } }),
          g.upstream ? `${g.branch} → ${g.upstream} · switch branch` : "Switch branch"))
        .when(g.ahead > 0 || g.behind > 0, (e) => e.child(item("ab", [`↓${g.behind} ↑${g.ahead}`], null, g.upstream ? `Compared with ${g.upstream} (as of the last fetch)` : null)))
        .child(item("changes", [icon("changes"), `${g.changes} ${g.changes === 1 ? "change" : "changes"}`], () => run("mira-tabs.changes"), "Show Changes")))
      .child(item("agents", [div().size(6).rounded(3).bg(working ? t.working : t.dim), `${list.length} ${list.length === 1 ? "agent" : "agents"}`]))
      .when(blocked.length > 0, (e) => e.child(item("needs", [div().text_color(t.blocked).child(`${blocked.length} ${blocked.length === 1 ? "needs" : "need"} you`)],
        () => { const a = blocked.find((x) => !x.focused) ?? blocked[0]; run("agent.focus", { terminal: a.address }); },
        blocked.map((a) => `${a.program?.name ?? a.app ?? "agent"} · ${a.space_name}`).join("\n"))))
      .child(div().flex_1())
      .child(item("focus-mode", [icon(focusMode ? "minimize" : "maximize"), focusMode ? "Leave focus" : "Focus"], () => { this.toggleFocus(); cx.notify(); },
        `Focus mode: only the terminals${focusKey ? ` (${focusKey})` : ""}`))
      .when(Boolean(paletteKey), (e) => e.child(div().id("palette").px(6).text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(`${paletteKey}  commands`)));
  }
}
