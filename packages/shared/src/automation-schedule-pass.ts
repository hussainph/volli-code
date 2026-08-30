/**
 * What one host owes one schedule right now (VC-112, VC-130) — the durability
 * policy, as a pure function.
 *
 * `automation-schedule.ts` answers *when* a schedule is next due; this module
 * answers *what to do about it*, which is the harder half and the one every
 * hard rule in VC-130 actually lives in:
 *
 *  - **Never early.** An occurrence becomes a Run only once the clock has
 *    reached it. The comparison is `dueAt <= now`, with no rounding anywhere.
 *  - **Reschedule, never replay.** A gap of missed occurrences produces ONE
 *    skip step and no Runs, however long the app was closed. There is no input
 *    to this function that returns two Run steps.
 *  - **The cursor moves forward, once per step.** Each step carries the instant
 *    the caller's cursor should stand at after performing it, so a host that
 *    dies between two steps repeats at most the step it was in — and the
 *    command ids the caller derives from `dueAt` collapse that repeat.
 *  - **A skip says something true.** The reason is derived from `watchingSince`
 *    rather than assumed, because "Volli wasn't running" is a claim about this
 *    process and only this process can make it.
 *
 * It is a pure function for the reason the amendment on VC-130 gives: these are
 * the rules whose failure modes are unattended work starting at a time nobody
 * chose, and each of them is a table test here instead of a sleep against a
 * live timer. The Electron timer (`main/automations/scheduler.ts`) supplies a
 * clock and performs the returned steps; it decides none of them.
 *
 * Nothing here reads a clock, a host zone, a database or a process. Every
 * input arrives as an argument, which is also what lets this policy travel with
 * the record if the Automation ever moves to an account (VC-112) while the
 * timer stays local.
 */
import type { AutomationMissedReason } from "./automation";
import { nextScheduleOccurrence, type AutomationSchedule } from "./automation-schedule";

export interface SchedulePassInput {
  schedule: AutomationSchedule;
  /** The Automation's durable id — what the stagger is derived from. */
  staggerKey: string;
  /**
   * How far this host has already evaluated this schedule, or `null` when it
   * never has.
   *
   * `null` is FIRST SIGHT, and it is not retroactive: a schedule created today,
   * or switched on today, or met for the first time on a new machine, owes
   * nothing for the history it never watched. The same non-retroactive rule an
   * armed column has (VC-128), and what stops a fresh install from
   * manufacturing a backlog out of dates it was never there for.
   */
  cursor: number | null;
  /** The host's clock, in epoch milliseconds. */
  now: number;
  /**
   * When this host started watching, in epoch milliseconds.
   *
   * The one fact that makes a skip's reason honest rather than assumed. An
   * occurrence whose due time is older than this went by while this process was
   * not running — the app was closed, or crashed, or had not launched yet — and
   * that is the only case allowed to say so.
   */
  watchingSince: number;
  /**
   * How late an occurrence may still start, in milliseconds.
   *
   * The line between "the timer fired a moment behind" and "nobody was
   * watching". Exactly this late still runs; further behind is a skip, because
   * beyond the grace this process cannot claim to have observed the due time —
   * a suspended laptop and a closed app are the same blindness.
   */
  graceMs: number;
  /**
   * How many missed occurrences one pass will count.
   *
   * Bounds only the COUNT in a skip's own sentence, never a Run: a pass that
   * hits the limit records what it counted and leaves its cursor on the last
   * occurrence it named, so the next pass resumes from there.
   */
  missedLimit: number;
}

/**
 * One thing to do, and where the cursor stands once it is done.
 *
 * A step is an instruction to a host, not an event: the caller performs it —
 * recording a skip through the durable command ledger, asking the Run door —
 * and this module never learns how it went. That separation is the point. A
 * refusal from the Run door is the host's to record, because only the host
 * asked.
 */
export type SchedulePassStep =
  /**
   * Start watching, owing nothing. The only step of a first sight, and the
   * reason a new schedule cannot produce a backlog: the cursor lands on `now`
   * and the next occurrence stands.
   */
  | { kind: "watch"; through: number }
  /**
   * A gap that went by unobserved. ONE step per gap rather than one per
   * occurrence — a closed weekend owes an hourly schedule around fifty
   * otherwise, each with a "Run now" that must not be pressed fifty times —
   * naming the last due time it covers and how many it stood for.
   */
  | {
      kind: "skip";
      dueAt: number;
      missedCount: number;
      reason: AutomationMissedReason;
      through: number;
    }
  /** An occurrence the clock has reached, and is not too late to start. */
  | { kind: "run"; dueAt: number; through: number };

export interface SchedulePass {
  /**
   * What to do, in order. Empty when nothing is owed; at most one skip and one
   * Run, which is the never-replay rule as a type rather than as a comment.
   */
  steps: readonly SchedulePassStep[];
  /**
   * When this schedule is next due — after every step above, so a caller that
   * performs them and then sleeps until this instant cannot see the same
   * occurrence twice.
   */
  nextDueAt: number;
}

/**
 * Everything one host owes one schedule at `now`.
 *
 * Reading the body as the rules it encodes, in order: a schedule never seen
 * here starts its clock and owes nothing; a due time further behind than the
 * grace is a skip, however many occurrences the gap held, and is never
 * replayed; a due time the clock has reached and the grace still allows is a
 * Run; and the answer ends with the next occurrence after all of it.
 */
export function evaluateSchedulePass(input: SchedulePassInput): SchedulePass {
  const occurrence = (after: number): number =>
    nextScheduleOccurrence({
      schedule: input.schedule,
      staggerKey: input.staggerKey,
      after,
    });

  if (input.cursor === null) {
    return { steps: [{ kind: "watch", through: input.now }], nextDueAt: occurrence(input.now) };
  }

  const steps: SchedulePassStep[] = [];
  /** The earliest due time this pass is still willing to start. */
  const runnableFrom = input.now - input.graceMs;
  let due = occurrence(input.cursor);

  if (due < runnableFrom) {
    // `due` is itself the first occurrence nobody watched, so the walk starts
    // at one rather than at zero — and the count can never be the zero that
    // would put "0 occurrences" on a row that exists because one was missed.
    let last = due;
    let missedCount = 1;
    while (missedCount < input.missedLimit) {
      const next = occurrence(last);
      if (next >= runnableFrom) break;
      last = next;
      missedCount += 1;
    }
    steps.push({
      kind: "skip",
      dueAt: last,
      missedCount,
      // The reason describes the due time this row NAMES. A gap that began
      // before launch and ends after it is reported by its last occurrence,
      // because that is the one the row is about.
      reason: last < input.watchingSince ? { kind: "app-closed" } : { kind: "not-observed" },
      through: last,
    });
    due = occurrence(last);
  }

  // Never early, and never stale: `due <= now` is the whole never-early rule,
  // and `due >= runnableFrom` re-checks the grace because a pass that hit the
  // missed limit can still be standing in the past. That one is the next
  // pass's skip, not this pass's very late Run.
  if (due <= input.now && due >= runnableFrom) {
    steps.push({ kind: "run", dueAt: due, through: due });
    due = occurrence(due);
  }

  return { steps, nextDueAt: due };
}
