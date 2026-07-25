/**
 * Offset ↔ Monaco position mapping for the Document Mode projection.
 *
 * The projection engine (`markdown-projection.ts`) and the `@file` reference
 * parser both speak character offsets, because that is the coordinate the
 * markdown parser and the reveal rule use. Monaco speaks positions: a 1-based
 * line number and a 1-based column. This module is the only place that
 * conversion happens, so the off-by-one lives in exactly one tested spot.
 *
 * Two conventions to hold on to:
 *  - `to` on a line is the offset just past its last CHARACTER, excluding the
 *    line terminator — the same convention CodeMirror's `doc.lineAt()` uses, so
 *    the geometry ported from the live-preview plugin keeps working verbatim.
 *  - `\r\n` is one terminator, not two. Monaco normalizes a model's EOL, but the
 *    text handed to this module is whatever came off disk, so a CRLF document
 *    must not be read as a trailing `\r` character on every line.
 */

/** A Monaco position: 1-based on both axes. */
export interface TextPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** A Monaco range (`IRange`), 1-based on both axes. */
export interface TextRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

/** One line of the document, in offsets. `to` excludes the line terminator. */
export interface DocumentLine {
  /** 1-based, matching Monaco's line numbering. */
  readonly number: number;
  readonly from: number;
  readonly to: number;
}

/**
 * A prebuilt line table for one document. Built once per projection pass —
 * every lookup below is O(log n) against it rather than rescanning the text.
 */
export interface LineIndex {
  /** Offset of each line's first character. Always at least one entry. */
  readonly starts: readonly number[];
  /** Offset just past each line's last character, terminator excluded. */
  readonly ends: readonly number[];
  /** Total character length of the indexed text. */
  readonly length: number;
}

/** Build the line table for `text`. An empty document is one empty line. */
export function buildLineIndex(text: string): LineIndex {
  const starts: number[] = [0];
  const ends: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "\n") continue;
    // A `\r` immediately before the `\n` belongs to the terminator, not to the
    // line's content.
    ends.push(i > 0 && text[i - 1] === "\r" ? i - 1 : i);
    starts.push(i + 1);
  }
  ends.push(text.length);
  return { starts, ends, length: text.length };
}

/** How many lines the document has. A trailing newline opens a final empty line. */
export function lineCount(index: LineIndex): number {
  return index.starts.length;
}

/**
 * The line holding `offset`. Offsets outside the document clamp to the first or
 * last line rather than throwing — callers are porting spans out of a parser
 * that may sit one past the end of the buffer.
 */
export function lineAt(index: LineIndex, offset: number): DocumentLine {
  const { starts } = index;
  // Largest `i` with starts[i] <= offset. A negative offset leaves `lo` at 0.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lineNumbered(index, lo + 1);
}

/**
 * The line with the given 1-based number, clamped into range. This is the
 * `doc.line(n)` counterpart the ported block-decoration loops walk with.
 */
export function lineNumbered(index: LineIndex, number: number): DocumentLine {
  const last = index.starts.length;
  const clamped = number < 1 ? 1 : number > last ? last : number;
  const i = clamped - 1;
  return { number: clamped, from: index.starts[i], to: index.ends[i] };
}

/** The Monaco position for a character offset, clamped into the document. */
export function offsetToPosition(index: LineIndex, offset: number): TextPosition {
  const line = lineAt(index, offset);
  // An offset landing inside a `\r\n` terminator clamps to the line's end
  // column, which is where Monaco would put a caret at "end of line" anyway.
  const clamped = offset < line.from ? line.from : offset > line.to ? line.to : offset;
  return { lineNumber: line.number, column: clamped - line.from + 1 };
}

/**
 * The Monaco range for a `[from, to)` offset span. Callers pass spans straight
 * out of the markdown tree, which are always ordered and never reversed.
 */
export function spanToRange(index: LineIndex, from: number, to: number): TextRange {
  const start = offsetToPosition(index, from);
  const end = offsetToPosition(index, to);
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}
