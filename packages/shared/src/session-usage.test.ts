import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SESSION_USAGE_SUMMARY,
  mergeSessionUsageSummaries,
  summarizeSessionUsage,
  type SessionUsage,
} from "./session-usage";

/** One metered model operation, with everything optional left absent. */
function measured(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    costUsd: 0.5,
    costBasis: "catalog-estimate",
    ...overrides,
  };
}

describe("summarizeSessionUsage", () => {
  it("reports nothing measured rather than a zero bill", () => {
    expect(summarizeSessionUsage([])).toEqual(EMPTY_SESSION_USAGE_SUMMARY);
    expect(EMPTY_SESSION_USAGE_SUMMARY.knownCostUsd).toBeNull();
    expect(EMPTY_SESSION_USAGE_SUMMARY.costCoverage).toBe("unavailable");
  });

  it("adds each token class apart from the others", () => {
    const summary = summarizeSessionUsage([
      measured({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 5 }),
      measured({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 200, cacheWriteTokens: 7 }),
    ]);
    expect(summary.inputTokens).toBe(30);
    expect(summary.outputTokens).toBe(3);
    expect(summary.cacheReadTokens).toBe(300);
    expect(summary.cacheWriteTokens).toBe(12);
    expect(summary.requestCount).toBe(2);
  });

  it("counts a request whose provider reported no tokens, without inventing zeros", () => {
    const summary = summarizeSessionUsage([
      measured({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    ]);
    expect(summary.requestCount).toBe(1);
    expect(summary.tokenRequestCount).toBe(0);
    expect(summary.inputTokens).toBe(0);
  });

  it("keeps a mixed report partial so a total never looks exact", () => {
    const summary = summarizeSessionUsage([
      measured({ costUsd: 1.25 }),
      measured({ costUsd: null, costBasis: "unavailable" }),
    ]);
    expect(summary.knownCostUsd).toBe(1.25);
    expect(summary.pricedRequestCount).toBe(1);
    expect(summary.costCoverage).toBe("partial");
  });

  it("says complete only when every request carried a price", () => {
    const summary = summarizeSessionUsage([measured({ costUsd: 1 }), measured({ costUsd: 2 })]);
    expect(summary.knownCostUsd).toBe(3);
    expect(summary.costCoverage).toBe("complete");
  });

  it("distinguishes a request that genuinely cost nothing from one with no price", () => {
    const free = summarizeSessionUsage([measured({ costUsd: 0 })]);
    expect(free.knownCostUsd).toBe(0);
    expect(free.costCoverage).toBe("complete");

    const unpriced = summarizeSessionUsage([measured({ costUsd: null, costBasis: "unavailable" })]);
    expect(unpriced.knownCostUsd).toBeNull();
    expect(unpriced.costCoverage).toBe("unavailable");
  });

  it("does not blend a reported bill with a catalogue estimate", () => {
    expect(
      summarizeSessionUsage([
        measured({ costBasis: "provider-reported" }),
        measured({ costBasis: "catalog-estimate" }),
      ]).costBasis,
    ).toBe("mixed");
    expect(
      summarizeSessionUsage([
        measured({ costBasis: "provider-reported" }),
        measured({ costBasis: "provider-reported" }),
      ]).costBasis,
    ).toBe("provider-reported");
  });

  it("ignores the basis of a request that carried no price at all", () => {
    expect(
      summarizeSessionUsage([
        measured({ costBasis: "catalog-estimate", costUsd: 2 }),
        measured({ costBasis: "unavailable", costUsd: null }),
      ]).costBasis,
    ).toBe("catalog-estimate");
  });

  it("totals many small prices without printing float noise", () => {
    expect(
      summarizeSessionUsage([measured({ costUsd: 0.1 }), measured({ costUsd: 0.2 })]).knownCostUsd,
    ).toBe(0.3);
  });

  it("measures cached input against all prompt tokens, not against output", () => {
    const summary = summarizeSessionUsage([
      measured({
        inputTokens: 100,
        cacheReadTokens: 300,
        cacheWriteTokens: 100,
        outputTokens: 500,
      }),
    ]);
    expect(summary.cachedInputShare).toBe(0.6);
  });

  it("has no cached input share when no prompt tokens were reported", () => {
    expect(
      summarizeSessionUsage([
        measured({ inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }),
      ]).cachedInputShare,
    ).toBeNull();
  });

  it("counts compaction and utility work against the same Session total", () => {
    const summary = summarizeSessionUsage([
      measured({ cause: "assistant", costUsd: 1 }),
      measured({ cause: "compaction", costUsd: 2 }),
      measured({ cause: "utility", costUsd: 4 }),
    ]);
    expect(summary.requestCount).toBe(3);
    expect(summary.knownCostUsd).toBe(7);
  });
});

describe("mergeSessionUsageSummaries", () => {
  it("reports nothing measured for nothing merged", () => {
    expect(mergeSessionUsageSummaries([])).toEqual(EMPTY_SESSION_USAGE_SUMMARY);
  });

  it("says exactly what summarizing the same operations in one pass says", () => {
    // The property that makes the fold safe: a caller may summarize per Session
    // and add the summaries, or summarize the lot, and must not get two
    // different reports of one Ticket's spend.
    const operations = [
      measured({ costUsd: 0.1, inputTokens: 10, cacheReadTokens: 90, outputTokens: 5 }),
      measured({ costUsd: 0.2, inputTokens: 20, cacheReadTokens: 80, outputTokens: 7 }),
      measured({ costUsd: null, inputTokens: 5, cacheReadTokens: 0, outputTokens: 1 }),
    ];
    expect(
      mergeSessionUsageSummaries([
        summarizeSessionUsage(operations.slice(0, 1)),
        summarizeSessionUsage(operations.slice(1)),
      ]),
    ).toEqual(summarizeSessionUsage(operations));
  });

  it("adds money at the same precision, so a fold prints no float noise", () => {
    expect(
      mergeSessionUsageSummaries([
        summarizeSessionUsage([measured({ costUsd: 0.1 })]),
        summarizeSessionUsage([measured({ costUsd: 0.2 })]),
      ]).knownCostUsd,
    ).toBe(0.3);
  });

  it("keeps an unmeasured Session unmeasured rather than free", () => {
    const merged = mergeSessionUsageSummaries([
      EMPTY_SESSION_USAGE_SUMMARY,
      EMPTY_SESSION_USAGE_SUMMARY,
    ]);
    expect(merged.knownCostUsd).toBeNull();
    expect(merged.costCoverage).toBe("unavailable");
    expect(merged.costBasis).toBe("unavailable");
  });

  it("lets an unpriced Session cast no basis vote", () => {
    // Otherwise every parent that ever delegated to a Session Volli could not
    // price would report `mixed`, and `mixed` is what stops a surface printing
    // an exact figure.
    expect(
      mergeSessionUsageSummaries([
        summarizeSessionUsage([measured({ costUsd: 1, costBasis: "provider-reported" })]),
        EMPTY_SESSION_USAGE_SUMMARY,
      ]).costBasis,
    ).toBe("provider-reported");
  });

  it("reports two bases as mixed, whichever side carried which", () => {
    const provider = summarizeSessionUsage([
      measured({ costUsd: 1, costBasis: "provider-reported" }),
    ]);
    const catalog = summarizeSessionUsage([
      measured({ costUsd: 2, costBasis: "catalog-estimate" }),
    ]);
    expect(mergeSessionUsageSummaries([provider, catalog]).costBasis).toBe("mixed");
    expect(mergeSessionUsageSummaries([catalog, provider]).costBasis).toBe("mixed");
  });

  it("carries a side that was already mixed through the fold", () => {
    const mixed = summarizeSessionUsage([
      measured({ costUsd: 1, costBasis: "provider-reported" }),
      measured({ costUsd: 2, costBasis: "catalog-estimate" }),
    ]);
    expect(mixed.costBasis).toBe("mixed");
    expect(
      mergeSessionUsageSummaries([mixed, summarizeSessionUsage([measured({ costUsd: 3 })])])
        .costBasis,
    ).toBe("mixed");
  });

  it("turns a complete side partial once an unpriced request joins it", () => {
    expect(
      mergeSessionUsageSummaries([
        summarizeSessionUsage([measured({ costUsd: 1 })]),
        summarizeSessionUsage([measured({ costUsd: null })]),
      ]).costCoverage,
    ).toBe("partial");
  });

  it("re-measures the cached share over the merged prompt rather than averaging two", () => {
    // The two sides sit at 0.9 and 0 on their own; the honest answer for the
    // pair is neither of those and is not their mean.
    const merged = mergeSessionUsageSummaries([
      summarizeSessionUsage([
        measured({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 }),
      ]),
      summarizeSessionUsage([
        measured({ inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      ]),
    ]);
    expect(merged.cachedInputShare).toBe(0.45);
  });

  it("has no cached share when neither side reported a prompt token", () => {
    expect(
      mergeSessionUsageSummaries([EMPTY_SESSION_USAGE_SUMMARY, EMPTY_SESSION_USAGE_SUMMARY])
        .cachedInputShare,
    ).toBeNull();
  });

  it("does not care what order the rows arrive in", () => {
    const one = summarizeSessionUsage([measured({ costUsd: 1, inputTokens: 3 })]);
    const two = summarizeSessionUsage([measured({ costUsd: null, inputTokens: 4 })]);
    const three = summarizeSessionUsage([measured({ costUsd: 2, inputTokens: 5 })]);
    expect(mergeSessionUsageSummaries([one, two, three])).toEqual(
      mergeSessionUsageSummaries([three, two, one]),
    );
  });
});
