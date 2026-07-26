import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetFile, ChangeSetSnapshot } from "@volli/shared";

import { EMPTY_CHANGE_RECENCY_STATE, reduceChangeRecency } from "./ticket-change-recency";
import {
  applyChangeSetRefresh,
  formatChangeCounts,
  formatChangeStatus,
  presentChangeRow,
  presentChangeRowWithRecency,
  selectChangeRow,
  sortChangeSetFiles,
  splitChangePath,
  type ChangesNavigatorState,
} from "./ticket-changes-model";

function file(overrides: Partial<ChangeSetFile> & Pick<ChangeSetFile, "path">): ChangeSetFile {
  return {
    status: "modified",
    insertions: 1,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

describe("splitChangePath", () => {
  it("leads with the filename and keeps the parent path secondary", () => {
    expect(splitChangePath("src/components/ticket/rail.tsx")).toEqual({
      filename: "rail.tsx",
      parentPath: "src/components/ticket",
    });
  });

  it("uses an empty parent for repo-root files", () => {
    expect(splitChangePath("README.md")).toEqual({ filename: "README.md", parentPath: "" });
  });
});

describe("formatChangeStatus", () => {
  it("labels every Change Set status including conflicted", () => {
    expect(formatChangeStatus("added")).toBe("Added");
    expect(formatChangeStatus("modified")).toBe("Modified");
    expect(formatChangeStatus("deleted")).toBe("Deleted");
    expect(formatChangeStatus("renamed")).toBe("Renamed");
    expect(formatChangeStatus("untracked")).toBe("Untracked");
    expect(formatChangeStatus("conflicted")).toBe("Conflicted");
  });
});

describe("formatChangeCounts", () => {
  it("renders insertion and deletion counts for text files", () => {
    expect(formatChangeCounts(file({ path: "a.ts", insertions: 11, deletions: 2 }))).toBe("+11 −2");
  });

  it("shows an honest binary marker instead of +0 −0", () => {
    expect(
      formatChangeCounts(
        file({ path: "logo.png", insertions: null, deletions: null, binary: true }),
      ),
    ).toBe("Binary");
  });

  it("shows no counts when both sides are null on a non-binary (e.g. untracked)", () => {
    expect(
      formatChangeCounts(
        file({
          path: "scratch.txt",
          status: "untracked",
          insertions: null,
          deletions: null,
          binary: false,
        }),
      ),
    ).toBeNull();
  });
});

describe("presentChangeRow", () => {
  it("presents a normal file with filename, parent, status, and counts", () => {
    expect(presentChangeRow(file({ path: "src/a.ts", insertions: 3, deletions: 1 }))).toEqual({
      path: "src/a.ts",
      filename: "a.ts",
      parentPath: "src",
      statusLabel: "Modified",
      countsLabel: "+3 −1",
      renameFrom: null,
    });
  });

  it("surfaces both rename paths (previousPath → path)", () => {
    expect(
      presentChangeRow(
        file({
          path: "src/new-name.ts",
          previousPath: "src/old-name.ts",
          status: "renamed",
          insertions: 0,
          deletions: 0,
        }),
      ),
    ).toEqual({
      path: "src/new-name.ts",
      filename: "new-name.ts",
      parentPath: "src",
      statusLabel: "Renamed",
      countsLabel: "+0 −0",
      renameFrom: "src/old-name.ts",
    });
  });

  it("projects passive stale awareness into visible and accessible row copy", () => {
    const recency = reduceChangeRecency(
      reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
        type: "inspect",
        path: "src/a.ts",
        revision: "revision-1",
      }),
      { type: "external-revision", path: "src/a.ts", revision: "revision-2" },
    );

    expect(presentChangeRowWithRecency(file({ path: "src/a.ts" }), recency)).toMatchObject({
      updatedLabel: "Updated",
      updatedDescription: "Updated since you last opened this file",
    });
  });
});

describe("sortChangeSetFiles", () => {
  it("sorts by path for a stable flat list", () => {
    const sorted = sortChangeSetFiles([
      file({ path: "z.ts" }),
      file({ path: "a/b.ts" }),
      file({ path: "a.ts" }),
    ]);
    expect(sorted.map((f) => f.path)).toEqual(["a.ts", "a/b.ts", "z.ts"]);
  });
});

function navigatorState(overrides: Partial<ChangesNavigatorState> = {}): ChangesNavigatorState {
  return {
    revision: null,
    files: [],
    activeTabId: "doc",
    listFocusPath: null,
    hiddenCount: 0,
    ...overrides,
  };
}

function snapshot(over: Partial<ChangeSetSnapshot> = {}): ChangeSetSnapshot {
  const files = over.files ?? [];
  return {
    baseRevision: "base",
    headRevision: "head",
    revision: "rev",
    insertions: 0,
    deletions: 0,
    truncated: false,
    totalCount: files.length,
    ...over,
    files,
  };
}

describe("applyChangeSetRefresh", () => {
  it("updates rows from the snapshot without opening, closing, or focusing a tab", () => {
    const before = navigatorState({
      activeTabId: "doc",
      listFocusPath: "src/a.ts",
      revision: "rev-1",
      files: [file({ path: "src/a.ts" })],
    });
    const after = applyChangeSetRefresh(
      before,
      snapshot({
        revision: "rev-2",
        insertions: 5,
        deletions: 1,
        files: [
          file({ path: "src/a.ts", insertions: 5, deletions: 1 }),
          file({ path: "src/b.ts" }),
        ],
      }),
    );

    expect(after.revision).toBe("rev-2");
    expect(after.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    // The single most important behavioral contract in #108:
    expect(after.activeTabId).toBe(before.activeTabId);
    expect(after.listFocusPath).toBe(before.listFocusPath);
  });

  it("is a no-op when the opaque revision is unchanged", () => {
    const before = navigatorState({
      revision: "same",
      files: [file({ path: "a.ts" })],
      activeTabId: "file:a.ts",
    });
    const after = applyChangeSetRefresh(
      before,
      snapshot({
        revision: "same",
        insertions: 99,
        deletions: 99,
        files: [file({ path: "z.ts", insertions: 99, deletions: 99 })],
      }),
    );
    expect(after).toBe(before);
  });

  it("carries the count the snapshot's cap left out", () => {
    const after = applyChangeSetRefresh(
      navigatorState(),
      snapshot({
        revision: "capped",
        files: [file({ path: "a.ts" }), file({ path: "b.ts" })],
        truncated: true,
        totalCount: 4002,
      }),
    );
    expect(after.hiddenCount).toBe(4000);
  });

  it("reports nothing hidden for an uncapped snapshot", () => {
    const after = applyChangeSetRefresh(
      navigatorState({ hiddenCount: 4000 }),
      snapshot({ revision: "full", files: [file({ path: "a.ts" })] }),
    );
    expect(after.hiddenCount).toBe(0);
  });
});

describe("selectChangeRow", () => {
  it("records a deliberate open intent for the path without stealing list focus", () => {
    const before = navigatorState({ activeTabId: "doc", listFocusPath: null });
    const { state, openPath } = selectChangeRow(before, "src/a.ts");
    expect(openPath).toBe("src/a.ts");
    expect(state.listFocusPath).toBe("src/a.ts");
    // Host opens the tab; the navigator itself does not mutate activeTabId
    // (decision #48 — initial keyboard focus stays in the Changes list).
    expect(state.activeTabId).toBe("doc");
  });
});
