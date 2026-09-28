import { EventEmitter } from "node:events";
import { describe, expect, it } from "vite-plus/test";

import { createSuspendClock } from "./suspend-clock";

const HOUR = 3_600_000;

describe("createSuspendClock", () => {
  it("measures a sleep from the suspend and resume announcements", () => {
    const power = new EventEmitter();
    let now = 1_000;
    const clock = createSuspendClock(power, () => now);

    expect(clock.suspendedMsWithin(0, now)).toBe(0);
    power.emit("suspend");
    // Before `resume` is delivered, the sleep counts up to whatever instant is asked about.
    expect(clock.suspendedMsWithin(0, 1_000 + 3 * HOUR)).toBe(3 * HOUR);
    now = 1_000 + 3 * HOUR;
    power.emit("resume");
    now += 60_000;
    expect(clock.suspendedMsWithin(0, now)).toBe(3 * HOUR);
    // A window that starts after the wake saw no sleep.
    expect(clock.suspendedMsWithin(1_000 + 3 * HOUR, now)).toBe(0);
  });

  it("defaults to the wall clock", () => {
    const power = new EventEmitter();
    const clock = createSuspendClock(power);
    power.emit("suspend");
    power.emit("resume");
    expect(clock.suspendedMsWithin(0, Date.now() + 1)).toBeGreaterThanOrEqual(0);
  });
});
