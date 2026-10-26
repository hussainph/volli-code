import { describe, expect, it } from "vite-plus/test";

import type { HostLiveWork } from "@volli/host-core/sessions";

import { holdWhileTurnsRun, POWER_RECHECK_MS } from "./power";

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
