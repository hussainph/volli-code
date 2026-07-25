/**
 * The Obsidian-style live-preview projection, as pure data.
 *
 * Given the document text and where the selection is, this walks the lezer
 * markdown tree and returns the list of things a renderer should do: style a
 * line, style an inline span, hide raw syntax, or replace a span with a widget.
 * It decides nothing about *how* those land on screen — that is the renderer's
 * job (Monaco decorations + content widgets in PR 2).
 *
 * Why it is pure and renderer-free:
 *  - It is a straight port of the CodeMirror `live-preview.ts` view plugin, and
 *    the port is only trustworthy if the behaviour is testable. Renderer tests
 *    here run in Node with no DOM, so anything that touches an editor instance
 *    is untestable by construction; anything that returns plain objects is
 *    exhaustively testable.
 *  - `reveal.ts` already owns the "is the selection touching this node?" rule
 *    that both renderers share. Keeping the projection pure keeps that rule the
 *    single behavioural contract of the migration.
 *
 * Two deliberate departures from the CodeMirror plugin:
 *  - The plugin only decorates `view.visibleRanges` (viewport culling). That is
 *    a renderer performance concern, not a projection rule, so this function is
 *    total over the document and the caller may cull as it likes.
 *  - The plugin reads `view.hasFocus` itself. Here focus is an input: `focused:
 *    false` reveals nothing, exactly like a blurred CodeMirror editor, because
 *    an invisible selection leaving raw delimiters on screen reads as a
 *    rendering glitch.
 *
 * Coordinates are character offsets — the same currency the markdown parser,
 * `reveal.ts` and `parseFileRefs` all speak. Only line-scale ops carry a Monaco
 * line number, mapped through `text-position.ts`.
 */
import { Emoji, GFM, parser, Subscript, Superscript } from "@lezer/markdown";

import { selectionTouches, type SelRange } from "./reveal";
import { buildLineIndex, lineAt } from "./text-position";

/**
 * The exact dialect `@codemirror/lang-markdown`'s `markdownLanguage` configures
 * (GFM + subscript/superscript/emoji). It matters beyond the extra node types:
 * enabling Subscript changes how `~…~` parses, so a parser missing it would
 * disagree with the CodeMirror editor about what is even a strikethrough.
 */
const markdownParser = parser.configure([GFM, Subscript, Superscript, Emoji]);

const HEADING_RE = /^ATXHeading([1-6])$/;

/** Inline containers that keep their text but get styled: node name → class. */
const INLINE_CLASSES: Readonly<Record<string, string | undefined>> = {
  StrongEmphasis: "volli-md-strong",
  Emphasis: "volli-md-em",
  Strikethrough: "volli-md-strike",
  InlineCode: "volli-md-code",
};

/**
 * The delimiter child each inline container collapses when the caret is away.
 * Looking marks up from the container (rather than handling the mark nodes on
 * their own) is what keeps `CodeMark` unambiguous: the identically-named fence
 * marks of a `FencedCode` block are never reached this way, and stay owned by
 * the fenced-code rule.
 */
const INLINE_MARKS: Readonly<Record<string, string>> = {
  StrongEmphasis: "EmphasisMark",
  Emphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  InlineCode: "CodeMark",
};

/** One instruction for the renderer. Offsets are character offsets into the text. */
export type ProjectionOp =
  /** Style a whole line (heading scale, blockquote, fenced-code block). */
  | { kind: "line-class"; line: number; className: string }
  /** Style an inline span in place, leaving its text visible. */
  | { kind: "inline-class"; from: number; to: number; className: string }
  /** Collapse a span to nothing — raw syntax the caret is currently away from. */
  | { kind: "hide"; from: number; to: number }
  /**
   * A link's label. `href` is null while the link is revealed (the user is
   * editing it, so a click must not navigate) and for reference links, which
   * carry no inline destination.
   */
  | { kind: "link"; from: number; to: number; className: string; href: string | null }
  /** Replace a span with rendered output instead of text. */
  | { kind: "widget"; from: number; to: number; widget: ProjectionWidget };

