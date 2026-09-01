/**
 * The timer's own rules (VC-130). Which instant comes next, and what a host
 * owes a schedule at this moment, both belong to `@volli/shared`'s pure policy
 * and are tested exhaustively there (`automation-schedule{,-pass}.test.ts`).
 * What is tested here is everything that needs a running process: that the
 * steps the policy returns are actually performed, that the cursor moves only
 * after a step settled, that a refusal is recorded, that this host's start time
 * reaches the policy, and that the timer keeps looking — including after a pass
 * that failed whole.
 *
 * The ports are fakes rather than a database, on purpose: this module is a
 * thin caller, so a test that had to open SQLite to ask "did it fire early"
 * would be testing the composition instead of the rule.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";
import { nextScheduleOccurrence, type Automation, type AutomationSchedule } from "@volli/shared";

import type { AutomationSkipIntent } from "./engine";
import {
  AUTOMATION_SCHEDULE_LATE_GRACE_MS,
  AUTOMATION_SCHEDULE_TICK_MS,
  createAutomationScheduler,
  schedulableAutomations,
  scheduleRunCommandId,
  scheduleSkipCommandId,
  type AutomationSchedulerPorts,
  type ScheduledRunOutcome,
} from "./scheduler";
import type { ScheduleCursors } from "./schedule-cursor";

const LONDON = "Europe/London";
/** 21:30 every day, off the hour so nothing in these cases is staggered. */
const NIGHTLY: AutomationSchedule = { preset: "daily", hour: 21, minute: 30, timeZone: LONDON };

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "a1",
    projectId: "p1",
    name: "Nightly sweep",
    instructions: "/sweep",
    trigger: { kind: "schedule", schedule: NIGHTLY },
    runtime: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** The instant a schedule is next due after `after` — the policy's own answer. */
function due(after: number, schedule: AutomationSchedule = NIGHTLY, key = "a1"): number {
  return nextScheduleOccurrence({ schedule, staggerKey: key, after });
}

interface Harness {
  ports: AutomationSchedulerPorts;
  scheduler: ReturnType<typeof createAutomationScheduler>;
  runs: { commandId: string; automationId: string; projectId: string }[];
  skips: { commandId: string; skip: AutomationSkipIntent }[];
  cursors: ScheduleCursors;
  logs: string[];
  /** Every delay the timer was armed with, newest last. */
  delays: number[];
  setNow(at: number): void;
  setEnabled(automationIds: readonly string[]): void;
  /** Starts a lifecycle now exactly as an enable or schedule edit does. */
  rebaseCursor(automationId: string): void;
  /** Runs whatever the timer is waiting for, as if the delay elapsed. */
  fire(): Promise<void>;
}

