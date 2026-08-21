import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  refreshMonacoEditorTheme,
  resetMonacoEditorThemeForTests,
} from "@renderer/editor/monaco-theme";

import {
  applyExternalSeed,
  attachEditorContribution,
  fileEditorAriaLabel,
  fileEditorConstructionOptions,
  isGlobalSaveShortcut,
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

/** A dirty lease whose draft touched line 1 while disk moved on elsewhere. */
function mergeLease() {
  return {
    model: { getValue: () => "human first\nkeep\nlast\n" },
    snapshot: () => ({ baseline: "first\nkeep\nlast\n" }),
    applyExternalUpdate: vi.fn(),
    adoptCleanBaseline: vi.fn(),
  };
}

describe("applyExternalSeed", () => {
  it("merges through the shared registry policy", () => {
    const lease = mergeLease();

    const result = applyExternalSeed({
      lease,
      lastWrite: null,
      seed: { value: "first\nkeep\nagent last\n", revision: 12 },
    });

    expect(result).toMatchObject({ kind: "apply", outcome: "merge" });
    expect(lease.applyExternalUpdate).toHaveBeenCalledWith({
      baseline: "first\nkeep\nagent last\n",
      value: "human first\nkeep\nagent last\n",
      revision: 12,
    });
  });

  it("applies nothing to the model on a conflict, only recording the disk revision", () => {
    // No editor is reachable from this signature at all: the registry lands an
    // external write as minimal edits and Monaco maps the caret through them,
    // so there is no pre-edit snapshot left for a caller to restore on top.
    const lease = mergeLease();

    const result = applyExternalSeed({
      lease,
      lastWrite: null,
      seed: { value: "agent first\nkeep\nlast\n", revision: 12 },
    });

    expect(result).toMatchObject({ kind: "conflict", reason: "overlap" });
    expect(lease.applyExternalUpdate).not.toHaveBeenCalled();
    expect(lease.adoptCleanBaseline).toHaveBeenCalledWith({
      value: "agent first\nkeep\nlast\n",
      revision: 12,
    });
  });
});

describe("fileEditorConstructionOptions", () => {
  const base = { readOnly: false, ariaLabel: "notes.md" };

  it("builds the source-mode look plus the state the component owns", () => {
    expect(fileEditorConstructionOptions(base)).toMatchObject({
      lineNumbers: "on",
      fontFamily: "var(--font-mono)",
      minimap: { enabled: false },
      theme: "vitesse-dark",
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
      theme: "vitesse-dark",
      readOnly: true,
      domReadOnly: true,
      ariaLabel: "notes.md",
    });
  });

  it("uses the active Vitesse half so remounts do not clobber Appearance", () => {
    refreshMonacoEditorTheme("vitesse-light");
    expect(fileEditorConstructionOptions(base)).toMatchObject({ theme: "vitesse-light" });
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

describe("isGlobalSaveShortcut", () => {
  const chord = {
    key: "s",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
  };

  /** The gap this closes: focus on a tab, the file tree, or a banner button. */
  it("answers ⌘S raised outside any editor", () => {
    expect(isGlobalSaveShortcut(chord, false)).toBe(true);
  });

  it("answers ⌃S too, for a keyboard that has no ⌘", () => {
    expect(isGlobalSaveShortcut({ ...chord, metaKey: false, ctrlKey: true }, false)).toBe(true);
  });

  it("answers a shifted ⇧⌘S rather than dropping the keystroke", () => {
    expect(isGlobalSaveShortcut({ ...chord, key: "S" }, false)).toBe(true);
  });

  /** Monaco's own binding already ran; a second write would race the first. */
  it("defers to a keystroke Monaco has already handled", () => {
    expect(isGlobalSaveShortcut({ ...chord, defaultPrevented: true }, false)).toBe(false);
  });

  it("defers to whichever editor the keystroke came from", () => {
    expect(isGlobalSaveShortcut(chord, true)).toBe(false);
  });

  it("treats a held ⌘S as one save, not a stream", () => {
    expect(isGlobalSaveShortcut({ ...chord, repeat: true }, false)).toBe(false);
  });

  it("ignores plain s, and ⌥⌘S — a chord someone else may own", () => {
    expect(isGlobalSaveShortcut({ ...chord, metaKey: false }, false)).toBe(false);
    expect(isGlobalSaveShortcut({ ...chord, altKey: true }, false)).toBe(false);
    expect(isGlobalSaveShortcut({ ...chord, key: "a" }, false)).toBe(false);
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
