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
});