function harness(options: {
  now: number;
  automations?: readonly Automation[];
  enabled?: readonly string[];
  cursors?: ScheduleCursors;
  runOutcome?: (input: { automationId: string }) => ScheduledRunOutcome;
  listAutomations?: () => Promise<readonly Automation[]>;
}): Harness {
  let now = options.now;
  let enabled = [...(options.enabled ?? ["a1"])];
  const cursors: ScheduleCursors = { ...options.cursors };
  const runs: Harness["runs"] = [];
  const skips: Harness["skips"] = [];
  const logs: string[] = [];
  const delays: number[] = [];
  let pending: (() => void) | null = null;

  const ports: AutomationSchedulerPorts = {
    now: () => now,
    listAutomations:
      options.listAutomations ?? (() => Promise.resolve(options.automations ?? [automation()])),
    enabledAutomationIds: () => Promise.resolve([...enabled]),
    readCursors: () => Promise.resolve({ ...cursors }),
    advanceCursor: (input) => {
      const current = cursors[input.automationId];
      if (current === undefined || current < input.through)
        cursors[input.automationId] = input.through;
      return Promise.resolve();
    },
    recordSkip: (input) => {
      skips.push(input);
      return Promise.resolve();
    },
    startRun: (input) => {
      runs.push(input);
      return Promise.resolve(options.runOutcome?.(input) ?? { ok: true });
    },
    setTimer: (delayMs, fireTimer) => {
      delays.push(delayMs);
      pending = fireTimer;
      return 0 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {
      pending = null;
    },
    log: (message) => logs.push(message),
  };

  const scheduler = createAutomationScheduler(ports);
  return {
    ports,
    scheduler,
    runs,
    skips,
    cursors,
    logs,
    delays,
    setNow: (at) => {
      now = at;
    },
    setEnabled: (automationIds) => {
      enabled = [...automationIds];
    },
    rebaseCursor: (automationId) => {
      cursors[automationId] = now;
    },
    fire: async () => {
      const fireTimer = pending;
      pending = null;
      fireTimer?.();
      await scheduler.settled();
    },
  };
}

describe("schedulableAutomations", () => {
  it("takes only the scheduled, switched-on, project-owned records", () => {
    const scheduled = automation({ id: "a1" });
    const manual = automation({ id: "a2", trigger: { kind: "none" } });
    const columns = automation({ id: "a3", trigger: { kind: "columns", columns: ["doing"] } });
    const off = automation({ id: "a4" });
    // A global record carrying a schedule cannot say which project it means.
    // The editor and main's write both refuse the combination; this is the
    // third door, for a row an older build could have written.
    const global = automation({ id: "a5", projectId: null });
    const all = [scheduled, manual, columns, off, global];
    expect(schedulableAutomations(all, ["a1", "a2", "a3", "a5"])).toEqual([
      { id: "a1", name: "Nightly sweep", projectId: "p1", schedule: NIGHTLY },
    ]);
  });

  it("fires nothing on a machine where nothing was switched on", () => {
    expect(schedulableAutomations([automation()], [])).toEqual([]);
  });
});

describe("the command ids", () => {
  it("are content hashes, pinned because the derivation is durable", () => {
    // docs/BOUNDARIES.md rule 1 allows a UUID, a content hash, or a string
    // scoped by a session/attachment UUID. These are the second form, and the
    // exact strings are pinned here because they are `automation_commands.id`:
    // changing the algorithm, the prefix or the field order would not error, it
    // would silently make every occurrence a new command and let a relaunch
    // record the same missed evening twice.
    expect(scheduleRunCommandId("a1", 1000)).toBe(
      `sha256:${createHash("sha256").update("volli:automation-schedule:run:a1:1000").digest("hex")}`,
    );
    expect(scheduleSkipCommandId("a1", 1000)).toBe(
      `sha256:${createHash("sha256").update("volli:automation-schedule:skip:a1:1000").digest("hex")}`,
    );
  });

  it("name one occurrence each, so the same one cannot be recorded or run twice", () => {
    // Same occurrence, same id — across processes, which is what makes a crash
    // mid-record idempotent rather than duplicating.
    expect(scheduleRunCommandId("a1", 1000)).toBe(scheduleRunCommandId("a1", 1000));
    expect(scheduleRunCommandId("a1", 1000)).not.toBe(scheduleRunCommandId("a1", 2000));
    expect(scheduleRunCommandId("a1", 1000)).not.toBe(scheduleRunCommandId("a2", 1000));
    // And a Run is never the same command as the skip for the same occurrence.
    expect(scheduleRunCommandId("a1", 1000)).not.toBe(scheduleSkipCommandId("a1", 1000));
  });
});

describe("first sight", () => {
  it("starts the clock now and owes nothing for the past", () => {
    // The non-retroactive rule: a schedule created (or switched on) today is
    // not owed every evening since the epoch, exactly as arming a column
    // governs arrivals rather than the Tickets already sitting in it.
    const now = Date.parse("2026-06-10T12:00:00Z");
    const h = harness({ now });
    return h.scheduler.start().then(() => {
      expect(h.runs).toEqual([]);
      expect(h.skips).toEqual([]);
      expect(h.cursors["a1"]).toBe(now);
    });
  });
});

describe("never early", () => {
  it("does not run an occurrence the clock has not reached", async () => {
    const now = Date.parse("2026-06-10T12:00:00Z");
    const h = harness({ now, cursors: { a1: now - 1 } });
    await h.scheduler.start();
    expect(h.runs).toEqual([]);
    // Armed for the remaining wait, capped by the tick so a long sleep or a
    // clock jump cannot leave the timer stranded.
    expect(h.delays.at(-1)).toBe(AUTOMATION_SCHEDULE_TICK_MS);
  });

  it("waits exactly the remaining time when the occurrence is inside one tick", async () => {
    const nextDue = due(Date.parse("2026-06-10T12:00:00Z"));
    const now = nextDue - 20_000;
    const h = harness({ now, cursors: { a1: now - 1 } });
    await h.scheduler.start();
    expect(h.delays.at(-1)).toBe(20_000);
    expect(h.runs).toEqual([]);
  });

  it("runs it once the clock arrives, and not before", async () => {
    const nextDue = due(Date.parse("2026-06-10T12:00:00Z"));
    const h = harness({ now: nextDue - 20_000, cursors: { a1: nextDue - 20_001 } });
    await h.scheduler.start();
    expect(h.runs).toEqual([]);
    h.setNow(nextDue);
    await h.fire();
    expect(h.runs).toEqual([
      { commandId: scheduleRunCommandId("a1", nextDue), automationId: "a1", projectId: "p1" },
    ]);
  });
});

describe("reschedule, never replay", () => {
  it("records ONE Skipped occurrence for a closed app and starts no Runs", async () => {
    // Three nights missed. The rule is that none of them runs on launch — the
    // next occurrence stands and the history says what was skipped.
    const from = Date.parse("2026-06-01T00:00:00Z");
    const now = Date.parse("2026-06-04T09:00:00Z");
    const h = harness({ now, cursors: { a1: from } });
    await h.scheduler.start();

    expect(h.runs).toEqual([]);
    expect(h.skips).toHaveLength(1);
    const [recorded] = h.skips;
    expect(recorded?.skip.missedCount).toBe(3);
    expect(recorded?.skip.reason).toEqual({ kind: "app-closed" });
    expect(recorded?.skip.automationName).toBe("Nightly sweep");
    expect(recorded?.skip.projectId).toBe("p1");
    // The row names the LAST due time it covers, and the cursor moved past it.
    expect(recorded?.skip.dueAt).toBe(due(Date.parse("2026-06-03T00:00:00Z")));
    expect(h.cursors["a1"]).toBe(recorded?.skip.dueAt);
    expect(recorded?.commandId).toBe(scheduleSkipCommandId("a1", recorded?.skip.dueAt ?? 0));
  });

  it("leaves the next occurrence standing after a gap", async () => {
    const now = Date.parse("2026-06-04T09:00:00Z");
    const h = harness({ now, cursors: { a1: Date.parse("2026-06-01T00:00:00Z") } });
    await h.scheduler.start();
    // Armed for the next real occurrence, not for a backlog.
    expect(h.delays.at(-1)).toBe(AUTOMATION_SCHEDULE_TICK_MS);
    h.setNow(due(now));
    await h.fire();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.commandId).toBe(scheduleRunCommandId("a1", due(now)));
  });

  it("never hands the same occurrence out twice", async () => {
    const nextDue = due(Date.parse("2026-06-10T12:00:00Z"));
    const h = harness({ now: nextDue, cursors: { a1: nextDue - 1 } });
    await h.scheduler.start();
    expect(h.runs).toHaveLength(1);
    // A second pass at the same instant: the cursor has moved past it, so
    // there is nothing due and nothing to replay.
    await h.scheduler.refresh();
    expect(h.runs).toHaveLength(1);
  });

  it("treats a due time the machine slept through as missed, not as a very late Run", async () => {
    // The app was open the whole time; the machine was not awake. Anything
    // further behind than the grace window is a skip, because starting
    // unattended work hours late is the behaviour a person switches off.
    const nextDue = due(Date.parse("2026-06-10T12:00:00Z"));
    const h = harness({
      now: nextDue + AUTOMATION_SCHEDULE_LATE_GRACE_MS + 1,
      cursors: { a1: nextDue - 1 },
    });
    await h.scheduler.start();
    expect(h.runs).toEqual([]);
    expect(h.skips).toHaveLength(1);
    expect(h.skips[0]?.skip.dueAt).toBe(nextDue);
    expect(h.skips[0]?.skip.missedCount).toBe(1);
  });

  it("still runs an occurrence that is merely a little late", async () => {
    // A timer that fired behind on a host that was awake for the due time:
    // the grace is exactly for this, and the Run starts late.
    const start = Date.parse("2026-06-10T12:00:00Z");
    const nextDue = due(start);
    const h = harness({ now: start, cursors: { a1: nextDue - 1 } });
    await h.scheduler.start();
    expect(h.runs).toEqual([]);
    h.setNow(nextDue + AUTOMATION_SCHEDULE_LATE_GRACE_MS - 1);
    await h.fire();
    expect(h.skips).toEqual([]);
    expect(h.runs).toHaveLength(1);
  });

  it("skips rather than replays a due time that went by before this launch", async () => {
    // The relaunch case, one minute wide: Volli was closed at 21:30 and opened
    // at 21:31, inside the grace. The grace absorbs a timer that fired late,
    // never a due time nobody was there for — so this launch starts no Run and
    // records the occurrence as Skipped, with "Run now" beside it.
    const nextDue = due(Date.parse("2026-06-10T12:00:00Z"));
    const h = harness({ now: nextDue + 60_000, cursors: { a1: nextDue - 1 } });
    await h.scheduler.start();
    expect(h.runs).toEqual([]);
    expect(h.skips).toHaveLength(1);
    expect(h.skips[0]?.skip).toMatchObject({
      dueAt: nextDue,
      missedCount: 1,
      reason: { kind: "app-closed" },
    });
    // And the cursor stands past it, so the next launch does not meet it again.
    expect(h.cursors["a1"]).toBe(nextDue);
  });
});

