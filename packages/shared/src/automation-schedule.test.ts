import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATION_SCHEDULE_PRESETS,
  AUTOMATION_SCHEDULE_STAGGER_MS,
  hostTimeZone,
  isScheduleTimeZone,
  nextScheduleOccurrence,
  parseAutomationSchedule,
  SCHEDULE_WEEKDAYS,
  schedulePhrase,
  scheduleSentence,
  scheduleStaggerMs,
  scheduleTimeLabel,
  type AutomationSchedule,
} from "./automation-schedule";

const LONDON = "Europe/London";
const NEW_YORK = "America/New_York";

/** A schedule at :30, so nothing in these cases is staggered unless it asks to be. */
function daily(overrides: Partial<Extract<AutomationSchedule, { preset: "daily" }>> = {}) {
  return { preset: "daily", hour: 21, minute: 30, timeZone: LONDON, ...overrides } as const;
}

/** The wall-clock reading of an instant in a zone, as `YYYY-MM-DD HH:mm`. */
function wallClock(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

describe("parseAutomationSchedule", () => {
  it("reads each preset", () => {
    expect(parseAutomationSchedule({ preset: "hourly", minute: 5, timeZone: LONDON })).toEqual({
      preset: "hourly",
      minute: 5,
      timeZone: LONDON,
    });
    expect(
      parseAutomationSchedule({ preset: "daily", hour: 9, minute: 0, timeZone: LONDON }),
    ).toEqual({ preset: "daily", hour: 9, minute: 0, timeZone: LONDON });
    expect(
      parseAutomationSchedule({ preset: "weekdays", hour: 9, minute: 0, timeZone: LONDON }),
    ).toEqual({ preset: "weekdays", hour: 9, minute: 0, timeZone: LONDON });
    expect(
      parseAutomationSchedule({
        preset: "weekly",
        weekday: "monday",
        hour: 8,
        minute: 15,
        timeZone: LONDON,
      }),
    ).toEqual({ preset: "weekly", weekday: "monday", hour: 8, minute: 15, timeZone: LONDON });
  });

  it("refuses anything it cannot read rather than repairing it", () => {
    // Every refusal below would otherwise become a time nobody chose, and the
    // Automation would start unattended work at it.
    expect(parseAutomationSchedule(null)).toBeNull();
    expect(parseAutomationSchedule("every day")).toBeNull();
    expect(parseAutomationSchedule({ preset: "daily", hour: 9, minute: 0 })).toBeNull();
    expect(
      parseAutomationSchedule({ preset: "daily", hour: 9, minute: 0, timeZone: "Mars/Olympus" }),
    ).toBeNull();
    expect(
      parseAutomationSchedule({ preset: "daily", hour: 9, minute: 60, timeZone: LONDON }),
    ).toBeNull();
    expect(
      parseAutomationSchedule({ preset: "daily", hour: 24, minute: 0, timeZone: LONDON }),
    ).toBeNull();
    expect(
      parseAutomationSchedule({ preset: "daily", hour: 9.5, minute: 0, timeZone: LONDON }),
    ).toBeNull();
    expect(
      parseAutomationSchedule({ preset: "monthly", hour: 9, minute: 0, timeZone: LONDON }),
    ).toBeNull();
    expect(parseAutomationSchedule({ preset: "hourly", minute: -1, timeZone: LONDON })).toBeNull();
    expect(
      parseAutomationSchedule({
        preset: "weekly",
        weekday: "caturday",
        hour: 8,
        minute: 0,
        timeZone: LONDON,
      }),
    ).toBeNull();
    expect(
      parseAutomationSchedule({ preset: "weekly", hour: 8, minute: 0, timeZone: LONDON }),
    ).toBeNull();
    expect(parseAutomationSchedule({ preset: "hourly", minute: 0, timeZone: "" })).toBeNull();
    expect(parseAutomationSchedule({ preset: "hourly", minute: 0, timeZone: 7 })).toBeNull();
  });
});

describe("isScheduleTimeZone / hostTimeZone", () => {
  it("accepts a real IANA zone and refuses anything else", () => {
    expect(isScheduleTimeZone(LONDON)).toBe(true);
    expect(isScheduleTimeZone("UTC")).toBe(true);
    expect(isScheduleTimeZone("Middle/Earth")).toBe(false);
    expect(isScheduleTimeZone("")).toBe(false);
    expect(isScheduleTimeZone(undefined)).toBe(false);
  });

  it("answers the host zone as a zone this build can resolve", () => {
    const zone = hostTimeZone();
    expect(isScheduleTimeZone(zone)).toBe(true);
    expect(typeof zone).toBe("string");
  });
});

describe("the sentence", () => {
  it("reads as the row it is authored in", () => {
    expect(schedulePhrase({ preset: "hourly", minute: 5, timeZone: LONDON })).toBe(
      "Hourly at :05 past the hour",
    );
    expect(schedulePhrase(daily())).toBe("Every day at 21:30");
    expect(schedulePhrase({ preset: "weekdays", hour: 9, minute: 0, timeZone: LONDON })).toBe(
      "Mon–Fri at 09:00",
    );
    expect(
      schedulePhrase({
        preset: "weekly",
        weekday: "wednesday",
        hour: 8,
        minute: 5,
        timeZone: LONDON,
      }),
    ).toBe("Weekly on Wednesday at 08:05");
    expect(scheduleSentence(daily())).toBe("Every day at 21:30 Europe/London");
    expect(scheduleTimeLabel({ preset: "hourly", minute: 0, timeZone: LONDON })).toBe(":00");
  });

  it("names every preset and every weekday", () => {
    expect(AUTOMATION_SCHEDULE_PRESETS).toEqual(["hourly", "daily", "weekdays", "weekly"]);
    expect(SCHEDULE_WEEKDAYS).toHaveLength(7);
    for (const weekday of SCHEDULE_WEEKDAYS) {
      expect(
        schedulePhrase({ preset: "weekly", weekday, hour: 0, minute: 1, timeZone: LONDON }),
      ).toMatch(/^Weekly on [A-Z][a-z]+ at 00:01$/);
    }
  });
});

describe("nextScheduleOccurrence", () => {
  it("is strictly after the moment it is asked about, for every preset", () => {
    // The never-early rule, stated as the operator that enforces it. Asked
    // again with its own answer, it must move on rather than repeat.
    const schedules: AutomationSchedule[] = [
      { preset: "hourly", minute: 0, timeZone: LONDON },
      { preset: "hourly", minute: 17, timeZone: NEW_YORK },
      daily(),
      { preset: "weekdays", hour: 9, minute: 0, timeZone: NEW_YORK },
      { preset: "weekly", weekday: "monday", hour: 8, minute: 0, timeZone: LONDON },
    ];
    for (const schedule of schedules) {
      let cursor = Date.parse("2026-03-01T00:00:00Z");
      for (let step = 0; step < 40; step += 1) {
        const next = nextScheduleOccurrence({ schedule, staggerKey: "a-b-c", after: cursor });
        expect(next).toBeGreaterThan(cursor);
        cursor = next;
      }
    }
  });

  it("fires a daily schedule at its stored wall time", () => {
    const at = nextScheduleOccurrence({
      schedule: daily(),
      staggerKey: "id",
      after: Date.parse("2026-06-01T10:00:00Z"),
    });
    expect(wallClock(at, LONDON)).toBe("2026-06-01 21:30");
  });

  it("moves to the next day once the day's time has passed", () => {
    const at = nextScheduleOccurrence({
      schedule: daily(),
      staggerKey: "id",
      after: Date.parse("2026-06-01T22:00:00Z"),
    });
    expect(wallClock(at, LONDON)).toBe("2026-06-02 21:30");
  });

  it("puts an hourly schedule on the next hour at its minute", () => {
    const schedule = { preset: "hourly", minute: 15, timeZone: LONDON } as const;
    const at = nextScheduleOccurrence({
      schedule,
      staggerKey: "id",
      after: Date.parse("2026-06-01T10:20:00Z"),
    });
    expect(wallClock(at, LONDON)).toBe("2026-06-01 12:15");
  });

  it("skips the weekend for a weekdays schedule", () => {
    // 2026-06-06 is a Saturday in London.
    const at = nextScheduleOccurrence({
      schedule: { preset: "weekdays", hour: 9, minute: 30, timeZone: LONDON },
      staggerKey: "id",
      after: Date.parse("2026-06-06T00:00:00Z"),
    });
    expect(wallClock(at, LONDON)).toBe("2026-06-08 09:30");
  });

  it("lands a weekly schedule on its own weekday", () => {
    const schedule = {
      preset: "weekly",
      weekday: "wednesday",
      hour: 7,
      minute: 45,
      timeZone: LONDON,
    } as const;
    const first = nextScheduleOccurrence({
      schedule,
      staggerKey: "id",
      after: Date.parse("2026-06-01T00:00:00Z"),
    });
    expect(wallClock(first, LONDON)).toBe("2026-06-03 07:45");
    const second = nextScheduleOccurrence({ schedule, staggerKey: "id", after: first });
    expect(wallClock(second, LONDON)).toBe("2026-06-10 07:45");
  });

  it("fires a weekly schedule the same day when its time is still ahead", () => {
    // The start slot is already eligible, so the eligibility walk does not run.
    const at = nextScheduleOccurrence({
      schedule: { preset: "weekly", weekday: "monday", hour: 23, minute: 0, timeZone: LONDON },
      staggerKey: "id",
      after: Date.parse("2026-06-08T06:00:00Z"),
    });
    expect(wallClock(at, LONDON)).toBe("2026-06-08 23:00");
  });
});

describe("daylight saving is the zone's problem", () => {
  it("keeps the stored wall time across a spring-forward transition", () => {
    // London jumps 01:00 → 02:00 on 2026-03-29.
    const schedule = { preset: "daily", hour: 9, minute: 30, timeZone: LONDON } as const;
    const before = nextScheduleOccurrence({
      schedule,
      staggerKey: "id",
      after: Date.parse("2026-03-28T00:00:00Z"),
    });
    const after = nextScheduleOccurrence({ schedule, staggerKey: "id", after: before });
    expect(wallClock(before, LONDON)).toBe("2026-03-28 09:30");
    expect(wallClock(after, LONDON)).toBe("2026-03-29 09:30");
    // The wall time held, so the real gap between them is 23 hours, not 24.
    expect(after - before).toBe(23 * 3_600_000);
  });

  it("keeps the stored wall time across a fall-back transition", () => {
    // London falls back 02:00 → 01:00 on 2026-10-25.
    const schedule = { preset: "daily", hour: 9, minute: 30, timeZone: LONDON } as const;
    const before = nextScheduleOccurrence({
      schedule,
      staggerKey: "id",
      after: Date.parse("2026-10-24T00:00:00Z"),
    });
    const after = nextScheduleOccurrence({ schedule, staggerKey: "id", after: before });
    expect(wallClock(before, LONDON)).toBe("2026-10-24 09:30");
    expect(wallClock(after, LONDON)).toBe("2026-10-25 09:30");
    expect(after - before).toBe(25 * 3_600_000);
  });

  it("runs late rather than early for a time the spring-forward gap deletes", () => {
    // 01:30 never happens on 2026-03-29 in London. The occurrence lands after
    // the gap — late is the contract's allowed direction.
    const schedule = { preset: "daily", hour: 1, minute: 30, timeZone: LONDON } as const;
    const at = nextScheduleOccurrence({
      schedule,
      staggerKey: "id",
      after: Date.parse("2026-03-28T12:00:00Z"),
    });
    expect(at).toBeGreaterThan(Date.parse("2026-03-29T01:00:00Z"));
    expect(wallClock(at, LONDON)).toBe("2026-03-29 02:30");
  });

  it("fires once, at the later reading, for a time the fall-back repeats", () => {
    // 01:30 happens twice on 2026-10-25 in London: once at 00:30 UTC (BST) and
    // again at 01:30 UTC (GMT). The LATER one is the occurrence — an ambiguous
    // wall time is settled in the contract's own direction — and the repeated
    // hour still yields exactly one, with the next a whole day later.
    const schedule = { preset: "daily", hour: 1, minute: 30, timeZone: LONDON } as const;
    const at = nextScheduleOccurrence({
      schedule,
      staggerKey: "id",
      after: Date.parse("2026-10-24T12:00:00Z"),
    });
    expect(at).toBe(Date.parse("2026-10-25T01:30:00Z"));
    expect(wallClock(at, LONDON)).toBe("2026-10-25 01:30");
    const following = nextScheduleOccurrence({ schedule, staggerKey: "id", after: at });
    expect(wallClock(following, LONDON)).toBe("2026-10-26 01:30");
  });

  it("runs late rather than early for a gap time in a zone WEST of UTC", () => {
    // The bug this case exists for: New York jumps 02:00 → 03:00 EDT on
    // 2026-03-08, so 02:30 never happens. Guessing an offset and correcting
    // once answered 06:30Z — 01:30 EST, a full hour BEFORE the authored wall
    // time and before the transition itself. The contract has one direction,
    // and it is not that one.
    const schedule = { preset: "daily", hour: 2, minute: 30, timeZone: NEW_YORK } as const;
    const at = nextScheduleOccurrence({
      schedule,
      staggerKey: "id",
      after: Date.parse("2026-03-07T12:00:00Z"),
    });
    expect(at).toBe(Date.parse("2026-03-08T07:30:00Z"));
    expect(wallClock(at, NEW_YORK)).toBe("2026-03-08 03:30");
    // Said as the rule rather than as a constant: whatever instant 02:30 EST
    // would have been, the occurrence is not before it.
    expect(at).toBeGreaterThanOrEqual(Date.parse("2026-03-08T07:30:00Z"));
    // And the day after is the ordinary 02:30 again — one deleted morning
    // does not move the schedule.
    const following = nextScheduleOccurrence({ schedule, staggerKey: "id", after: at });
    expect(wallClock(following, NEW_YORK)).toBe("2026-03-09 02:30");
  });

  it("fires once, at the later reading, for a fold time in a zone WEST of UTC", () => {
    // New York repeats 01:00–01:59 on 2026-11-01: 01:30 happens at 05:30Z
    // (EDT) and again at 06:30Z (EST). London already asserted the later
    // reading wins; before the fix New York quietly chose the earlier one, so
    // the same stored schedule had two different meanings by hemisphere.
    const schedule = { preset: "daily", hour: 1, minute: 30, timeZone: NEW_YORK } as const;
    const at = nextScheduleOccurrence({
      schedule,
      staggerKey: "id",
      after: Date.parse("2026-10-31T12:00:00Z"),
    });
    expect(at).toBe(Date.parse("2026-11-01T06:30:00Z"));
    expect(wallClock(at, NEW_YORK)).toBe("2026-11-01 01:30");
    const following = nextScheduleOccurrence({ schedule, staggerKey: "id", after: at });
    expect(wallClock(following, NEW_YORK)).toBe("2026-11-02 01:30");
  });

  it("never lands before the authored wall time, on either side of any transition", () => {
    // The contract as a property rather than as four examples. Every minute of
    // every 2026 transition in four zones — two east of UTC, two west, one of
    // them on a 30-minute shift — asked at one-minute resolution across the
    // transition day: the occurrence's own wall reading is never EARLIER than
    // the time that was authored.
    const zones: [string, string][] = [
      [LONDON, "2026-03-29"],
      [LONDON, "2026-10-25"],
      [NEW_YORK, "2026-03-08"],
      [NEW_YORK, "2026-11-01"],
      ["Australia/Lord_Howe", "2026-10-04"],
      ["Pacific/Auckland", "2026-09-27"],
    ];
    for (const [timeZone, day] of zones) {
      const start = Date.parse(`${day}T00:00:00Z`) - 12 * 3_600_000;
      for (let hour = 0; hour < 24; hour += 1) {
        for (const minute of [0, 15, 30, 45]) {
          const schedule = { preset: "daily", hour, minute, timeZone } as const;
          const at = nextScheduleOccurrence({ schedule, staggerKey: "id", after: start });
          const authored = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
          const landed = wallClock(at, timeZone).slice(11);
          // A gap time lands later in the day than it was written; nothing
          // ever lands earlier, which is the whole contract.
          expect(landed >= authored, `${timeZone} ${authored} landed at ${landed}`).toBe(true);
        }
      }
    }
  });

  it("crosses a US transition on the US zone's own date, not Europe's", () => {
    // New York springs forward on 2026-03-08, three weeks before London.
    const schedule = { preset: "daily", hour: 9, minute: 0, timeZone: NEW_YORK } as const;
    const before = nextScheduleOccurrence({
      schedule,
      staggerKey: "id",
      after: Date.parse("2026-03-07T00:00:00Z"),
    });
    const after = nextScheduleOccurrence({ schedule, staggerKey: "id", after: before });
    expect(after - before).toBe(23 * 3_600_000);
    expect(wallClock(after, NEW_YORK)).toBe("2026-03-08 09:00");
  });

  it("keeps an hourly schedule hourly through a transition", () => {
    const schedule = { preset: "hourly", minute: 30, timeZone: LONDON } as const;
    let cursor = Date.parse("2026-03-28T23:00:00Z");
    for (let step = 0; step < 6; step += 1) {
      const next = nextScheduleOccurrence({ schedule, staggerKey: "id", after: cursor });
      expect(next - cursor).toBeLessThanOrEqual(2 * 3_600_000);
      cursor = next;
    }
  });
});

describe("the stored zone wins over the host", () => {
  it("reads the stored zone and nothing else, at either end of the day line", () => {
    // Travelling never moves a schedule (VC-112). This module names no host
    // clock at all — there is no `TZ` to consult here, by construction — so
    // what is asserted is the consequence: two zones nineteen hours apart each
    // land on THEIR OWN 21:30, and neither is dragged toward the other or
    // toward whatever machine happens to be running the test.
    //
    // The travelling laptop itself is proved one layer up, where a host clock
    // exists to move: `main/automations/scheduler.test.ts`.
    const after = Date.parse("2026-06-01T00:00:00Z");
    for (const timeZone of ["Pacific/Kiritimati", "Pacific/Niue", LONDON, NEW_YORK]) {
      const at = nextScheduleOccurrence({
        schedule: daily({ timeZone }),
        staggerKey: "id",
        after,
      });
      expect(wallClock(at, timeZone).slice(-5)).toBe("21:30");
      expect(at).toBeGreaterThan(after);
    }
  });

  it("gives two zones two different instants for the same wall time", () => {
    // Each schedule reads 21:30 on its OWN clock, which is a different instant
    // and — here — even a different calendar day: 2026-06-01T00:00Z is still
    // 31 May in New York, so its next 21:30 comes first.
    const after = Date.parse("2026-06-01T00:00:00Z");
    const london = nextScheduleOccurrence({ schedule: daily(), staggerKey: "id", after });
    const newYork = nextScheduleOccurrence({
      schedule: daily({ timeZone: NEW_YORK }),
      staggerKey: "id",
      after,
    });
    expect(wallClock(london, LONDON)).toBe("2026-06-01 21:30");
    expect(wallClock(newYork, NEW_YORK)).toBe("2026-05-31 21:30");
    expect(newYork).not.toBe(london);
    // The next New York occurrence after that one is a day later on its clock.
    const nextNewYork = nextScheduleOccurrence({
      schedule: daily({ timeZone: NEW_YORK }),
      staggerKey: "id",
      after: newYork,
    });
    expect(wallClock(nextNewYork, NEW_YORK)).toBe("2026-06-01 21:30");
    expect(nextNewYork - london).toBe(5 * 3_600_000);
  });
});

describe("the stagger", () => {
  it("pushes a top-of-hour schedule back by under five minutes", () => {
    const schedule = { preset: "daily", hour: 9, minute: 0, timeZone: LONDON } as const;
    const stagger = scheduleStaggerMs(schedule, "automation-a");
    expect(stagger).toBeGreaterThanOrEqual(0);
    expect(stagger).toBeLessThan(AUTOMATION_SCHEDULE_STAGGER_MS);
    const at = nextScheduleOccurrence({
      schedule,
      staggerKey: "automation-a",
      after: Date.parse("2026-06-01T00:00:00Z"),
    });
    expect(at).toBe(Date.parse("2026-06-01T08:00:00Z") + stagger);
  });

  it("leaves a schedule that already staggered itself alone", () => {
    expect(scheduleStaggerMs(daily(), "automation-a")).toBe(0);
    expect(scheduleStaggerMs({ preset: "hourly", minute: 1, timeZone: LONDON }, "x")).toBe(0);
  });

  it("never wanders: the same schedule and key give the same offset every time", () => {
    const schedule = { preset: "hourly", minute: 0, timeZone: LONDON } as const;
    const first = nextScheduleOccurrence({
      schedule,
      staggerKey: "automation-a",
      after: Date.parse("2026-06-01T00:00:00Z"),
    });
    const second = nextScheduleOccurrence({ schedule, staggerKey: "automation-a", after: first });
    const third = nextScheduleOccurrence({ schedule, staggerKey: "automation-a", after: second });
    // Every occurrence carries the identical offset, so the gap is exactly an
    // hour — a schedule that re-rolled its stagger would drift within it.
    expect(second - first).toBe(3_600_000);
    expect(third - second).toBe(3_600_000);
    expect(first % 3_600_000).toBe(scheduleStaggerMs(schedule, "automation-a"));
  });

  it("does not wake two Automations together", () => {
    const schedule = { preset: "daily", hour: 9, minute: 0, timeZone: LONDON } as const;
    const offsets = new Set(
      ["a1b2", "c3d4", "e5f6", "0781", "9abc"].map((key) => scheduleStaggerMs(schedule, key)),
    );
    expect(offsets.size).toBeGreaterThan(1);
  });

  it("is always a delay, never a head start", () => {
    for (const key of ["a", "bb", "ccc", "dddd", "eeeee", ""]) {
      expect(
        scheduleStaggerMs({ preset: "hourly", minute: 0, timeZone: LONDON }, key),
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
