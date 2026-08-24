/**
 * The notation, held to the sentences it must never print.
 *
 * Most of these assert an ABSENCE — no bare dollar sign on an estimate, no
 * `$0.00` for an unpriced report, no cost row for a Session nobody metered.
 * Each one is a one-character mistake away, and none of them would fail
 * visibly: they would simply state something false about money in a place a
 * reader has no reason to doubt.
 */
import { describe, expect, it } from "vite-plus/test";

import { summarizeSessionUsage, type SessionUsage, type SessionUsageSummary } from "@volli/shared";

import {
  formatCachedShare,
  formatUsageCost,
  formatUsd,
  totalUsageTokens,
  usageBarSegments,
  usageBasisLine,
  USAGE_CLASSES,
  USAGE_CLASS_LABEL,
  USAGE_WINDOWS,
} from "./usage-format";

function op(over: Partial<SessionUsage> = {}): SessionUsage {
  return {
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
    costUsd: 0.5,
    costBasis: "catalog-estimate",
    ...over,
  };
}

const EMPTY = summarizeSessionUsage([]);

describe("formatUsageCost", () => {
  it("returns null when nothing was metered, so the surface renders no row", () => {
    // Distinct from "—": a terminal companion never called a model, and a cost
    // row of any kind would invent a fact about it.
    expect(formatUsageCost(EMPTY)).toBeNull();
  });

  it("prints an em dash when operations happened but none could be priced", () => {
    const summary = summarizeSessionUsage([
      op({ costUsd: null, costBasis: "unavailable" }),
      op({ costUsd: null, costBasis: "unavailable" }),
    ]);
    expect(formatUsageCost(summary)).toBe("—");
    // The one string this module exists to prevent.
    expect(formatUsageCost(summary)).not.toBe("$0.00");
  });

  it("prints a bare figure only when every priced operation was provider-reported", () => {
    const summary = summarizeSessionUsage([
      op({ costBasis: "provider-reported" }),
      op({ costBasis: "provider-reported" }),
    ]);
    expect(formatUsageCost(summary)).toBe("$1.00");
  });

  it("marks a catalogue estimate with a tilde", () => {
    expect(formatUsageCost(summarizeSessionUsage([op()]))).toBe("~$0.50");
  });

  it("marks a mixed basis with a tilde — the weaker claim wins", () => {
    const summary = summarizeSessionUsage([
      op({ costBasis: "provider-reported" }),
      op({ costBasis: "catalog-estimate" }),
    ]);
    expect(summary.costBasis).toBe("mixed");
    expect(formatUsageCost(summary)).toBe("~$1.00");
  });

  it("appends a plus when only some operations were priced", () => {
    const summary = summarizeSessionUsage([op(), op({ costUsd: null, costBasis: "unavailable" })]);
    expect(summary.costCoverage).toBe("partial");
    expect(formatUsageCost(summary)).toBe("~$0.50+");
  });

  it("can carry both hedges at once — reported, but partial", () => {
    const summary = summarizeSessionUsage([
      op({ costBasis: "provider-reported" }),
      op({ costUsd: null, costBasis: "unavailable" }),
    ]);
    expect(formatUsageCost(summary)).toBe("$0.50+");
  });
});

