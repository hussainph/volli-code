import { describe, expect, it } from "vite-plus/test";

import { compactAge, formatStamp, relativeTime } from "./relative-time";

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
