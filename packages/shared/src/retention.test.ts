import { describe, expect, it } from "vite-plus/test";

import { computeArchiveReadiness, computeWorktreeReclaim, decideTrimFinish } from "./retention";

const DAY = 24 * 60 * 60 * 1000;

describe("computeArchiveReadiness", () => {
  const base = {
    status: "done" as const,
    keep: false,
    dismissed: false,
    prUrl: null,
    prState: null,
    doneEntryAt: 0,
    now: 100 * DAY,
    ttlMs: 14 * DAY,
  };

  it("flags a merged PR as archive-ready in any column (reason pr-merged)", () => {
    expect(
      computeArchiveReadiness({
        ...base,
        status: "needs_review",
        prUrl: "https://x/pull/1",
        prState: "merged",
        doneEntryAt: null,
      }),
    ).toEqual({ archiveReady: true, reason: "pr-merged" });
  });

  it("does not TTL a ticket whose Done entry is younger than the TTL", () => {
    expect(computeArchiveReadiness({ ...base, doneEntryAt: 99 * DAY })).toEqual({
      archiveReady: false,
      reason: null,
    });
  });

  it("flags a Done, PR-less ticket past its TTL (reason ttl-expired)", () => {
    expect(computeArchiveReadiness({ ...base, doneEntryAt: 80 * DAY })).toEqual({
      archiveReady: true,
      reason: "ttl-expired",
    });
  });

  it("never TTLs a ticket with an OPEN PR — it waits for the merge", () => {
    expect(
      computeArchiveReadiness({
        ...base,
        prUrl: "https://x/pull/1",
        prState: "open",
        doneEntryAt: 1,
      }),
    ).toEqual({
      archiveReady: false,
      reason: null,
    });
  });

  it("TTLs a Done ticket whose PR was closed (not merged) once expired", () => {
    expect(
      computeArchiveReadiness({
        ...base,
        prUrl: "https://x/pull/1",
        prState: "closed",
        doneEntryAt: 1,
      }),
    ).toEqual({
      archiveReady: true,
      reason: "ttl-expired",
    });
  });

  it("suppresses the prompt when dismissed, but still reports the reason", () => {
    expect(
      computeArchiveReadiness({
        ...base,
        prUrl: "https://x/pull/1",
        prState: "merged",
        dismissed: true,
      }),
    ).toEqual({
      archiveReady: false,
      reason: "pr-merged",
    });
  });

  // A kept ticket is exempt from both merge and TTL cleanup paths.
  it("Keep exempts a merged-PR ticket (merge path)", () => {
    expect(
      computeArchiveReadiness({
        ...base,
        prUrl: "https://x/pull/1",
        prState: "merged",
        keep: true,
      }),
    ).toEqual({
      archiveReady: false,
      reason: null,
    });
  });

  it("Keep exempts an expired Done ticket (TTL path)", () => {
    expect(computeArchiveReadiness({ ...base, doneEntryAt: 1, keep: true })).toEqual({
      archiveReady: false,
      reason: null,
    });
  });

  // F1: a discovered-but-unpolled PR (prUrl set, prState still null — never
  // polled, offline, gh missing) reads as UNKNOWN, not "no PR", and must not
  // let the TTL fire. Regression for the bug where a Done-past-TTL ticket
  // with a live OPEN PR could archive because the watch just hadn't polled
  // its state yet.
  it("does not TTL a Done ticket with a discovered-but-unpolled PR (prUrl set, prState unknown)", () => {
    expect(
      computeArchiveReadiness({
        ...base,
        prUrl: "https://x/pull/1",
        prState: null,
        doneEntryAt: 80 * DAY,
      }),
    ).toEqual({
      archiveReady: false,
      reason: null,
    });
  });

  // The flip side of the above: a ticket with NO PR at all also has
  // `prState: null`, but there's nothing to wait on, so the TTL applies
  // normally — `prUrl === null` is what distinguishes "no PR" from "unknown".
  it("still TTLs a Done ticket with no PR at all (prUrl null, prState null)", () => {
    expect(
      computeArchiveReadiness({
        ...base,
        prUrl: null,
        prState: null,
        doneEntryAt: 80 * DAY,
      }),
    ).toEqual({
      archiveReady: true,
      reason: "ttl-expired",
    });
  });
});

// VC-113. The reclaim is the prompt's narrower sibling: the prompt asks "is
// this worth wrapping up?", the reclaim asks "is it safe to delete the folder
// without asking?". Only time can answer the second one.
describe("computeWorktreeReclaim", () => {
  const base = {
    status: "done" as const,
    keep: false,
    prUrl: null,
    prState: null,
    doneEntryAt: 0,
    now: 100 * DAY,
    ttlMs: 14 * DAY,
  };

  it("reclaims a Done ticket that has sat past the TTL", () => {
    expect(computeWorktreeReclaim(base)).toEqual({ reclaim: true, reason: "ttl-expired" });
  });

  // The bug in one case: a merge is not a dwell. The prompt reacts to it; the
  // deletion must not.
  it("does NOT reclaim on a merge alone, however fresh the merge is", () => {
    expect(
      computeWorktreeReclaim({
        ...base,
        status: "needs_review",
        prUrl: "https://x/pull/1",
        prState: "merged",
        doneEntryAt: null,
      }),
    ).toEqual({ reclaim: false, reason: null });
  });

  it("reclaims a long-merged ticket once the dwell is what earned it", () => {
    expect(
      computeWorktreeReclaim({
        ...base,
        prUrl: "https://x/pull/1",
        prState: "merged",
        doneEntryAt: 80 * DAY,
      }),
    ).toEqual({ reclaim: true, reason: "ttl-expired" });
  });

  it("never reclaims while a PR is open", () => {
    expect(computeWorktreeReclaim({ ...base, prUrl: "https://x/pull/1", prState: "open" })).toEqual(
      { reclaim: false, reason: null },
    );
  });

  it("never reclaims while a PR exists but has not been observed yet", () => {
    expect(computeWorktreeReclaim({ ...base, prUrl: "https://x/pull/1", prState: null })).toEqual({
      reclaim: false,
      reason: null,
    });
  });

  it("never reclaims a Keep-pinned ticket", () => {
    expect(computeWorktreeReclaim({ ...base, keep: true })).toEqual({
      reclaim: false,
      reason: null,
    });
  });

  it("never reclaims outside Done", () => {
    expect(computeWorktreeReclaim({ ...base, status: "doing" })).toEqual({
      reclaim: false,
      reason: null,
    });
  });

  it("never reclaims a ticket whose Done entry cannot be dated", () => {
    expect(computeWorktreeReclaim({ ...base, doneEntryAt: null })).toEqual({
      reclaim: false,
      reason: null,
    });
  });

  it("waits out the last day rather than rounding it away", () => {
    expect(computeWorktreeReclaim({ ...base, doneEntryAt: 100 * DAY - 14 * DAY + 1 })).toEqual({
      reclaim: false,
      reason: null,
    });
  });
});

