import { describe, expect, it } from "vite-plus/test";

import { targetAt } from "./document-decorations";
import { documentModeOptions } from "./document-mode";

describe("documentModeOptions", () => {
  it("strips every code-editor affordance a document must not show", () => {
    const options = documentModeOptions({});
    expect(options.lineNumbers).toBe("off");
    expect(options.glyphMargin).toBe(false);
    expect(options.folding).toBe(false);
    expect(options.lineDecorationsWidth).toBe(0);
    expect(options.minimap).toEqual({ enabled: false });
    expect(options.overviewRulerLanes).toBe(0);
    expect(options.renderLineHighlight).toBe("none");
    expect(options.contextmenu).toBe(false);
  });

  it("reads as prose: wrapped, sans-serif, and measured from the DOM", () => {
    const options = documentModeOptions({});
    expect(options.wordWrap).toBe("on");
    // Decorations here change glyph widths (headings, collapsed syntax), so the
    // wrapping calculation has to measure rather than assume a monospace grid.
    expect(options.wrappingStrategy).toBe("advanced");
    expect(options.fontFamily).toBe("var(--font-sans)");
  });

  it("offers only the `@` picker, never word-based code suggestions", () => {
    const options = documentModeOptions({});
    expect(options.quickSuggestions).toBe(false);
    expect(options.wordBasedSuggestions).toBe("off");
    expect(options.suggestOnTriggerCharacters).toBe(true);
  });

  it("passes a placeholder through and omits it when there is none", () => {
    expect(documentModeOptions({ placeholder: "Add description…" }).placeholder).toBe(
      "Add description…",
    );
    expect("placeholder" in documentModeOptions({})).toBe(false);
  });
});

describe("targetAt", () => {
  const targets = [
    { range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 7 }, id: "a" },
    { range: { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 3 }, id: "b" },
  ];

  it("finds the target holding a position", () => {
    expect(targetAt(targets, { lineNumber: 1, column: 4 })?.id).toBe("a");
    expect(targetAt(targets, { lineNumber: 3, column: 9 })?.id).toBe("b");
    expect(targetAt(targets, { lineNumber: 4, column: 1 })?.id).toBe("b");
  });

  it("includes the start column and excludes the end column", () => {
    // The end column is where the character AFTER the span begins, so a click
    // there is a click on the next thing along, not on this one.
    expect(targetAt(targets, { lineNumber: 1, column: 2 })?.id).toBe("a");
    expect(targetAt(targets, { lineNumber: 1, column: 7 })).toBeNull();
  });

  it("is null outside every target", () => {
    expect(targetAt(targets, { lineNumber: 1, column: 1 })).toBeNull();
    expect(targetAt(targets, { lineNumber: 2, column: 1 })).toBeNull();
    expect(targetAt(targets, { lineNumber: 4, column: 3 })).toBeNull();
    expect(targetAt(targets, { lineNumber: 9, column: 1 })).toBeNull();
  });

  it("is null when there is nothing to hit", () => {
    expect(targetAt([], { lineNumber: 1, column: 1 })).toBeNull();
  });
});
