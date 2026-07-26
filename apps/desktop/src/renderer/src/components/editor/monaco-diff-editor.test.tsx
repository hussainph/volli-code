import { describe, expect, it, vi } from "vite-plus/test";
import type { editor } from "monaco-editor";

import {
  attachDiffModels,
  diffEditorConstructionOptions,
  releaseDiffLeases,
  type DiffLeasePair,
} from "./monaco-diff-editor";

describe("diffEditorConstructionOptions", () => {
  it('maps "inline" to renderSideBySide: false and omits theme', () => {
    const options = diffEditorConstructionOptions({ presentation: "inline" });
    expect(options).toMatchObject({
      renderSideBySide: false,
      automaticLayout: true,
    });
    // DiffEditor theming is via monaco.editor.setTheme — never construction options
    // (docs/plans/theming-engine.md).
    expect(options).not.toHaveProperty("theme");
  });

  it('maps "side-by-side" to renderSideBySide: true', () => {
    expect(diffEditorConstructionOptions({ presentation: "side-by-side" })).toMatchObject({
      renderSideBySide: true,
    });
  });
});

describe("attachDiffModels", () => {
  it("sets original and modified models on the diff editor", () => {
    const original = { id: "original" } as unknown as editor.ITextModel;
    const modified = { id: "modified" } as unknown as editor.ITextModel;
    const setModel = vi.fn();
    const diffEditor = { setModel } as unknown as editor.IStandaloneDiffEditor;

    attachDiffModels(diffEditor, { original, modified });

    expect(setModel).toHaveBeenCalledWith({ original, modified });
  });
});

describe("releaseDiffLeases", () => {
  it("releases both original and modified leases", () => {
    const originalRelease = vi.fn();
    const modifiedRelease = vi.fn();
    const pair: DiffLeasePair = {
      original: { release: originalRelease },
      modified: { release: modifiedRelease },
    };

    releaseDiffLeases(pair);

    expect(originalRelease).toHaveBeenCalledTimes(1);
    expect(modifiedRelease).toHaveBeenCalledTimes(1);
  });
});