/** The rendered stand-ins a `widget` op can ask for. */
export type ProjectionWidget =
  /** A `[ ]`/`[x]` task marker, rendered as a real checkbox. */
  | { type: "checkbox"; checked: boolean }
  /** A `-`/`*`/`+` list marker, rendered as a bullet glyph. */
  | { type: "bullet" }
  /** A `---`/`***`/`___` thematic break, rendered as a horizontal rule. */
  | { type: "rule" }
  /** An inline image, rendered from its source URL. */
  | { type: "image"; src: string; alt: string };

/** What `projectMarkdown` needs to know about the document's current condition. */
export interface ProjectionInput {
  /** The full document text. */
  readonly text: string;
  /** Selection ranges, normalized so `from <= to`. A bare caret is `from === to`. */
  readonly selection: readonly SelRange[];
  /** False (a blurred editor) reveals nothing, whatever the selection says. */
  readonly focused: boolean;
}

/**
 * Project one markdown document into renderer instructions.
 *
 * Ops come back in tree-traversal order (document order for block starts,
 * outer node before inner). Nothing here is sorted or deduplicated: a renderer
 * that needs sorted decorations sorts them itself, which is what both
 * CodeMirror's `Decoration.set` and Monaco's decoration collection do anyway.
 */
export function projectMarkdown(input: ProjectionInput): readonly ProjectionOp[] {
  const { text } = input;
  const selection: readonly SelRange[] = input.focused ? input.selection : [];
  const index = buildLineIndex(text);
  const ops: ProjectionOp[] = [];

  /** Whether the selection touches the whole line holding `pos` (block reveal). */
  const lineTouched = (pos: number): boolean => {
    const line = lineAt(index, pos);
    return selectionTouches(selection, line.from, line.to);
  };

  /**
   * Raw block syntax is hidden together with the whitespace that separates it
   * from the content (`# `, `> `, `- `), or the indent would survive the
   * collapse and the rendered line would start one space in.
   */
  const throughTrailingSpace = (from: number, to: number): number => {
    const line = lineAt(index, from);
    let end = to;
    while (end < line.to && text[end] === " ") end += 1;
    return end;
  };

  markdownParser.parse(text).iterate({
    enter: (node) => {
      const heading = HEADING_RE.exec(node.name);
      if (heading !== null) {
        ops.push({
          kind: "line-class",
          line: lineAt(index, node.from).number,
          className: `volli-md-h${heading[1]}`,
        });
        return; // descend for HeaderMark + inline nodes
      }
      if (node.name === "SetextHeading1" || node.name === "SetextHeading2") {
        ops.push({
          kind: "line-class",
          line: lineAt(index, node.from).number,
          className: node.name === "SetextHeading1" ? "volli-md-h1" : "volli-md-h2",
        });
        return;
      }
      if (node.name === "HeaderMark") {
        if (!lineTouched(node.from)) {
          ops.push({ kind: "hide", from: node.from, to: throughTrailingSpace(node.from, node.to) });
        }
        return;
      }

      // --- Inline emphasis: style the span, hide the delimiters off-cursor. --
      const inlineClass = INLINE_CLASSES[node.name];
      if (inlineClass !== undefined) {
        ops.push({ kind: "inline-class", from: node.from, to: node.to, className: inlineClass });
        if (!selectionTouches(selection, node.from, node.to)) {
          // The delimiters are hidden from HERE rather than when the mark node
          // itself is entered, so the reveal test reads the container's span
          // without a parent lookup. Nested spans still reveal independently:
          // each container asks the question about its own [from, to].
          for (const mark of node.node.getChildren(INLINE_MARKS[node.name])) {
            ops.push({ kind: "hide", from: mark.from, to: mark.to });
          }
        }
        return; // descend: emphasis can nest, and can contain links/code
      }

      // --- Links: styled label, `[…](url)` hidden off-cursor, href carried. --
      if (node.name === "Link") {
        const link = node.node;
        const reveal = selectionTouches(selection, node.from, node.to);
        // A Link's first two direct LinkMark children are always its `[` and
        // `]`, in that order — the parser will not admit a Link without both,
        // and `getChildren` skips the marks of any nested image/link.
        const [openMark, closeMark] = link.getChildren("LinkMark");
        const labelFrom = openMark.to;
        const labelTo = closeMark.from;
        const urlNode = link.getChild("URL");
        const url = urlNode === null ? "" : text.slice(urlNode.from, urlNode.to);
        if (labelTo > labelFrom) {
          ops.push({
            kind: "link",
            from: labelFrom,
            to: labelTo,
            className: "volli-md-link",
            // A revealed link is being edited, not followed; and a reference
            // link has no inline destination to follow in the first place.
            href: !reveal && url !== "" ? url : null,
          });
        }
        if (!reveal) {
          ops.push({ kind: "hide", from: node.from, to: labelFrom });
          ops.push({ kind: "hide", from: labelTo, to: node.to });
        }
        // Fully handled: the label is one styled span, so re-decorating markup
        // inside it would collapse text the link still has to show.
        return false;
      }

      // --- Images: render the image when the caret is elsewhere. ------------
      if (node.name === "Image") {
        if (!selectionTouches(selection, node.from, node.to)) {
          const image = node.node;
          const urlNode = image.getChild("URL");
          const src = urlNode === null ? "" : text.slice(urlNode.from, urlNode.to);
          const [openMark, closeMark] = image.getChildren("LinkMark");
          const alt = text.slice(openMark.to, closeMark.from);
          // A reference image (`![alt]`) has nothing to load; showing its raw
          // syntax is more useful than an empty box.
          if (src !== "") {
            ops.push({
              kind: "widget",
              from: node.from,
              to: node.to,
              widget: { type: "image", src, alt },
            });
          }
        }
        return false;
      }

      // --- Fenced code: block background; hide the ``` lines off-cursor. -----
      if (node.name === "FencedCode") {
        const reveal = selectionTouches(selection, node.from, node.to);
        const startLine = lineAt(index, node.from);
        // `to - 1` steps back off the terminator the block ends past, so the
        // last line of the block is the last line that HOLDS something.
        const endLine = lineAt(index, Math.max(node.from, Math.min(node.to - 1, index.length)));
        for (let n = startLine.number; n <= endLine.number; n += 1) {
          let className = "volli-md-fence";
          if (n === startLine.number) className += " volli-md-fence-open";
          if (n === endLine.number) className += " volli-md-fence-close";
          ops.push({ kind: "line-class", line: n, className });
        }
        // A one-line block is all fence and no content: collapsing it would
        // leave nothing on screen to put the caret back into.
        if (!reveal && endLine.number > startLine.number) {
          // The opening line always holds its ``` run, so it is never empty.
          ops.push({ kind: "hide", from: startLine.from, to: startLine.to });
          // The closing line can be: an unterminated block runs to a blank line.
          if (endLine.to > endLine.from) {
            ops.push({ kind: "hide", from: endLine.from, to: endLine.to });
          }
        }
        return false;
      }

      // --- Horizontal rule --------------------------------------------------
      if (node.name === "HorizontalRule") {
        if (lineTouched(node.from)) {
          // Still line-scale styling: an un-styled `***` would jump in size the
          // moment the caret lands on it.
          ops.push({
            kind: "line-class",
            line: lineAt(index, node.from).number,
            className: "volli-md-hr-reveal",
          });
        } else {
          ops.push({ kind: "widget", from: node.from, to: node.to, widget: { type: "rule" } });
        }
        return;
      }

      // --- Blockquote: per-line border; hide `>` marks off-line. ------------
      if (node.name === "Blockquote") {
        const startLine = lineAt(index, node.from);
        const endLine = lineAt(index, Math.max(node.from, Math.min(node.to - 1, index.length)));
        for (let n = startLine.number; n <= endLine.number; n += 1) {
          ops.push({ kind: "line-class", line: n, className: "volli-md-blockquote" });
        }
        return; // descend for QuoteMark + inline
      }
      if (node.name === "QuoteMark") {
        // Per LINE, not per block: a multi-line quote reveals only the marker
        // on the line being edited, so the rest stays rendered.
        if (!lineTouched(node.from)) {
          ops.push({ kind: "hide", from: node.from, to: throughTrailingSpace(node.from, node.to) });
        }
        return;
      }

      return;
    },
  });

  return ops;
}
