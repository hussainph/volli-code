import { describe, expect, it } from "vite-plus/test";

import { reportSessionUsage, type SessionUsageEntry } from "./session-usage-report";

const DAY = 86_400_000;
/** 2026-08-01T00:00:00Z, so a UTC day key is readable in a failure message. */
const AUGUST = Date.UTC(2026, 7, 1);

function entry(overrides: Partial<SessionUsageEntry> = {}): SessionUsageEntry {
  return {
    sessionId: "session-1",
    projectId: "project-1",
    ticketId: "ticket-1",
    occurredAt: AUGUST,
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
    costUsd: 0.25,
    costBasis: "catalog-estimate",
    ...overrides,
  };
}

describe("reportSessionUsage", () => {
  it("answers an empty window with nothing measured, not with zero spent", () => {
    const report = reportSessionUsage([], { groupBy: "model" });
    expect(report.total.knownCostUsd).toBeNull();
    expect(report.total.costCoverage).toBe("unavailable");
    expect(report.groups).toEqual([]);
    expect(report.meteredSessionCount).toBe(0);
  });

  it("totals every entry once, whatever it is grouped by", () => {
    const entries = [
      entry({ sessionId: "a", costUsd: 1 }),
      entry({ sessionId: "b", costUsd: 2 }),
      entry({ sessionId: "b", costUsd: 4 }),
    ];
    for (const groupBy of ["ticket", "session", "model", "day"] as const) {
      expect(reportSessionUsage(entries, { groupBy }).total.knownCostUsd).toBe(7);
    }
  });

  it("counts the Sessions that actually spent, not the entries", () => {
    const report = reportSessionUsage(
      [entry({ sessionId: "a" }), entry({ sessionId: "b" }), entry({ sessionId: "b" })],
      { groupBy: "session" },
    );
    expect(report.meteredSessionCount).toBe(2);
    expect(report.total.requestCount).toBe(3);
  });

  it("splits a Session that changed model without losing its total", () => {
    const report = reportSessionUsage(
      [
        entry({ modelId: "claude-opus-4-1", costUsd: 8 }),
        entry({ providerId: "openai", modelId: "gpt-5", costUsd: 2 }),
      ],
      { groupBy: "model" },
    );
    expect(report.groups.map((group) => group.key)).toEqual([
      "anthropic/claude-opus-4-1",
      "openai/gpt-5",
    ]);
    expect(report.groups.map((group) => group.usage.knownCostUsd)).toEqual([8, 2]);
    expect(report.total.knownCostUsd).toBe(10);
  });

  it("orders groups by what they cost, so the expensive one is first", () => {
    const report = reportSessionUsage(
      [
        entry({ sessionId: "cheap", costUsd: 1 }),
        entry({ sessionId: "dear", costUsd: 9 }),
        entry({ sessionId: "middling", costUsd: 5 }),
      ],
      { groupBy: "session" },
    );
    expect(report.groups.map((group) => group.key)).toEqual(["dear", "middling", "cheap"]);
  });

  // A Project Session has no ticket. It is still spend, and dropping it would
  // make the sum of the groups quietly smaller than the total above them.
  it("keeps unticketed spend as its own group rather than discarding it", () => {
    const report = reportSessionUsage(
      [entry({ ticketId: "ticket-1", costUsd: 3 }), entry({ ticketId: null, costUsd: 4 })],
      { groupBy: "ticket" },
    );
    expect(report.groups.map((group) => group.key)).toEqual([null, "ticket-1"]);
    expect(report.groups.reduce((sum, group) => sum + (group.usage.knownCostUsd ?? 0), 0)).toBe(7);
  });

  it("buckets time by UTC day, so a report does not move when the reader does", () => {
    const report = reportSessionUsage(
      [
        // 23:30 UTC on the 1st, which is the 2nd in some places and not others.
        entry({ occurredAt: AUGUST + 84_600_000, costUsd: 1 }),
        entry({ occurredAt: AUGUST + DAY, costUsd: 2 }),
      ],
      { groupBy: "day" },
    );
    expect(report.groups.map((group) => group.key)).toEqual(["2026-08-02", "2026-08-01"]);
  });

  it("carries partial coverage into each group, not only into the total", () => {
    const report = reportSessionUsage(
      [
        entry({ sessionId: "a", costUsd: 5 }),
        entry({ sessionId: "a", costUsd: null, costBasis: "unavailable" }),
        entry({ sessionId: "b", costUsd: 1 }),
      ],
      { groupBy: "session" },
    );
    expect(report.groups[0]?.usage.costCoverage).toBe("partial");
    expect(report.groups[1]?.usage.costCoverage).toBe("complete");
    expect(report.total.costCoverage).toBe("partial");
  });

  // A wholly unpriced group has no number to rank by. It sorts as if it cost
  // nothing, which is an ordering choice and not a claim: its own summary
  // still reads `unavailable`, never `$0.00`.
  it("ranks a group nothing could price below every group that has a number", () => {
    const report = reportSessionUsage(
      [
        entry({ sessionId: "unpriced", costUsd: null, costBasis: "unavailable" }),
        entry({ sessionId: "priced", costUsd: 2 }),
      ],
      { groupBy: "session" },
    );
    expect(report.groups.map((group) => group.key)).toEqual(["priced", "unpriced"]);
    expect(report.groups[1]?.usage.costCoverage).toBe("unavailable");
    expect(report.groups[1]?.usage.knownCostUsd).toBeNull();
  });

  it("reports the whole window without groups when none is asked for", () => {
    const report = reportSessionUsage([entry({ costUsd: 3 })], {});
    expect(report.groups).toEqual([]);
    expect(report.total.knownCostUsd).toBe(3);
  });
});
