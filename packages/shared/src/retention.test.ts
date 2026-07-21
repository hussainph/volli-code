import { describe, expect, it } from "vite-plus/test";

import { computeArchiveReadiness } from "./retention";

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

  // The Vibe-Kanban bug, encoded: a kept ticket is exempt from BOTH paths.
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
