const DAY_MS = 24 * 60 * 60 * 1000;

/** A daily London slot and cursor with exactly three missed occurrences. */
export function automationScheduleFixture(now) {
  const timeZone = "Europe/London";
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  return {
    schedule: { preset: "daily", hour: (hour + 12) % 24, minute: 30, timeZone },
    // A 72-hour interval is not three calendar days across DST. Put the slot
    // roughly twelve hours away from BOTH ends, so London's one-hour shift
    // cannot add/remove an occurrence, and none can fire while the smoke runs.
    cursor: now - 3 * DAY_MS - 60_000,
  };
}
