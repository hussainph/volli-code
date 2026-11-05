// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import type { editor } from "monaco-editor";
import { warmDocumentEditorFonts } from "./warm-document-editor";

describe("idle document font measurement", () => {
  it("uses the real document font options without a model or focus, then disposes once", () => {
    const doc = document.implementation.createHTMLDocument();
    const dispose = vi.fn();
    const create = vi.fn((container: HTMLElement, options: unknown) => {
      expect(doc.body.contains(container)).toBe(true);
      expect(container.getAttribute("aria-hidden")).toBe("true");
      expect(container.inert).toBe(true);
      expect(container.style.contain).toBe("strict");
      expect(container.style.visibility).toBe("hidden");
      expect(options).toMatchObject({
        model: null,
        fontFamily: "var(--font-sans)",
        fontSize: 14,
        lineHeight: 24,
        automaticLayout: false,
        dimension: { width: 600, height: 24 },
      });
      return { dispose } as editor.IStandaloneCodeEditor;
    });
    warmDocumentEditorFonts({ create }, doc);
    warmDocumentEditorFonts({ create }, doc);
    expect(create).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(doc.body.childElementCount).toBe(0);
  });

  it("removes a failed host and permits a later retry", () => {
    const doc = document.implementation.createHTMLDocument();
    const create = vi.fn((): editor.IStandaloneCodeEditor => {
      throw new Error("font measurement unavailable");
    });
    expect(() => warmDocumentEditorFonts({ create }, doc)).toThrow("font measurement");
    expect(doc.body.childElementCount).toBe(0);
    expect(() => warmDocumentEditorFonts({ create }, doc)).toThrow("font measurement");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
