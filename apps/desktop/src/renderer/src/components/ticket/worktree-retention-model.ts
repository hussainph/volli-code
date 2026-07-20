/**
 * Pure resolver for the retention overlay on the Done-flow rail (issue #76,
 * CONCEPT #16). Given a ticket's transient retention state, it decides whether
 * the single adaptive action should become "Archive & clean", whether the quiet
 * "kept" state shows, the archive-reason context line, and the non-gating
 * conflict/failing-check notices. Kept side-effect-free and separate from
 * `ticket-properties.tsx` so the rules are unit-testable without mounting React
 * or faking `window.api` — the same split `worktree-done-flow-model.ts` uses.
 *
 * Two invariants it encodes, both settled:
 *  - Surfacing NEVER gates (decision #44): a conflict or failing-check notice
 *    explains why a PR can't merge yet; it never disables the wrap-up action.
 *  - Keep is a HARD exemption (decision #16): a kept ticket is never
 *    archive-ready, so the prompt never fights a user's explicit "keep it".
 */
import type { TicketRetentionState } from "@volli/shared";

/** A surfaced, non-gating retention notice — a merge conflict or failing checks. */
export interface RetentionNotice {
  /** The one-line summary shown inline ("PR has merge conflicts" / "N checks failing"). */
  text: string;
  /** Full check names for the hover tooltip; `null` when there's nothing extra to list. */
  detail: string | null;
}

/** The retention overlay the Done-flow rail composes over its adaptive action. */
export interface RetentionView {
  /** Offer "Archive & clean" as the adaptive primary (archive-ready, not dismissed, not kept). */
  archiveReady: boolean;
  /** The durable Keep pin is set — show the quiet "kept" state with an un-keep path. */
  kept: boolean;
  /** The archive-reason context line ("PR merged" / "In Done for N+ days"), or `null` when not ready. */
  reasonLine: string | null;
  /** Non-gating conflict/failing-check notices, conflict first (surfacing only). */
  notices: RetentionNotice[];
}

/** The adaptive primary verb when a ticket is archive-ready. */
export const ARCHIVE_CLEAN_LABEL = "Archive & clean";
/** Chevron-menu verb: pin the worktree, exempting it from both retention paths. */
export const KEEP_WORKTREE_LABEL = "Keep worktree";
/** The un-keep affordance shown in the quiet kept state. */
export const UNKEEP_LABEL = "Un-keep";
/** Chevron-menu verb: dismiss the prompt for this launch (re-offered next launch). */
export const DISMISS_LABEL = "Dismiss";

/** The archive-reason context line: "PR merged" or "In Done for N+ days". */
function reasonLine(state: TicketRetentionState, ttlDays: number | null): string | null {
  if (!state.archiveReady || state.reason === null) return null;
  if (state.reason === "pr-merged") return "PR merged";
  // ttl-expired: name the configured threshold when we know it.
  return ttlDays !== null ? `In Done for ${ttlDays}+ days` : "In Done long enough to archive";
}

/** The non-gating conflict/failing-check notices for a PR (empty when there are none). */
function resolveNotices(state: TicketRetentionState): RetentionNotice[] {
  const notices: RetentionNotice[] = [];
  if (state.hasConflicts) notices.push({ text: "PR has merge conflicts", detail: null });
  const count = state.failingChecks.length;
  if (count > 0) {
    notices.push({
      text: `${count} check${count === 1 ? "" : "s"} failing`,
      detail: state.failingChecks.join(", "),
    });
  }
  return notices;
}

/**
 * Resolves the retention overlay from a ticket's transient retention state.
 * `null` state (not fetched yet, or the ticket has no worktree) yields an inert
 * empty view. `ttlDays` names the TTL threshold in the "In Done for N+ days"
 * line; pass `null` when it isn't loaded yet (a TTL-less fallback line is used).
 */
export function resolveRetention(
  state: TicketRetentionState | null,
  ttlDays: number | null,
): RetentionView {
  if (state === null) {
    return { archiveReady: false, kept: false, reasonLine: null, notices: [] };
  }
  return {
    archiveReady: state.archiveReady,
    kept: state.keep,
    reasonLine: reasonLine(state, ttlDays),
    notices: resolveNotices(state),
  };
}
