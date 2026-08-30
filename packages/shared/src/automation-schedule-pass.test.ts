/**
 * The durability rules of VC-130, as a table.
 *
 * Every claim here used to be reachable only through the Electron timer's
 * ports — a fake clock, a fake ledger, a fake `setTimeout` — which is what the
 * ticket's amendment ruled against: "reschedule and never replay, never start
 * early, stagger, and let the stored zone win" are statements about arithmetic,
 * and arithmetic is tested as arithmetic.
 */
import { describe, expect, it } from "vite-plus/test";

import { evaluateSchedulePass, type SchedulePassInput } from "./automation-schedule-pass";
import { nextScheduleOccurrence, type AutomationSchedule } from "./automation-schedule";

const LONDON = "Europe/London";
/** 21:30 nightly — off the hour, so nothing here is staggered unless it asks. */
const NIGHTLY: AutomationSchedule = { preset: "daily", hour: 21, minute: 30, timeZone: LONDON };
const GRACE = 2 * 60_000;

function pass(overrides: Partial<SchedulePassInput> & { now: number }) {
  return evaluateSchedulePass({
    schedule: NIGHTLY,
    staggerKey: "a1",
    cursor: null,
    // The ordinary case unless a case says otherwise: this pass is the launch
    // sweep, so anything already behind went by while the app was closed.
    watchingSince: overrides.now,
    graceMs: GRACE,
    missedLimit: 10_000,
    ...overrides,
  });
}

/** The instant a schedule is next due after `after`. */
function due(after: number, schedule: AutomationSchedule = NIGHTLY): number {
  return nextScheduleOccurrence({ schedule, staggerKey: "a1", after });
}

describe("first sight", () => {
  it("starts the clock and owes nothing for the past", () => {
    // A schedule created today is not owed every evening since the epoch. The
    // same non-retroactive rule an armed column has (VC-128).
    const now = Date.parse("2026-06-10T12:00:00Z");
    const owed = pass({ now, cursor: null });
    expect(owed.steps).toEqual([{ kind: "watch", through: now }]);
    expect(owed.nextDueAt).toBe(due(now));
  });
});

describe("never early", () => {
  it("owes nothing while the clock is still short of the occurrence", () => {
    const now = Date.parse("2026-06-10T12:00:00Z");
    const owed = pass({ now, cursor: now - 1 });
    expect(owed.steps).toEqual([]);
    expect(owed.nextDueAt).toBeGreaterThan(now);
  });

  it("does not run an occurrence one millisecond early", () => {
    const at = due(Date.parse("2026-06-10T12:00:00Z"));
    expect(pass({ now: at - 1, cursor: at - 2 }).steps).toEqual([]);
  });

  it("runs it the millisecond the clock arrives", () => {
    const at = due(Date.parse("2026-06-10T12:00:00Z"));
    const owed = pass({ now: at, cursor: at - 1 });
    expect(owed.steps).toEqual([{ kind: "run", dueAt: at, through: at }]);
    // And the next look is the FOLLOWING occurrence, so performing this step
    // and sleeping until then cannot see the same one twice.
    expect(owed.nextDueAt).toBe(due(at));
  });
});

describe("the grace window", () => {
  it("still runs an occurrence exactly as late as the window allows", () => {
    // The boundary itself, stated in both directions rather than approached
    // from one side: "how late a Run may still start" includes that instant.
    const at = due(Date.parse("2026-06-10T12:00:00Z"));
    const owed = pass({ now: at + GRACE, cursor: at - 1 });
    expect(owed.steps).toEqual([{ kind: "run", dueAt: at, through: at }]);
  });

  it("skips an occurrence one millisecond past the window", () => {
    const at = due(Date.parse("2026-06-10T12:00:00Z"));
    const owed = pass({ now: at + GRACE + 1, cursor: at - 1 });
    expect(owed.steps).toEqual([
      { kind: "skip", dueAt: at, missedCount: 1, reason: { kind: "app-closed" }, through: at },
    ]);
  });
});

