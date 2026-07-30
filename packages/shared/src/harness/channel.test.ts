import { describe, expect, it } from "vite-plus/test";

import { harnessChannelState } from "./channel";

const GRACE = 20_000;
/** A harness Volli configured that also speaks at boot — claude-code, cursor, opencode. */
const EXPECTED = true;

describe("harnessChannelState", () => {
  it("says nothing about a harness that never launched through the wrapper", () => {
    expect(
      harnessChannelState({ lastLaunchAt: null, lastEventAt: null }, EXPECTED, 100_000, GRACE),
    ).toBe("unproven");
  });

  // An event with no launch behind it is a real event — a hook from a launch
  // that predates the table, or a harness started outside the wrapper. It is
  // recorded, and it still proves nothing about a launch we never saw.
  it("says nothing about an event with no launch behind it", () => {
    expect(
      harnessChannelState({ lastLaunchAt: null, lastEventAt: 90_000 }, EXPECTED, 100_000, GRACE),
    ).toBe("unproven");
  });

  it("waits out the grace window before accusing a launch that has said nothing", () => {
    const channel = { lastLaunchAt: 100_000, lastEventAt: null };
    expect(harnessChannelState(channel, EXPECTED, 100_000, GRACE)).toBe("unproven");
    expect(harnessChannelState(channel, EXPECTED, 119_999, GRACE)).toBe("unproven");
    expect(harnessChannelState(channel, EXPECTED, 120_000, GRACE)).toBe("silent");
  });

  it("calls a launch reporting the moment its event lands, without waiting out the window", () => {
    expect(
      harnessChannelState(
        { lastLaunchAt: 100_000, lastEventAt: 100_001 },
        EXPECTED,
        100_002,
        GRACE,
      ),
    ).toBe("reporting");
  });

  // The announce and the startup hook can share a millisecond, and an event
  // stamped exactly at the launch belongs to that launch.
  it("counts an event stamped at the launch itself as that launch reporting", () => {
    expect(
      harnessChannelState(
        { lastLaunchAt: 100_000, lastEventAt: 100_000 },
        EXPECTED,
        999_999,
        GRACE,
      ),
    ).toBe("reporting");
  });

  // The whole point of the two columns: yesterday's evidence expires the moment
  // a newer launch fails to produce its own. Monotonic status cannot do this.
  it("forgets a working launch as soon as a newer one goes quiet", () => {
    const healthy = { lastLaunchAt: 100_000, lastEventAt: 101_000 };
    expect(harnessChannelState(healthy, EXPECTED, 200_000, GRACE)).toBe("reporting");
    const upgraded = { ...healthy, lastLaunchAt: 300_000 };
    expect(harnessChannelState(upgraded, EXPECTED, 400_000, GRACE)).toBe("silent");
    const fixed = { lastLaunchAt: 500_000, lastEventAt: 500_500 };
    expect(harnessChannelState(fixed, EXPECTED, 600_000, GRACE)).toBe("reporting");
  });

  describe("a harness that may not be held to a reporting promise", () => {
    // Codex, verified in the TUI: it has no session until there is a turn, so
    // its SessionStart arrives beside the first prompt and never before. A
    // launch nobody has typed into is silent in the plainest sense and says
    // nothing whatever about the channel. Accusing it is the exact false
    // accusation this model was built to remove, and no length of silence
    // licenses it.
    it("is never accused, however long the silence runs", () => {
      const channel = { lastLaunchAt: 100_000, lastEventAt: null };
      expect(harnessChannelState(channel, false, 120_000, GRACE)).toBe("unproven");
      expect(harnessChannelState(channel, false, 100_000_000, GRACE)).toBe("unproven");
    });

    // The gate defers the accusation; it never withholds the fact. Once the
    // user takes a turn and the event lands, the channel has proved itself on
    // the same terms as any other harness.
    it("still reports the moment its first event lands", () => {
      expect(
        harnessChannelState({ lastLaunchAt: 100_000, lastEventAt: 130_000 }, false, 140_000, GRACE),
      ).toBe("reporting");
    });

    // The same `false` covers an id nothing can describe — a manifest untrusted
    // since the launch, a harness this build does not ship. It made no promise
    // anyone read, and `expectsHarnessEvents(undefined)` says so.
    it("covers a harness whose adapter cannot be looked up at all", () => {
      expect(
        harnessChannelState({ lastLaunchAt: 100_000, lastEventAt: null }, false, 999_999, GRACE),
      ).toBe("unproven");
    });
  });
});