describe("formatUsd", () => {
  it("keeps a true zero distinguishable from an unpriced report", () => {
    // A provider that charged nothing SAID something; only `knownCostUsd: null`
    // means it said nothing, and that is `formatUsageCost`'s em dash.
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("refuses to round a real charge down to nothing", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.0000001)).toBe("<$0.01");
  });

  it("groups thousands so a large total stays readable", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("answers an em dash for a non-finite amount rather than printing NaN", () => {
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("usageBarSegments", () => {
  it("drops classes that contributed nothing rather than drawing them at zero", () => {
    const summary = summarizeSessionUsage([
      op({ cacheWriteTokens: 0, cacheReadTokens: 0, inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(usageBarSegments(summary).map((segment) => segment.id)).toEqual(["input", "output"]);
  });

  it("orders prompt classes cheapest-first, then output", () => {
    expect(usageBarSegments(summarizeSessionUsage([op()])).map((segment) => segment.id)).toEqual([
      "cacheRead",
      "input",
      "cacheWrite",
      "output",
    ]);
  });

  it("sums to the whole, so flex-grow fills the track exactly", () => {
    const summary = summarizeSessionUsage([op()]);
    const total = usageBarSegments(summary).reduce((sum, segment) => sum + segment.tokens, 0);
    expect(total).toBe(totalUsageTokens(summary));
  });

  it("is empty for an unmetered summary", () => {
    expect(usageBarSegments(EMPTY)).toEqual([]);
  });

  it("labels uncached input as such, so it is not read as containing cache reads", () => {
    expect(USAGE_CLASS_LABEL.input).toBe("Uncached input");
    expect(USAGE_CLASSES).toHaveLength(4);
  });
});

describe("formatCachedShare", () => {
  it("is null when no prompt token was ever counted", () => {
    expect(formatCachedShare(EMPTY)).toBeNull();
  });

  it("rounds to a whole percent", () => {
    const summary = summarizeSessionUsage([
      op({ cacheReadTokens: 900, inputTokens: 100, cacheWriteTokens: 0 }),
    ]);
    expect(formatCachedShare(summary)).toBe("90%");
  });

  it("never rounds a real share down to zero", () => {
    const summary = summarizeSessionUsage([
      op({ cacheReadTokens: 1, inputTokens: 10_000, cacheWriteTokens: 0 }),
    ]);
    expect(formatCachedShare(summary)).toBe("<1%");
  });

  it("reports a genuinely cold cache as 0%", () => {
    const summary = summarizeSessionUsage([
      op({ cacheReadTokens: 0, inputTokens: 500, cacheWriteTokens: 100 }),
    ]);
    expect(formatCachedShare(summary)).toBe("0%");
  });
});

describe("usageBasisLine", () => {
  it("is null when nothing was metered", () => {
    expect(usageBasisLine(EMPTY)).toBeNull();
  });

  it("names the count alone when the report is complete", () => {
    expect(usageBasisLine(summarizeSessionUsage([op(), op()]))).toBe("Estimated · 2 operations");
  });

  it("singularises one operation", () => {
    expect(usageBasisLine(summarizeSessionUsage([op()]))).toBe("Estimated · 1 operation");
  });

  it("spends the line on coverage when the total is only a floor", () => {
    const summary = summarizeSessionUsage([op(), op({ costUsd: null, costBasis: "unavailable" })]);
    expect(usageBasisLine(summary)).toBe("Estimated · 1 of 2 operations priced");
  });

  it("says so when a total is provider-reported", () => {
    const summary = summarizeSessionUsage([op({ costBasis: "provider-reported" })]);
    expect(usageBasisLine(summary)).toBe("Provider-reported · 1 operation");
  });

  it("reports an unpriced set as such rather than as an estimate of nothing", () => {
    const summary = summarizeSessionUsage([op({ costUsd: null, costBasis: "unavailable" })]);
    expect(usageBasisLine(summary)).toBe("No cost reported · 1 operation");
  });
});

describe("totalUsageTokens", () => {
  it("adds every class, so the caption matches the bar", () => {
    expect(totalUsageTokens(summarizeSessionUsage([op()]))).toBe(970);
  });

  it("is zero for an unmetered summary", () => {
    expect(totalUsageTokens(EMPTY)).toBe(0);
  });
});

describe("USAGE_WINDOWS", () => {
  it("offers three windows and opens on the actionable one", () => {
    expect(USAGE_WINDOWS.map((window) => window.key)).toEqual(["7d", "30d", "all"]);
  });
});

describe("a summary the ledger could hand over directly", () => {
  it("survives a hand-built shape, not only summarizeSessionUsage output", () => {
    // The report arm crossing IPC is a plain object; nothing guarantees it came
    // from the summariser, so the formatters must not depend on its invariants.
    const summary: SessionUsageSummary = {
      requestCount: 3,
      tokenRequestCount: 3,
      pricedRequestCount: 3,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      knownCostUsd: 2,
      costCoverage: "complete",
      costBasis: "provider-reported",
      cachedInputShare: 1 / 3,
    };
    expect(formatUsageCost(summary)).toBe("$2.00");
    expect(formatCachedShare(summary)).toBe("33%");
    expect(totalUsageTokens(summary)).toBe(4);
  });
});
