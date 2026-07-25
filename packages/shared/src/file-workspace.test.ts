import { describe, it, expect } from "vite-plus/test";
import {
  activateFile,
  closeFile,
  EMPTY_FILE_WORKSPACE,
  isPreviewTab,
  markFileEdited,
  pinFile,
  previewFile,
  sanitizeFileWorkspace,
  type FileWorkspaceState,
  type FileWorkspaceTab,
} from "./file-workspace";

/** A workspace literal, so a cycle's setup never depends on operations under test. */
function workspace(tabs: readonly FileWorkspaceTab[], activeRelPath: string | null) {
  return { tabs, activeRelPath } satisfies FileWorkspaceState;
}

describe("previewFile", () => {
  it("opens one active preview tab on an empty workspace", () => {
    const state = previewFile(EMPTY_FILE_WORKSPACE, "src/app.ts");
    expect(state.tabs).toEqual([{ relPath: "src/app.ts", pinned: false }]);
    expect(state.activeRelPath).toBe("src/app.ts");
  });

  it("replaces the existing preview tab in place rather than accumulating tabs", () => {
    const first = previewFile(EMPTY_FILE_WORKSPACE, "src/app.ts");
    const second = previewFile(first, "src/main.ts");
    expect(second.tabs).toEqual([{ relPath: "src/main.ts", pinned: false }]);
    expect(second.activeRelPath).toBe("src/main.ts");
  });

  it("activates an already-open pinned tab without unpinning it or disturbing the preview tab", () => {
    const state = workspace(
      [
        { relPath: "src/app.ts", pinned: true },
        { relPath: "src/scratch.ts", pinned: false },
      ],
      "src/scratch.ts",
    );
    const next = previewFile(state, "src/app.ts");
    expect(next.tabs).toEqual(state.tabs);
    expect(next.activeRelPath).toBe("src/app.ts");
  });
});

describe("pinFile", () => {
  it("makes a preview tab persistent so the next preview opens beside it", () => {
    const previewed = previewFile(EMPTY_FILE_WORKSPACE, "src/app.ts");
    const pinned = pinFile(previewed, "src/app.ts");
    expect(pinned.tabs).toEqual([{ relPath: "src/app.ts", pinned: true }]);

    const next = previewFile(pinned, "src/main.ts");
    expect(next.tabs).toEqual([
      { relPath: "src/app.ts", pinned: true },
      { relPath: "src/main.ts", pinned: false },
    ]);
    expect(next.activeRelPath).toBe("src/main.ts");
  });

  it("opens a not-yet-open file as a pinned, active tab", () => {
    const state = workspace([{ relPath: "src/app.ts", pinned: false }], "src/app.ts");
    const next = pinFile(state, "docs/CONCEPT.md");
    expect(next.tabs).toEqual([
      { relPath: "src/app.ts", pinned: false },
      { relPath: "docs/CONCEPT.md", pinned: true },
    ]);
    expect(next.activeRelPath).toBe("docs/CONCEPT.md");
  });

  it("is idempotent on an already-pinned tab and keeps focus where it was", () => {
    const state = workspace(
      [
        { relPath: "src/app.ts", pinned: true },
        { relPath: "src/scratch.ts", pinned: false },
      ],
      "src/scratch.ts",
    );
    expect(pinFile(state, "src/app.ts")).toBe(state);
  });
});

describe("markFileEdited", () => {
  it("pins a preview tab, so the next preview can no longer replace it", () => {
    const previewed = previewFile(EMPTY_FILE_WORKSPACE, "src/app.ts");
    const edited = markFileEdited(previewed, "src/app.ts");
    expect(edited.tabs).toEqual([{ relPath: "src/app.ts", pinned: true }]);

    const next = previewFile(edited, "src/main.ts");
    expect(next.tabs).toEqual([
      { relPath: "src/app.ts", pinned: true },
      { relPath: "src/main.ts", pinned: false },
    ]);
  });

  it("never opens a tab for a file that is not already open", () => {
    const state = workspace([{ relPath: "src/app.ts", pinned: false }], "src/app.ts");
    expect(markFileEdited(state, "src/other.ts")).toEqual(state);
  });

  it("leaves an already-pinned tab untouched", () => {
    const state = workspace([{ relPath: "src/app.ts", pinned: true }], "src/app.ts");
    expect(markFileEdited(state, "src/app.ts")).toEqual(state);
  });
});

