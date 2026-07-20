import type { DiffStat } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  formatMergeBaseSummary,
  resolveDoneFlow,
  type DoneFlowStage,
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

const PR = "https://github.com/x/y/pull/1";

function view(
  s: WorktreeStatusSnapshot | null,
  prUrl: string | null,
  stage: DoneFlowStage = "idle",
) {
  return resolveDoneFlow(s, prUrl, stage);
}

describe("resolveDoneFlow — primary action", () => {
  it("is a disabled 'Create draft PR' with a Loading reason before the first fetch, no PR", () => {
    const { primary } = view(null, null);
    expect(primary.kind).toBe("create-pr");
    expect(primary.label).toBe("Create draft PR");
    expect(primary.disabled).toBe(true);
    expect(primary.reason).toBe("Loading…");
  });

  it("is an enabled 'View PR' before the first fetch when a PR already exists", () => {
    const { primary } = view(null, PR);
    expect(primary.kind).toBe("view-pr");
    expect(primary.label).toBe("View PR");
    expect(primary.disabled).toBe(false);
    expect(primary.reason).toBeNull();
  });

  it("is 'Commit & create draft PR' when the tree is dirty and no PR exists", () => {
    const { primary } = view(status({ uncommitted: true }), null);
    expect(primary.kind).toBe("commit-pr");
    expect(primary.label).toBe("Commit & create draft PR");
    expect(primary.disabled).toBe(false);
  });

  it("is 'Commit & push updates' when the tree is dirty and a PR exists", () => {
    const { primary } = view(status({ uncommitted: true }), PR);
    expect(primary.kind).toBe("commit-push-updates");
    expect(primary.label).toBe("Commit & push updates");
    expect(primary.disabled).toBe(false);
  });

  it("is 'Push & create draft PR' when clean, ahead of base, and no PR exists", () => {
    const { primary } = view(status({ aheadOfBase: 3 }), null);
    expect(primary.kind).toBe("push-pr");
    expect(primary.label).toBe("Push & create draft PR");
    expect(primary.disabled).toBe(false);
  });

  it("is 'Push updates' when a PR exists and local commits are unpushed", () => {
    const { primary } = view(status({ aheadOfBase: 5, unpushed: 2 }), PR);
    expect(primary.kind).toBe("push-updates");
    expect(primary.label).toBe("Push updates");
    expect(primary.disabled).toBe(false);
  });

  it("is 'View PR' when a PR exists with nothing pending", () => {
    const { primary } = view(status({ aheadOfBase: 5, unpushed: 0 }), PR);
    expect(primary.kind).toBe("view-pr");
    expect(primary.label).toBe("View PR");
    expect(primary.disabled).toBe(false);
  });

  it("prefers commit over push once the tree is dirty (commit-stack wins)", () => {
    // dirty + ahead + no PR → commit-pr, not push-pr
    expect(view(status({ uncommitted: true, aheadOfBase: 3 }), null).primary.kind).toBe(
      "commit-pr",
    );
    // dirty + unpushed + PR → commit-push-updates, not push-updates
    expect(view(status({ uncommitted: true, unpushed: 2 }), PR).primary.kind).toBe(
      "commit-push-updates",
    );
  });

  it("is a disabled 'Create draft PR' with 'No changes vs base yet' when clean and even with base", () => {
    const { primary } = view(status({ aheadOfBase: 0 }), null);
    expect(primary.kind).toBe("create-pr");
    expect(primary.disabled).toBe(true);
    expect(primary.reason).toBe("No changes vs base yet");
  });

  it("is a disabled 'Create draft PR' with 'Base branch not resolved' when the base is unknown", () => {
    const { primary } = view(status({ aheadOfBase: null }), null);
    expect(primary.kind).toBe("create-pr");
    expect(primary.disabled).toBe(true);
    expect(primary.reason).toBe("Base branch not resolved");
  });

  it("never treats behind-base as a blocker", () => {
    const { primary } = view(status({ uncommitted: true, behindBase: 4, aheadOfBase: 2 }), null);
    expect(primary.kind).toBe("commit-pr");
    expect(primary.disabled).toBe(false);
  });
});

