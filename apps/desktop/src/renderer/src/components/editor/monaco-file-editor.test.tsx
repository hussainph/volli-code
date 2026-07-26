import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  refreshMonacoEditorTheme,
  resetMonacoEditorThemeForTests,
} from "@renderer/editor/monaco-theme";

import {
  attachEditorContribution,
  classifyExternalChange,
  fileEditorAriaLabel,
  fileEditorConstructionOptions,
  MonacoFileEditor,
  type MonacoDocumentOptions,
  type MonacoEditorContext,
  planExplicitSave,
  saveFailureMessage,
} from "./monaco-file-editor";

afterEach(() => {
  resetMonacoEditorThemeForTests();
});

/**
 * The mount effect calls `attachEditorContribution` once after the editor is
 * created and disposes whatever it returns on teardown. Renderer tests run
 * under Node with no DOM, so the seam is exercised here with a fake context —
 * no real Monaco, matching how the pure helpers above are tested.
 */
describe("attachEditorContribution", () => {
  const context = {
    editor: { id: "editor" },
    model: { id: "model" },
    monaco: { KeyCode: {} },
  } as unknown as MonacoEditorContext;

  it("runs contribute once on attach and its disposer on teardown", () => {
    const dispose = vi.fn();
    const contribute = vi.fn(() => ({ dispose }));

    const contribution = attachEditorContribution(contribute, context);

    expect(contribute).toHaveBeenCalledTimes(1);
    expect(contribute).toHaveBeenCalledWith(context);
    expect(dispose).not.toHaveBeenCalled();

    contribution?.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the host did not pass a contribution", () => {
    expect(attachEditorContribution(undefined, context)).toBeNull();
  });

  it("tolerates a contribution that attaches nothing disposable", () => {
    expect(attachEditorContribution(() => undefined, context)).toBeNull();
  });
});

describe("fileEditorConstructionOptions", () => {
  const base = { readOnly: false, ariaLabel: "notes.md" };

  it("builds the source-mode look plus the state the component owns", () => {
    expect(fileEditorConstructionOptions(base)).toMatchObject({
      lineNumbers: "on",
      fontFamily: "var(--font-mono)",
      minimap: { enabled: false },
      theme: "one-dark-pro",
      readOnly: false,
      domReadOnly: false,
      ariaLabel: "notes.md",
    });
  });

  it("lets a host restyle the document — Document Mode drops the gutter", () => {
    const options = fileEditorConstructionOptions({
      ...base,
      overrides: { lineNumbers: "off", glyphMargin: false, padding: { top: 32, bottom: 96 } },
    });

    expect(options).toMatchObject({
      lineNumbers: "off",
      glyphMargin: false,
      padding: { top: 32, bottom: 96 },
      // Untouched defaults still come through.
      automaticLayout: true,
    });
  });

  it("keeps the component-owned keys out of a host's reach", () => {
    // The type omits them; this proves the runtime guarantee behind that type,
    // since a host reaching for `as` would otherwise silently win.
    const hostile = {
      theme: "someone-elses-theme",
      readOnly: false,
      ariaLabel: "wrong",
    } as unknown as MonacoDocumentOptions;

    expect(
      fileEditorConstructionOptions({ readOnly: true, ariaLabel: "notes.md", overrides: hostile }),
    ).toMatchObject({
      theme: "one-dark-pro",
      readOnly: true,
      domReadOnly: true,
      ariaLabel: "notes.md",
    });
  });

  it("uses the active catalog theme so remounts do not clobber Appearance", () => {
    refreshMonacoEditorTheme("nord");
    expect(fileEditorConstructionOptions(base)).toMatchObject({ theme: "nord" });
  });
});