describe("activateFile", () => {
  it("focuses an already-open tab without changing the tab set", () => {
    const state = workspace(
      [
        { relPath: "src/app.ts", pinned: true },
        { relPath: "src/scratch.ts", pinned: false },
      ],
      "src/scratch.ts",
    );
    const next = activateFile(state, "src/app.ts");
    expect(next.tabs).toEqual(state.tabs);
    expect(next.activeRelPath).toBe("src/app.ts");
  });

  it("is a no-op for a path that is not open", () => {
    const state = workspace([{ relPath: "src/app.ts", pinned: true }], "src/app.ts");
    expect(activateFile(state, "src/other.ts")).toBe(state);
  });

  it("returns the same state when the file is already active", () => {
    const state = workspace([{ relPath: "src/app.ts", pinned: true }], "src/app.ts");
    expect(activateFile(state, "src/app.ts")).toBe(state);
    expect(previewFile(state, "src/app.ts")).toBe(state);
  });
});

describe("closeFile", () => {
  const three = workspace(
    [
      { relPath: "a.ts", pinned: true },
      { relPath: "b.ts", pinned: true },
      { relPath: "c.ts", pinned: false },
    ],
    "b.ts",
  );

  it("activates the tab to the left when the active tab is closed", () => {
    const next = closeFile(three, "b.ts");
    expect(next.tabs.map((tab) => tab.relPath)).toEqual(["a.ts", "c.ts"]);
    expect(next.activeRelPath).toBe("a.ts");
  });

  it("activates the tab that slid into the freed index when there is nothing to the left", () => {
    const next = closeFile({ ...three, activeRelPath: "a.ts" }, "a.ts");
    expect(next.activeRelPath).toBe("b.ts");
  });

  it("leaves the active tab alone when a different tab is closed", () => {
    const next = closeFile(three, "a.ts");
    expect(next.activeRelPath).toBe("b.ts");
    expect(next.tabs.map((tab) => tab.relPath)).toEqual(["b.ts", "c.ts"]);
  });

  it("clears the active file when the last tab is closed", () => {
    const one = workspace([{ relPath: "a.ts", pinned: false }], "a.ts");
    expect(closeFile(one, "a.ts")).toEqual(EMPTY_FILE_WORKSPACE);
  });

  it("is a no-op for a path that is not open", () => {
    expect(closeFile(three, "zzz.ts")).toEqual(three);
  });

  it("frees the preview slot, so the next preview opens a fresh tab", () => {
    const closed = closeFile(three, "c.ts");
    expect(isPreviewTab(closed, "c.ts")).toBe(false);
    const next = previewFile(closed, "d.ts");
    expect(next.tabs.map((tab) => tab.relPath)).toEqual(["a.ts", "b.ts", "d.ts"]);
    expect(isPreviewTab(next, "d.ts")).toBe(true);
  });
});

describe("purity", () => {
  it("never mutates the state it is handed", () => {
    const tabs: FileWorkspaceTab[] = [
      { relPath: "a.ts", pinned: true },
      { relPath: "b.ts", pinned: false },
    ];
    const state = workspace(tabs, "b.ts");
    const snapshot = structuredClone({ tabs, activeRelPath: state.activeRelPath });

    previewFile(state, "c.ts");
    pinFile(state, "b.ts");
    markFileEdited(state, "b.ts");
    activateFile(state, "a.ts");
    closeFile(state, "a.ts");

    expect({ tabs, activeRelPath: state.activeRelPath }).toEqual(snapshot);
  });
});

