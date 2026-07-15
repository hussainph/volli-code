import { EditorView, WidgetType } from "@codemirror/view";

/**
 * The block/inline widgets the live-preview layer swaps in for raw markdown
 * syntax when the cursor is outside a node (see live-preview.ts). Each widget is
 * display-only — it never mutates the document except the task checkbox, which
 * dispatches a byte-level `[ ]`/`[x]` swap so the buffer stays the source of
 * truth.
 */

/** A rendered task checkbox that toggles the underlying `[ ]`/`[x]` marker. */
export class CheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }

  override toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-md-task-checkbox";
    input.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
    // mousedown (not change) so we can preventDefault and stop CodeMirror from
    // also placing a caret where the widget sits.
    input.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? "[ ]" : "[x]" },
      });
    });
    return input;
  }

  override ignoreEvent(): boolean {
    // Let the browser deliver the mousedown to our own listener above.
    return true;
  }
}

/** A styled bullet glyph standing in for a `-`/`*`/`+` list marker. */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "•";
    return span;
  }
}

/** A rendered `<hr>` standing in for a `---`/`***`/`___` thematic break. */
export class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-hr";
    wrap.appendChild(document.createElement("hr"));
    return wrap;
  }
}

/** An inline image rendered from its source URL (syntax collapsed). */
export class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-image";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    wrap.appendChild(img);
    return wrap;
  }
}
