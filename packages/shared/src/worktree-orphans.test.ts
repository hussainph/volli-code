import { describe, expect, it } from "vite-plus/test";

import {
  isCompletedOrphanCleanupItem,
  isOrphanAgeBasis,
  isOrphanCleanupItemKind,
  isOrphanCleanupItemOutcome,
  isOrphanCleanupRejectionCode,
  isOrphanCleanupSource,
  isOrphanKeptReason,
  isOrphanMetadataKeptReason,
  orphanCleanupNeedsAttention,
  tallyOrphanCleanup,
  type OrphanCleanupItem,
  type OrphanCleanupItemState,
} from "./worktree-orphans";

function item(state: OrphanCleanupItemState, id: string = state): OrphanCleanupItem {
  return {
    id,
    kind: "worktree",
    path: `/tmp/${id}`,
    projectId: "p1",
    projectName: "Project",
    branch: null,
    state,
    detail: null,
    startedAt: null,
    settledAt: null,
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
