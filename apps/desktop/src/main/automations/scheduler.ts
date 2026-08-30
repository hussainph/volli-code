/**
 * The schedule timer (VC-112, VC-130) — the first timer infrastructure in this
 * main process, and deliberately the thinnest thing that could deserve the
 * name.
 *
 * **It decides nothing about time.** Which instant comes next is
 * `@volli/shared`'s `nextScheduleOccurrence`, a pure function of the schedule,
 * its stored IANA zone and a current time. This module owns only what a pure
 * function cannot: a clock, a `setTimeout`, and the host-local memory of how
 * far it has already looked. That split is the ticket's ruled architecture —
 * every hard rule (never early, reschedule rather than replay, stagger, the
 * stored zone wins) is a table test over there rather than a sleep over here.
 *
 * **The three rules this module does own**, because each is about *being
 * awake* rather than about time:
 *
 *  1. **Never early.** An occurrence is fired only once `now` has reached it.
 *     There is no rounding, no "close enough": the comparison is `due <= now`.
 *  2. **Reschedule, never replay.** A due time that passed while nothing was
 *     watching is recorded as a Skipped occurrence and the cursor moves past
 *     it. No launch ever fires a backlog, however long the app was closed —
 *     one row says what was missed, and a person may start it by hand.
 *  3. **Late has a limit.** The app being open is not the same as the app
 *     having been awake: a laptop that slept through 21:00 and woke at 23:00
 *     did not observe the due time. Anything more than
 *     {@link AUTOMATION_SCHEDULE_LATE_GRACE_MS} behind is therefore a skip
 *     rather than a very late Run — which is the honest reading, and keeps an
 *     unattended Session from starting hours after anyone expected it.
 *
 * What it fires is a Run whose Target is the PROJECT (VC-112: a schedule
 * Trigger names the Project), so a schedule opens a Project Session.
 */
import {
  automationTriggerSchedule,
  missedScheduleOccurrences,
  nextScheduleOccurrence,
  type Automation,
  type AutomationSchedule,
} from "@volli/shared";

import type { AutomationSkipIntent } from "./engine";
import type { ScheduleCursors } from "./schedule-cursor";

/**
 * How long the timer sleeps at most, however far away the next occurrence is.
 *
 * A long `setTimeout` is not a promise: the process can be suspended, the
 * system clock can jump, and Node's own timers cap out around 24.8 days. So the
 * timer re-asks at least once a minute and sleeps the exact remaining time
 * whenever that is shorter — precise when it matters, self-correcting when the
 * machine has been doing something else.
 */
export const AUTOMATION_SCHEDULE_TICK_MS = 60_000;

/**
 * How late a Run may still start, in milliseconds.
 *
 * Two minutes. VC-112's contract is that a Run may start late but never early,
 * and this is where "late" stops meaning late and starts meaning missed. A
 * timer that fires a few seconds behind, a machine briefly busy at 09:00, a
 * process that took a moment to boot — all inside. A closed app, a slept
 * laptop, a machine off for the weekend — all outside, and all recorded as
 * Skipped occurrences instead, because starting unattended work hours after
 * anyone expected it is how a person learns to switch the feature off.
 */
export const AUTOMATION_SCHEDULE_LATE_GRACE_MS = 2 * 60_000;

/**
 * How many missed occurrences one pass will count.
 *
 * Only the COUNT in the skip's own sentence is bounded by this, never a Run:
 * a pass that hits the limit records what it counted, moves its cursor to the
 * last occurrence it named, and the next pass resumes from there. Ten thousand
 * covers an hourly schedule on a machine that was off for over a year.
 */
export const AUTOMATION_SCHEDULE_MISSED_LIMIT = 10_000;

/** One Automation this host may fire on a schedule. */
export interface ScheduledAutomation {
  id: string;
  name: string;
  /** Never null: a schedule Run's Target is the Project (see the filter below). */
  projectId: string;
  schedule: AutomationSchedule;
}

/** What the Run door answers the timer — the same coded refusal a person gets. */
export type ScheduledRunOutcome = { ok: true } | { ok: false; code: string; error: string };

