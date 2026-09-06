import type { ModelCatalogRefreshReport } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { refreshOutcome } from "./model-access-refresh-model";

function report(overrides: Partial<ModelCatalogRefreshReport> = {}): ModelCatalogRefreshReport {
  return {
    added: 0,
    removed: 0,
    rejected: 0,
    refreshedProviderIds: ["acme"],
    failedProviderIds: [],
    ...overrides,
  };
}

describe("refreshOutcome", () => {
  it("separates a current catalog from one that never got refreshed", () => {
    // The distinction the button exists to make: both show the same rows.
    expect(refreshOutcome(report())).toEqual({
      kind: "unchanged",
      message: "Model catalog unchanged.",
    });
    expect(
      refreshOutcome(report({ refreshedProviderIds: [], failedProviderIds: ["acme"] })),
    ).toEqual({
      kind: "failed",
      message: "Couldn't refresh models: 1 provider failed.",
    });
  });

  it("names additions and removals together", () => {
    expect(refreshOutcome(report({ added: 2 })).message).toBe("Models refreshed: 2 added.");
    expect(refreshOutcome(report({ removed: 3 })).message).toBe("Models refreshed: 3 removed.");
    expect(refreshOutcome(report({ added: 1, removed: 4 }))).toEqual({
      kind: "changed",
      message: "Models refreshed: 1 added, 4 removed.",
    });
  });

  it("reports a partial failure and an unsafe rejection above the additions", () => {
    // Some providers did land, so this is not a failure — but the parts that
    // did not are what a person may want to act on, and outrank the good news.
    expect(refreshOutcome(report({ added: 5, failedProviderIds: ["other"] }))).toEqual({
      kind: "issues",
      message: "Models refreshed with issues: 1 provider failed.",
    });
    expect(refreshOutcome(report({ added: 5, rejected: 1 })).message).toBe(
      "Models refreshed with issues: 1 model rejected as unsafe.",
    );
    expect(
      refreshOutcome(report({ rejected: 2, failedProviderIds: ["other", "third"] })).message,
    ).toBe("Models refreshed with issues: 2 providers failed; 2 models rejected as unsafe.");
  });

  it("pluralizes every count it says", () => {
    expect(
      refreshOutcome(report({ refreshedProviderIds: [], failedProviderIds: ["a", "b"] })).message,
    ).toBe("Couldn't refresh models: 2 providers failed.");
    expect(refreshOutcome(report({ rejected: 1 })).message).toContain("1 model rejected");
    expect(refreshOutcome(report({ rejected: 2 })).message).toContain("2 models rejected");
  });
});
