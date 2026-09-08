import { describe, expect, it } from "vite-plus/test";

import {
  isCompletedOrphanCleanupItem,
  isOrphanAgeBasis,
  isOrphanCleanupItemKind,
  isOrphanCleanupItemOutcome,
  isOrphanCleanupPlanItem,
  isOrphanCleanupRejectionCode,
  isOrphanCleanupSource,
  isOrphanKeptReason,
  isOrphanMetadataKeptReason,
  orphanCleanupNeedsAttention,
  tallyOrphanCleanup,
  type OrphanCleanupItem,
  type OrphanCleanupItemState,
  type OrphanCleanupPlanItem,
} from "./worktree-orphans";

function item(state: OrphanCleanupItemState, id: string = state): OrphanCleanupItem {
  return {
    id,
    kind: "worktree",
    path: `/tmp/${id}`,
    projectId: "p1",
    projectName: "Project",
    projectPath: "/repo",
    branch: null,
    state,
    detail: null,
    startedAt: null,
    settledAt: null,
    reconciledAt: null,
  };
}

function planItem(overrides: Partial<OrphanCleanupPlanItem> = {}): OrphanCleanupPlanItem {
  return {
    id: "rev1:worktree:0",
    kind: "worktree",
    path: "/wt/a",
    projectId: "p1",
    projectName: "Project",
    projectPath: "/repo",
    branch: "volli/VC-1",
    gitReason: null,
    ...overrides,
  };
}

describe("orphan vocabulary guards", () => {
  it("recognises its own words and refuses anything else", () => {
    expect(isOrphanAgeBasis("directory")).toBe(true);
    expect(isOrphanAgeBasis("commit")).toBe(true);
    expect(isOrphanAgeBasis("mtime")).toBe(false);

    expect(isOrphanKeptReason("recently-used")).toBe(true);
    expect(isOrphanKeptReason("age-unknown")).toBe(true);
    expect(isOrphanKeptReason("active")).toBe(true);
    expect(isOrphanKeptReason("busy")).toBe(false);

    expect(isOrphanMetadataKeptReason("not-owned")).toBe(true);
    expect(isOrphanMetadataKeptReason("ticket-linked")).toBe(true);
    expect(isOrphanMetadataKeptReason("stale")).toBe(false);

    expect(isOrphanCleanupSource("settings")).toBe(true);
    expect(isOrphanCleanupSource("startup")).toBe(true);
    expect(isOrphanCleanupSource("cli")).toBe(false);

    expect(isOrphanCleanupItemKind("worktree")).toBe(true);
    expect(isOrphanCleanupItemKind("metadata")).toBe(true);
    expect(isOrphanCleanupItemKind("branch")).toBe(false);

    expect(isOrphanCleanupRejectionCode("scan-superseded")).toBe(true);
    expect(isOrphanCleanupRejectionCode("unknown-items")).toBe(true);
    expect(isOrphanCleanupRejectionCode("conflict")).toBe(true);
    expect(isOrphanCleanupRejectionCode("nope")).toBe(false);
  });

  it("treats only the four recorded outcomes as outcomes", () => {
    expect(isOrphanCleanupItemOutcome("completed")).toBe(true);
    expect(isOrphanCleanupItemOutcome("skipped")).toBe(true);
    expect(isOrphanCleanupItemOutcome("failed")).toBe(true);
    expect(isOrphanCleanupItemOutcome("indeterminate")).toBe(true);
    // The two derived states are never recorded as facts.
    expect(isOrphanCleanupItemOutcome("pending")).toBe(false);
    expect(isOrphanCleanupItemOutcome("executing")).toBe(false);
  });

  it("says only a completed item means the world changed", () => {
    expect(isCompletedOrphanCleanupItem("completed")).toBe(true);
    for (const state of ["pending", "executing", "skipped", "failed", "indeterminate"] as const) {
      expect(isCompletedOrphanCleanupItem(state)).toBe(false);
    }
  });
});

// The guard a durable reader uses before believing a stored plan (VC-284
// re-review C3). It is deliberately whole-shape: a plan item that is missing a
// path, or carries one of the wrong type, cannot be silently folded into a
// shorter plan, because a shorter plan is a shorter deletion history.
describe("isOrphanCleanupPlanItem", () => {
  it("accepts a complete plan item of either kind", () => {
    expect(isOrphanCleanupPlanItem(planItem())).toBe(true);
    expect(
      isOrphanCleanupPlanItem(
        planItem({
          kind: "metadata",
          branch: null,
          gitReason: "gitdir file points to non-existent location",
        }),
      ),
    ).toBe(true);
  });

  it("refuses anything that is not one", () => {
    expect(isOrphanCleanupPlanItem(null)).toBe(false);
    expect(isOrphanCleanupPlanItem([planItem()])).toBe(false);
    expect(isOrphanCleanupPlanItem("rev1:worktree:0")).toBe(false);
    for (const damaged of [
      { id: "" },
      { id: 7 },
      { kind: "branch" },
      { path: "" },
      { path: 3 },
      { projectId: null },
      { projectName: 1 },
      { projectPath: null },
      { branch: 4 },
      { gitReason: 4 },
    ]) {
      expect(isOrphanCleanupPlanItem({ ...planItem(), ...damaged })).toBe(false);
    }
  });
});

describe("tallyOrphanCleanup", () => {
  it("counts every state, including the two derived ones", () => {
    const run = {
      items: [
        item("completed"),
        item("completed", "completed-2"),
        item("skipped"),
        item("failed"),
        item("indeterminate"),
        item("executing"),
        item("pending"),
      ],
    };
    expect(tallyOrphanCleanup(run)).toEqual({
      completed: 2,
      skipped: 1,
      failed: 1,
      indeterminate: 1,
      executing: 1,
      pending: 1,
    });
  });

  it("counts nothing for a run with no items", () => {
    expect(tallyOrphanCleanup({ items: [] })).toEqual({
      completed: 0,
      skipped: 0,
      failed: 0,
      indeterminate: 0,
      executing: 0,
      pending: 0,
    });
  });
});

describe("orphanCleanupNeedsAttention", () => {
  it("is quiet about skips, which are the policy working", () => {
    expect(orphanCleanupNeedsAttention({ items: [item("completed"), item("skipped")] })).toBe(
      false,
    );
    expect(orphanCleanupNeedsAttention({ items: [item("pending")] })).toBe(false);
  });

  it("speaks up for a failure, an unknown effect, or an unsettled mutation", () => {
    expect(orphanCleanupNeedsAttention({ items: [item("failed")] })).toBe(true);
    expect(orphanCleanupNeedsAttention({ items: [item("indeterminate")] })).toBe(true);
    expect(orphanCleanupNeedsAttention({ items: [item("executing")] })).toBe(true);
  });
});