export interface AutomationSchedulerPorts {
  now(): number;
  /** Every Automation on this machine; the filter below decides which can fire. */
  listAutomations(): Promise<readonly Automation[]>;
  /** Which Automations are switched on HERE — the machine-local projection. */
  enabledAutomationIds(): Promise<readonly string[]>;
  /** How far this host has evaluated each schedule. */
  readCursors(): Promise<ScheduleCursors>;
  /** Moves one schedule's cursor forward; never backwards. */
  advanceCursor(input: { automationId: string; through: number }): Promise<void>;
  /** Records a Skipped occurrence through the durable command ledger. */
  recordSkip(input: { commandId: string; skip: AutomationSkipIntent }): Promise<void>;
  /** Starts one Run against the Project — the same door a person's Run uses. */
  startRun(input: {
    commandId: string;
    automationId: string;
    projectId: string;
  }): Promise<ScheduledRunOutcome>;
  setTimer(delayMs: number, fire: () => void): NodeJS.Timeout;
  clearTimer(handle: NodeJS.Timeout): void;
  log?(message: string): void;
}

export interface AutomationScheduler {
  /** Evaluates once and arms the timer. Safe to call on a host with no schedules. */
  start(): Promise<void>;
  /** Re-evaluates after a record, Trigger or switch changed. */
  refresh(): Promise<void>;
  /** Disarms the timer. Work already in flight still settles. */
  stop(): void;
  /** The pass in flight, so a test (or a shutdown) can await it. */
  settled(): Promise<void>;
}

/**
 * The Automations this host may fire on a schedule right now.
 *
 * Three conditions, and each is a rule rather than a filter:
 *
 *  - **It carries a schedule.** An unreadable stored schedule already degraded
 *    to "Nothing else" in the shared parser, so it simply is not here.
 *  - **It is switched on HERE.** The machine-local enabled set governs what
 *    starts an Automation besides a person (VC-112), and a schedule is exactly
 *    that. Off is the resting state, so a machine nobody has switched anything
 *    on fires nothing — which is also why a brand-new machine owes no skips.
 *  - **It belongs to a project.** A schedule Run's Target is the Project, and a
 *    globally listed Automation names none. The editor and main's write both
 *    refuse that combination (`automationScheduleProblem`); this is the third
 *    door, because a record written by an older build could still hold one and
 *    the timer must not guess which project it meant.
 */
export function schedulableAutomations(
  automations: readonly Automation[],
  enabledAutomationIds: readonly string[],
): ScheduledAutomation[] {
  const enabled = new Set(enabledAutomationIds);
  const schedulable: ScheduledAutomation[] = [];
  for (const automation of automations) {
    const schedule = automationTriggerSchedule(automation.trigger);
    if (schedule === null) continue;
    if (!enabled.has(automation.id)) continue;
    if (automation.projectId === null) continue;
    schedulable.push({
      id: automation.id,
      name: automation.name,
      projectId: automation.projectId,
      schedule,
    });
  }
  return schedulable;
}

/**
 * The command id for one occurrence's Run, and for one gap's skip.
 *
 * DURABLE DERIVATIONS, frozen the moment they ship (CLAUDE.md): they are the
 * ledger's own idempotency keys, so changing the shape would not error — it
 * would let a crash-and-relaunch record the same missed evening twice, or start
 * a second Run for an occurrence that already has one. Scoped by the
 * Automation's own UUID, which is docs/BOUNDARIES.md standing rule 1's third
 * form; nothing machine-local appears in either.
 *
 * The occurrence's due time is the whole point of including it: it is what
 * makes "this occurrence" a stable identity across processes, so two windows,
 * a retry and a relaunch all name the same command rather than three.
 */
export function scheduleRunCommandId(automationId: string, dueAt: number): string {
  return `${automationId}:run:${dueAt}`;
}

export function scheduleSkipCommandId(automationId: string, dueAt: number): string {
  return `${automationId}:skip:${dueAt}`;
}

