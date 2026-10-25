import { describe, expect, it } from "vite-plus/test";

import { DESKTOP_ENTRIES } from "./desktop-entries";
import {
  THIS_MAC_RUNNER_OFF,
  THIS_MAC_RUNNER_PROBLEMS,
  THIS_MAC_RUNNER_STATES,
} from "./this-mac-runner";

describe("this Mac's runner wire vocabulary", () => {
  it("answers a launch that is not a Volli Cloud one with nothing running", () => {
    expect(THIS_MAC_RUNNER_OFF).toEqual({
      state: "off",
      runnerId: null,
      runnerName: null,
      since: null,
      waitingFacts: 0,
      problem: null,
      message: null,
    });
    expect(Object.isFrozen(THIS_MAC_RUNNER_OFF)).toBe(true);
    expect(THIS_MAC_RUNNER_STATES).toContain(THIS_MAC_RUNNER_OFF.state);
  });

  it("names a problem only for the states that are blocked", () => {
    expect(THIS_MAC_RUNNER_STATES).toEqual(expect.arrayContaining(["removed", "failed"]));
    expect(new Set(THIS_MAC_RUNNER_PROBLEMS).size).toBe(THIS_MAC_RUNNER_PROBLEMS.length);
    expect(new Set(THIS_MAC_RUNNER_STATES).size).toBe(THIS_MAC_RUNNER_STATES.length);
  });

  it("declares every runners entry host-placed and client-local, its reads as reads", () => {
    const runners = DESKTOP_ENTRIES.filter(({ key }) => key.startsWith("runners."));
    expect(runners.map(({ key, idempotency }) => [key, idempotency])).toEqual([
      ["runners.thisMac", "read"],
      ["runners.subscribeThisMac", "read"],
      ["runners.addThisMac", "natural"],
      ["runners.removeThisMac", "natural"],
    ]);
    for (const entry of runners) {
      expect(entry.placement, entry.key).toBe("host");
      expect(entry.compatibility, entry.key).toBe("client-local");
    }
  });
});