describe("sanitizeFileWorkspace", () => {
  it("falls back to the empty workspace for anything that is not a tab record", () => {
    for (const raw of [null, undefined, 7, "tabs", [], {}, { tabs: "nope" }]) {
      expect(sanitizeFileWorkspace(raw)).toEqual(EMPTY_FILE_WORKSPACE);
    }
  });

  it("keeps well-formed tabs in order and drops malformed ones", () => {
    const raw = {
      tabs: [
        { relPath: "a.ts", pinned: true },
        { relPath: 42, pinned: true },
        { relPath: "b.ts", pinned: "yes" },
        null,
        "c.ts",
        { pinned: false },
        { relPath: "d.ts", pinned: false },
      ],
      activeRelPath: "a.ts",
    };
    expect(sanitizeFileWorkspace(raw)).toEqual({
      tabs: [
        { relPath: "a.ts", pinned: true },
        { relPath: "d.ts", pinned: false },
      ],
      activeRelPath: "a.ts",
    });
  });
});

describe("sanitizeFileWorkspace active file", () => {
  it("clears an active path that no surviving tab claims", () => {
    const raw = { tabs: [{ relPath: "a.ts", pinned: true }], activeRelPath: "gone.ts" };
    expect(sanitizeFileWorkspace(raw).activeRelPath).toBeNull();
  });

  it("clears a non-string active path", () => {
    const raw = { tabs: [{ relPath: "a.ts", pinned: true }], activeRelPath: 3 };
    expect(sanitizeFileWorkspace(raw).activeRelPath).toBeNull();
  });
});

describe("sanitizeFileWorkspace duplicates", () => {
  it("collapses a repeated relPath to its first slot and keeps the pinned reading", () => {
    const raw = {
      tabs: [
        { relPath: "a.ts", pinned: false },
        { relPath: "b.ts", pinned: true },
        { relPath: "a.ts", pinned: true },
      ],
      activeRelPath: "a.ts",
    };
    expect(sanitizeFileWorkspace(raw)).toEqual({
      tabs: [
        { relPath: "a.ts", pinned: true },
        { relPath: "b.ts", pinned: true },
      ],
      activeRelPath: "a.ts",
    });
  });

  it("never lets a later unpinned copy demote the tab it collapses onto", () => {
    const raw = {
      tabs: [
        { relPath: "a.ts", pinned: true },
        { relPath: "a.ts", pinned: false },
      ],
      activeRelPath: "a.ts",
    };
    expect(sanitizeFileWorkspace(raw)).toEqual({
      tabs: [{ relPath: "a.ts", pinned: true }],
      activeRelPath: "a.ts",
    });
  });
});

describe("sanitizeFileWorkspace preview invariant", () => {
  it("pins every unpinned tab but the last, so only one preview slot survives", () => {
    const raw = {
      tabs: [
        { relPath: "a.ts", pinned: false },
        { relPath: "b.ts", pinned: true },
        { relPath: "c.ts", pinned: false },
      ],
      activeRelPath: "a.ts",
    };
    const state = sanitizeFileWorkspace(raw);
    expect(state.tabs).toEqual([
      { relPath: "a.ts", pinned: true },
      { relPath: "b.ts", pinned: true },
      { relPath: "c.ts", pinned: false },
    ]);
    expect(state.tabs.filter((tab) => !tab.pinned)).toHaveLength(1);
  });

  it("leaves a rehydrated workspace stable under a second sanitize pass", () => {
    const once = sanitizeFileWorkspace({
      tabs: [
        { relPath: "a.ts", pinned: false },
        { relPath: "b.ts", pinned: false },
      ],
      activeRelPath: "b.ts",
    });
    expect(sanitizeFileWorkspace(once)).toEqual(once);
  });
});

describe("sanitizeFileWorkspace path safety", () => {
  it("drops tabs whose relPath is not a safe project-relative path", () => {
    const raw = {
      tabs: [
        { relPath: "", pinned: true },
        { relPath: "/etc/passwd", pinned: true },
        { relPath: "../outside.ts", pinned: true },
        { relPath: "src/app.ts", pinned: true },
      ],
      activeRelPath: "../outside.ts",
    };
    expect(sanitizeFileWorkspace(raw)).toEqual({
      tabs: [{ relPath: "src/app.ts", pinned: true }],
      activeRelPath: null,
    });
  });
});