describe("decideTrimFinish (VC-340, VC-1156)", () => {
  const OLD = "https://x/pull/1";
  const NEW = "https://x/pull/2";
  const base = { status: "needs_review" as const, archived: false, mergedPrUrl: null, history: [] };

  it("finishes an archived ticket, in any column", () => {
    expect(decideTrimFinish({ ...base, status: "doing", archived: true })).toEqual({
      finished: true,
      trigger: { kind: "archived" },
    });
  });

  it("finishes a Done ticket with no PR at all", () => {
    expect(decideTrimFinish({ ...base, status: "done" })).toEqual({
      finished: true,
      trigger: { kind: "done" },
    });
  });

  it("does not finish an unmerged ticket outside Done", () => {
    expect(decideTrimFinish(base)).toEqual({ finished: false, reason: "not finished" });
  });

  it("finishes a merged ticket never moved after its merge (unchanged from VC-340)", () => {
    expect(
      decideTrimFinish({
        ...base,
        mergedPrUrl: OLD,
        history: [
          { kind: "status_changed", to: "doing" },
          { kind: "status_changed", to: "needs_review" },
          { kind: "pr_merged", url: OLD },
        ],
      }),
    ).toEqual({ finished: true, trigger: { kind: "pr_merged", url: OLD } });
  });

  it("finishes on a merge observed before its record lands", () => {
    expect(
      decideTrimFinish({
        ...base,
        mergedPrUrl: OLD,
        history: [{ kind: "status_changed", to: "needs_review" }],
      }),
    ).toEqual({ finished: true, trigger: { kind: "pr_merged", url: OLD } });
  });

  it.each(["backlog", "todo", "doing", "needs_review"] as const)(
    "does not finish a ticket moved to %s after its merge, while that merge is the latest",
    (to) => {
      expect(
        decideTrimFinish({
          ...base,
          status: to,
          mergedPrUrl: OLD,
          history: [
            { kind: "pr_merged", url: OLD },
            { kind: "status_changed", to: "done" },
            { kind: "status_changed", to },
          ],
        }),
      ).toEqual({ finished: false, reason: "moved since the merge" });
    },
  );

  it("does not finish the VC-1150 sequence: merged in review, then moved to Doing", () => {
    expect(
      decideTrimFinish({
        ...base,
        status: "doing",
        mergedPrUrl: OLD,
        history: [
          { kind: "status_changed", to: "needs_review" },
          { kind: "pr_merged", url: OLD },
          { kind: "status_changed", to: "doing" },
        ],
      }),
    ).toEqual({ finished: false, reason: "moved since the merge" });
  });

  it("dates a duplicated merge record from its first appearance", () => {
    expect(
      decideTrimFinish({
        ...base,
        status: "doing",
        mergedPrUrl: OLD,
        history: [
          { kind: "pr_merged", url: OLD },
          { kind: "status_changed", to: "doing" },
          { kind: "pr_merged", url: OLD },
        ],
      }),
    ).toEqual({ finished: false, reason: "moved since the merge" });
  });

  it("finishes again when a new PR merges after the reactivation, before and after its record lands", () => {
    const history = [
      { kind: "pr_merged", url: OLD },
      { kind: "status_changed", to: "doing" },
    ] as const;
    const finished = { finished: true, trigger: { kind: "pr_merged", url: NEW } };
    expect(
      decideTrimFinish({ ...base, status: "doing", mergedPrUrl: NEW, history: [...history] }),
    ).toEqual(finished);
    expect(
      decideTrimFinish({
        ...base,
        status: "doing",
        mergedPrUrl: NEW,
        history: [...history, { kind: "pr_merged", url: NEW }],
      }),
    ).toEqual(finished);
  });

  it("does not finish on a new PR's merge recorded before a later move", () => {
    expect(
      decideTrimFinish({
        ...base,
        status: "doing",
        mergedPrUrl: NEW,
        history: [
          { kind: "pr_merged", url: NEW },
          { kind: "status_changed", to: "doing" },
        ],
      }),
    ).toEqual({ finished: false, reason: "moved since the merge" });
  });

  it("finishes a reactivated ticket moved back to Done by hand, with no new PR", () => {
    expect(
      decideTrimFinish({
        ...base,
        status: "done",
        mergedPrUrl: OLD,
        history: [
          { kind: "pr_merged", url: OLD },
          { kind: "status_changed", to: "doing" },
          { kind: "status_changed", to: "done" },
        ],
      }),
    ).toEqual({ finished: true, trigger: { kind: "done" } });
  });
});
