import { describe, expect, it, vi } from "vite-plus/test";
import type { editor } from "monaco-editor";

import {
  attachDiffModels,
  diffEditorConstructionOptions,
  diffEditorInitFailureMessage,
  diffFocusTarget,
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
    // DiffEditor theming is via monaco.editor.setTheme — never construction options.
    expect(options).not.toHaveProperty("theme");
  });

  it('maps "side-by-side" to renderSideBySide: true and keeps it in narrow panes', () => {
    expect(diffEditorConstructionOptions({ presentation: "side-by-side" })).toMatchObject({
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
    });
  });

  it("carries the user's word-wrap choice into both sides", () => {
    expect(diffEditorConstructionOptions({ presentation: "inline", wordWrap: true })).toMatchObject(
      { wordWrap: "on" },
    );
    expect(
      diffEditorConstructionOptions({ presentation: "inline", wordWrap: false }),
    ).toMatchObject({ wordWrap: "off" });
    // A caller with no opinion leaves Monaco's own default alone.
    expect(diffEditorConstructionOptions({ presentation: "inline" })).not.toHaveProperty(
      "wordWrap",
    );
  });
});

/** A pressable node: what it matches with `closest`, and which pane holds it. */
function node(focusableAncestor: Element | null = null): Element {
  return { closest: () => focusableAncestor } as unknown as Element;
}

/** A stand-in for one side's DOM node: `contains` is all that is consulted. */
function pane(members: readonly Element[]): Element {
  return { contains: (child: Node | null) => members.includes(child as Element) } as Element;
}

describe("diffFocusTarget (VC-148)", () => {
  const originalLine = node();
  const modifiedLine = node();
  const originalDom = pane([originalLine]);
  const modifiedDom = pane([modifiedLine]);

  it("focuses the modified side when a press left focus outside the diff", () => {
    // The measured defect: a click on a real view line inside the Changes diff
    // left `document.activeElement` as BODY, so ⌘S and arrow-key scroll — both
    // editor-local keybindings — were unreachable from a mouse.
    expect(
      diffFocusTarget({
        originalDom,
        modifiedDom,
        target: modifiedLine,
        activeElement: node(),
      }),
    ).toBe("modified");
  });

  it("focuses the side that was actually pressed, so a base selection survives", () => {
    expect(
      diffFocusTarget({ originalDom, modifiedDom, target: originalLine, activeElement: null }),
    ).toBe("original");
  });

  it("does nothing when that side already holds focus", () => {
    // The ordinary second click. Re-focusing here would interrupt a drag with
    // the very handler meant to rescue the first press.
    expect(
      diffFocusTarget({
        originalDom,
        modifiedDom,
        target: modifiedLine,
        activeElement: modifiedLine,
      }),
    ).toBeNull();
    expect(
      diffFocusTarget({
        originalDom,
        modifiedDom,
        target: originalLine,
        activeElement: originalLine,
      }),
    ).toBeNull();
  });

  it("leaves a press on a widget's own field alone", () => {
    // The find widget's input, the go-to-line prompt: the browser focuses these
    // by itself, and taking the press would stop it doing so.
    const field = node(node());
    expect(
      diffFocusTarget({
        originalDom: pane([]),
        modifiedDom: pane([field]),
        target: field,
        activeElement: null,
      }),
    ).toBeNull();
  });

  it("leaves a press that landed on neither editor alone", () => {
    // Nothing outside the two editors is this handler's business — including
    // every press there is before the editors have any DOM at all.
    expect(
      diffFocusTarget({ originalDom, modifiedDom, target: node(), activeElement: null }),
    ).toBeNull();
    expect(
      diffFocusTarget({
        originalDom: null,
        modifiedDom: null,
        target: node(),
        activeElement: null,
      }),
    ).toBeNull();
    expect(
      diffFocusTarget({ originalDom, modifiedDom, target: null, activeElement: null }),
    ).toBeNull();
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

  it("forwards modified view state to the modified lease release", () => {
    const originalRelease = vi.fn();
    const modifiedRelease = vi.fn();
    const pair: DiffLeasePair = {
      original: { release: originalRelease },
      modified: { release: modifiedRelease },
    };
    const viewState = { scrollTop: 40 };

    releaseDiffLeases(pair, viewState);

    expect(originalRelease).toHaveBeenCalledWith();
    expect(modifiedRelease).toHaveBeenCalledWith(viewState);
  });
});

describe("diffEditorInitFailureMessage", () => {
  it("formats copy DiffView puts in DiffStub so init failure is not a silent empty pane", () => {
    expect(diffEditorInitFailureMessage("src/app.ts", "WebGL unavailable")).toBe(
      "Couldn't load src/app.ts: WebGL unavailable",
    );
  });
});
