/**
 * Whether an Automation is switched on ON THIS MACHINE (VC-127) — the
 * machine-local PROJECTION half. The intent that changes it is an ordinary
 * Automation command (`engine.ts`, `automation.set-enabled`); this module owns
 * only where the answer is stored and how it is read back.
 *
 * Three decisions are worth stating, because each is the reason this is not a
 * column on `automations`:
 *
 *  1. **It is machine-local by construction.** VC-112 rules that an
 *     Automation's shareable half is its Skill in git and the record itself
 *     never travels; enablement is one step more local still — the same tier
 *     as a column's arming, which that ruling also declares per machine. It
 *     therefore rides `app_state`, beside the global runtime-preferences
 *     record VC-112 cites, and there is no path by which a project directory
 *     could carry it to a second machine. When the record moves to an account,
 *     THIS does not go with it: it names a host, not the Automation.
 *  2. **Machine-local is not a licence to skip the seam.** `docs/BOUNDARIES.md`
 *     rule 5 asks new domain surfaces to take command → event → projection
 *     shape, and this switch is user intent that changes whether an Automation
 *     fires. So the write is a durable command with an immutable event and a
 *     receipt, exactly like create/update/delete; what is machine-local is the
 *     PROJECTION TARGET, which is this file. That split is the reusable
 *     pattern for every other per-machine Automation switch (a column's
 *     arming, VC-128).
 *  3. **The ENABLED set is what is stored, and absent means off.** VC-112:
 *     "A new machine sees the Skills and fires nothing until someone turns
 *     something on there." A machine that has never been asked has not said
 *     yes, so it must be indistinguishable from a machine that said no — and
 *     the only shape where that is true by construction is the set of ids
 *     somebody switched ON here. The resting state is still zero rows.
 *
 * What it governs: what starts an Automation BESIDES a person. Running by hand
 * is universal (VC-112), so an Automation that is off stays runnable from
 * every surface that lists it and simply never fires on its own.
 *
 * One id in this set can outlive the record it names — deleting an Automation
 * does not sweep it — and that is inert rather than a leak: ids are UUIDs and
 * are never reused, the set is only ever consulted for records something is
 * already listing, and the command that writes it refuses an Automation that
 * does not exist, so nothing can add a name that never had a record.
 */
import type Database from "better-sqlite3";

import { getAppState, setAppState } from "../db/app-state-repo";

/**
 * The `app_state` key. A frozen string: it names durable rows, so changing it
 * would not error — it would silently switch every enabled Automation back
 * off, which is the failure mode nobody would notice until one did not fire.
 */
export const AUTOMATIONS_ENABLED_KEY = "volli:automations-enabled";

/**
 * The stored ids, deduped and sorted.
 *
 * Tolerant on read for the reason durable history is (CLAUDE.md): this row
 * outlives the build that wrote it, and a hand-edited or future-shaped blob
 * must not be able to brick the page that reads it. Anything unparseable, or
 * parseable but not an array of strings, reads as "nothing switched on here" —
 * the resting state, and the safe one: a corrupt row can only fail closed.
 *
 * WHOLLY closed, and that is the point of the second check. A row half of
 * whose entries are not strings is a row this build cannot claim to
 * understand, so salvaging the readable half would be a guess about which
 * Automations a person switched on — and a wrong guess there FIRES something
 * nobody armed on this machine. Refusing the whole row instead can only
 * under-fire, which VC-112 already calls the resting state; the person turns
 * the switch back on and the next write replaces the row with bytes this
 * build did write.
 */
export function enabledAutomationIds(db: Database.Database): string[] {
  const stored = getAppState(db, AUTOMATIONS_ENABLED_KEY);
  if (stored === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  if (!parsed.every((id) => typeof id === "string")) return [];
  return [...new Set(parsed)].toSorted();
}

/**
 * Replaces the set whole.
 *
 * Sorted and deduped on write as well as on read, so the stored bytes for a
 * given set are stable and two writes that mean the same thing produce the
 * same row. The arithmetic of "which set" belongs to the command that decided
 * it, not here — this is the projection's writer, and it is called inside the
 * ledger transaction that appended the event, so the row and the history move
 * together or neither does.
 */
export function putEnabledAutomationIds(
  db: Database.Database,
  ids: readonly string[],
  now: number,
): string[] {
  const next = [...new Set(ids)].toSorted();
  setAppState(db, AUTOMATIONS_ENABLED_KEY, JSON.stringify(next), now);
  return next;
}
