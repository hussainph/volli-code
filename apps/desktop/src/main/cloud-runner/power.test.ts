import { describe, expect, it } from "vite-plus/test";

import type { HostLiveWork } from "@volli/host-core/sessions";

import {
  createRunnerResidencyHold,
  holdWhileTurnsRun,
  POWER_RECHECK_MS,
  RESIDENCY_RECHECK_MS,
  residencyHoldWanted,
  runnerPowerCapability,
  type RunnerPowerFacts,
  type RunnerPowerSource,
} from "./power";

/** C1's closed source vocabulary, as the contract names it. */
const SOURCES = ["ac", "battery", "unknown"] as const satisfies readonly RunnerPowerSource[];

describe("the cloud launch's power policy", () => {
  it("holds while turns run, window or not, ignores shells, and re-reads on its own clock", () => {
    let work: HostLiveWork = { turns: 0, shells: 2 };
    let listener: ((next: HostLiveWork) => void) | null = null;
    let tick: (() => void) | null = null;
    const calls: string[] = [];
    const stop = holdWhileTurnsRun(
      {
        current: () => work,
        subscribe: (next) => {
          listener = next;
          return () => (listener = null);
        },
      },
      { hold: () => void calls.push("hold"), release: () => void calls.push("release") },
      {
        setInterval: (run, ms) => {
          expect(ms).toBe(POWER_RECHECK_MS);
          tick = run;
          return "handle";
        },
        clearInterval: () => (tick = null),
      },
    );
    expect(calls).toEqual([]);
    work = { turns: 1, shells: 0 };
    listener!(work);
    listener!(work);
    expect(calls).toEqual(["hold"]);
    // A binding that closed on its own is not announced: the clock finds it.
    work = { turns: 0, shells: 0 };
    tick!();
    expect(calls).toEqual(["hold", "release"]);
    work = { turns: 2, shells: 0 };
    tick!();
    stop();
    expect(calls).toEqual(["hold", "release", "hold", "release"]);
    expect(listener).toBeNull();
    expect(tick).toBeNull();
  });
});

const blocker = (calls: string[]) => ({
  hold: () => void calls.push("hold"),
  release: () => void calls.push("release"),
});

describe("keeping this Mac working as a runner", () => {
  it("reports the switch as alwaysOn and the reading as the source", () => {
    expect(runnerPowerCapability({ enabled: true, source: "ac" })).toEqual({
      source: "ac",
      alwaysOn: true,
    });
    expect(runnerPowerCapability({ enabled: false, source: "battery" })).toEqual({
      source: "battery",
      alwaysOn: false,
    });
    for (const source of SOURCES) {
      expect(runnerPowerCapability({ enabled: true, source }).source).toBe(source);
    }
  });

  it("wants the assertion only from a Mac asked to stay available on wall power", () => {
    const wanted = (enabled: boolean) =>
      SOURCES.filter((source) => residencyHoldWanted({ enabled, source }));
    expect(wanted(true)).toEqual(["ac"]);
    expect(wanted(false)).toEqual([]);
  });

  it("holds and releases as the switch and the wall change, and finds an unannounced change", () => {
    let facts: RunnerPowerFacts = { enabled: true, source: "battery" };
    let tick: (() => void) | null = null;
    const calls: string[] = [];
    const hold = createRunnerResidencyHold(() => facts, blocker(calls), {
      setInterval: (run, ms) => {
        expect(ms).toBe(RESIDENCY_RECHECK_MS);
        tick = run;
        return "handle";
      },
      clearInterval: () => (tick = null),
    });
    // Plugged in only after the panel said so: nothing held yet.
    expect(calls).toEqual([]);
    facts = { enabled: true, source: "ac" };
    hold.refresh();
    hold.refresh();
    expect(calls).toEqual(["hold"]);
    // Battery announced by `powerMonitor`: release at once.
    facts = { enabled: true, source: "battery" };
    hold.refresh();
    expect(calls).toEqual(["hold", "release"]);
    // The switch was turned on with no event at all: the clock finds it.
    facts = { enabled: true, source: "ac" };
    tick!();
    expect(calls).toEqual(["hold", "release", "hold"]);
    // Off means today's behaviour, plugged in or not.
    facts = { enabled: false, source: "ac" };
    tick!();
    expect(calls).toEqual(["hold", "release", "hold", "release"]);
    facts = { enabled: true, source: "ac" };
    hold.refresh();
    const lateTick = tick!;
    hold.stop();
    hold.refresh();
    lateTick();
    hold.stop();
    expect(calls).toEqual(["hold", "release", "hold", "release", "hold", "release"]);
    expect(tick).toBeNull();
  });

  it("releases rather than holds when the facts cannot be read", () => {
    let readable = true;
    let tick: (() => void) | null = null;
    const calls: string[] = [];
    const hold = createRunnerResidencyHold(
      () => {
        if (!readable) throw new Error("database is closed");
        return { enabled: true, source: "ac" };
      },
      blocker(calls),
      {
        setInterval: (run) => {
          tick = run;
          return "handle";
        },
        clearInterval: () => (tick = null),
      },
    );
    expect(calls).toEqual(["hold"]);
    readable = false;
    tick!();
    expect(calls).toEqual(["hold", "release"]);
    hold.stop();
    expect(calls).toEqual(["hold", "release"]);
  });
});
