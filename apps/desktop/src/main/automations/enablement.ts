/**
 * Whether an Automation is switched on ON THIS MACHINE (VC-127).
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
 *     could carry it to a second machine.
 *  2. **It is not a durable command.** `docs/BOUNDARIES.md` rule 5 asks new
 *     DOMAIN surfaces to take command → event → projection shape. The record
 *     does exactly that (`engine.ts`). This is operating state about a host,
 *     not a fact about the Automation, so putting it in the ledger would make
 *     a per-machine switch part of the history a future account-side record
 *     inherits — precisely the coupling the ruling removes.
 *  3. **Only the DISABLED set is stored.** Absent means enabled: a person who
 *     has never touched the switch has not said "off", and a set of `true`s
 *     would leave "never asked" and "on" indistinguishable. It also means the
 *     resting state costs zero rows.
 *
 * What it governs: what starts an Automation BESIDES a person. Running by
 * hand is universal (VC-112), so a disabled Automation stays runnable from
 * every surface that lists it and simply never fires on its own.
 */
import type Database from "better-sqlite3";

import { getAppState, setAppState } from "../db/app-state-repo";

/**
 * The `app_state` key. A frozen string: it names durable rows, so changing it
 * would not error — it would silently switch every disabled Automation back
 * on, which is the failure mode nobody would notice until one fired.
 */
export const AUTOMATIONS_DISABLED_KEY = "volli:automations-disabled";

/**
 * The stored ids, deduped and sorted.
 *
 * Tolerant on read for the reason durable history is (CLAUDE.md): this row
 * outlives the build that wrote it, and a hand-edited or future-shaped blob
 * must not be able to brick the page that reads it. Anything unparseable, or
 * parseable but not an array of strings, reads as "nothing disabled" — the
 * resting state — rather than throwing.
 */
export function disabledAutomationIds(db: Database.Database): string[] {
  const stored = getAppState(db, AUTOMATIONS_DISABLED_KEY);
  if (stored === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((id): id is string => typeof id === "string"))].toSorted();
}

/**
 * Records one switch and answers with the whole new set.
 *
 * Whole-set answers rather than an ack, so a caller never has to reconstruct
 * what it now believes from what it just asked for. Sorted and deduped on
 * write as well as read, so the stored bytes for a given set are stable and
 * two writes that mean the same thing produce the same row.
 */
export function setAutomationEnabled(
  db: Database.Database,
  input: { automationId: string; enabled: boolean },
  now: number,
): string[] {
  const current = new Set(disabledAutomationIds(db));
  if (input.enabled) current.delete(input.automationId);
  else current.add(input.automationId);
  const next = [...current].toSorted();
  setAppState(db, AUTOMATIONS_DISABLED_KEY, JSON.stringify(next), now);
  return next;
}
