import { describe, expect, it } from "vite-plus/test";

import {
  STREAK_DAYS,
  STREAK_WEEKS,
  streakGrid,
  streakStep,
  streakWindowStart,
} from "./session-streak";

/** Local noon `daysAgo` days before `now` — a stamp that cannot straddle a boundary. */
function daysBefore(now: Date, daysAgo: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12).getTime();
}

const NOW = new Date(2026, 4, 20, 9, 41);

describe("the window", () => {
  it("is 26 weeks of cells", () => {
    expect(STREAK_DAYS).toBe(STREAK_WEEKS * 7);
  });

  it("opens at local midnight on the oldest day, not at this hour", () => {
    const start = new Date(streakWindowStart(NOW.getTime()));
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
    expect(start.getTime()).toBe(
      new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - (STREAK_DAYS - 1)).getTime(),
    );
  });

  it("honours a caller's own window length", () => {
    const start = new Date(streakWindowStart(NOW.getTime(), 7));
    expect(start.getDate()).toBe(NOW.getDate() - 6);
  });
});

describe("streakGrid", () => {
  it("fills one cell per day, oldest first, with today last", () => {
    const grid = streakGrid([], NOW.getTime());
    expect(grid.days).toHaveLength(STREAK_DAYS);
    expect(grid.days[0]).toEqual({ index: 0, daysAgo: STREAK_DAYS - 1, count: 0 });
    expect(grid.days[STREAK_DAYS - 1]).toEqual({
      index: STREAK_DAYS - 1,
      daysAgo: 0,
      count: 0,
    });
  });

  it("buckets stamps into their own local day", () => {
    const grid = streakGrid(
      [daysBefore(NOW, 0), daysBefore(NOW, 0), daysBefore(NOW, 2)],
      NOW.getTime(),
      7,
    );
    expect(grid.days.map((day) => day.count)).toEqual([0, 0, 0, 0, 1, 0, 2]);
    expect(grid.total).toBe(3);
    expect(grid.activeDays).toBe(2);
  });

  it("buckets by the calendar day, so a stamp minutes before midnight is yesterday", () => {
    const lateLastNight = new Date(
      NOW.getFullYear(),
      NOW.getMonth(),
      NOW.getDate() - 1,
      23,
      58,
    ).getTime();
    const grid = streakGrid([lateLastNight], NOW.getTime(), 3);
    expect(grid.days.map((day) => day.count)).toEqual([0, 1, 0]);
  });

  it("ignores stamps older than the window rather than piling them into its first cell", () => {
    const grid = streakGrid([daysBefore(NOW, 9), daysBefore(NOW, 1)], NOW.getTime(), 7);
    expect(grid.total).toBe(1);
    expect(grid.days[0]?.count).toBe(0);
  });

  it("ignores stamps from the future", () => {
    const grid = streakGrid([daysBefore(NOW, -3)], NOW.getTime(), 7);
    expect(grid.total).toBe(0);
  });

  it("counts the run of days ending today", () => {
    const grid = streakGrid(
      [daysBefore(NOW, 0), daysBefore(NOW, 1), daysBefore(NOW, 2), daysBefore(NOW, 4)],
      NOW.getTime(),
      7,
    );
    expect(grid.currentStreak).toBe(3);
  });

  it("has no streak when today has no Session", () => {
    const grid = streakGrid([daysBefore(NOW, 1), daysBefore(NOW, 2)], NOW.getTime(), 7);
    expect(grid.currentStreak).toBe(0);
  });

  it("counts a whole window of activity as one unbroken streak", () => {
    const every = Array.from({ length: 7 }, (_, index) => daysBefore(NOW, index));
    expect(streakGrid(every, NOW.getTime(), 7).currentStreak).toBe(7);
  });
});

describe("streakStep", () => {
  it("keeps an empty day off the ramp entirely", () => {
    expect(streakStep(0)).toBe(0);
  });

  it("climbs three lit steps on fixed thresholds", () => {
    expect(streakStep(1)).toBe(1);
    expect(streakStep(4)).toBe(1);
    expect(streakStep(5)).toBe(2);
    expect(streakStep(8)).toBe(2);
    expect(streakStep(9)).toBe(3);
    expect(streakStep(40)).toBe(3);
  });
});
