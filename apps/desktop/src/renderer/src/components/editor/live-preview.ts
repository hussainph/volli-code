import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type KeyBinding,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import { type SelRange, selectionTouches } from "./reveal";
import { BulletWidget, CheckboxWidget, ImageWidget, RuleWidget } from "./widgets";

/**
 * The Obsidian-style live-preview decoration layer. It walks the lezer markdown
 * syntax tree over the visible ranges and, for every node, either styles it in
 * place (a mark decoration) or replaces its raw syntax with rendered output (a
 * replace/widget decoration) — but only while the selection is *outside* the
 * node. `reveal.ts` owns the "is the selection touching this node?" predicate;
 * the moment the caret lands on a node its delimiters reappear, which is what
 * keeps the buffer byte-faithful and directly editable.
 *
 * Nothing here mutates the document except the task checkbox widget, which
 * swaps `[ ]`/`[x]` at the byte level.
 */

const HEADING_RE = /^ATXHeading([1-6])$/;

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const selection: SelRange[] = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const decos: Range<Decoration>[] = [];

  const push = (deco: Decoration, from: number, to: number): void => {
    decos.push(deco.range(from, to));
  };
  const lineTouched = (pos: number): boolean => {
    const line = doc.lineAt(pos);
    return selectionTouches(selection, line.from, line.to);
  };

  const tree = syntaxTree(state);
  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    tree.iterate({
      from: vFrom,
      to: vTo,
      enter: (node) => {
        const name = node.name;

        // --- Headings: line-scale class + hide the `#` marks off-line. ---------
        const heading = HEADING_RE.exec(name);
        if (heading) {
          const line = doc.lineAt(node.from);
          push(Decoration.line({ class: `cm-md-h${heading[1]}` }), line.from, line.from);
          return; // descend for HeaderMark + inline nodes
        }
        if (name === "SetextHeading1" || name === "SetextHeading2") {
          const line = doc.lineAt(node.from);
          const cls = name === "SetextHeading1" ? "cm-md-h1" : "cm-md-h2";
          push(Decoration.line({ class: cls }), line.from, line.from);
          return;
        }
        if (name === "HeaderMark") {
          if (!lineTouched(node.from)) {
            const line = doc.lineAt(node.from);
            let contentStart = node.to;
            while (
              contentStart < line.to &&
              doc.sliceString(contentStart, contentStart + 1) === " "
            ) {
              contentStart += 1;
            }
            if (contentStart > node.from) push(Decoration.replace({}), node.from, contentStart);
          }
          return;
        }

        // --- Inline emphasis: style the span, hide the delimiters off-cursor. --
        if (name === "StrongEmphasis") {
          push(Decoration.mark({ class: "cm-md-strong" }), node.from, node.to);
          return;
        }
        if (name === "Emphasis") {
          push(Decoration.mark({ class: "cm-md-em" }), node.from, node.to);
          return;
        }
        if (name === "Strikethrough") {
          push(Decoration.mark({ class: "cm-md-strike" }), node.from, node.to);
          return;
        }
        if (name === "InlineCode") {
          push(Decoration.mark({ class: "cm-md-code" }), node.from, node.to);
          return;
        }
        if (name === "EmphasisMark" || name === "StrikethroughMark") {
          const parent = node.node.parent;
          if (parent && !selectionTouches(selection, parent.from, parent.to)) {
            push(Decoration.replace({}), node.from, node.to);
          }
          return;
        }
        if (name === "CodeMark") {
          const parent = node.node.parent;
          if (
            parent &&
            parent.name === "InlineCode" &&
            !selectionTouches(selection, parent.from, parent.to)
          ) {
            push(Decoration.replace({}), node.from, node.to);
          }
          return; // fenced-code marks are owned by the FencedCode case below
        }

        // --- Links: styled label, hide `[...](url)`, click opens externally. ---
        if (name === "Link") {
          const linkNode = node.node;
          const reveal = selectionTouches(selection, node.from, node.to);
          const marks = linkNode.getChildren("LinkMark");
          const open = marks[0];
          const closeBracket = marks.find((m) => doc.sliceString(m.from, m.to) === "]");
          const urlNode = linkNode.getChild("URL");
          const url = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
          const labelFrom = open ? open.to : node.from + 1;
          const labelTo = closeBracket ? closeBracket.from : node.to;
          if (labelTo > labelFrom) {
            const spec =
              !reveal && url
                ? { class: "cm-md-link", attributes: { "data-md-href": url } }
                : { class: "cm-md-link" };
            push(Decoration.mark(spec), labelFrom, labelTo);
          }
          if (!reveal) {
            if (labelFrom > node.from) push(Decoration.replace({}), node.from, labelFrom);
            if (node.to > labelTo) push(Decoration.replace({}), labelTo, node.to);
          }
          return false; // fully handled; don't re-process LinkMark/URL children
        }

        // --- Images: render the image when the caret is elsewhere. ------------
        if (name === "Image") {
          if (!selectionTouches(selection, node.from, node.to)) {
            const imgNode = node.node;
            const urlNode = imgNode.getChild("URL");
            const src = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
            const marks = imgNode.getChildren("LinkMark");
            const open = marks[0];
            const closeBracket = marks.find((m) => doc.sliceString(m.from, m.to) === "]");
            const altFrom = open ? open.to : node.from + 2;
            const altTo = closeBracket ? closeBracket.from : altFrom;
            const alt = altTo > altFrom ? doc.sliceString(altFrom, altTo) : "";
            if (src) {
              push(Decoration.replace({ widget: new ImageWidget(src, alt) }), node.from, node.to);
            }
          }
          return false;
        }

        // --- Fenced code: block background; hide the ``` lines off-cursor. -----
        if (name === "FencedCode") {
          const reveal = selectionTouches(selection, node.from, node.to);
          const startLine = doc.lineAt(node.from);
          const endLine = doc.lineAt(Math.max(node.from, Math.min(node.to - 1, doc.length)));
          for (let n = startLine.number; n <= endLine.number; n += 1) {
            const ln = doc.line(n);
            let cls = "cm-md-fence";
            if (n === startLine.number) cls += " cm-md-fence-open";
            if (n === endLine.number) cls += " cm-md-fence-close";
            push(Decoration.line({ class: cls }), ln.from, ln.from);
          }
          if (!reveal && endLine.number > startLine.number) {
            if (startLine.to > startLine.from) {
              push(Decoration.replace({}), startLine.from, startLine.to);
            }
            if (endLine.to > endLine.from) {
              push(Decoration.replace({}), endLine.from, endLine.to);
            }
          }
          return false;
        }

        // --- Horizontal rule --------------------------------------------------
        if (name === "HorizontalRule") {
          const line = doc.lineAt(node.from);
          if (selectionTouches(selection, line.from, line.to)) {
            push(Decoration.line({ class: "cm-md-hr-reveal" }), line.from, line.from);
          } else {
            push(Decoration.replace({ widget: new RuleWidget() }), node.from, node.to);
          }
          return;
        }

        // --- Blockquote: per-line border; hide `>` marks off-line. ------------
        if (name === "Blockquote") {
          const startLine = doc.lineAt(node.from);
          const endLine = doc.lineAt(Math.max(node.from, Math.min(node.to - 1, doc.length)));
          for (let n = startLine.number; n <= endLine.number; n += 1) {
            const ln = doc.line(n);
            push(Decoration.line({ class: "cm-md-blockquote" }), ln.from, ln.from);
          }
          return; // descend for QuoteMark + inline
        }
        if (name === "QuoteMark") {
          if (!lineTouched(node.from)) {
            const line = doc.lineAt(node.from);
            let end = node.to;
            while (end < line.to && doc.sliceString(end, end + 1) === " ") end += 1;
            push(Decoration.replace({}), node.from, end);
          }
          return;
        }

        // --- Lists: bullets → glyph, ordered markers styled, tasks → checkbox -
        if (name === "ListMark") {
          const markText = doc.sliceString(node.from, node.to);
          const ordered = /\d/.test(markText);
          const item = node.node.parent;
          const isTask = item ? item.getChild("Task") !== null : false;
          const reveal = lineTouched(node.from);
          if (ordered) {
            push(Decoration.mark({ class: "cm-md-list-mark" }), node.from, node.to);
          } else if (isTask) {
            if (!reveal) {
              const line = doc.lineAt(node.from);
              let end = node.to;
              while (end < line.to && doc.sliceString(end, end + 1) === " ") end += 1;
              push(Decoration.replace({}), node.from, end);
            }
          } else if (!reveal) {
            push(Decoration.replace({ widget: new BulletWidget() }), node.from, node.to);
          } else {
            push(Decoration.mark({ class: "cm-md-list-mark" }), node.from, node.to);
          }
          return;
        }
        if (name === "TaskMarker") {
          if (!lineTouched(node.from)) {
            const text = doc.sliceString(node.from, node.to);
            const checked = /x/i.test(text);
            push(
              Decoration.replace({ widget: new CheckboxWidget(checked, node.from, node.to) }),
              node.from,
              node.to,
            );
          }
          return;
        }

        return;
      },
    });
  }

  return Decoration.set(decos, true);
}

