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
 * ## Sizing
 *
 * Font sizes and weights stay in CSS (`document-mode.css`), where DESIGN.md's
 * type scale lives. Monaco only needs to be told when a line's box has to grow,
 * which it cannot infer from a class it never parses — hence the `lineHeight`
 * multipliers below, which are the one piece of heading geometry duplicated out
 * of the stylesheet and are asserted against it by nothing but review.
 */
import type { ProjectionOp } from "./markdown-projection";
import { buildLineIndex, lineAt, lineNumbered, spanToRange, type TextRange } from "./text-position";

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
 * Line-box growth for the line classes whose text is bigger than the editor's
 * font size. Only h1–h3 need it: h4 renders at the body size and h5/h6 below it,
 * so the default line box already fits them.
 */
const LINE_HEIGHT_MULTIPLIERS: Readonly<Record<string, number>> = {
  "volli-md-h1": 1.9,
  "volli-md-h2": 1.6,
  "volli-md-h3": 1.35,
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
          // Both layers on purpose: `className` paints the full-width box a
          // blockquote border or code-fence background needs, `inlineClassName`
          // is the only one that can reach the glyphs.
          className: op.className,
          inlineClassName: op.className,
          inlineClassNameAffectsLetterSpacing: true,
          isWholeLine: true,
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
          className: "volli-md-hr",
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
