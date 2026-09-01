/**
 * How far THIS machine has evaluated each schedule (VC-130) — the scheduler's
 * own place-keeping, and the one piece of this feature that is neither a
 * command nor a record.
 *
 * **Why it is not a durable command.** docs/BOUNDARIES.md rule 5 governs new
 * domain surfaces: user intent that changes what the product does rides
 * command → event → projection. A cursor is none of that. Nobody asks for it,
 * it changes nothing anyone can observe, and it carries no decision — it is the
 * timer's memory of its own last pass, the same tier as a file offset. The
 * facts it produces DO ride the ledger: a Run is a Run, and a due time that
 * passed without one is an `automation.record-skip` command with an event and a
 * receipt. Writing the cursor through the ledger too would put "a timer woke
 * up" in the record's permanent history, which is a log, not a fact about the
 * Automation.
 *
 * **Locality is not the reason, and could not be.** Enablement is machine-local
 * too and still rides command → event → receipt through the engine
 * (`automation.set-enabled`), because switching an Automation on IS user intent
 * about the record. So is arming. The line is what the write is, not where it
 * lives — and a cursor is the timer's own place-keeping either way.
 *
 * **Why it is nevertheless machine-local.** It answers "did this host see that
 * due time go by", and only this host can. A second machine that has never run the app owes
 * no skips for the evenings it was off — it was never going to fire them, and
 * VC-112 already rules that a machine fires nothing until someone switches
 * something on there. So the cursor rides `app_state` beside the enabled set,
 * it is absent from git and from any project directory, and when the record
 * moves to an account this stays behind.
 *
 * **What a missing cursor means, and why that is the safe direction.** No
 * entry means "never evaluated here", and the scheduler answers by starting the
 * clock now: the next occurrence stands and nothing before it is owed. That is
 * the same non-retroactive rule arming has (VC-128) and it is what stops a
 * newly created schedule, a newly enabled one, or a corrupt row from
 * manufacturing a backlog out of history it never watched. Enabling a record
 * or changing its schedule clears the old lifecycle's cursor back to this
 * state; the scheduler, not that user mutation, establishes the new baseline
 * when it next evaluates the record.
 */
import type Database from "better-sqlite3";

import { getAppState, setAppState } from "../db/app-state-repo";

/**
 * The `app_state` key. A frozen string: it names durable rows, so changing it
 * would not error — every schedule would silently look unevaluated, restart its
 * clock at the next launch, and quietly forget one occurrence each.
 */
export const AUTOMATION_SCHEDULE_CURSORS_KEY = "volli:automation-schedule-cursors";

/** Automation id → the epoch-ms occurrence this host has evaluated through. */
export type ScheduleCursors = Record<string, number>;

/**
 * The stored cursors, with anything unreadable dropped.
 *
 * Tolerant on read like every other durable row this app owns, but dropping
 * PER ENTRY rather than voiding the whole record — the split `automations-repo`
 * makes for arming, and for the same reason: each entry names its own
 * Automation, so one this build cannot read can only be about one schedule.
 * Voiding the map would restart every OTHER schedule's clock, which silently
 * forgives skips that really were owed. A dropped entry only restarts its own.
 */
export function readScheduleCursors(db: Database.Database): ScheduleCursors {
  const stored = getAppState(db, AUTOMATION_SCHEDULE_CURSORS_KEY);
  if (stored === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const cursors: ScheduleCursors = {};
  for (const [automationId, at] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at)) cursors[automationId] = at;
  }
  return cursors;
}

/**
 * Moves one schedule's cursor forward, leaving every other entry alone.
 *
 * Forward ONLY, and that is the never-replay rule expressed in storage: a
 * caller that has fired or skipped an occurrence moves past it, and a stale
 * caller (a second window, a retried pass) cannot drag the cursor back and make
 * the same evening due again. Entries for Automations that no longer exist are
 * left rather than swept — they are inert, ids are UUIDs and never reused, and
 * a sweep would need to be right about deletions it did not witness.
 */
export function advanceScheduleCursor(
  db: Database.Database,
  input: { automationId: string; through: number },
  now: number,
): ScheduleCursors {
  const cursors = readScheduleCursors(db);
  const current = cursors[input.automationId];
  if (current !== undefined && current >= input.through) return cursors;
  const next = { ...cursors, [input.automationId]: input.through };
  setAppState(db, AUTOMATION_SCHEDULE_CURSORS_KEY, JSON.stringify(next), now);
  return next;
}

/**
 * Forgets one schedule lifecycle's place without disturbing any other.
 *
 * Re-enabling a record and editing its schedule both begin a new lifecycle:
 * occurrences from the disabled interval or the old schedule were never owed
 * by the new one. Removing the entry makes the scheduler apply its ordinary
 * first-sight rule and start watching from its next pass's `now`.
 *
 * An absent entry stays absent rather than writing an initial baseline here.
 * Establishing that baseline durably at mutation time is a separate concern;
 * this operation only prevents an existing lifecycle from leaking forward.
 */
export function clearScheduleCursor(
  db: Database.Database,
  automationId: string,
  now: number,
): ScheduleCursors {
  const cursors = readScheduleCursors(db);
  if (cursors[automationId] === undefined) return cursors;
  const next = { ...cursors };
  delete next[automationId];
  setAppState(db, AUTOMATION_SCHEDULE_CURSORS_KEY, JSON.stringify(next), now);
  return next;
}