describe("resolveDoneFlow — sequencer rule", () => {
  it("disables a commit-stack primary with the sequencer reason", () => {
    const { primary } = view(status({ uncommitted: true, sequencerActive: true }), null);
    expect(primary.kind).toBe("commit-pr");
    expect(primary.disabled).toBe(true);
    expect(primary.reason).toBe("Merge/rebase in progress — resolve it in the terminal.");
  });

  it("leaves a push-only primary enabled during a sequencer op", () => {
    const { primary } = view(status({ aheadOfBase: 3, sequencerActive: true }), null);
    expect(primary.kind).toBe("push-pr");
    expect(primary.disabled).toBe(false);
    expect(primary.reason).toBeNull();
  });

  it("leaves View PR enabled during a sequencer op", () => {
    const { primary } = view(status({ sequencerActive: true, unpushed: 0 }), PR);
    expect(primary.kind).toBe("view-pr");
    expect(primary.disabled).toBe(false);
  });

  it("disables the menu Commit verb with the sequencer reason but leaves Push enabled", () => {
    const { menu } = view(
      status({ uncommitted: true, aheadOfBase: 2, sequencerActive: true }),
      null,
    );
    expect(menu.commit.disabled).toBe(true);
    expect(menu.commit.reason).toBe("Merge/rebase in progress — resolve it in the terminal.");
    expect(menu.push.disabled).toBe(false);
  });
});

describe("resolveDoneFlow — busy stage", () => {
  it("disables the primary and shows 'Committing…' while committing", () => {
    const { primary } = view(status({ uncommitted: true }), null, "committing");
    expect(primary.label).toBe("Committing…");
    expect(primary.disabled).toBe(true);
    expect(primary.reason).toBeNull();
  });

  it("disables the primary and shows 'Pushing…' while pushing", () => {
    const { primary } = view(status({ aheadOfBase: 3 }), null, "pushing");
    expect(primary.label).toBe("Pushing…");
    expect(primary.disabled).toBe(true);
  });

  it("disables every menu verb while a stage is running", () => {
    const { menu } = view(status({ uncommitted: true, aheadOfBase: 3 }), PR, "committing");
    expect(menu.commit.disabled).toBe(true);
    expect(menu.push.disabled).toBe(true);
    expect(menu.openPr.disabled).toBe(true);
  });
});

describe("resolveDoneFlow — chevron menu", () => {
  it("enables Commit only when the tree is dirty and no sequencer op is mid-flight", () => {
    expect(view(status({ uncommitted: true }), null).menu.commit.disabled).toBe(false);
  });

  it("disables Commit with 'Working tree clean' on a clean tree", () => {
    const { menu } = view(status({ uncommitted: false }), null);
    expect(menu.commit.disabled).toBe(true);
    expect(menu.commit.reason).toBe("Working tree clean");
  });

  it("disables Commit with 'Loading…' before the first fetch", () => {
    const { menu } = view(null, null);
    expect(menu.commit.disabled).toBe(true);
    expect(menu.commit.reason).toBe("Loading…");
  });

  it("labels Push 'Push & create draft PR' with no PR, enabled iff ahead of base", () => {
    const ahead = view(status({ aheadOfBase: 2 }), null).menu.push;
    expect(ahead.kind).toBe("push-pr");
    expect(ahead.label).toBe("Push & create draft PR");
    expect(ahead.disabled).toBe(false);

    const even = view(status({ aheadOfBase: 0 }), null).menu.push;
    expect(even.disabled).toBe(true);
    expect(even.reason).toBe("Nothing to push");
  });

  it("labels Push 'Push updates' with a PR, enabled iff unpushed commits exist", () => {
    const unpushed = view(status({ unpushed: 2 }), PR).menu.push;
    expect(unpushed.kind).toBe("push-updates");
    expect(unpushed.label).toBe("Push updates");
    expect(unpushed.disabled).toBe(false);

    const pushed = view(status({ unpushed: 0 }), PR).menu.push;
    expect(pushed.disabled).toBe(true);
    expect(pushed.reason).toBe("Nothing to push");
  });

  it("enables Open PR only when a prUrl exists", () => {
    expect(view(status(), PR).menu.openPr.disabled).toBe(false);
    const noPr = view(status(), null).menu.openPr;
    expect(noPr.disabled).toBe(true);
    expect(noPr.reason).toBe("No PR yet");
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
