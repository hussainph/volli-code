import { describe, expect, it } from "vite-plus/test";

import { preferTextPresentationForAmbiguousSymbols } from "./symbol-presentation";

describe("preferTextPresentationForAmbiguousSymbols", () => {
  it("forces Claude Code's record symbol to text presentation", () => {
    expect(preferTextPresentationForAmbiguousSymbols("⏺ running")).toBe("⏺︎ running");
  });

  it("preserves explicit text and emoji presentation selectors", () => {
    expect(preferTextPresentationForAmbiguousSymbols("⏺︎ ⏺️")).toBe("⏺︎ ⏺️");
  });

  it("leaves emoji-default characters and ordinary terminal text alone", () => {
    expect(preferTextPresentationForAmbiguousSymbols("😀 build 123")).toBe("😀 build 123");
  });

  it("does not break explicit joined emoji sequences", () => {
    expect(preferTextPresentationForAmbiguousSymbols("👩‍💻")).toBe("👩‍💻");
  });

  it("returns pictograph-free output unchanged via the fast path", () => {
    const line = "error: build failed (exit 1)\n";
    expect(preferTextPresentationForAmbiguousSymbols(line)).toBe(line);
  });

  it("marks each of several adjacent ambiguous symbols", () => {
    expect(preferTextPresentationForAmbiguousSymbols("⏺⏺")).toBe("⏺︎⏺︎");
  });
});
