import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageLimitsUpdate,
  clampPercent,
  elapsedShare,
  formatCheckedAgo,
  formatDuration,
  formatResetsIn,
  isUsageStale,
  paceOf,
  remainingPercent,
  resolveUsageLimitsAfterProbe,
  usageTone,
  type UsageLimits,
  type UsageWindow,
} from "./usage-limits";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const HOUR = 3_600_000;

function window(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent: 40,
    resetsAt: new Date(NOW + 2 * HOUR).toISOString(),
    windowDurationMins: 300,
    ...overrides,
  };
}

describe("remainingPercent", () => {
  it("is the complement of what was used, clamped to the bar", () => {
    expect(remainingPercent({ usedPercent: 40 })).toBe(60);
    expect(remainingPercent({ usedPercent: 0 })).toBe(100);
    expect(remainingPercent({ usedPercent: 130 })).toBe(0);
    expect(remainingPercent({ usedPercent: -5 })).toBe(100);
  });
});

describe("clampPercent", () => {
  it("reads NaN as nothing used rather than propagating it", () => {
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(50)).toBe(50);
  });
});

describe("elapsedShare", () => {
  it("places now inside a window that resets in two of its five hours", () => {
    expect(elapsedShare(window(), NOW)).toBeCloseTo(0.6);
  });

  it("clamps to the window: not before it started, not past its reset", () => {
    expect(elapsedShare(window(), NOW - 10 * HOUR)).toBe(0);
    expect(elapsedShare(window(), NOW + 10 * HOUR)).toBe(1);
  });

  it("cannot place a window with no reset, no length, or a bad length", () => {
    expect(elapsedShare({ windowDurationMins: 300 }, NOW)).toBeNull();
    expect(elapsedShare({ resetsAt: window().resetsAt }, NOW)).toBeNull();
    expect(elapsedShare(window({ windowDurationMins: 0 }), NOW)).toBeNull();
    expect(elapsedShare(window({ resetsAt: "not a date" }), NOW)).toBeNull();
  });
});

describe("paceOf", () => {
  // Sixty percent of the window has elapsed in every case below.
  it("reads more used than elapsed as ahead, less as under, within the band as on", () => {
    expect(paceOf(window({ usedPercent: 80 }), NOW)).toBe("ahead");
    expect(paceOf(window({ usedPercent: 30 }), NOW)).toBe("under");
    expect(paceOf(window({ usedPercent: 60 }), NOW)).toBe("on");
  });

  it("holds the band edges as on pace", () => {
    expect(paceOf(window({ usedPercent: 65 }), NOW)).toBe("on");
    expect(paceOf(window({ usedPercent: 55 }), NOW)).toBe("on");
    expect(paceOf(window({ usedPercent: 65.01 }), NOW)).toBe("ahead");
    expect(paceOf(window({ usedPercent: 54.99 }), NOW)).toBe("under");
  });

  it("has no reading for a window it cannot place", () => {
    expect(paceOf(window({ resetsAt: undefined }), NOW)).toBeNull();
  });

  it("has no reading once the reset has passed, whatever was used", () => {
    expect(paceOf(window({ usedPercent: 30 }), NOW + 2 * HOUR)).toBeNull();
    expect(paceOf(window({ usedPercent: 30 }), NOW + 10 * HOUR)).toBeNull();
    // A moment before the reset still reads.
    expect(paceOf(window({ usedPercent: 30 }), NOW + 2 * HOUR - 1)).toBe("under");
  });
});

describe("formatDuration", () => {
  it("prints the two largest non-zero units and never seconds", () => {
    expect(formatDuration(2 * HOUR + 13 * 60_000 + 59_000)).toBe("2h 13m");
    expect(formatDuration(3 * 24 * HOUR + 4 * HOUR)).toBe("3d 4h");
    expect(formatDuration(3 * 24 * HOUR)).toBe("3d");
    expect(formatDuration(2 * HOUR)).toBe("2h");
    expect(formatDuration(45 * 60_000)).toBe("45m");
  });

  it("floors the sub-minute range and negative time to <1m", () => {
    expect(formatDuration(59_000)).toBe("<1m");
    expect(formatDuration(0)).toBe("<1m");
    expect(formatDuration(-5_000)).toBe("<1m");
  });
});

