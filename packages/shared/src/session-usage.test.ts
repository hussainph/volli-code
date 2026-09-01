import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SESSION_USAGE_SUMMARY,
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