describe("a skip says something true", () => {
  it("says the app was closed for a gap this process was not there for", async () => {
    // The launch sweep: the scheduler stamps when it started watching, and
    // every due time older than that provably had nobody to start it.
    const now = Date.parse("2026-06-04T09:00:00Z");
    const h = harness({ now, cursors: { a1: Date.parse("2026-06-01T00:00:00Z") } });
    await h.scheduler.start();
    expect(h.skips[0]?.skip.reason).toEqual({ kind: "app-closed" });
  });

  it("says it was not observed when the app was open the whole time", async () => {
    // Same shape, different truth: this process was already watching when the
    // due time went by, so "Volli wasn't running" would be a false sentence in
    // the Run history. The machine slept, or the loop stalled — either way what
    // is recorded is that nobody saw it, not a cause we cannot know.
    const start = Date.parse("2026-06-10T12:00:00Z");
    const nextDue = due(start);
    const h = harness({ now: start, cursors: { a1: start - 1 } });
    await h.scheduler.start();
    expect(h.skips).toEqual([]);
    // The machine wakes two hours after the occurrence it slept through.
    h.setNow(nextDue + 2 * 3_600_000);
    await h.fire();
    expect(h.runs).toEqual([]);
    expect(h.skips).toHaveLength(1);
    expect(h.skips[0]?.skip.dueAt).toBe(nextDue);
    expect(h.skips[0]?.skip.reason).toEqual({ kind: "not-observed" });
  });

  it("leaves the occurrence owed when its skip could not be recorded", async () => {
    // The cursor is what says "this host is past that due time". Moving it over
    // a skip that never reached the ledger would turn a skip into a silence,
    // which is the one outcome VC-112 forbids — so the step fails, the cursor
    // stays, and the next pass records it again under the same derived id.
    const now = Date.parse("2026-06-04T09:00:00Z");
    const cursor = Date.parse("2026-06-01T00:00:00Z");
    const h = harness({ now, cursors: { a1: cursor } });
    h.ports.recordSkip = () => Promise.reject(new Error("database is locked"));
    await h.scheduler.start();
    expect(h.cursors["a1"]).toBe(cursor);
    expect(h.runs).toEqual([]);
    expect(h.logs.some((line) => line.includes("database is locked"))).toBe(true);
    // And the retry works: the same pass, with a ledger that answers.
    h.ports.recordSkip = (input) => {
      h.skips.push(input);
      return Promise.resolve();
    };
    await h.scheduler.refresh();
    expect(h.skips).toHaveLength(1);
    expect(h.cursors["a1"]).toBe(h.skips[0]?.skip.dueAt);
  });
});

