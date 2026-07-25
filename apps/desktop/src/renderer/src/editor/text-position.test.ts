import { describe, expect, it } from "vite-plus/test";

import {
  buildLineIndex,
  lineAt,
  lineCount,
  lineNumbered,
  offsetToPosition,
  spanToRange,
} from "./text-position";

describe("lineAt", () => {
  it("reports the line holding an offset, with the terminator outside the span", () => {
    const index = buildLineIndex("alpha\nbeta\ngamma");

    expect(lineAt(index, 0)).toEqual({ number: 1, from: 0, to: 5 });
    expect(lineAt(index, 6)).toEqual({ number: 2, from: 6, to: 10 });
    expect(lineAt(index, 13)).toEqual({ number: 3, from: 11, to: 16 });
  });

  it("puts an offset resting on a line boundary on the line it starts", () => {
    const index = buildLineIndex("alpha\nbeta");

    // Offset 5 is the newline itself — still the end of line 1.
    expect(lineAt(index, 5).number).toBe(1);
    // Offset 6 is the first character of line 2.
    expect(lineAt(index, 6).number).toBe(2);
  });

  it("clamps offsets outside the document onto the first and last line", () => {
    const index = buildLineIndex("alpha\nbeta");

    expect(lineAt(index, -10).number).toBe(1);
    expect(lineAt(index, 9999).number).toBe(2);
  });

  it("treats a CRLF terminator as one break, not a trailing character", () => {
    const index = buildLineIndex("alpha\r\nbeta");

    expect(lineAt(index, 0)).toEqual({ number: 1, from: 0, to: 5 });
    expect(lineAt(index, 7)).toEqual({ number: 2, from: 7, to: 11 });
  });

  it("does not mistake a lone leading newline for a CRLF terminator", () => {
    const index = buildLineIndex("\nbeta");

    expect(lineAt(index, 0)).toEqual({ number: 1, from: 0, to: 0 });
    expect(lineAt(index, 1)).toEqual({ number: 2, from: 1, to: 5 });
  });
});

describe("lineCount", () => {
  it("counts an empty document as one empty line, like an empty Monaco model", () => {
    const index = buildLineIndex("");

    expect(lineCount(index)).toBe(1);
    expect(lineAt(index, 0)).toEqual({ number: 1, from: 0, to: 0 });
  });

  it("counts the empty line a trailing newline opens", () => {
    expect(lineCount(buildLineIndex("alpha\n"))).toBe(2);
    expect(lineAt(buildLineIndex("alpha\n"), 6)).toEqual({ number: 2, from: 6, to: 6 });
  });
});

describe("lineNumbered", () => {
  it("looks a line up by its 1-based number", () => {
    const index = buildLineIndex("alpha\nbeta\ngamma");

    expect(lineNumbered(index, 2)).toEqual({ number: 2, from: 6, to: 10 });
  });

  it("clamps a number outside the document to the first or last line", () => {
    const index = buildLineIndex("alpha\nbeta");

    expect(lineNumbered(index, 0).number).toBe(1);
    expect(lineNumbered(index, 99).number).toBe(2);
  });
});

describe("offsetToPosition", () => {
  it("is 1-based on both axes", () => {
    const index = buildLineIndex("alpha\nbeta");

    expect(offsetToPosition(index, 0)).toEqual({ lineNumber: 1, column: 1 });
    expect(offsetToPosition(index, 3)).toEqual({ lineNumber: 1, column: 4 });
    expect(offsetToPosition(index, 6)).toEqual({ lineNumber: 2, column: 1 });
  });

  it("maps the offset just past a line's last character to the end-of-line column", () => {
    const index = buildLineIndex("alpha\nbeta");

    expect(offsetToPosition(index, 5)).toEqual({ lineNumber: 1, column: 6 });
  });

  it("clamps an offset sitting inside a CRLF terminator to the end-of-line column", () => {
    // Offset 6 is the `\n` of the `\r\n`; there is no column for it.
    const index = buildLineIndex("alpha\r\nbeta");

    expect(offsetToPosition(index, 6)).toEqual({ lineNumber: 1, column: 6 });
  });

  it("clamps offsets outside the document to its first and last position", () => {
    const index = buildLineIndex("alpha\nbeta");

    expect(offsetToPosition(index, -5)).toEqual({ lineNumber: 1, column: 1 });
    expect(offsetToPosition(index, 9999)).toEqual({ lineNumber: 2, column: 5 });
  });
});

describe("spanToRange", () => {
  it("converts an offset span into a Monaco range", () => {
    const index = buildLineIndex("alpha\nbeta\ngamma");

    expect(spanToRange(index, 2, 8)).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 3,
    });
  });

  it("turns a zero-width span into an empty range at one position", () => {
    const index = buildLineIndex("alpha");

    expect(spanToRange(index, 3, 3)).toEqual({
      startLineNumber: 1,
      startColumn: 4,
      endLineNumber: 1,
      endColumn: 4,
    });
  });
});
