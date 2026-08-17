/**
 * Projection ops → Monaco decoration descriptors.
 *
 * `markdown-projection.ts` says WHAT the document should look like in character
 * offsets; this module says how that lands on Monaco, in Monaco's own
 * coordinates and option shapes. It is deliberately the whole translation, and
 * deliberately pure: the only thing left for the editor glue is to hand these
 * descriptors to `editor.createDecorationsCollection()` and to build the DOM for
 * the one op family Monaco has no declarative answer for (images).
 *
 * ## Hiding text in Monaco
 *
 * This is the hard part of the port and the reason the descriptor shape looks
 * the way it does. CodeMirror has `Decoration.replace()`, which removes a span
 * from the rendered document outright. Monaco has no equivalent, and the two
 * things that sound like one are not:
 *
 *  - `editor.setHiddenAreas()` hides whole LINES (it is the folding mechanism).
 *    Markdown syntax to collapse — `#`, `**`, `[`, `](url)` — is almost always a
 *    fragment of a line, so this can't express it.
 *  - Content widgets are absolutely-positioned overlays that reserve no space in
 *    the line, so hiding text with one would leave the original text underneath.
 *
 * What does work is an `inlineClassName` whose CSS is `display: none`. Monaco
 * splits a rendered view line into one span per decoration range, so the class
 * lands on a span that contains exactly the characters to collapse, and the
 * browser removes it from layout. The catch — and the reason
 * `inlineClassNameAffectsLetterSpacing` is set on every decoration this module
 * emits that changes glyph metrics — is that Monaco otherwise assumes every
 * character is one grid cell wide and computes cursor/selection geometry
 * arithmetically. With the flag set it measures the real DOM ranges instead, so
 * a caret placed after a collapsed `**` lands where the visible text is rather
 * than two invisible columns to the right.
 *
 * Injected text (`before`) is the other half: it is Monaco's supported way to
 * put glyphs into a line that the model does not contain (it is how inlay hints
 * work), and unlike a widget it participates in layout and in cursor movement.
 * That is what renders a list bullet in place of a hidden `-`.
 *
 * ## The two layers of a line class
 *
 * A `line-class` op names ONE class, and Monaco has two places to put it:
 * `className`, which lands on the full-width element it draws behind the line,
 * and `inlineClassName`, which lands on the glyph spans themselves. They are
 * not interchangeable and they are not both always wanted. A code fence's
 * ground and a blockquote's rule are a BOX — they have to be painted once,
 * across the whole line, including the empty run past the last character. A
 * heading is TEXT — it has no box at all, and a whole-line decoration carrying
 * it would only put an element that paints nothing on every heading line.
 *
 * So the box layer is emitted only for the classes that have one (below), and
 * the stylesheet keeps every box property under `volli-md-box` — the marker
 * class that rides the whole-line element and nothing else. Without that split
 * the same class is on both layers, and a box property is drawn again for every
 * span in the line: the blockquote rule reappears in front of each run of text,
 * and the fence's ground repaints over the selection wash Monaco draws beneath
 * the glyphs.
 *
 * ## Sizing
 *
 * Font sizes and weights stay in CSS (`document-mode.css`), where DESIGN.md's
 * type scale lives. Monaco only needs to be told when a line's box has to grow,
 * which it cannot infer from a class it never parses — hence the `lineHeight`
 * multipliers below, which are the one piece of heading geometry duplicated out
 * of the stylesheet and are asserted against it by nothing but review.
 */
import type { ProjectionOp } from "./markdown-projection";
import {
  buildLineIndex,
  lineAt,
  lineNumbered,
  spanToRange,
  type TextPosition,
  type TextRange,
} from "./text-position";

/**
 * `monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges`. Inlined as
 * a number so this module stays free of a Monaco value import (it must run in
 * the Node test environment). Every decoration here is a projection of the
 * CURRENT text and is rebuilt on the next content change, so growing at the
 * edges would only ever mean "swallow the character just typed" for one frame —
 * long enough to look like the editor ate it.
 */
export const NEVER_GROWS_WHEN_TYPING_AT_EDGES = 1;

/** Text Monaco renders into a line without the model containing it. */
export interface InjectedText {
  readonly content: string;
  readonly inlineClassName: string;
  readonly inlineClassNameAffectsLetterSpacing: boolean;
}

/**
 * The subset of `monaco.editor.IModelDecorationOptions` Document Mode uses.
 * Structural rather than imported so the descriptors can be built and asserted
 * without loading Monaco; it is assignable to the real interface.
 */
export interface DocumentDecorationOptions {
  /** Background/box layer, behind the text. Full width when `isWholeLine`. */
  readonly className?: string;
  /** Wraps the characters themselves — the only layer that can collapse them. */
  readonly inlineClassName?: string;
  readonly inlineClassNameAffectsLetterSpacing?: boolean;
  readonly isWholeLine?: boolean;
  /** Multiplier on the editor's line height, for lines whose text outgrows it. */
  readonly lineHeight?: number;
  readonly before?: InjectedText;
  readonly stickiness?: number;
}

