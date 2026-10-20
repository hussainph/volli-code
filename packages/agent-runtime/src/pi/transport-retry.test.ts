import { describe, expect, it } from "vite-plus/test";
import {
  autoRetryDelayMs,
  planTransportRetry,
  TRANSPORT_RETRY_BASE_MS,
  TRANSPORT_RETRY_BUDGET_MS,
  TRANSPORT_RETRY_CEILING_MS,
  TRANSPORT_RETRY_LIMIT,
} from "./transport-retry";

describe("autoRetryDelayMs", () => {
  it("doubles the wait up to a ceiling, jittered", () => {
    expect(autoRetryDelayMs(0)).toBeGreaterThanOrEqual(500);
    expect(autoRetryDelayMs(0)).toBeLessThan(600);
    expect(autoRetryDelayMs(3)).toBeGreaterThanOrEqual(4000);
    expect(autoRetryDelayMs(3)).toBeLessThan(4100);
    expect(autoRetryDelayMs(7)).toBeGreaterThanOrEqual(60_000);
    expect(autoRetryDelayMs(7)).toBeLessThan(60_100);
    expect(autoRetryDelayMs(20)).toBeLessThan(60_100);
  });
});

/** The attempts the default schedule gets before its waiting would pass the budget. */
function attemptsUnderDefaultSchedule(): { attempts: number; waitedMs: number } {
  const spent = { attempts: 0, waitedMs: 0 };
  for (;;) {
    const backoff = Math.min(
      TRANSPORT_RETRY_BASE_MS * 2 ** spent.attempts,
      TRANSPORT_RETRY_CEILING_MS,
    );
    const plan = planTransportRetry(spent, backoff, undefined);
    if (plan.kind === "give-up") return spent;
    spent.attempts += 1;
    spent.waitedMs += plan.delayMs;
  }
}

describe("planTransportRetry", () => {
  it("spends about fifteen minutes of waiting under the default schedule", () => {
    const { attempts, waitedMs } = attemptsUnderDefaultSchedule();
    expect(attempts).toBe(20);
    expect(waitedMs).toBeGreaterThan(14 * 60_000);
    expect(waitedMs).toBeLessThanOrEqual(TRANSPORT_RETRY_BUDGET_MS);
    // The attempt cap is a backstop that the product schedule never reaches.
    expect(attempts).toBeLessThan(TRANSPORT_RETRY_LIMIT);
  });

  it("waits the longer of the schedule and the provider's own hint", () => {
    expect(planTransportRetry({ attempts: 0, waitedMs: 0 }, 500, 20_000)).toEqual({
      kind: "back-off",
      delayMs: 20_000,
    });
    expect(planTransportRetry({ attempts: 5, waitedMs: 0 }, 16_000, 2_000)).toEqual({
      kind: "back-off",
      delayMs: 16_000,
    });
  });

  it("does not start a wait that would carry the turn past its budget", () => {
    // A provider asking for an hour is describing a quota in all but name.
    expect(planTransportRetry({ attempts: 0, waitedMs: 0 }, 500, 60 * 60_000)).toEqual({
      kind: "give-up",
    });
    expect(
      planTransportRetry(
        { attempts: 3, waitedMs: TRANSPORT_RETRY_BUDGET_MS - 1_000 },
        2_000,
        undefined,
      ),
    ).toEqual({ kind: "give-up" });
  });

  it("stops at the attempt backstop even when the schedule waits nothing", () => {
    expect(
      planTransportRetry({ attempts: TRANSPORT_RETRY_LIMIT, waitedMs: 0 }, 0, undefined),
    ).toEqual({
      kind: "give-up",
    });
    expect(
      planTransportRetry({ attempts: TRANSPORT_RETRY_LIMIT - 1, waitedMs: 0 }, 0, undefined),
    ).toEqual({ kind: "back-off", delayMs: 0 });
  });
});
