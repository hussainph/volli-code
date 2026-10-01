import type { PrCheck, TicketRetentionState } from "../../../../ipc/contract";
import { describe, expect, it } from "vite-plus/test";

import { resolvePrChecks } from "./pr-checks-model";
import type { WorktreeStatusSnapshot } from "./worktree-done-flow-model";
import { worktreeGlance } from "./worktree-glance-model";

function status(over: Partial<WorktreeStatusSnapshot> = {}): WorktreeStatusSnapshot {
  return {
    uncommitted: false,
    sequencerActive: false,
    aheadOfBase: 0,
    behindBase: 0,
    unpushed: 0,
    ...over,
  };
}

function check(name: string, state: PrCheck["state"]): PrCheck {
  return { name, workflow: null, state, url: null };
}

function checks(...states: PrCheck["state"][]) {
  const retention: TicketRetentionState = {
    ticketId: "t1",
    prUrl: "https://github.com/o/r/pull/7",
    prState: "open",
    hasConflicts: false,
    checks: states.map((state, index) => check(`c${index}`, state)),
    archiveReady: false,
    reason: null,
    keep: false,
    dismissed: false,
  };
  return resolvePrChecks(retention);
}

describe("worktreeGlance — one fact, by priority", () => {
  it("says nothing until the status has been read", () => {
    expect(worktreeGlance({ status: null, checks: null })).toBeNull();
    expect(worktreeGlance({ status: null, checks: checks("failing") })).toBeNull();
  });

  it("a red suite outranks everything, in the checks row's own words", () => {
    expect(
      worktreeGlance({
        status: status({ uncommitted: true, unpushed: 3 }),
        checks: checks("failing", "failing"),
      }),
    ).toEqual({ phrase: "2 checks failing", tone: "error" });
  });

  it("uncommitted work outranks unpushed commits, and stays quiet", () => {
    expect(
      worktreeGlance({
        status: status({ uncommitted: true, aheadOfBase: 3, unpushed: 3 }),
        checks: null,
      }),
    ).toEqual({ phrase: "Uncommitted", tone: "idle" });
  });

  it("counts what is left to push once the tree is clean", () => {
    expect(
      worktreeGlance({ status: status({ aheadOfBase: 3, unpushed: 3 }), checks: null }),
    ).toEqual({
      phrase: "3 to push",
      tone: "idle",
    });
  });

  it("names a branch that has never been pushed without inventing a count", () => {
    expect(
      worktreeGlance({ status: status({ aheadOfBase: 2, unpushed: null }), checks: null }),
    ).toEqual({
      phrase: "Not pushed",
      tone: "idle",
    });
  });

  it("a running suite outranks a green one and a pushed branch", () => {
    expect(
      worktreeGlance({ status: status({ aheadOfBase: 3 }), checks: checks("pending", "passing") }),
    ).toEqual({
      phrase: "1 check running",
      tone: "working",
    });
  });

  it("a green suite is the one local state a tone is spent on", () => {
    expect(
      worktreeGlance({ status: status({ aheadOfBase: 3 }), checks: checks("passing", "passing") }),
    ).toEqual({
      phrase: "All checks passed",
      tone: "ready",
    });
  });

  it("an all-skipped suite is reported, not celebrated", () => {
    expect(
      worktreeGlance({ status: status({ aheadOfBase: 3 }), checks: checks("skipped") }),
    ).toEqual({
      phrase: "All checks skipped",
      tone: "idle",
    });
  });

  it("a pushed branch with no PR yet is up to date", () => {
    expect(
      worktreeGlance({ status: status({ aheadOfBase: 3, unpushed: 0 }), checks: null }),
    ).toEqual({
      phrase: "Up to date",
      tone: "idle",
    });
  });

  it("a fault leads everything, before and after the status is read", () => {
    expect(worktreeGlance({ status: null, checks: null, fault: "missing" })).toEqual({
      phrase: "Missing on disk",
      tone: "error",
    });
    expect(
      worktreeGlance({ status: status({ uncommitted: true }), checks: null, fault: "unreadable" }),
    ).toEqual({ phrase: "Unreadable", tone: "error" });
  });

  it("archive-ready outranks the branch's own state — the next act is not on the branch", () => {
    expect(
      worktreeGlance({
        status: status({ uncommitted: true }),
        checks: checks("failing"),
        archiveReady: true,
      }),
    ).toEqual({ phrase: "Ready to archive", tone: "ready" });
  });

  it("a fresh worktree has no commits; an unknown one is only clean", () => {
    expect(worktreeGlance({ status: status(), checks: null })).toEqual({
      phrase: "No commits",
      tone: "idle",
    });
    expect(
      worktreeGlance({ status: status({ aheadOfBase: null, unpushed: null }), checks: null }),
    ).toEqual({
      phrase: "Clean",
      tone: "idle",
    });
  });
});