export interface DocumentDecoration {
  readonly range: TextRange;
  readonly options: DocumentDecorationOptions;
}

/** A followable link label, for the editor's mouse handler. */
export interface DocumentLinkTarget {
  readonly range: TextRange;
  readonly href: string;
}

/** A task marker the user can click to toggle, with the edit it implies. */
export interface DocumentCheckbox {
  readonly range: TextRange;
  readonly checked: boolean;
  /** The literal marker to write when this checkbox is clicked. */
  readonly toggledText: string;
}

/**
 * An image to render. Monaco cannot put an `<img>` inline (see the widget note
 * above), so Document Mode hides the `![alt](src)` source and renders the image
 * in a view zone directly beneath its line — Monaco's only mechanism for block
 * content that actually reserves vertical space.
 */
export interface DocumentImage {
  readonly afterLineNumber: number;
  readonly src: string;
  readonly alt: string;
}

/** Everything one projection pass tells the editor to do. */
export interface DocumentRender {
  readonly decorations: readonly DocumentDecoration[];
  readonly links: readonly DocumentLinkTarget[];
  readonly checkboxes: readonly DocumentCheckbox[];
  readonly images: readonly DocumentImage[];
}

/** The class that collapses a span to zero width (see the module note). */
export const HIDDEN_CLASS = "volli-md-hidden";

/**
 * The marker the whole-line element carries and the glyph spans never do. Every
 * box property in the stylesheet hangs off it, so a class that reaches both
 * layers still paints its box exactly once (see the module note).
 */
export const LINE_BOX_CLASS = "volli-md-box";

/**
 * The line classes that paint a box behind the line rather than styling its
 * text: a fenced block's ground and a blockquote's rule. Their `-open`/`-close`
 * companions round the ends of that same box, so they ride along with it and do
 * not need to be listed. Everything else a `line-class` op can name — the
 * headings, a revealed thematic break — is text only.
 */
const LINE_BOX_CLASSES: ReadonlySet<string> = new Set(["volli-md-fence", "volli-md-blockquote"]);

/** Whether a (possibly compound) line-class list paints a box behind the line. */
function paintsLineBox(className: string): boolean {
  return className.split(/\s+/).some((name) => LINE_BOX_CLASSES.has(name));
}

/**
 * Line-box growth for the line classes whose text is bigger than the editor's
 * font size. Only h1–h2 need it now that the heading sizes ride the app's type
 * scale: h3 renders at the body step and h4–h6 below it, so the default line box
 * already fits them.
 *
 * The numbers are the editor's own line height (24px for 14px text) scaled to
 * keep one ratio the stylesheet has always implied — a heading's line box is
 * ~2.03× its font size. h1 is 24px → 2.05; h2 is 18px → 1.5.
 */
const LINE_HEIGHT_MULTIPLIERS: Readonly<Record<string, number>> = {
  "volli-md-h1": 2.05,
  "volli-md-h2": 1.5,
};

/**
 * The growth asked for by a (possibly compound) line-class list — `line-class`
 * ops carry several classes at once for fenced code. No two entries of the table
 * above can appear together, so the first match is the answer.
 */
function lineHeightFor(className: string): number | undefined {
  for (const name of className.split(/\s+/)) {
    const multiplier = LINE_HEIGHT_MULTIPLIERS[name];
    if (multiplier !== undefined) return multiplier;
  }
  return undefined;
}

export interface RenderProjectionInput {
  readonly text: string;
  readonly ops: readonly ProjectionOp[];
}

/**
 * Translate one projection pass. Ops arrive in tree order, unsorted and
 * undeduplicated (see `projectMarkdown`); Monaco's decoration collection sorts
 * and layers for itself, so this preserves the order it was given.
 */
