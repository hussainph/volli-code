import { describe, expect, it } from "vite-plus/test";

import { compactAge, formatStamp, nextAgeChangeAt, relativeTime } from "./relative-time";

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0); // 2026-07-14T12:00:00Z
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe("relativeTime", () => {
  it("reads sub-45s and future stamps as 'just now'", () => {
    expect(relativeTime(NOW, NOW)).toBe("just now");
    expect(relativeTime(NOW - 30 * SECOND, NOW)).toBe("just now");
    expect(relativeTime(NOW + 5 * MINUTE, NOW)).toBe("just now");
  });

  it("counts minutes, hours, days, and weeks", () => {
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toBe("5m ago");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3h ago");
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe("2d ago");
    expect(relativeTime(NOW - 3 * WEEK, NOW)).toBe("3w ago");
  });

  it("rolls up to an absolute date beyond ~4 weeks", () => {
    const older = relativeTime(NOW - 6 * WEEK, NOW);
    expect(older).not.toContain("ago");
    expect(older.length).toBeGreaterThan(0);
    // Different calendar year → the year is included.
    const lastYear = relativeTime(Date.UTC(2025, 0, 1), NOW);
    expect(lastYear).toContain("2025");
  });

  it("defaults `now` to the wall clock", () => {
    expect(relativeTime(Date.now())).toBe("just now");
  });
});

describe("compactAge", () => {
  it("says 'now' where relativeTime says 'just now'", () => {
    expect(compactAge(NOW, NOW)).toBe("now");
    expect(compactAge(NOW - 30 * SECOND, NOW)).toBe("now");
    expect(compactAge(NOW + 5 * MINUTE, NOW)).toBe("now");
  });

  it("drops the trailing ' ago' from every relative answer", () => {
    expect(compactAge(NOW - 5 * MINUTE, NOW)).toBe("5m");
    expect(compactAge(NOW - 3 * HOUR, NOW)).toBe("3h");
    expect(compactAge(NOW - 2 * DAY, NOW)).toBe("2d");
    expect(compactAge(NOW - 3 * WEEK, NOW)).toBe("3w");
  });

  it("keeps month + day for a same-year rollup", () => {
    const older = compactAge(NOW - 6 * WEEK, NOW);
    expect(older).not.toContain("ago");
    expect(older).not.toContain("2026");
    expect(older).not.toContain("'");
  });

  it("trades the day for a two-digit year across the calendar boundary", () => {
    const crossYear = compactAge(Date.UTC(2025, 11, 6, 12, 0, 0), NOW);
    expect(crossYear).toBe("Dec '25");
    // The string the age column could not hold; the whole point of the form.
    expect(crossYear).not.toContain("2025");
    expect(crossYear).not.toContain(",");
  });

  it("defaults `now` to the wall clock", () => {
    expect(compactAge(Date.now())).toBe("now");
  });
});

/** What `compactAge` reads one millisecond either side of the boundary. */
function straddle(epochMs: number, now: number): [string, string] {
  const at = nextAgeChangeAt(epochMs, now);
  return [compactAge(epochMs, at - 1), compactAge(epochMs, at)];
}

describe("nextAgeChangeAt", () => {
  it("closes the 'just now' bucket at 45 seconds, a future stamp included", () => {
    expect(nextAgeChangeAt(NOW, NOW)).toBe(NOW + 45 * SECOND);
    expect(nextAgeChangeAt(NOW, NOW - 5 * MINUTE)).toBe(NOW + 45 * SECOND);
    expect(straddle(NOW - 30 * SECOND, NOW)).toEqual(["now", "0m"]);
  });

  it("closes every later bucket on its own unit", () => {
    expect(nextAgeChangeAt(NOW - 90 * SECOND, NOW)).toBe(NOW - 90 * SECOND + 2 * MINUTE);
    expect(nextAgeChangeAt(NOW - 90 * MINUTE, NOW)).toBe(NOW - 90 * MINUTE + 2 * HOUR);
    expect(nextAgeChangeAt(NOW - 36 * HOUR, NOW)).toBe(NOW - 36 * HOUR + 2 * DAY);
    expect(nextAgeChangeAt(NOW - 10 * DAY, NOW)).toBe(NOW - 10 * DAY + 2 * WEEK);
  });

  it("is the first instant the age actually reads differently, at every rung", () => {
    expect(straddle(NOW - 90 * SECOND, NOW)).toEqual(["1m", "2m"]);
    expect(straddle(NOW - 90 * MINUTE, NOW)).toEqual(["1h", "2h"]);
    expect(straddle(NOW - 36 * HOUR, NOW)).toEqual(["1d", "2d"]);
    expect(straddle(NOW - 10 * DAY, NOW)).toEqual(["1w", "2w"]);
    // The rung that leaves the relative ladder entirely. Only the near side is
    // named: the far side is a localised date, so the fact worth asserting is
    // that it is no longer a week count.
    const [lastWeek, rolledUp] = straddle(NOW - 4 * WEEK + SECOND, NOW);
    expect(lastWeek).toBe("3w");
    expect(rolledUp).not.toMatch(/w$/);
  });

  it("waits for the turn of the year once the age is an absolute date", () => {
    const at = nextAgeChangeAt(NOW - 6 * WEEK, NOW);
    expect(at).toBe(new Date(2027, 0, 1).getTime());
    // Nothing about that date moves until the year printed beside it does.
    const [thisYear, nextYear] = straddle(NOW - 6 * WEEK, NOW);
    expect(thisYear).not.toContain("'");
    expect(nextYear).toContain("'26");
  });

  it("is always strictly in the future, so a caller arming a timer cannot spin", () => {
    for (const age of [0, SECOND, MINUTE, HOUR, DAY, WEEK, 6 * WEEK, 60 * WEEK]) {
      expect(nextAgeChangeAt(NOW - age, NOW)).toBeGreaterThan(NOW);
    }
  });
});

describe("formatStamp", () => {
  it("renders a date-only stamp by default, year always present", () => {
    const stamp = formatStamp(NOW);
    expect(stamp).toContain("2026");
    expect(stamp).not.toMatch(/\d:\d\d/);
    // Explicit `time: false` is the same date-only rendering.
    expect(formatStamp(NOW, { time: false })).toBe(stamp);
  });

  it("adds hour/minute with `time: true`", () => {
    const stamp = formatStamp(NOW, { time: true });
    expect(stamp).toContain("2026");
    expect(stamp).toMatch(/\d:\d\d/);
  });
});