describe("formatResetsIn", () => {
  it("counts down to the reset", () => {
    expect(formatResetsIn(window(), NOW)).toBe("resets in 2h");
    expect(formatResetsIn(window(), NOW - 13 * 60_000)).toBe("resets in 2h 13m");
  });

  it("says now once the reset has passed and nothing newer arrived", () => {
    expect(formatResetsIn(window(), NOW + 3 * HOUR)).toBe("resets now");
    expect(formatResetsIn(window({ resetsAt: new Date(NOW).toISOString() }), NOW)).toBe(
      "resets now",
    );
  });
});

describe("usageTone", () => {
  // Sixty percent of the window has elapsed in every case below.
  it("is critical at a tenth left, whatever the pace", () => {
    expect(usageTone(window({ usedPercent: 90 }), NOW)).toBe("critical");
    expect(usageTone(window({ usedPercent: 95, resetsAt: undefined }), NOW)).toBe("critical");
  });

  it("asks for attention at a quarter left, or when spending runs ahead", () => {
    expect(usageTone(window({ usedPercent: 75 }), NOW)).toBe("attention");
    // Half left, but 60% of the window gone: ahead of even.
    expect(usageTone(window({ usedPercent: 50 }), NOW)).toBe("normal");
    expect(usageTone(window({ usedPercent: 70 }), NOW)).toBe("attention");
  });

  it("is ordinary with plenty left and no reading that says otherwise", () => {
    expect(usageTone(window({ usedPercent: 40 }), NOW)).toBe("normal");
    expect(usageTone(window({ usedPercent: 40, resetsAt: undefined }), NOW)).toBe("normal");
  });
});

describe("formatCheckedAgo", () => {
  it("reads under the minute as just now, otherwise as an age", () => {
    expect(formatCheckedAgo(NOW - 30_000, NOW)).toBe("checked just now");
    expect(formatCheckedAgo(NOW - 4 * 60_000, NOW)).toBe("checked 4m ago");
    expect(formatCheckedAgo(NOW - 26 * HOUR, NOW)).toBe("checked 1d 2h ago");
  });
});

describe("isUsageStale", () => {
  it("turns stale at ten minutes, past the probe's own freshness hold", () => {
    expect(isUsageStale({ checkedAt: NOW - 5 * 60_000 }, NOW)).toBe(false);
    expect(isUsageStale({ checkedAt: NOW - 10 * 60_000 }, NOW)).toBe(true);
  });

  it("has nothing to say without a usable reset time", () => {
    expect(formatResetsIn({}, NOW)).toBeNull();
    expect(formatResetsIn({ resetsAt: "soon" }, NOW)).toBeNull();
  });
});

