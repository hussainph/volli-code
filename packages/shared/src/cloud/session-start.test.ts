import { describe, expect, test } from "vite-plus/test";

import type { RunnerId } from "./ids";
import {
  composerDefaultRunnerId,
  lacksSessionStart,
  preferredRunnerId,
  runnerPowerOf,
  sessionStartState,
  UNKNOWN_RUNNER_POWER,
  type RunnerPickerRow,
} from "./session-start";

const A = "00000000-0000-4000-8000-00000000000a" as RunnerId;
const B = "00000000-0000-4000-8000-00000000000b" as RunnerId;
const C = "00000000-0000-4000-8000-00000000000c" as RunnerId;

function row(id: RunnerId, overrides: Partial<RunnerPickerRow> = {}): RunnerPickerRow {
  return {
    id,
    name: id.slice(-1),
    kind: "linux",
    status: "online",
    statusChangedAt: 1_000,
    power: { source: "ac", alwaysOn: true },
    providers: [],
    version: "0.3.0",
    upgradeRequired: false,
    ...overrides,
  };
}

describe("runnerPowerOf", () => {
  test("reads the C1 power report, and anything else as unknown", () => {
    expect(runnerPowerOf({ power: { source: "ac", alwaysOn: true } })).toEqual({
      source: "ac",
      alwaysOn: true,
    });
    expect(runnerPowerOf({ power: { source: "battery", alwaysOn: false } })).toEqual({
      source: "battery",
      alwaysOn: false,
    });
    expect(runnerPowerOf({ power: { source: "solar", alwaysOn: "yes" } })).toEqual(
      UNKNOWN_RUNNER_POWER,
    );
    for (const capabilities of [null, undefined, "x", {}, { power: null }, { power: 3 }]) {
      expect(runnerPowerOf(capabilities)).toEqual(UNKNOWN_RUNNER_POWER);
    }
  });
});

describe("lacksSessionStart", () => {
  test("judges only a runner that reported its job capabilities", () => {
    expect(lacksSessionStart({ tools: ["automation.run"] })).toBe(true);
    expect(lacksSessionStart({ tools: ["automation.run", "session.start"] })).toBe(false);
    for (const capabilities of [null, undefined, 1, {}, { tools: "session.start" }]) {
      expect(lacksSessionStart(capabilities)).toBe(false);
    }
  });
});

describe("the default runner", () => {
  test("prefers an online, always-on runner on AC, the most recently active first", () => {
    expect(
      preferredRunnerId([
        row(A, { statusChangedAt: 1_000 }),
        row(B, { statusChangedAt: 3_000 }),
        row(C, { statusChangedAt: 2_000 }),
      ]),
    ).toBe(B);
    // A tie is broken by id, so the answer never flickers.
    expect(preferredRunnerId([row(B), row(A)])).toBe(A);
    expect(preferredRunnerId([row(A), row(B)])).toBe(A);
  });

  test("passes over runners that are not online, not always on, or not plugged in", () => {
    expect(
      preferredRunnerId([
        row(A, { status: "asleep" }),
        row(B, { power: { source: "battery", alwaysOn: true } }),
        row(C, { power: { source: "ac", alwaysOn: false } }),
      ]),
    ).toBeNull();
    expect(preferredRunnerId([])).toBeNull();
  });

  test("the composer falls back to this Mac, then the first online runner, then none", () => {
    const runners = [row(A, { status: "offline" }), row(B), row(C)];
    expect(composerDefaultRunnerId({ runners, defaultRunnerId: C }, A)).toBe(C);
    expect(composerDefaultRunnerId({ runners, defaultRunnerId: null }, A)).toBe(A);
    expect(composerDefaultRunnerId({ runners, defaultRunnerId: null }, null)).toBe(B);
    expect(composerDefaultRunnerId({ runners, defaultRunnerId: null }, "elsewhere")).toBe(B);
    expect(
      composerDefaultRunnerId(
        { runners: [row(A, { status: "asleep" })], defaultRunnerId: null },
        null,
      ),
    ).toBeNull();
  });
});

test("a start's state follows its job", () => {
  expect(sessionStartState("queued")).toBe("queued");
  expect(sessionStartState("leased")).toBe("starting");
  expect(sessionStartState("done")).toBe("started");
  for (const status of ["failed", "expired", "cancelled"] as const) {
    expect(sessionStartState(status)).toBe("failed");
  }
});
