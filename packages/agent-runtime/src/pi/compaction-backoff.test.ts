import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_COMPACTION_SETTINGS } from "./harness-compaction";
import {
  THRESHOLD_COMPACTION_FAILURE_CAP,
  thresholdCompactionAllowed,
  type ThresholdCompactionRetryInput,
} from "./compaction-backoff";

const STEP = 20_000;
const CAP = 3;

function allowed(input: Partial<ThresholdCompactionRetryInput>): boolean {
  return thresholdCompactionAllowed({
    occupied: 200_000,
    failedAt: undefined,
    failures: 0,
    step: STEP,
    cap: CAP,
    ...input,
  });
}

describe("thresholdCompactionAllowed", () => {
  it("attempts a run's first threshold compaction", () => {
    expect(allowed({})).toBe(true);
  });

  it("holds the next attempt until the context has grown by the whole step", () => {
    const failedAt = 200_000;
    expect(allowed({ failures: 1, failedAt, occupied: 200_000 })).toBe(false);
    expect(allowed({ failures: 1, failedAt, occupied: 219_999 })).toBe(false);
    expect(allowed({ failures: 1, failedAt, occupied: 220_000 })).toBe(true);
    expect(allowed({ failures: 2, failedAt, occupied: 250_000 })).toBe(true);
  });

  it("never attempts on a context that shrank since the failure", () => {
    expect(allowed({ failures: 1, failedAt: 200_000, occupied: 150_000 })).toBe(false);
  });

  it("stops at the cap, however far the context has grown", () => {
    expect(allowed({ failures: 3, failedAt: 200_000, occupied: 1_000_000 })).toBe(false);
    expect(allowed({ failures: 4, failedAt: 200_000, occupied: 1_000_000 })).toBe(false);
    expect(allowed({ failures: 1, failedAt: 200_000, occupied: 1_000_000, cap: 1 })).toBe(false);
  });

  it("is the owner's numbers: three attempts, a step of keepRecentTokens", () => {
    expect(THRESHOLD_COMPACTION_FAILURE_CAP).toBe(3);
    // The step the runtime passes is Pi's own `keepRecentTokens`, not a copy.
    expect(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens).toBe(20_000);
  });
});
