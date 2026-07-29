import { describe, expect, it } from "vite-plus/test";

import { harnessChannelState } from "./channel";

const GRACE = 20_000;

describe("harnessChannelState", () => {
  it("says nothing about a harness that never launched through the wrapper", () => {
    expect(harnessChannelState({ lastLaunchAt: null, lastEventAt: null }, 100_000, GRACE)).toBe(
      "unproven",
    );
  });

  // An event with no launch behind it is a real event — a hook from a launch
  // that predates the table, or a harness started outside the wrapper. It is
  // recorded, and it still proves nothing about a launch we never saw.
  it("says nothing about an event with no launch behind it", () => {
    expect(harnessChannelState({ lastLaunchAt: null, lastEventAt: 90_000 }, 100_000, GRACE)).toBe(
      "unproven",
    );
  });

  it("waits out the grace window before accusing a launch that has said nothing", () => {
    const channel = { lastLaunchAt: 100_000, lastEventAt: null };
    expect(harnessChannelState(channel, 100_000, GRACE)).toBe("unproven");
    expect(harnessChannelState(channel, 119_999, GRACE)).toBe("unproven");
    expect(harnessChannelState(channel, 120_000, GRACE)).toBe("silent");
  });

  it("calls a launch reporting the moment its event lands, without waiting out the window", () => {
    expect(
      harnessChannelState({ lastLaunchAt: 100_000, lastEventAt: 100_001 }, 100_002, GRACE),
    ).toBe("reporting");
  });

  // The announce and the startup hook can share a millisecond, and an event
  // stamped exactly at the launch belongs to that launch.
  it("counts an event stamped at the launch itself as that launch reporting", () => {
    expect(
      harnessChannelState({ lastLaunchAt: 100_000, lastEventAt: 100_000 }, 999_999, GRACE),
    ).toBe("reporting");
  });

  // The whole point of the two columns: yesterday's evidence expires the moment
  // a newer launch fails to produce its own. Monotonic status cannot do this.
  it("forgets a working launch as soon as a newer one goes quiet", () => {
    const healthy = { lastLaunchAt: 100_000, lastEventAt: 101_000 };
    expect(harnessChannelState(healthy, 200_000, GRACE)).toBe("reporting");
    const upgraded = { ...healthy, lastLaunchAt: 300_000 };
    expect(harnessChannelState(upgraded, 400_000, GRACE)).toBe("silent");
    const fixed = { lastLaunchAt: 500_000, lastEventAt: 500_500 };
    expect(harnessChannelState(fixed, 600_000, GRACE)).toBe("reporting");
  });
});