export function renderProjection(input: RenderProjectionInput): DocumentRender {
  const index = buildLineIndex(input.text);
  const decorations: DocumentDecoration[] = [];
  const links: DocumentLinkTarget[] = [];
  const checkboxes: DocumentCheckbox[] = [];
  const images: DocumentImage[] = [];

  /** The span's Monaco range, or null when it covers no characters at all. */
  const rangeOf = (from: number, to: number): TextRange | null =>
    to <= from ? null : spanToRange(index, from, to);

  const hide = (from: number, to: number): void => {
    const range = rangeOf(from, to);
    if (range === null) return;
    decorations.push({
      range,
      options: {
        inlineClassName: HIDDEN_CLASS,
        inlineClassNameAffectsLetterSpacing: true,
        stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
      },
    });
  };

  for (const op of input.ops) {
    if (op.kind === "line-class") {
      const line = lineNumbered(index, op.line);
      decorations.push({
        range: {
          startLineNumber: line.number,
          startColumn: 1,
          endLineNumber: line.number,
          endColumn: line.to - line.from + 1,
        },
        options: {
          // The box layer, and only for a class that has a box to paint (see
          // the module note). `volli-md-box` is what the stylesheet hangs those
          // properties off, so the class below can also reach the glyphs
          // without painting its box a second time on each of them.
          ...(paintsLineBox(op.className)
            ? { className: `${LINE_BOX_CLASS} ${op.className}`, isWholeLine: true }
            : {}),
          // The only layer that can reach the glyphs — the block's face and
          // colour, whether or not anything is drawn behind them.
          inlineClassName: op.className,
          inlineClassNameAffectsLetterSpacing: true,
          lineHeight: lineHeightFor(op.className),
          stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
        },
      });
      continue;
    }

    if (op.kind === "inline-class") {
      const range = rangeOf(op.from, op.to);
      if (range === null) continue;
      decorations.push({
        range,
        options: {
          inlineClassName: op.className,
          inlineClassNameAffectsLetterSpacing: true,
          stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
        },
      });
      continue;
    }

    if (op.kind === "hide") {
      hide(op.from, op.to);
      continue;
    }

    if (op.kind === "link") {
      const range = rangeOf(op.from, op.to);
      if (range === null) continue;
      // The extra class is what turns the label into an affordance: a revealed
      // link (href null — the user is editing it) stays styled but must not
      // offer a pointer cursor for a click that will not navigate.
      const className = op.href === null ? op.className : `${op.className} volli-md-link-open`;
      decorations.push({
        range,
        options: {
          inlineClassName: className,
          inlineClassNameAffectsLetterSpacing: true,
          stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
        },
      });
      if (op.href !== null) links.push({ range, href: op.href });
      continue;
    }

    const { widget } = op;
    if (widget.type === "bullet") {
      const range = rangeOf(op.from, op.to);
      if (range === null) continue;
      decorations.push({
        range,
        options: {
          // Collapse the `-`/`*`/`+` and inject the glyph in its place, so the
          // marker is one rendered unit rather than a bullet beside a dash.
          inlineClassName: HIDDEN_CLASS,
          inlineClassNameAffectsLetterSpacing: true,
          before: {
            content: "•",
            inlineClassName: "volli-md-bullet",
            inlineClassNameAffectsLetterSpacing: true,
          },
          stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
        },
      });
      continue;
    }

    if (widget.type === "checkbox") {
      const range = rangeOf(op.from, op.to);
      if (range === null) continue;
      const state = widget.checked ? "volli-md-checkbox-on" : "volli-md-checkbox-off";
      decorations.push({
        range,
        options: {
          // The box is drawn by the class's `::before`; the `[ ]` text itself
          // collapses to nothing inside it (see document-mode.css).
          inlineClassName: `volli-md-checkbox ${state}`,
          inlineClassNameAffectsLetterSpacing: true,
          stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
        },
      });
      checkboxes.push({
        range,
        checked: widget.checked,
        // Byte-level, exactly as the CodeMirror widget wrote it: the marker is
        // the document, so toggling writes markdown and nothing else.
        toggledText: widget.checked ? "[ ]" : "[x]",
      });
      continue;
    }

    if (widget.type === "rule") {
      const line = lineAt(index, op.from);
      hide(op.from, op.to);
      decorations.push({
        range: {
          startLineNumber: line.number,
          startColumn: 1,
          endLineNumber: line.number,
          endColumn: line.to - line.from + 1,
        },
        options: {
          // A rule is nothing BUT a box — no inline layer, since the `---` it
          // replaces is hidden. It still takes the marker, so "a box property
          // lives under `volli-md-box`" holds for the whole stylesheet.
          className: `${LINE_BOX_CLASS} volli-md-hr`,
          isWholeLine: true,
          stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
        },
      });
      continue;
    }

    hide(op.from, op.to);
    images.push({
      afterLineNumber: lineAt(index, op.from).number,
      src: widget.src,
      alt: widget.alt,
    });
  }

  return { decorations, links, checkboxes, images };
}

/**
 * The target a click landed on, or null.
 *
 * Monaco's mouse events report a model POSITION, not the decoration under the
 * pointer: `IMouseTarget` exposes the element only for its own built-in
 * decorations, and injected text/inline classes are not among them. So the
 * editor asks this instead, against the ranges the current projection produced —
 * which are never stale, because a projection pass runs on every content change
 * and no edit can happen between one and a click.
 *
 * The end column is exclusive: it is where the character AFTER the span starts,
 * so a click there belongs to whatever comes next, not to this target. The start
 * column is inclusive, matching how a caret sitting on a boundary is treated
 * everywhere else in this layer.
 */
export function targetAt<Target extends { readonly range: TextRange }>(
  targets: readonly Target[],
  position: TextPosition,
): Target | null {
  for (const target of targets) {
    const { range } = target;
    if (position.lineNumber < range.startLineNumber) continue;
    if (position.lineNumber > range.endLineNumber) continue;
    if (position.lineNumber === range.startLineNumber && position.column < range.startColumn) {
      continue;
    }
    if (position.lineNumber === range.endLineNumber && position.column >= range.endColumn) continue;
    return target;
  }
  return null;
}
