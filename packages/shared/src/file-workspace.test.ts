import { describe, it, expect } from "vite-plus/test";
import {
  activateFile,
  closeFile,
  EMPTY_FILE_WORKSPACE,
  isPreviewTab,
  markFileEdited,
  moveFile,
  pinFile,
  previewFile,
  renameFile,
  sanitizeFileWorkspace,
  substitutedPath,
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

describe("renameFile", () => {
  const three = workspace(
    [
      { relPath: "a.ts", pinned: true },
      { relPath: "b.ts", pinned: true },
      { relPath: "c.ts", pinned: false },
    ],
    "b.ts",
  );

  it("keeps the tab in its slot, with its pin, and follows the focus", () => {
    const next = renameFile(three, "b.ts", "renamed.ts");
    expect(next.tabs).toEqual([
      { relPath: "a.ts", pinned: true },
      { relPath: "renamed.ts", pinned: true },
      { relPath: "c.ts", pinned: false },
    ]);
    expect(next.activeRelPath).toBe("renamed.ts");
  });

  it("leaves the focus where it was when some other tab is renamed", () => {
    expect(renameFile(three, "a.ts", "renamed.ts").activeRelPath).toBe("b.ts");
  });

  it("keeps a preview tab replaceable", () => {
    const next = renameFile(three, "c.ts", "renamed.ts");
    expect(isPreviewTab(next, "renamed.ts")).toBe(true);
  });

  it("is a no-op for a file that is not open, and for a rename onto itself", () => {
    expect(renameFile(three, "zzz.ts", "other.ts")).toEqual(three);
    expect(renameFile(three, "b.ts", "b.ts")).toEqual(three);
  });

  it("absorbs a stale tab already holding the destination path, keeping the pin", () => {
    const stale = workspace(
      [
        { relPath: "a.ts", pinned: false },
        { relPath: "b.ts", pinned: true },
      ],
      "a.ts",
    );
    const next = renameFile(stale, "a.ts", "b.ts");
    expect(next.tabs).toEqual([{ relPath: "b.ts", pinned: true }]);
    expect(next.activeRelPath).toBe("b.ts");
  });

  it("brings focus onto the surviving tab when the stale destination held it", () => {
    const stale = workspace(
      [
        { relPath: "a.ts", pinned: true },
        { relPath: "b.ts", pinned: false },
      ],
      "b.ts",
    );
    const next = renameFile(stale, "a.ts", "b.ts");
    expect(next.tabs).toEqual([{ relPath: "b.ts", pinned: true }]);
    expect(next.activeRelPath).toBe("b.ts");
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
    renameFile(state, "a.ts", "renamed.ts");

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

describe("moveFile", () => {
  const three = workspace(
    [
      { relPath: "a.ts", pinned: true },
      { relPath: "b.ts", pinned: true },
      { relPath: "c.ts", pinned: true },
    ],
    "a.ts",
  );

  it("moves a tab to the given index, leaving the others in order", () => {
    expect(moveFile(three, "c.ts", 0).tabs).toEqual([
      { relPath: "c.ts", pinned: true },
      { relPath: "a.ts", pinned: true },
      { relPath: "b.ts", pinned: true },
    ]);
    expect(moveFile(three, "a.ts", 1).tabs).toEqual([
      { relPath: "b.ts", pinned: true },
      { relPath: "a.ts", pinned: true },
      { relPath: "c.ts", pinned: true },
    ]);
  });

  it("pins the tab it moves, so an arranged preview is never replaced", () => {
    const state = workspace(
      [
        { relPath: "a.ts", pinned: true },
        { relPath: "glance.ts", pinned: false },
      ],
      "glance.ts",
    );
    const moved = moveFile(state, "glance.ts", 0);
    expect(moved.tabs).toEqual([
      { relPath: "glance.ts", pinned: true },
      { relPath: "a.ts", pinned: true },
    ]);
    expect(isPreviewTab(moved, "glance.ts")).toBe(false);
    // The next glance therefore opens its own tab instead of taking this slot.
    expect(previewFile(moved, "next.ts").tabs).toHaveLength(3);
  });

  it("pins a preview tab dropped back on its own slot", () => {
    const state = workspace([{ relPath: "glance.ts", pinned: false }], "glance.ts");
    expect(moveFile(state, "glance.ts", 0).tabs).toEqual([{ relPath: "glance.ts", pinned: true }]);
  });

  it("clamps an index past either end of the strip", () => {
    expect(moveFile(three, "a.ts", 99).tabs.at(-1)).toEqual({ relPath: "a.ts", pinned: true });
    expect(moveFile(three, "c.ts", -4).tabs[0]).toEqual({ relPath: "c.ts", pinned: true });
  });

  it("never moves the focus — arranging a tab is not selecting it", () => {
    expect(moveFile(three, "c.ts", 0).activeRelPath).toBe("a.ts");
  });

  it("returns by identity for a file that is not open and for a pinned no-op move", () => {
    expect(moveFile(three, "missing.ts", 0)).toBe(three);
    expect(moveFile(three, "b.ts", 1)).toBe(three);
  });
});

describe("substitutedPath", () => {
  const open = workspace(
    [
      { relPath: "glance.ts", pinned: false },
      { relPath: "b.ts", pinned: true },
    ],
    "glance.ts",
  );

  it("reports the swap a preview replacement made in place", () => {
    const after = previewFile(open, "next.ts");
    expect(substitutedPath(open.tabs, after.tabs)).toEqual({ from: "glance.ts", to: "next.ts" });
  });

  it("reports the swap a rename made in place", () => {
    const after = renameFile(open, "b.ts", "renamed.ts");
    expect(substitutedPath(open.tabs, after.tabs)).toEqual({ from: "b.ts", to: "renamed.ts" });
  });

  it("reports nothing for a transition that did not swap one tab's path", () => {
    // Opening and closing change the LENGTH; pinning changes no path at all.
    expect(substitutedPath(open.tabs, pinFile(open, "c.ts").tabs)).toBeNull();
    expect(substitutedPath(open.tabs, closeFile(open, "b.ts").tabs)).toBeNull();
    expect(substitutedPath(open.tabs, pinFile(open, "glance.ts").tabs)).toBeNull();
    expect(substitutedPath(open.tabs, open.tabs)).toBeNull();
  });

  it("reports nothing for a move, which disagrees at two indices at the least", () => {
    expect(substitutedPath(open.tabs, moveFile(open, "b.ts", 0).tabs)).toBeNull();
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
