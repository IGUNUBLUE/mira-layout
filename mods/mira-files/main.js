// mira-files: the Files panel (a layout block), or one file as a pane beside the terminal
// when opened with props { file, root?, on? } (an editor, or an image viewer).
import { View } from "gpui-kit";
import { props } from "herdr";
import { Tree } from "./tree.js";
import { EditorPane } from "./editor.js";

export default class Files extends View {
  init(initial, cx) {
    const p = props() ?? initial;
    this.impl = p?.file ? new EditorPane(p) : new Tree();
    this.impl.init(cx);
  }

  render(cx) {
    return this.impl.render(cx);
  }

  async close(cx) {
    await this.impl.close?.(cx);
  }
}
