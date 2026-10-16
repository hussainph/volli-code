import { describe, expect, it } from "vite-plus/test";
import { createBillingCandidates } from "./auto-select/fixtures";
import { parseBillingCandidates } from "./billing-candidate-input";

const candidates = () => createBillingCandidates("real-user-ladder", Date.UTC(2026, 0, 1));

describe("editable billing candidate JSON", () => {
  it("accepts a fixture and preserves unknown windows", () => {
    const input = candidates();
    input[0]!.weekly = null;
    expect(parseBillingCandidates(input)).toEqual({ ok: true, candidates: input });
  });
  it.each([null, {}, [], [{}], [null, null]])(
    "rejects malformed lists without throwing: %j",
    (input) => {
      expect(parseBillingCandidates(input).ok).toBe(false);
    },
  );
  it.each(["selection", "tiers", "billingSource", "fiveHour", "weekly"])(
    "rejects missing %s",
    (field) => {
      const input = candidates();
      delete (input[0] as unknown as Record<string, unknown>)[field];
      expect(parseBillingCandidates(input).ok).toBe(false);
    },
  );
  it("rejects invalid effort, tier, percentages, resets and duplicates", () => {
    const invalid = (change: (input: ReturnType<typeof candidates>) => void) => {
      const input = candidates();
      change(input);
      expect(parseBillingCandidates(input).ok).toBe(false);
    };
    invalid((input) => {
      input[0]!.selection.reasoningLevel = "unknown" as never;
    });
    invalid((input) => {
      input[0]!.tiers = ["unknown" as never];
    });
    invalid((input) => {
      input[0]!.fiveHour!.leftPercent = 101;
    });
    invalid((input) => {
      input[0]!.fiveHour!.resetsAt = "yesterday";
    });
    invalid((input) => {
      input[1] = input[0]!;
    });
  });
});