describe("applyUsageLimitsUpdate", () => {
  const held: UsageLimits = {
    checkedAt: NOW - HOUR,
    windows: [
      window(),
      window({ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 12 }),
    ],
  };

  it("creates the snapshot from the first update", () => {
    const next = applyUsageLimitsUpdate(undefined, { observedAt: NOW, windows: [window()] });
    expect(next).toEqual({ checkedAt: NOW, windows: [window()] });
  });

  it("does not invent a reset or a length the first report never carried", () => {
    const bare: UsageWindow = { id: "session", kind: "session", label: "Session", usedPercent: 9 };
    const next = applyUsageLimitsUpdate(undefined, { observedAt: NOW, windows: [bare] });
    expect(next?.windows[0]).toEqual(bare);
    expect(next?.windows[0]).not.toHaveProperty("resetsAt");
    expect(next?.windows[0]).not.toHaveProperty("windowDurationMins");
  });

  it("returns the held object untouched when the update has nothing to say", () => {
    expect(applyUsageLimitsUpdate(held, { observedAt: NOW, windows: [] })).toBe(held);
    expect(applyUsageLimitsUpdate(undefined, { observedAt: NOW, windows: [] })).toBeUndefined();
  });

  it("returns the held object untouched when every window already says the same", () => {
    const update = { observedAt: NOW, windows: [window()] };
    expect(applyUsageLimitsUpdate(held, update)).toBe(held);
  });

  it("upserts the window it names and leaves its neighbours alone", () => {
    const next = applyUsageLimitsUpdate(held, {
      observedAt: NOW,
      windows: [window({ usedPercent: 55 })],
    });
    expect(next).not.toBe(held);
    expect(next?.checkedAt).toBe(NOW);
    expect(next?.windows.map((entry) => entry.usedPercent)).toEqual([55, 12]);
  });

  it("keeps the prior reset and length when the update omits them", () => {
    const next = applyUsageLimitsUpdate(held, {
      observedAt: NOW,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 70 }],
    });
    expect(next?.windows[0]).toEqual(window({ usedPercent: 70 }));
  });

  it("takes a reset and length the update supplies over the prior ones", () => {
    const later = new Date(NOW + 4 * HOUR).toISOString();
    const next = applyUsageLimitsUpdate(held, {
      observedAt: NOW,
      windows: [window({ resetsAt: later, windowDurationMins: 360 })],
    });
    expect(next?.windows[0]).toEqual(window({ resetsAt: later, windowDurationMins: 360 }));
  });

  it("appends a window it has not seen before, and drops nothing", () => {
    const opus = window({ id: "seven_day_opus", kind: "weekly", label: "Weekly · Opus" });
    const next = applyUsageLimitsUpdate(held, { observedAt: NOW, windows: [opus] });
    expect(next?.windows.map((entry) => entry.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
    ]);
  });

  it("clamps an out-of-range utilization as it lands", () => {
    const next = applyUsageLimitsUpdate(undefined, {
      observedAt: NOW,
      windows: [window({ usedPercent: 140 })],
    });
    expect(next?.windows[0]?.usedPercent).toBe(100);
  });

  it("clears a failed probe once a turn reports real windows", () => {
    const failed: UsageLimits = {
      checkedAt: NOW - HOUR,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    const next = applyUsageLimitsUpdate(failed, { observedAt: NOW, windows: [window()] });
    expect(next).toEqual({ checkedAt: NOW, windows: [window()] });
  });

  it("never grows windows on an unsupported account", () => {
    const unsupported: UsageLimits = {
      checkedAt: NOW - HOUR,
      windows: [],
      unavailable: { reason: "unsupported" },
    };
    expect(applyUsageLimitsUpdate(unsupported, { observedAt: NOW, windows: [window()] })).toBe(
      unsupported,
    );
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  const good: UsageLimits = { checkedAt: NOW - HOUR, windows: [window()] };
  const failed: UsageLimits = {
    checkedAt: NOW,
    windows: [],
    unavailable: { reason: "probeFailed" },
  };
  const unsupported: UsageLimits = {
    checkedAt: NOW,
    windows: [],
    unavailable: { reason: "unsupported" },
  };

  it("keeps the last good read over a failed probe", () => {
    expect(resolveUsageLimitsAfterProbe(good, failed)).toBe(good);
  });

  it("reports the failure when there is nothing good to keep", () => {
    expect(resolveUsageLimitsAfterProbe(undefined, failed)).toBe(failed);
    const earlierFailure: UsageLimits = { ...failed, checkedAt: NOW - HOUR };
    expect(resolveUsageLimitsAfterProbe(earlierFailure, failed)).toBe(failed);
  });

  it("lets a full read replace what was held, windows and all", () => {
    const fresh: UsageLimits = {
      checkedAt: NOW,
      windows: [window({ usedPercent: 5 })],
    };
    expect(resolveUsageLimitsAfterProbe(good, fresh)).toBe(fresh);
  });

  it("treats unsupported as authoritative over held windows", () => {
    expect(resolveUsageLimitsAfterProbe(good, unsupported)).toBe(unsupported);
  });
});