export function createAutomationScheduler(ports: AutomationSchedulerPorts): AutomationScheduler {
  const log = ports.log ?? ((message: string) => console.error(message));
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  /** One pass at a time, and one queued behind it — never a pile. */
  let pass: Promise<void> = Promise.resolve();

  function disarm(): void {
    if (timer === null) return;
    ports.clearTimer(timer);
    timer = null;
  }

  function arm(delayMs: number): void {
    disarm();
    if (stopped) return;
    timer = ports.setTimer(delayMs, () => {
      timer = null;
      void run();
    });
  }

  /**
   * One schedule's whole pass: what it missed, whether it is due, and when it
   * is next due. Answers the next occurrence so the caller can arm the timer
   * for the earliest of them.
   */
  async function evaluate(
    automation: ScheduledAutomation,
    cursors: ScheduleCursors,
    now: number,
  ): Promise<number> {
    const occurrence = (after: number) =>
      nextScheduleOccurrence({ schedule: automation.schedule, staggerKey: automation.id, after });

    const cursor = cursors[automation.id];
    if (cursor === undefined) {
      // First sight of this schedule on this machine — a new record, a switch
      // just turned on, or a first launch. It is not retroactive: the clock
      // starts now and the next occurrence stands, exactly as arming a column
      // governs arrivals rather than the Tickets already sitting there.
      await ports.advanceCursor({ automationId: automation.id, through: now });
      return occurrence(now);
    }

    let due = occurrence(cursor);
    // Everything older than the grace window went by unobserved. Recorded as
    // ONE Skipped occurrence naming the last of them, and never replayed.
    const staleBefore = now - AUTOMATION_SCHEDULE_LATE_GRACE_MS;
    if (due <= staleBefore) {
      const missed = missedScheduleOccurrences({
        schedule: automation.schedule,
        staggerKey: automation.id,
        after: cursor,
        through: staleBefore,
        limit: AUTOMATION_SCHEDULE_MISSED_LIMIT,
      });
      const last = missed[missed.length - 1] ?? due;
      await ports.recordSkip({
        commandId: scheduleSkipCommandId(automation.id, last),
        skip: {
          automationId: automation.id,
          automationName: automation.name,
          projectId: automation.projectId,
          dueAt: last,
          missedCount: missed.length,
          reason: { kind: "app-closed" },
        },
      });
      await ports.advanceCursor({ automationId: automation.id, through: last });
      due = occurrence(last);
    }

    // Never early: only an occurrence `now` has actually reached may run. And
    // never stale: one the grace window has already disowned is the sweep's,
    // which the next pass resumes.
    if (due <= now && due > staleBefore) {
      const outcome = await ports.startRun({
        commandId: scheduleRunCommandId(automation.id, due),
        automationId: automation.id,
        projectId: automation.projectId,
      });
      if (!outcome.ok) {
        // A refusal is not a silence. The scheduler was awake and asked; the
        // door said no, and the person finds out from the same Run history
        // that shows a closed-app skip, with the same "Run now" beside it.
        await ports.recordSkip({
          commandId: scheduleSkipCommandId(automation.id, due),
          skip: {
            automationId: automation.id,
            automationName: automation.name,
            projectId: automation.projectId,
            dueAt: due,
            missedCount: 1,
            reason: { kind: "run-refused", code: outcome.code, error: outcome.error },
          },
        });
      }
      await ports.advanceCursor({ automationId: automation.id, through: due });
      due = occurrence(due);
    }
    return due;
  }

  async function sweep(): Promise<void> {
    const [automations, enabled] = await Promise.all([
      ports.listAutomations(),
      ports.enabledAutomationIds(),
    ]);
    const schedulable = schedulableAutomations(automations, enabled);
    if (schedulable.length === 0) {
      // Nothing to watch. No timer either — a refresh follows every write that
      // could add one, so a sleeping host stays asleep.
      disarm();
      return;
    }
    const cursors = await ports.readCursors();
    const now = ports.now();
    let earliest: number | null = null;
    for (const automation of schedulable) {
      try {
        const next = await evaluate(automation, cursors, now);
        if (earliest === null || next < earliest) earliest = next;
      } catch (error) {
        // One schedule's failure must not stop the others: this is the process
        // that decides whether ANY unattended work happens, so it fails per
        // schedule rather than per host. The next pass retries it.
        log(
          `[volli] automation schedule ${automation.id} could not be evaluated: ${errorText(error)}`,
        );
      }
    }
    if (earliest === null) {
      arm(AUTOMATION_SCHEDULE_TICK_MS);
      return;
    }
    arm(Math.max(0, Math.min(earliest - ports.now(), AUTOMATION_SCHEDULE_TICK_MS)));
  }

  function run(): Promise<void> {
    // Serialized: a tick that lands while a pass is still awaiting the Run door
    // queues behind it rather than evaluating the same occurrence twice. The
    // ledger would collapse the duplicate anyway — the command id is derived
    // from the occurrence — but doing the work twice is not free.
    pass = pass
      .then(() => (stopped ? undefined : sweep()))
      .catch((error: unknown) => {
        log(`[volli] automation scheduler pass failed: ${errorText(error)}`);
      });
    return pass;
  }

  return {
    async start() {
      stopped = false;
      await run();
    },
    async refresh() {
      if (stopped) return;
      await run();
    },
    stop() {
      stopped = true;
      disarm();
    },
    settled() {
      return pass;
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
