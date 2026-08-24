import { describe, expect, it } from "vite-plus/test";

import { changeSetToDiffStat, type ChangeSetSnapshot } from "./change-set";

function snapshot(over: Partial<ChangeSetSnapshot> = {}): ChangeSetSnapshot {
  return {
    baseRevision: "base",
    headRevision: "head",
    files: [],
    insertions: 0,
    deletions: 0,
    revision: "rev",
    truncated: false,
    totalCount: 0,
    ...over,
  };
}

describe("changeSetToDiffStat", () => {
  it("projects Change Set files into the legacy DiffStat shape", () => {
    const diff = changeSetToDiffStat(
      snapshot({
        files: [
          {
            path: "src/a.ts",
            status: "modified",
            insertions: 3,
            deletions: 1,
            binary: false,
          },
          {
            path: "new.ts",
            status: "untracked",
            insertions: 4,
            deletions: 0,
            binary: false,
          },
          {
            path: "logo.png",
            status: "added",
            insertions: null,
            deletions: null,
            binary: true,
          },
          {
            path: "conflict.ts",
            status: "conflicted",
            insertions: 2,
            deletions: 2,
            binary: false,
          },
        ],
        insertions: 9,
        deletions: 3,
      }),
    );
    expect(diff).toEqual({
      files: [
        { path: "src/a.ts", insertions: 3, deletions: 1, untracked: false },
        { path: "new.ts", insertions: 4, deletions: 0, untracked: true },
        { path: "logo.png", insertions: null, deletions: null, untracked: false },
        { path: "conflict.ts", insertions: 2, deletions: 2, untracked: false },
      ],
      insertions: 9,
      deletions: 3,
    });
  });
});
