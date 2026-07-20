import type { DiffStat } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  formatAheadBehind,
  formatMergeBaseSummary,
  formatWorkingTree,
  getDoneFlowActions,
  type WorktreeStatusSnapshot,
} from "./worktree-done-flow-model";

function status(overrides: Partial<WorktreeStatusSnapshot> = {}): WorktreeStatusSnapshot {
  return {
    uncommitted: false,
    sequencerActive: false,
    aheadOfBase: null,
    behindBase: null,
    unpushed: null,
    ...overrides,
  };
}

function diff(overrides: Partial<DiffStat> = {}): DiffStat {
  return { files: [], insertions: 0, deletions: 0, ...overrides };
}

describe("getDoneFlowActions", () => {
  it("shows nothing but 'open PR' before status has loaded, if a PR already exists", () => {
    const actions = getDoneFlowActions(null, "https://github.com/x/y/pull/1", {
      committing: false,
      pushingPr: false,
    });
    expect(actions.showSequencerNotice).toBe(false);
    expect(actions.showCommit).toBe(false);
    expect(actions.showPushPr).toBe(false);
    expect(actions.showOpenPr).toBe(true);
  });

  it("shows nothing before status has loaded and no PR exists yet", () => {
    const actions = getDoneFlowActions(null, null, { committing: false, pushingPr: false });
    expect(actions.showCommit).toBe(false);
    expect(actions.showPushPr).toBe(false);
    expect(actions.showOpenPr).toBe(false);
  });

  it("offers commit when the tree is dirty and no sequencer op is mid-flight", () => {
    const actions = getDoneFlowActions(status({ uncommitted: true }), null, {
      committing: false,
      pushingPr: false,
    });
    expect(actions.showCommit).toBe(true);
    expect(actions.commitDisabled).toBe(false);
  });

  it("withholds the commit button (never just disables it) while a sequencer op is mid-flight", () => {
    const actions = getDoneFlowActions(status({ uncommitted: true, sequencerActive: true }), null, {
      committing: false,
      pushingPr: false,
    });
    expect(actions.showCommit).toBe(false);
    expect(actions.showSequencerNotice).toBe(true);
  });

  it("disables (but still shows) commit while a commit is in flight", () => {
    const actions = getDoneFlowActions(status({ uncommitted: true }), null, {
      committing: true,
      pushingPr: false,
    });
    expect(actions.showCommit).toBe(true);
    expect(actions.commitDisabled).toBe(true);
  });

  it("offers push-and-create-PR once the branch is ahead of base and no PR exists", () => {
    const actions = getDoneFlowActions(status({ aheadOfBase: 3 }), null, {
      committing: false,
      pushingPr: false,
    });
    expect(actions.showPushPr).toBe(true);
    expect(actions.pushPrDisabled).toBe(false);
  });

  it("does not offer push-and-create-PR when aheadOfBase is null (base unknown) or zero", () => {
    expect(
      getDoneFlowActions(status({ aheadOfBase: null }), null, {
        committing: false,
        pushingPr: false,
      }).showPushPr,
    ).toBe(false);
    expect(
      getDoneFlowActions(status({ aheadOfBase: 0 }), null, {
        committing: false,
        pushingPr: false,
      }).showPushPr,
    ).toBe(false);
  });

  it("prefers 'open PR' over 'push & create draft PR' once a prUrl exists", () => {
    const actions = getDoneFlowActions(
      status({ aheadOfBase: 5 }),
      "https://github.com/x/y/pull/2",
      {
        committing: false,
        pushingPr: false,
      },
    );
    expect(actions.showPushPr).toBe(false);
    expect(actions.showOpenPr).toBe(true);
  });

  it("disables push-and-create-PR while it is already in flight", () => {
    const actions = getDoneFlowActions(status({ aheadOfBase: 1 }), null, {
      committing: false,
      pushingPr: true,
    });
    expect(actions.showPushPr).toBe(true);
    expect(actions.pushPrDisabled).toBe(true);
  });

  it("never treats behind-base as a blocker — commit/push stay available while behind", () => {
    const actions = getDoneFlowActions(
      status({ uncommitted: true, behindBase: 4, aheadOfBase: 2 }),
      null,
      {
        committing: false,
        pushingPr: false,
      },
    );
    expect(actions.showCommit).toBe(true);
    expect(actions.showPushPr).toBe(true);
  });

  it("offers 'push updates' when a PR exists and local commits haven't reached origin", () => {
    const actions = getDoneFlowActions(
      status({ aheadOfBase: 5, unpushed: 2 }),
      "https://github.com/x/y/pull/2",
      { committing: false, pushingPr: false },
    );
    expect(actions.showPushUpdates).toBe(true);
    expect(actions.showPushPr).toBe(false);
    expect(actions.showOpenPr).toBe(true);
  });

  it("never offers 'push updates' without a PR, when fully pushed, or when unpushed is unknown", () => {
    const noPr = getDoneFlowActions(status({ unpushed: 2 }), null, {
      committing: false,
      pushingPr: false,
    });
    expect(noPr.showPushUpdates).toBe(false);
    const pushed = getDoneFlowActions(status({ unpushed: 0 }), "https://github.com/x/y/pull/2", {
      committing: false,
      pushingPr: false,
    });
    expect(pushed.showPushUpdates).toBe(false);
    const unknown = getDoneFlowActions(
      status({ unpushed: null }),
      "https://github.com/x/y/pull/2",
      {
        committing: false,
        pushingPr: false,
      },
    );
    expect(unknown.showPushUpdates).toBe(false);
  });
});

