/**
 * The schedule timer (VC-112, VC-130) — the first timer infrastructure in this
 * main process, and deliberately the thinnest thing that could deserve the
 * name.
 *
 * **It decides nothing.** Which instant comes next is `@volli/shared`'s
 * `nextScheduleOccurrence`; what a host owes a schedule at this moment — what
 * it missed, why, whether it may run now, and where its cursor lands — is
 * `evaluateSchedulePass`, beside it and equally pure. This module owns only
 * what a pure function cannot: a clock, a `setTimeout`, the host-local memory
 * of how far it has already looked, and the doors it performs the returned
 * steps against. That split is the ticket's ruled architecture — every hard
 * rule (never early, reschedule rather than replay, one skip per gap, a
 * truthful reason, the stagger, the stored zone winning) is a table test over
 * there rather than a sleep over here.
 *
 * **What is genuinely this module's**, because each needs a running process:
 *
 *  1. **Being awake at all.** The tick, the arming, the re-arming after a pass
 *     that failed — a scheduler that stops looking is the silence VC-112
 *     forbids, and only something with a timer can guarantee the next look.
 *  2. **Performing the steps.** Recording a skip through the durable command
 *     ledger, asking the Run door, moving the cursor. Each step carries the
 *     cursor position it earns, so a crash between two steps repeats at most
 *     one of them — and the command ids below make that repeat idempotent.
 *  3. **A refusal that is not a silence.** Only the caller of the Run door
 *     learns it said no, so recording that refusal as a Skipped occurrence is
 *     the host's job rather than the policy's.
 *  4. **When this host started watching.** `watchingSince` is what lets the
 *     pure policy say "Volli wasn't running" only when that is true.
 *
 * What it fires is a Run whose Target is the PROJECT (VC-112: a schedule
 * Trigger names the Project), so a schedule opens a Project Session.
 */
import { createHash } from "node:crypto";

import {
  automationTriggerSchedule,
  evaluateSchedulePass,
  type Automation,
  type AutomationSchedule,
  type SchedulePassStep,
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
 * process that took a moment to boot — all inside, and exactly this late still
 * runs. A closed app, a slept laptop, a machine off for the weekend — all
 * outside, and all recorded as Skipped occurrences instead, because starting
 * unattended work hours after anyone expected it is how a person learns to
 * switch the feature off.
 *
 * The window says only WHETHER an occurrence still runs. What the resulting
 * skip then claims about the world is a separate question the policy answers
 * from `watchingSince`: an occurrence older than this process says the app was
 * closed, and one this running process simply failed to reach says that
 * instead.
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
 * A CONTENT HASH — docs/BOUNDARIES.md standing rule 1's second form. The rule's
 * third form is a string scoped by a session/attachment UUID and an Automation
 * id is not one, so the deterministic identity this needs is spelled the way
 * the rule actually allows rather than by widening the rule.
 *
 * Deterministic is the whole requirement: the occurrence's due time makes "this
 * occurrence" a stable identity across processes, so a crash and a relaunch
 * name the same command instead of recording the same missed evening twice or
 * starting a second Run for an occurrence that already has one.
 *
 * **The derivation is FROZEN** (CLAUDE.md): these strings are durable ledger
 * ids, so changing the algorithm, the prefix, the separator or the field order
 * would not error — it would silently make every occurrence a new command and
 * undo the idempotency above. The hashed material names its purpose so no other
 * derivation in the app can ever collide with it.
 */
function scheduleCommandId(kind: "run" | "skip", automationId: string, dueAt: number): string {
  const material = `volli:automation-schedule:${kind}:${automationId}:${dueAt}`;
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

export function scheduleRunCommandId(automationId: string, dueAt: number): string {
  return scheduleCommandId("run", automationId, dueAt);
}

export function scheduleSkipCommandId(automationId: string, dueAt: number): string {
  return scheduleCommandId("skip", automationId, dueAt);
}

export function createAutomationScheduler(ports: AutomationSchedulerPorts): AutomationScheduler {
  const log = ports.log ?? ((message: string) => console.error(message));
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  /**
   * When this host started watching — stamped at construction and re-stamped by
   * every `start()`, because a scheduler that was stopped in between was not
   * watching either.
   *
   * It exists to keep one sentence honest. "Volli wasn't running" is a claim
   * about this process, so the policy is told when the process began rather
   * than left to assume that everything late happened while the app was shut.
   */
  let watchingSince = ports.now();
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
   * Performs one step the policy returned, then moves the cursor to where that
   * step earned.
   *
   * The cursor advance is LAST and inside the same call on purpose: a step
   * whose write threw leaves the cursor where it was, so the next pass owes the
   * same occurrence again rather than stepping silently over a skip that never
   * reached the ledger. Repeating it is safe — the command id is derived from
   * the occurrence, so the ledger collapses the retry.
   */
  async function perform(automation: ScheduledAutomation, step: SchedulePassStep): Promise<void> {
    const identity = {
      automationId: automation.id,
      automationName: automation.name,
      projectId: automation.projectId,
    };
    if (step.kind === "skip") {
      await ports.recordSkip({
        commandId: scheduleSkipCommandId(automation.id, step.dueAt),
        skip: {
          ...identity,
          dueAt: step.dueAt,
          missedCount: step.missedCount,
          reason: step.reason,
        },
      });
    } else if (step.kind === "run") {
      const outcome = await ports.startRun({
        commandId: scheduleRunCommandId(automation.id, step.dueAt),
        automationId: automation.id,
        projectId: automation.projectId,
      });
      if (!outcome.ok) {
        // A refusal is not a silence. The scheduler was awake and asked; the
        // door said no, and the person finds out from the same Run history
        // that shows a closed-app skip, with the same "Run now" beside it.
        // Only the caller of the door can know this, which is why it is the
        // one skip reason the policy does not decide.
        await ports.recordSkip({
          commandId: scheduleSkipCommandId(automation.id, step.dueAt),
          skip: {
            ...identity,
            dueAt: step.dueAt,
            missedCount: 1,
            reason: { kind: "run-refused", code: outcome.code, error: outcome.error },
          },
        });
      }
    }
    await ports.advanceCursor({ automationId: automation.id, through: step.through });
  }

  /**
   * One schedule's whole pass: ask the policy what is owed, do it, and answer
   * when this schedule is next due so the caller can arm for the earliest.
   */
  async function evaluate(
    automation: ScheduledAutomation,
    cursors: ScheduleCursors,
    now: number,
  ): Promise<number> {
    const owed = evaluateSchedulePass({
      schedule: automation.schedule,
      staggerKey: automation.id,
      cursor: cursors[automation.id] ?? null,
      now,
      watchingSince,
      graceMs: AUTOMATION_SCHEDULE_LATE_GRACE_MS,
      missedLimit: AUTOMATION_SCHEDULE_MISSED_LIMIT,
    });
    for (const step of owed.steps) await perform(automation, step);
    return owed.nextDueAt;
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
        // AND LOOK AGAIN. A pass can fail whole — a locked database at launch,
        // an unreadable projection — and a scheduler that only logged that
        // would stay disarmed for as long as the app stays open: no Runs, no
        // Skipped occurrences, nothing in the history to show it had stopped.
        // That is precisely the silence VC-112 forbids, so a failed pass
        // re-arms and the next tick retries it. `arm` still refuses once
        // stopped, so quitting is not a retry loop.
        arm(AUTOMATION_SCHEDULE_TICK_MS);
      });
    return pass;
  }

  return {
    async start() {
      stopped = false;
      watchingSince = ports.now();
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