describe("reschedule, never replay", () => {
  it("owes ONE skip and no Runs for three nights a closed app went through", () => {
    const now = Date.parse("2026-06-04T09:00:00Z");
    const owed = pass({ now, cursor: Date.parse("2026-06-01T00:00:00Z") });
    expect(owed.steps).toEqual([
      {
        kind: "skip",
        // The row names the LAST due time it stands for, and says how many.
        dueAt: due(Date.parse("2026-06-03T00:00:00Z")),
        missedCount: 3,
        reason: { kind: "app-closed" },
        through: due(Date.parse("2026-06-03T00:00:00Z")),
      },
    ]);
    // No backlog: the next occurrence stands, and nothing fires on launch.
    expect(owed.nextDueAt).toBe(due(now));
  });

  it("never owes two Runs, at any moment of a four-day gap", () => {
    // The no-backlog rule as a property. An hourly schedule and an app closed
    // for four days is a hundred occurrences; asked at two hundred different
    // moments across them, no pass ever owes more than one Run — and every
    // pass that owes anything owes at most one skip beside it.
    const hourly: AutomationSchedule = { preset: "hourly", minute: 30, timeZone: LONDON };
    const cursor = Date.parse("2026-06-01T00:00:00Z");
    for (let step = 0; step < 200; step += 1) {
      const owed = evaluateSchedulePass({
        schedule: hourly,
        staggerKey: "a1",
        cursor,
        now: cursor + step * 1_800_000 + 37_000,
        watchingSince: cursor,
        graceMs: GRACE,
        missedLimit: 10_000,
      });
      expect(owed.steps.filter((each) => each.kind === "run").length).toBeLessThanOrEqual(1);
      expect(owed.steps.filter((each) => each.kind === "skip").length).toBeLessThanOrEqual(1);
    }
  });

  it("records the gap and still runs the occurrence the clock has reached", () => {
    // A weekend missed, and tonight already due: the skip covers what was
    // missed, the Run is tonight's, and each carries its own cursor position.
    const at = due(Date.parse("2026-06-10T12:00:00Z"));
    const owed = pass({ now: at, cursor: Date.parse("2026-06-08T00:00:00Z") });
    expect(owed.steps.map((step) => step.kind)).toEqual(["skip", "run"]);
    const [skip, run] = owed.steps;
    expect(skip).toMatchObject({ missedCount: 2 });
    expect(run).toEqual({ kind: "run", dueAt: at, through: at });
  });

  it("counts no further than its limit, and leaves the rest to the next pass", () => {
    // An hourly schedule and a machine off for years. The bound is on the
    // COUNT in one row, never on a Run: the cursor lands on the last
    // occurrence counted, so the next pass resumes from there.
    const hourly: AutomationSchedule = { preset: "hourly", minute: 30, timeZone: LONDON };
    const owed = evaluateSchedulePass({
      schedule: hourly,
      staggerKey: "a1",
      cursor: Date.parse("2020-01-01T00:00:00Z"),
      now: Date.parse("2026-06-10T12:00:00Z"),
      watchingSince: 0,
      graceMs: GRACE,
      missedLimit: 10,
    });
    expect(owed.steps).toHaveLength(1);
    expect(owed.steps[0]).toMatchObject({ kind: "skip", missedCount: 10 });
    // Still in the past, so this pass owes no Run at all — that occurrence is
    // the next pass's skip, not a very late Run now.
    expect(owed.nextDueAt).toBeLessThan(Date.parse("2026-06-10T12:00:00Z"));
  });
});

describe("a skip says something true", () => {
  it("says the app was closed only for a due time older than this process", () => {
    const at = due(Date.parse("2026-06-10T12:00:00Z"));
    const owed = pass({
      now: at + GRACE + 1,
      cursor: at - 1,
      // The process came up after the occurrence went by.
      watchingSince: at + 1,
    });
    expect(owed.steps[0]).toMatchObject({ reason: { kind: "app-closed" } });
  });

  it("says it was not observed when this process was running the whole time", () => {
    // The app was open; the machine was asleep, or too busy, or suspended.
    // "Volli wasn't running" would be false, and a history that says a false
    // thing about why work did not happen is worse than a vague true one.
    const at = due(Date.parse("2026-06-10T12:00:00Z"));
    const owed = pass({
      now: at + GRACE + 1,
      cursor: at - 1,
      watchingSince: at - 60_000,
    });
    expect(owed.steps[0]).toMatchObject({ reason: { kind: "not-observed" } });
  });
});

describe("the stored zone wins, here too", () => {
  it("owes each zone's own 21:30, from identical cursors and an identical clock", () => {
    // This module names no host clock by construction — there is no `TZ` to
    // consult here — so what is asserted is the consequence: two schedules
    // that differ only in their stored zone owe DIFFERENT due times from the
    // same inputs, each its own 21:30. The travelling laptop itself is proved
    // one layer up, where a host clock exists to move
    // (`main/automations/scheduler.test.ts`).
    const cursor = Date.parse("2026-06-01T00:00:00Z");
    const now = Date.parse("2026-06-02T12:00:00Z");
    const owedIn = (timeZone: string) =>
      evaluateSchedulePass({
        schedule: { preset: "daily", hour: 21, minute: 30, timeZone },
        staggerKey: "a1",
        cursor,
        now,
        watchingSince: now,
        graceMs: GRACE,
        missedLimit: 10_000,
      });
    const london = owedIn(LONDON);
    const newYork = owedIn("America/New_York");
    // 21:30 in London is 20:30Z; 21:30 in New York is 01:30Z the next day. The
    // same moment therefore owes each a different occurrence.
    expect(london.steps[0]).toMatchObject({ dueAt: Date.parse("2026-06-01T20:30:00Z") });
    expect(newYork.steps[0]).toMatchObject({ dueAt: Date.parse("2026-06-02T01:30:00Z") });
    expect(london.nextDueAt).not.toBe(newYork.nextDueAt);
  });
});
