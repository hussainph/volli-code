/**
 * The timer's own rules (VC-130). What time it is next due belongs to
 * `@volli/shared`'s pure policy and is tested exhaustively there; what is
 * tested here is everything that depends on being AWAKE — never early, missed
 * rather than replayed, no backlog on launch, a refusal that is not a silence,
 * and a first sight that owes nothing.
 *
 * The ports are fakes rather than a database, on purpose: this module is a
 * thin caller, so a test that had to open SQLite to ask "did it fire early"
 * would be testing the composition instead of the rule.
 */
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
    enabledAutomationIds: () => Promise.resolve(options.enabled ?? ["a1"]),
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
  it("name the occurrence, so the same one cannot be recorded or run twice", () => {
    expect(scheduleRunCommandId("a1", 1000)).toBe("a1:run:1000");
    expect(scheduleSkipCommandId("a1", 1000)).toBe("a1:skip:1000");
    expect(scheduleRunCommandId("a1", 1000)).not.toBe(scheduleRunCommandId("a1", 2000));
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
    const nextDue = due(Date.parse("2026-06-10T12:00:00Z"));
    const h = harness({
      now: nextDue + AUTOMATION_SCHEDULE_LATE_GRACE_MS - 1,
      cursors: { a1: nextDue - 1 },
    });
    await h.scheduler.start();
    expect(h.skips).toEqual([]);
    expect(h.runs).toHaveLength(1);
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

  it("logs and survives a pass that fails outright", async () => {
    const h = harness({
      now: 0,
      listAutomations: () => Promise.reject(new Error("database is locked")),
    });
    await h.scheduler.start();
    expect(h.logs.some((line) => line.includes("database is locked"))).toBe(true);
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