describe("a skip and a silence never look the same", () => {
  it("records the refusal when the Run door says no", async () => {
    const nextDue = due(Date.parse("2026-06-10T12:00:00Z"));
    const h = harness({
      now: nextDue,
      cursors: { a1: nextDue - 1 },
      runOutcome: () => ({ ok: false, code: "MODEL_REQUIRED", error: "Choose a default model." }),
    });
    await h.scheduler.start();
    expect(h.runs).toHaveLength(1);
    expect(h.skips).toHaveLength(1);
    expect(h.skips[0]?.skip.reason).toEqual({
      kind: "run-refused",
      code: "MODEL_REQUIRED",
      error: "Choose a default model.",
    });
    // And the occurrence is still consumed: a refused Run is not retried on a
    // loop, it is recorded and the next occurrence stands.
    expect(h.cursors["a1"]).toBe(nextDue);
  });
});

describe("travelling never moves a schedule", () => {
  it("is due at the same instants whatever this machine's clock is set to", async () => {
    // The claim VC-112 makes about a person on a plane, tested where a host
    // clock actually exists. The pure policy names no host zone (see
    // `packages/shared/src/automation-schedule.test.ts`); what this adds is
    // that the SCHEDULER inherits that, so a laptop opened in another zone
    // fires the same evening it always did.
    const now = Date.parse("2026-06-10T12:00:00Z");
    const original = process.env.TZ;
    const armed: number[] = [];
    try {
      for (const zone of ["Pacific/Auckland", "America/Los_Angeles"]) {
        process.env.TZ = zone;
        const h = harness({ now, cursors: { a1: now - 1 } });
        await h.scheduler.start();
        armed.push(h.delays.at(-1) ?? -1);
        // And the occurrence itself is unmoved: run it, and the cursor lands on
        // the same instant either way.
        h.setNow(due(now));
        await h.fire();
        armed.push(h.cursors["a1"] ?? -1);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(armed[0]).toBe(armed[2]);
    expect(armed[1]).toBe(armed[3]);
    expect(armed[1]).toBe(due(now));
  });
});

describe("the pass as a whole", () => {
  it("keeps going when one schedule cannot be evaluated", async () => {
    const broken = automation({ id: "a2", name: "Broken" });
    const h = harness({
      now: Date.parse("2026-06-10T12:00:00Z"),
      automations: [automation(), broken],
      enabled: ["a1", "a2"],
    });
    const failing = h.ports.advanceCursor.bind(h.ports);
    h.ports.advanceCursor = (input) =>
      input.automationId === "a2" ? Promise.reject(new Error("disk full")) : failing(input);
    await h.scheduler.start();
    // This is the process that decides whether ANY unattended work happens, so
    // one schedule's failure must not take the others down with it.
    expect(h.cursors["a1"]).toBeDefined();
    expect(h.logs.some((line) => line.includes("disk full"))).toBe(true);
    expect(h.delays.length).toBeGreaterThan(0);
  });

  it("logs a pass that fails outright, and LOOKS AGAIN", async () => {
    // A locked database at launch used to disarm the scheduler for the life of
    // the process: no Runs, no Skipped occurrences, and nothing on screen to
    // say it had stopped watching. A pass that fails re-arms, so the fault is
    // transient rather than permanent.
    let failures = 1;
    const h = harness({
      now: Date.parse("2026-06-10T12:00:00Z"),
      listAutomations: () =>
        failures-- > 0
          ? Promise.reject(new Error("database is locked"))
          : Promise.resolve([automation()]),
    });
    await h.scheduler.start();
    expect(h.logs.some((line) => line.includes("database is locked"))).toBe(true);
    expect(h.delays.at(-1)).toBe(AUTOMATION_SCHEDULE_TICK_MS);
    // The retry tick finds a working database and the schedule is watched again.
    await h.fire();
    expect(h.cursors["a1"]).toBeDefined();
  });

  it("does not re-arm after a failed pass once it has been stopped", async () => {
    const h = harness({
      now: 0,
      listAutomations: () => Promise.reject(new Error("database is locked")),
    });
    h.scheduler.stop();
    await h.scheduler.start().then(() => h.scheduler.stop());
    await h.scheduler.refresh();
    expect(h.delays.filter((delay) => delay === AUTOMATION_SCHEDULE_TICK_MS)).toHaveLength(1);
  });

  it("arms no timer on a host with nothing scheduled", async () => {
    const h = harness({ now: 0, automations: [], enabled: [] });
    await h.scheduler.start();
    expect(h.delays).toEqual([]);
  });

  it("stops, and refuses to re-arm afterwards", async () => {
    const h = harness({ now: Date.parse("2026-06-10T12:00:00Z") });
    await h.scheduler.start();
    const armed = h.delays.length;
    h.scheduler.stop();
    await h.scheduler.refresh();
    expect(h.delays.length).toBe(armed);
  });

  it("starts a re-enabled schedule at now, not at the hours it was off", async () => {
    const hourly: AutomationSchedule = { preset: "hourly", minute: 30, timeZone: LONDON };
    const firstDue = due(Date.parse("2026-06-10T12:00:00Z"), hourly);
    const secondDue = due(firstDue, hourly);
    const beforeDue = firstDue - 60_000;
    const h = harness({
      now: beforeDue,
      automations: [automation({ trigger: { kind: "schedule", schedule: hourly } })],
      cursors: { a1: beforeDue - 1 },
    });
    await h.scheduler.start();

    // The schedule is switched off before either occurrence, then both due
    // times pass while it is explicitly outside the scheduler's enabled set.
    h.setEnabled([]);
    await h.scheduler.refresh();
    const reenabledAt = secondDue + 60_000;
    h.setNow(reenabledAt);

    // With the stale cursor, the first occurrence would be recorded as a skip
    // and the second replayed inside grace. Enabling starts a new lifecycle at
    // its command time before refreshing, so the disabled gap is not owed.
    h.rebaseCursor("a1");
    h.setEnabled(["a1"]);
    await h.scheduler.refresh();

    expect(h.runs).toEqual([]);
    expect(h.skips).toEqual([]);
    expect(h.cursors["a1"]).toBe(reenabledAt);
  });

  it("re-reads when a record or a switch changes", async () => {
    const h = harness({ now: Date.parse("2026-06-10T12:00:00Z") });
    await h.scheduler.start();
    const armed = h.delays.length;
    await h.scheduler.refresh();
    expect(h.delays.length).toBeGreaterThan(armed);
  });

  it("arms for the EARLIEST of several schedules", async () => {
    const now = Date.parse("2026-06-10T12:00:00Z");
    const hourly: AutomationSchedule = { preset: "hourly", minute: 30, timeZone: LONDON };
    const h = harness({
      now,
      automations: [
        automation(),
        automation({ id: "a2", trigger: { kind: "schedule", schedule: hourly } }),
      ],
      enabled: ["a1", "a2"],
      cursors: { a1: now - 1, a2: now - 1 },
    });
    await h.scheduler.start();
    const soonest = Math.min(due(now), due(now, hourly, "a2"));
    expect(h.delays.at(-1)).toBe(Math.min(soonest - now, AUTOMATION_SCHEDULE_TICK_MS));
  });
});
