import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";

import { shouldOpenLink, wrapTransaction } from "./live-preview";

/** Apply `wrapTransaction` to a fresh state and read back the doc + main selection. */
function applyWrap(doc: string, selection: { anchor: number; head: number }, mark: string) {
  const state = EditorState.create({ doc, selection });
  const tr = state.update(wrapTransaction(state, mark));
  const main = tr.state.selection.main;
  return { doc: tr.state.doc.toString(), from: main.from, to: main.to, empty: main.empty };
}

describe("wrapTransaction", () => {
  it("inserts a mark pair and leaves an empty caret BETWEEN them", () => {
    const result = applyWrap("", { anchor: 0, head: 0 }, "**");
    expect(result.doc).toBe("****");
    expect(result.empty).toBe(true);
    // Caret sits between the two `**` marks, so typing yields `**text**`.
    expect(result.from).toBe(2);
    expect(result.to).toBe(2);
  });

  it("keeps an empty caret between marks mid-document", () => {
    const result = applyWrap("ab", { anchor: 1, head: 1 }, "*");
    expect(result.doc).toBe("a**b");
    expect(result.from).toBe(2);
    expect(result.to).toBe(2);
  });

  it("wraps a non-empty selection and keeps the selection around the text", () => {
    const result = applyWrap("hello", { anchor: 0, head: 5 }, "**");
    expect(result.doc).toBe("**hello**");
    expect(result.from).toBe(2);
    expect(result.to).toBe(7);
  });

  it("strips the flanking marks when the selection is already wrapped", () => {
    const result = applyWrap("**hello**", { anchor: 2, head: 7 }, "**");
    expect(result.doc).toBe("hello");
    expect(result.from).toBe(0);
    expect(result.to).toBe(5);
  });

  it("strips marks around an empty caret sitting between them", () => {
    const result = applyWrap("****", { anchor: 2, head: 2 }, "**");
    expect(result.doc).toBe("");
    expect(result.from).toBe(0);
    expect(result.to).toBe(0);
  });

  it("wraps every range of a multi-cursor selection independently", () => {
    const state = EditorState.create({
      doc: "a b",
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)]),
      // A bare EditorState collapses to the main range unless multi-selection is
      // explicitly enabled (as it is in a real multi-cursor editor).
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const tr = state.update(wrapTransaction(state, "*"));
    expect(tr.state.doc.toString()).toBe("**a b**");
    // Each caret lands between ITS own pair: `*|*a b*|*` → new positions 1 and 6.
    expect(tr.state.selection.ranges.map((r) => r.from)).toEqual([1, 6]);
  });
});

describe("shouldOpenLink", () => {
  it("opens on a plain left-click", () => {
    expect(shouldOpenLink({ button: 0, ctrlKey: false })).toBe(true);
  });

  it("does not open on middle- or right-click", () => {
    expect(shouldOpenLink({ button: 1, ctrlKey: false })).toBe(false);
    expect(shouldOpenLink({ button: 2, ctrlKey: false })).toBe(false);
  });

  it("does not open on a ctrl-click (macOS context-menu chord)", () => {
    expect(shouldOpenLink({ button: 0, ctrlKey: true })).toBe(false);
  });
});