describe("planExplicitSave", () => {
  it("saves a dirty, idle, writable document", () => {
    expect(planExplicitSave({ readOnly: false, saving: false, dirty: true })).toBe("save");
  });

  it("never writes from a read-only editor, even when the model somehow diverged", () => {
    expect(planExplicitSave({ readOnly: true, saving: false, dirty: true })).toBe("skip-read-only");
  });

  it("coalesces a second Cmd-S while a write is in flight", () => {
    expect(planExplicitSave({ readOnly: false, saving: true, dirty: true })).toBe("skip-in-flight");
  });

  it("is a no-op on a clean document — Cmd-S must not touch the file's mtime", () => {
    expect(planExplicitSave({ readOnly: false, saving: false, dirty: false })).toBe("skip-clean");
  });

  it("ranks read-only above the in-flight and clean skips", () => {
    expect(planExplicitSave({ readOnly: true, saving: true, dirty: false })).toBe("skip-read-only");
  });
});

describe("classifyExternalChange", () => {
  const base = { baseline: "disk", dirty: false, lastWrite: null };

  it("adopts disk truth when the user has no draft to protect", () => {
    expect(classifyExternalChange({ ...base, incoming: "next" })).toBe("adopt");
  });

  it("reports divergence when disk moved under a dirty draft", () => {
    expect(classifyExternalChange({ ...base, dirty: true, incoming: "next" })).toBe("diverged");
  });

  it("treats a same-content event (an mtime touch) as no change at all", () => {
    expect(classifyExternalChange({ ...base, dirty: true, incoming: "disk" })).toBe("unchanged");
  });

  it("treats the echo of this view's own write as no change, even while dirty again", () => {
    // Cmd-S wrote "mine", the user kept typing, then the fs watch delivered our
    // own bytes back. That must not raise a 'changed on disk' banner.
    expect(
      classifyExternalChange({
        baseline: "disk",
        dirty: true,
        lastWrite: "mine",
        incoming: "mine",
      }),
    ).toBe("unchanged");
  });

  it("still diverges when someone else's bytes arrive after our own write", () => {
    expect(
      classifyExternalChange({
        baseline: "disk",
        dirty: true,
        lastWrite: "mine",
        incoming: "theirs",
      }),
    ).toBe("diverged");
  });
});

describe("saveFailureMessage", () => {
  it("surfaces the underlying reason with the file name", () => {
    expect(saveFailureMessage("README.md", "EACCES: permission denied")).toBe(
      "Could not save README.md: EACCES: permission denied",
    );
  });

  it("still says something when the failure carried no reason", () => {
    expect(saveFailureMessage("README.md", "   ")).toBe("Could not save README.md.");
  });
});

describe("fileEditorAriaLabel", () => {
  it("is the plain label for a clean writable document", () => {
    expect(
      fileEditorAriaLabel({ label: "README.md contents", readOnly: false, dirty: false }),
    ).toBe("README.md contents");
  });

  it("announces unsaved changes", () => {
    expect(fileEditorAriaLabel({ label: "README.md contents", readOnly: false, dirty: true })).toBe(
      "README.md contents, unsaved changes",
    );
  });

  it("announces read-only ahead of dirtiness", () => {
    expect(fileEditorAriaLabel({ label: "README.md contents", readOnly: true, dirty: true })).toBe(
      "README.md contents, read-only",
    );
  });
});

describe("MonacoFileEditor markup", () => {
  const identity = {
    kind: "file",
    projectId: "p1",
    checkout: { kind: "main" },
    relPath: "src/index.ts",
  } as const;

  function markup() {
    return renderToStaticMarkup(
      <MonacoFileEditor
        identity={identity}
        value="export const a = 1;\n"
        revision={1}
        viewId="file:p1:main:src/index.ts:source"
        ariaLabel="index.ts contents"
        readOnly={false}
        onSave={() => Promise.resolve({ ok: true, revision: 2 })}
      />,
    );
  }

  it("renders only the editor host before Monaco loads — no banner, no fallback", () => {
    const html = markup();

    expect(html).not.toContain("Changed on disk");
    expect(html).not.toContain("data-monaco-fallback");
  });
});
