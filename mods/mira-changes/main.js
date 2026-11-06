// mira-changes: the Changes panel (a layout block), or one file's side-by-side diff
// when opened as a pane with props { diff: { root, on, path, mode, list, ... } }.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Panel } from "./panel.js";
import { DiffPane } from "./diffpane.js";

export default class Changes extends View {
  init(initial, cx) {
    const p = props() ?? initial;
    this.impl = p?.diff ? new DiffPane(p.diff) : new Panel();
    this.impl.init(cx);
  }

  render(cx) {
    return this.impl.render(cx);
  }
}
