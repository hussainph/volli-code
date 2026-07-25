import { describe, expect, it } from "vite-plus/test";

import { planEmphasisWrap } from "./emphasis-wrap";

/**
 * Every fixture below is a single-line document, so a Monaco column is just
 * `offset + 1` — which keeps these assertions readable next to the CodeMirror-era
 * offsets they were ported from.
 */
function caret(line: number, column: number) {
  return { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column };
}

describe("planEmphasisWrap", () => {
  it("inserts a mark pair and leaves an empty caret BETWEEN them", () => {
    const plan = planEmphasisWrap({ text: "", selection: [{ from: 0, to: 0 }], mark: "**" });

    expect(plan.text).toBe("****");
    // Caret sits between the two `**` marks (offset 2), so typing yields `**text**`.
    expect(plan.selections).toEqual([caret(1, 3)]);
  });
});