/**
 * Wrap or unwrap each selection range with `mark` (e.g. `**` for bold). If the
 * text immediately flanking the selection already IS the mark, the pair is
 * stripped (toggle off); otherwise it is inserted.
 */
function toggleWrap(view: EditorView, mark: string): boolean {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const range of state.selection.ranges) {
    const before = state.sliceDoc(Math.max(0, range.from - mark.length), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + mark.length));
    if (before === mark && after === mark) {
      changes.push({ from: range.from - mark.length, to: range.from, insert: "" });
      changes.push({ from: range.to, to: range.to + mark.length, insert: "" });
    } else {
      changes.push({ from: range.from, to: range.from, insert: mark });
      changes.push({ from: range.to, to: range.to, insert: mark });
    }
  }
  view.dispatch(state.update({ changes }));
  return true;
}

/** ⌘B / ⌘I emphasis toggles + Escape-to-blur (the caller keeps its own key handling). */
export const markdownFormatKeymap: readonly KeyBinding[] = [
  { key: "Mod-b", run: (view) => toggleWrap(view, "**") },
  { key: "Mod-i", run: (view) => toggleWrap(view, "*") },
  {
    key: "Escape",
    run: (view) => {
      view.contentDOM.blur();
      return true;
    },
  },
];

/** The editor theme — every value maps to a token from globals.css/typeset.css. */
const liveTheme = EditorView.theme(
  {
    "&": {
      color: "var(--foreground)",
      fontFamily: "var(--font-sans)",
      fontSize: "0.875rem",
      backgroundColor: "transparent",
      // Fill a definite-height host (artifact pane) and take the host's
      // min-height as a clickable floor (empty ticket body).
      height: "100%",
      minHeight: "inherit",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.7" },
    ".cm-content": {
      fontFamily: "var(--font-sans)",
      lineHeight: "1.7",
      padding: "0",
      caretColor: "var(--foreground)",
    },
    ".cm-line": { padding: "0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
    ".cm-placeholder": { color: "var(--muted-foreground)" },
    ".cm-md-h1": {
      fontSize: "1.6em",
      fontWeight: "600",
      lineHeight: "1.3",
      letterSpacing: "-0.01em",
    },
    ".cm-md-h2": {
      fontSize: "1.35em",
      fontWeight: "600",
      lineHeight: "1.3",
      letterSpacing: "-0.01em",
    },
    ".cm-md-h3": { fontSize: "1.15em", fontWeight: "600", lineHeight: "1.3" },
    ".cm-md-h4": { fontSize: "1em", fontWeight: "600" },
    ".cm-md-h5": { fontSize: "0.9em", fontWeight: "600", color: "var(--muted-foreground)" },
    ".cm-md-h6": { fontSize: "0.9em", fontWeight: "600", color: "var(--muted-foreground)" },
    ".cm-md-strong": { fontWeight: "600", color: "var(--foreground)" },
    ".cm-md-em": { fontStyle: "italic" },
    ".cm-md-strike": { textDecoration: "line-through", color: "var(--muted-foreground)" },
    ".cm-md-code": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.9em",
      padding: "0.1em 0.35em",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)",
      background: "var(--muted)",
    },
    ".cm-md-link": {
      color: "var(--primary)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
      cursor: "pointer",
    },
    ".cm-md-list-mark": { color: "var(--muted-foreground)" },
    ".cm-md-bullet": { color: "var(--muted-foreground)" },
    ".cm-md-blockquote": {
      borderLeft: "3px solid var(--border-strong)",
      paddingLeft: "1em",
      color: "var(--muted-foreground)",
    },
    ".cm-md-fence": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.9em",
      background: "var(--card)",
      borderLeft: "1px solid var(--border)",
      borderRight: "1px solid var(--border)",
      paddingLeft: "1em",
      paddingRight: "1em",
    },
    ".cm-md-fence-open": {
      borderTop: "1px solid var(--border)",
      borderTopLeftRadius: "var(--radius-md)",
      borderTopRightRadius: "var(--radius-md)",
      paddingTop: "0.3em",
    },
    ".cm-md-fence-close": {
      borderBottom: "1px solid var(--border)",
      borderBottomLeftRadius: "var(--radius-md)",
      borderBottomRightRadius: "var(--radius-md)",
      paddingBottom: "0.3em",
    },
    ".cm-md-hr": { display: "inline-block", width: "100%", verticalAlign: "middle" },
    ".cm-md-hr hr": { border: "0", borderTop: "1px solid var(--border)", margin: "0.5em 0" },
    ".cm-md-image img": { maxWidth: "100%", height: "auto", borderRadius: "var(--radius-md)" },
    ".cm-md-task-checkbox": {
      marginRight: "0.5em",
      accentColor: "var(--primary)",
      verticalAlign: "middle",
      cursor: "pointer",
    },
  },
  { dark: true },
);

/** The full live-preview extension: decoration plugin + external-link click + theme. */
export function markdownLivePreview(): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate): void {
        // Reveal depends on the selection, so rebuild on selection changes too.
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (value) => value.decorations,
      eventHandlers: {
        mousedown(event) {
          const target = event.target as HTMLElement | null;
          const link = target?.closest<HTMLElement>("[data-md-href]");
          if (!link) return false;
          // A collapsed link only carries `data-md-href` while the caret is
          // outside it, so a hit here always means "open", never "edit".
          event.preventDefault();
          const href = link.getAttribute("data-md-href");
          // Routed through the main process's window-open handler (shell.openExternal).
          if (href) window.open(href, "_blank", "noopener");
          return true;
        },
      },
    },
  );

  return [plugin, liveTheme];
}