describe("formatWorkingTree", () => {
  it("reports uncommitted changes", () => {
    expect(formatWorkingTree(status({ uncommitted: true }))).toBe("Uncommitted changes present");
  });

  it("reports a clean tree", () => {
    expect(formatWorkingTree(status({ uncommitted: false }))).toBe("Working tree clean");
  });
});

describe("formatAheadBehind", () => {
  it("returns null when base is unknown", () => {
    expect(formatAheadBehind(status({ aheadOfBase: null, behindBase: 3 }))).toBeNull();
    expect(formatAheadBehind(status({ aheadOfBase: 3, behindBase: null }))).toBeNull();
  });

  it("reports up to date when both counts are zero", () => {
    expect(formatAheadBehind(status({ aheadOfBase: 0, behindBase: 0 }))).toBe(
      "Up to date with base",
    );
  });

  it("reports ahead only", () => {
    expect(formatAheadBehind(status({ aheadOfBase: 3, behindBase: 0 }))).toBe("3 ahead");
  });

  it("reports behind only, never as a blocker (info line, same shape as ahead)", () => {
    expect(formatAheadBehind(status({ aheadOfBase: 0, behindBase: 1 }))).toBe("1 behind base");
  });

  it("reports both ahead and behind", () => {
    expect(formatAheadBehind(status({ aheadOfBase: 3, behindBase: 1 }))).toBe(
      "3 ahead · 1 behind base",
    );
  });
});

describe("formatMergeBaseSummary", () => {
  it("returns null when there are no changes vs base", () => {
    expect(formatMergeBaseSummary(diff())).toBeNull();
  });

  it("summarizes file count and line deltas", () => {
    const summary = formatMergeBaseSummary(
      diff({
        files: [
          { path: "a.ts", insertions: 10, deletions: 2, untracked: false },
          { path: "b.ts", insertions: 1, deletions: 0, untracked: false },
        ],
        insertions: 11,
        deletions: 2,
      }),
    );
    expect(summary).toBe("2 files · +11 −2");
  });

  it("uses singular 'file' for exactly one file", () => {
    const summary = formatMergeBaseSummary(
      diff({
        files: [{ path: "a.ts", insertions: 1, deletions: 0, untracked: false }],
        insertions: 1,
        deletions: 0,
      }),
    );
    expect(summary).toBe("1 file · +1 −0");
  });

  it("calls out binary/untracked files separately since they carry no line counts", () => {
    const summary = formatMergeBaseSummary(
      diff({
        files: [
          { path: "a.ts", insertions: 1, deletions: 0, untracked: false },
          { path: "image.png", insertions: null, deletions: null, untracked: false },
          { path: "new.txt", insertions: null, deletions: null, untracked: true },
        ],
        insertions: 1,
        deletions: 0,
      }),
    );
    expect(summary).toBe("3 files · +1 −0 · +2 binary/untracked");
  });
});
