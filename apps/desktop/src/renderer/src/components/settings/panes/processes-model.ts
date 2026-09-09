/**
 * What the Running processes section SAYS, separated from what it draws
 * (VC-341) — the same split `storage-orphans-model.ts` makes, and for the same
 * reason: these sentences are the evidence a person decides a kill on, and a
 * sentence is worth testing without a DOM.
 */
import type { OrphanProcessCandidate } from "@volli/shared";

import type { OrphanProcessInventory } from "../../../../../ipc/contract";

/** The item ids a Reap all would name: never a row Volli may not kill. */
export function reapableIds(candidates: readonly OrphanProcessCandidate[]): string[] {
  return candidates
    .filter((candidate) => candidate.stance === "reapable")
    .map((candidate) => candidate.itemId);
}

/**
 * The summary line beside the section's action.
 *
 * It counts the two stances separately, because they are two different facts: a
 * machine with four processes Volli owns has a leak, and a machine with four
 * terminals of the person's own has a person working.
 */
export function processSummary(loading: boolean, inventory: OrphanProcessInventory | null): string {
  if (loading) return "Looking…";
  if (inventory === null) return "Not scanned";
  const total = inventory.candidates.length;
  if (total === 0) return "None";
  const theirs = total - inventory.reapableCount;
  const mine = `${inventory.reapableCount} to reap`;
  return theirs === 0 ? mine : `${mine}, ${theirs} not Volli's`;
}

/**
 * One row's second line: where it stands, how old it is, how much it holds, and
 * which evidence found it.
 *
 * The formatters are parameters so this module stays free of the renderer's
 * own helpers, and so the sentence can be asserted with formatters a test can
 * read.
 */
export function processRowMeta(
  candidate: OrphanProcessCandidate,
  formatAge: (ageMs: number) => string,
  formatBytes: (bytes: number) => string,
): string {
  const source = candidate.source === "ledger" ? "started by Volli" : "found by working directory";
  return [
    `pid ${candidate.pid}`,
    formatAge(candidate.ageMs),
    formatBytes(candidate.rssBytes),
    source,
    candidate.stance === "not-volli" ? "not Volli's" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
