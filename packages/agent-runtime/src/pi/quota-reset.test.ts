import { describe, expect, it } from "vite-plus/test";

import { failureResetsAt } from "./quota-reset";
import { UsageLimitsHolder } from "./usage-limits/holder";

const CODEX_WS = {
  reason: "model" as const,
  message: "Codex error: The usage limit has been reached",
};
const OBSERVED_AT = Date.parse("2026-09-06T09:50:34Z");
const RESET = "2026-09-06T14:00:00.000Z";

describe("failureResetsAt", () => {
  it("reads a timeless usage limit against the provider's spent windows in the holder", () => {
    const holder = new UsageLimitsHolder();
    holder.apply("openai-codex", {
      observedAt: OBSERVED_AT,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 100,
          resetsAt: RESET,
          windowDurationMins: 300,
        },
      ],
    });
    expect(
      failureResetsAt({
        failure: CODEX_WS,
        providerId: "openai-codex",
        observedAt: OBSERVED_AT,
        holder,
      }),
    ).toBe(Date.parse(RESET));
  });

  it("says nothing when no window is held for the provider, or there is no holder", () => {
    for (const holder of [new UsageLimitsHolder(), undefined]) {
      expect(
        failureResetsAt({
          failure: CODEX_WS,
          providerId: "openai-codex",
          observedAt: OBSERVED_AT,
          holder,
        }),
      ).toBeNull();
    }
  });
});
