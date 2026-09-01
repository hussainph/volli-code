import type { PrCheck, TicketRetentionState } from "../../../../ipc/contract";
import { describe, expect, it } from "vite-plus/test";

import { resolvePrChecks } from "./pr-checks-model";

const PR_URL = "https://github.com/o/r/pull/7";

function check(name: string, state: PrCheck["state"], over: Partial<PrCheck> = {}): PrCheck {
  return { name, workflow: null, state, url: null, ...over };
}

function retention(over: Partial<TicketRetentionState> = {}): TicketRetentionState {
  return {
    ticketId: "t1",
    prUrl: PR_URL,
    prState: "open",
    hasConflicts: false,
    checks: [],
    archiveReady: false,
    reason: null,
    keep: false,
    dismissed: false,
    ...over,
  };
}

describe("resolvePrChecks — when there is nothing to draw", () => {
  it("answers null before the retention state has loaded", () => {
    expect(resolvePrChecks(null)).toBeNull();
  });

  it("answers null for a ticket with no PR", () => {
    expect(
      resolvePrChecks(retention({ prUrl: null, checks: [check("build", "passing")] })),
    ).toBeNull();
  });

  it("answers null for a PR with an empty rollup — the row's whole opt-out", () => {
    // This is the case a project without a GitHub Actions pipeline lands in,
    // and the reason the feature needs no setting: nothing reported, nothing
    // drawn, no empty state explaining the absence.
    expect(resolvePrChecks(retention({ checks: [] }))).toBeNull();
  });
});

describe("resolvePrChecks — the verdict", () => {
  it("lets one failure outrank every pass", () => {
    const view = resolvePrChecks(
      retention({ checks: [check("a", "passing"), check("b", "failing"), check("c", "passing")] }),
    )!;
    expect(view.verdict).toBe("failing");
    expect(view.label).toBe("1 check failing");
  });

  it("reports a suite still running rather than a clean partial result", () => {
    const view = resolvePrChecks(
      retention({ checks: [check("a", "passing"), check("b", "pending")] }),
    )!;
    expect(view.verdict).toBe("pending");
    expect(view.label).toBe("1 check running");
  });

  it("puts failing ahead of running when both are present", () => {
    const view = resolvePrChecks(
      retention({ checks: [check("a", "pending"), check("b", "failing")] }),
    )!;
    expect(view.verdict).toBe("failing");
  });

  it("reads a wholly green suite as passed, skips included", () => {
    const view = resolvePrChecks(
      retention({ checks: [check("a", "passing"), check("b", "skipped")] }),
    )!;
    expect(view.verdict).toBe("passing");
    expect(view.label).toBe("All checks passed");
  });

  it("does NOT call an all-skipped suite passed", () => {
    // A workflow whose every job was filtered out passed nothing. A green
    // check beside "nothing ran" is the one reading here that could send
    // someone to merge on evidence that does not exist.
    const view = resolvePrChecks(
      retention({ checks: [check("a", "skipped"), check("b", "skipped")] }),
    )!;
    expect(view.verdict).toBe("skipped");
    expect(view.label).toBe("All checks skipped");
  });

  it("pluralizes the counted verdicts", () => {
    const failing = resolvePrChecks(
      retention({ checks: [check("a", "failing"), check("b", "failing")] }),
    )!;
    expect(failing.label).toBe("2 checks failing");
    const pending = resolvePrChecks(
      retention({ checks: [check("a", "pending"), check("b", "pending")] }),
    )!;
    expect(pending.label).toBe("2 checks running");
  });
});

describe("resolvePrChecks — counts and summary", () => {
  it("counts every state and sums them to the total", () => {
    const view = resolvePrChecks(
      retention({
        checks: [
          check("a", "passing"),
          check("b", "passing"),
          check("c", "failing"),
          check("d", "pending"),
          check("e", "skipped"),
        ],
      }),
    )!;
    expect(view.counts).toEqual({ passing: 2, failing: 1, pending: 1, skipped: 1, total: 5 });
  });

  it("writes the breakdown failing-first, naming only the non-empty states", () => {
    const view = resolvePrChecks(
      retention({
        checks: [check("a", "passing"), check("b", "failing"), check("c", "pending")],
      }),
    )!;
    expect(view.summary).toBe("1 failing · 1 running · 1 passed");
  });

  it("omits the breakdown when one state accounts for everything", () => {
    // The row's own label already said it; a header repeating it in different
    // words is noise, not detail.
    const view = resolvePrChecks(
      retention({ checks: [check("a", "passing"), check("b", "passing")] }),
    )!;
    expect(view.summary).toBeNull();
  });
});

describe("resolvePrChecks — reading order", () => {
  it("lists failing first, then running, then passed, then skipped", () => {
    const view = resolvePrChecks(
      retention({
        checks: [
          check("skipped-1", "skipped"),
          check("passing-1", "passing"),
          check("pending-1", "pending"),
          check("failing-1", "failing"),
        ],
      }),
    )!;
    expect(view.checks.map((c) => c.name)).toEqual([
      "failing-1",
      "pending-1",
      "passing-1",
      "skipped-1",
    ]);
  });

  it("keeps GitHub's own order within a bucket", () => {
    const view = resolvePrChecks(
      retention({
        checks: [check("b", "failing"), check("a", "failing"), check("c", "failing")],
      }),
    )!;
    expect(view.checks.map((c) => c.name)).toEqual(["b", "a", "c"]);
  });

  it("carries each check through unchanged", () => {
    const one = check("Check + Test", "passing", {
      workflow: "CI",
      url: "https://github.com/o/r/actions/runs/1",
    });
    const view = resolvePrChecks(retention({ checks: [one] }))!;
    expect(view.checks).toEqual([one]);
  });
});

describe("resolvePrChecks — the way out to GitHub", () => {
  it("points at the PR's own Checks tab", () => {
    const view = resolvePrChecks(retention({ checks: [check("a", "passing")] }))!;
    expect(view.checksUrl).toBe("https://github.com/o/r/pull/7/checks");
  });

  it("does not double the separator on a stored url with a trailing slash", () => {
    const view = resolvePrChecks(
      retention({ prUrl: `${PR_URL}/`, checks: [check("a", "passing")] }),
    )!;
    expect(view.checksUrl).toBe("https://github.com/o/r/pull/7/checks");
  });
});
