/**
 * What the usage rail's rows SAY, decided away from the components that draw
 * them.
 *
 * `usage-rail.tsx` holds the store reads, the window state and the preference
 * gate; the blocks beside it are pure over a `SessionUsageSummary`. This file
 * is the third piece: which rows a breakdown has, whose money each one carries
 * and what each is called. Those are decisions rather than drawing — a row
 * that attributes one Session's spend to another is wrong in a way no
 * screenshot shows — and a decision inside a `.tsx` is a decision no test can
 * reach.
 */
import {
  isSubagentSession,
  mergeSessionUsageSummaries,
  sessionUsageRank,
  shortSessionId,
  EMPTY_SESSION_USAGE_SUMMARY,
  type ChatSessionRecord,
  type SessionListingIdentity,
  type SessionUsageReport,
} from "@volli/shared";

import type { UsageGroupRow } from "@renderer/usage/usage-format";

/**
 * Every Session on this Ticket, metered or not — the union of the roster and
 * the report's groups, with each delegated child's spend folded into the
 * Session that delegated it.
 *
 * THE ROSTER IS NOT JUST A SOURCE OF LABELS. Passing only the metered groups
 * would drop every manual terminal companion and every chat that never reached
 * a model, which is the majority of Sessions on a Ticket someone has been
 * poking at — and the card's own count would then say "2 sessions" about a
 * Ticket with six. An unmetered Session appears at `—`, which reads as
 * unmeasured rather than free and is exactly the gap a reader needs to see:
 * it is where the spend Volli never mediated went.
 *
 * A metered group the roster no longer holds is kept too, at the bottom by
 * cost order. Its Session has been deleted; the money it spent has not.
 *
 * ── WHY A CHILD IS NOT A ROW OF ITS OWN (VC-279) ──────────────────────────
 * A Subagent Session is never a row in a Session listing, and a breakdown that
 * named one would be the last surface outside the parent chat that did: a
 * turn that delegated eight helpers would print eight rows here, ordered by
 * cost, in a rail whose whole argument is that spend should be cheap to scan.
 * The money must not vanish with the row — a child's tokens are the Ticket's
 * tokens and the total above these rows counts them — so it is ADDED to its
 * parent's row instead. That is also the truer sentence: delegation is how the
 * parent chose to spend, and "this chat cost $4.10, of which its helpers spent
 * $3.60" is one decision, not nine.
 *
 * The per-model breakdown is untouched by this. A model's cost is a fact about
 * the model and nobody reads that list looking for a Session.
 *
 * A child whose parent is not on this roster keeps its own row. That is the
 * honest fallback for spend with nowhere to go — losing money is worse than
 * showing a helper — and it is what a deleted or foreign parent leaves behind.
 */
// Takes the IDENTITY half of each listing row, not the whole row: this file
// decides which rows exist and what they are called, and the money comes from
// the report. A roster's own `usage` is a different question read through a
// different window, and asking for it here would invite a caller to believe
// the two were interchangeable.
export function ticketSessionRows(
  report: SessionUsageReport,
  roster: readonly SessionListingIdentity[] | undefined,
): readonly UsageGroupRow[] {
  const parents = parentBySession(roster);
  // Merged by the row the money ends up on, not by the Session that spent it.
  const byOwner = new Map<string, UsageGroupRow>();
  for (const group of report.groups) {
    const owner = group.key === null ? null : (parents.get(group.key) ?? group.key);
    // `null` is a real group — unticketed spend, or a Session the roster no
    // longer holds — so it needs a stable key rather than being dropped.
    const key = owner ?? "\u0000none";
    const held = byOwner.get(key);
    byOwner.set(key, {
      key,
      label: sessionLabel(owner, roster),
      usage:
        held === undefined ? group.usage : mergeSessionUsageSummaries([held.usage, group.usage]),
    });
  }
  const unmetered = (roster ?? [])
    .map((row) => rowSessionId(row))
    .filter((sessionId) => !byOwner.has(sessionId) && !parents.has(sessionId))
    .map((sessionId) => ({
      key: sessionId,
      label: sessionLabel(sessionId, roster),
      usage: EMPTY_SESSION_USAGE_SUMMARY,
    }));
  // Re-ordered rather than kept in the report's order: a parent that metered
  // little of its own can outspend a dearer Session once its helpers are
  // added, and `sessionUsageRank` is the report's own ordering so the two
  // cannot drift. After the merged rows come the unmetered ones, rather than
  // interleaved: the list is ordered by what things cost, and every row there
  // cost an amount nobody can compare.
  const metered = [...byOwner.values()].toSorted(
    (left, right) => sessionUsageRank(right.usage) - sessionUsageRank(left.usage),
  );
  return [...metered, ...unmetered];
}

/**
 * Each delegated child on the roster against the Session that delegated it —
 * the lookup the fold above spends, built once per render rather than searched
 * per group.
 *
 * A parent the roster does not hold is left out, so the child keeps its row:
 * see the fallback in {@link ticketSessionRows}. Chained delegation resolves to
 * the nearest parent the roster holds, because a Session may not delegate
 * beyond one level today and a row is better attributed one step than not at
 * all.
 */
function parentBySession(
  roster: readonly SessionListingIdentity[] | undefined,
): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  const held = new Set((roster ?? []).map((row) => rowSessionId(row)));
  for (const row of roster ?? []) {
    if (row.kind !== "chat") continue;
    const record: ChatSessionRecord = row.record;
    if (!isSubagentSession(record)) continue;
    if (record.parentSessionId === null || !held.has(record.parentSessionId)) continue;
    parents.set(record.sessionId, record.parentSessionId);
  }
  return parents;
}

/** A report's groups as display rows, already ordered by known cost. */
export function groupRows(
  report: SessionUsageReport,
  label: (key: string | null) => string,
): readonly UsageGroupRow[] {
  return report.groups.map((group) => ({
    key: group.key ?? "\u0000none",
    label: label(group.key),
    usage: group.usage,
  }));
}

/**
 * `anthropic/claude-opus-4-1` → `claude-opus-4-1`.
 *
 * The provider prefix is dropped rather than prettified: at a rail's width the
 * model is the part that distinguishes two rows, and a catalogue of display
 * names would be a second copy of something that moves with every provider
 * release. The full id stays available in the ledger.
 */
export function modelLabel(key: string | null): string {
  if (key === null) return "Unknown model";
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * A Session id resolved to its title, or its short id when the roster does not
 * hold it.
 *
 * `shortSessionId` is the app's own stable human-facing identifier, so a
 * Session whose title never landed still reads as the same thing the CLI and
 * the sidebar would call it.
 */
export function sessionLabel(
  key: string | null,
  roster: readonly SessionListingIdentity[] | undefined,
): string {
  if (key === null) return "Unattributed";
  const title = roster?.find((row) => rowSessionId(row) === key)?.record.title;
  return title !== undefined && title !== "" ? title : `Session ${shortSessionId(key)}`;
}

/**
 * A listing row's Session id, whichever arm it is.
 *
 * The two records spell it differently (`SessionRecord.id` against
 * `ChatSessionRecord.sessionId`), so the union has to be narrowed rather than
 * read through. Spelled once here because getting it wrong silently yields no
 * match, which renders as a bare id rather than as an error.
 */
function rowSessionId(row: SessionListingIdentity): string {
  return row.kind === "terminal" ? row.record.id : row.record.sessionId;
}
