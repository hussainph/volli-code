import { describe, expect, it } from "vite-plus/test";

import { planEmphasisWrap } from "./emphasis-wrap";

/**
 * Every fixture below is a single-line document, so a Monaco column is just
 * `offset + 1` — which keeps these assertions readable next to the CodeMirror-era
 * offsets they were ported from.
 */
function span(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
) {
  return { startLineNumber, startColumn, endLineNumber, endColumn };
}

function caret(line: number, column: number) {
  return span(line, column, line, column);
}

describe("planEmphasisWrap", () => {
  it("inserts a mark pair and leaves an empty caret BETWEEN them", () => {
    const plan = planEmphasisWrap({ text: "", selection: [{ from: 0, to: 0 }], mark: "**" });

    expect(plan.text).toBe("****");
    // Caret sits between the two `**` marks (offset 2), so typing yields `**text**`.
    expect(plan.selections).toEqual([caret(1, 3)]);
  });

  it("keeps an empty caret between marks mid-document", () => {
    const plan = planEmphasisWrap({ text: "ab", selection: [{ from: 1, to: 1 }], mark: "*" });

    expect(plan.text).toBe("a**b");
    expect(plan.selections).toEqual([caret(1, 3)]);
  });

  it("wraps a non-empty selection and keeps the selection around the text", () => {
    const plan = planEmphasisWrap({ text: "hello", selection: [{ from: 0, to: 5 }], mark: "**" });

    expect(plan.text).toBe("**hello**");
    // Offsets 2..7 — the words, not the marks.
    expect(plan.selections).toEqual([span(1, 3, 1, 8)]);
  });

  it("strips the flanking marks when the selection is already wrapped", () => {
    const plan = planEmphasisWrap({
      text: "**hello**",
      selection: [{ from: 2, to: 7 }],
      mark: "**",
    });

    expect(plan.text).toBe("hello");
    expect(plan.selections).toEqual([span(1, 1, 1, 6)]);
  });

  it("strips marks around an empty caret sitting between them", () => {
    const plan = planEmphasisWrap({ text: "****", selection: [{ from: 2, to: 2 }], mark: "**" });

    expect(plan.text).toBe("");
    expect(plan.selections).toEqual([caret(1, 1)]);
  });

  it("wraps every range of a multi-cursor selection independently", () => {
    const plan = planEmphasisWrap({
      text: "a b",
      selection: [
        { from: 0, to: 0 },
        { from: 3, to: 3 },
      ],
      mark: "*",
    });

    expect(plan.text).toBe("**a b**");
    // Each caret lands between ITS own pair: `*|*a b*|*` → offsets 1 and 6.
    expect(plan.selections).toEqual([caret(1, 2), caret(1, 7)]);
  });

  it("handles ranges given out of document order, and answers in the order given", () => {
    // Monaco's `getSelections()` is primary-first, not document-order — "add
    // cursor above" hands back exactly this shape.
    const plan = planEmphasisWrap({
      text: "a b",
      selection: [
        { from: 3, to: 3 },
        { from: 0, to: 0 },
      ],
      mark: "*",
    });

    expect(plan.text).toBe("**a b**");
    // Same two carets as above, reported against the same two input ranges.
    expect(plan.selections).toEqual([caret(1, 7), caret(1, 2)]);
  });
});
