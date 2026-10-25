import { describe, expect, it } from "vite-plus/test";

import {
  WORKING_COPY_FILE_STATES,
  workingCopyFileTotal,
  workingCopyLooseCount,
  workingCopySegments,
  type WorkingCopyFileCounts,
} from "./working-copy";

function counts(over: Partial<WorkingCopyFileCounts> = {}): WorkingCopyFileCounts {
  return { committed: 0, modified: 0, added: 0, untracked: 0, ...over };
}

describe("workingCopyFileTotal", () => {
  it("sums the four disjoint states", () => {
    expect(
      workingCopyFileTotal(counts({ committed: 4, modified: 2, added: 1, untracked: 3 })),
    ).toBe(10);
  });

  it("is zero for a clean working copy", () => {
    expect(workingCopyFileTotal(counts())).toBe(0);
  });
});

describe("workingCopyLooseCount", () => {
  it("counts only what is dirty right now", () => {
    expect(
      workingCopyLooseCount(counts({ committed: 7, modified: 2, added: 1, untracked: 3 })),
    ).toBe(6);
  });
});

describe("workingCopySegments", () => {
  it("draws committed first, then the loose states in order", () => {
    expect(
      workingCopySegments(counts({ committed: 4, modified: 2, added: 1, untracked: 3 })),
    ).toEqual([
      { state: "committed", count: 4 },
      { state: "modified", count: 2 },
      { state: "added", count: 1 },
      { state: "untracked", count: 3 },
    ]);
  });

  it("omits empty states so a one-state working copy is a solid bar", () => {
    expect(workingCopySegments(counts({ untracked: 2 }))).toEqual([
      { state: "untracked", count: 2 },
    ]);
  });

  it("draws nothing for a clean working copy", () => {
    expect(workingCopySegments(counts())).toEqual([]);
  });

  it("sums to the stated total — the claim a segmented bar makes", () => {
    const files = counts({ committed: 9, modified: 4, added: 2, untracked: 6 });
    const drawn = workingCopySegments(files).reduce((sum, segment) => sum + segment.count, 0);
    expect(drawn).toBe(workingCopyFileTotal(files));
  });

  it("covers every state the vocabulary declares", () => {
    const files = counts({ committed: 1, modified: 1, added: 1, untracked: 1 });
    expect(workingCopySegments(files).map((segment) => segment.state)).toEqual(
      WORKING_COPY_FILE_STATES,
    );
  });
});
