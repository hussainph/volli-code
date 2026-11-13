/**
 * The archive-readiness verdict (CONCEPT #16, issue #76) — pure,
 * dependency-free domain logic. Lives here rather than
 * `packages/host-core/src/worktree/retention.ts` per the repo's convention
 * (pure domain computations belong in `@volli/shared`); that main-process
 * module re-exports everything below so the merge-watch and its IPC surface
 * need no changes.
 */
import type { TicketStatus } from "./ticket";
import type { WorktreeTrimTrigger } from "./ticket-events";

/** Why a ticket is archive-ready — drives the retention prompt's copy. */
export type RetentionReason = "pr-merged" | "ttl-expired";

/** The inputs the readiness verdict is a pure function of. */
export interface ArchiveReadinessInput {
  status: TicketStatus;
  /** The durable Keep pin — exempts BOTH paths. */
  keep: boolean;
  /** In-memory, launch-scoped dismissal of the prompt (suppresses, doesn't exempt). */
  dismissed: boolean;
  /** The watched PR's url, or `null` when the ticket has no PR (yet). */
  prUrl: string | null;
  /**
   * The watched PR's state. `null` is ambiguous by itself — it means either
   * "no PR" (`prUrl` is also `null`) or "a PR exists but hasn't been polled
   * yet" (discovered this cycle, offline, `gh` missing — the first poll can
   * be up to one interval away). `computeArchiveReadiness` disambiguates
   * using `prUrl`; see its doc for why that matters.
   */
  prState: "open" | "merged" | "closed" | null;
  /** Epoch ms the ticket entered Done, or `null` when unknown. */
  doneEntryAt: number | null;
  now: number;
  ttlMs: number;
}

/** The readiness verdict: whether to prompt, and the underlying reason. */
export interface ArchiveReadiness {
  archiveReady: boolean;
  reason: RetentionReason | null;
}

/**
 * The pure retention verdict. Precedence:
 *  1. Keep pin — a hard exemption from both paths (`reason: null`).
 *     Short-circuit before either merge or TTL eligibility is evaluated.
 *  2. Merge path — a MERGED PR is archive-ready in any column.
 *  3. TTL path — a Done ticket whose Done entry is at least `ttlMs` old, whose
 *     PR isn't open, AND whose PR isn't UNKNOWN. A PR reads as unknown when
 *     `prUrl` is set but `prState` is still `null` — discovered (e.g. by the
 *     watch's own PR discovery) but not yet polled for status. Treating
 *     unknown the same as open is deliberate: "an open PR waits for its
 *     merge, never a TTL" must hold even in the window before the first
 *     status poll classifies it — otherwise a ticket with a very-online open
 *     PR could TTL-archive purely because the watch hasn't caught up yet. A
 *     ticket with NO PR at all (`prUrl === null`) is unaffected by this: its
 *     `prState` is `null` too, but there's nothing to wait on, so the TTL
 *     applies normally.
 * `archiveReady` is the reason being met AND not dismissed; `reason` still
 * reports the met condition when dismissed, so the surface can explain itself.
 */
export function computeArchiveReadiness(input: ArchiveReadinessInput): ArchiveReadiness {
  if (input.keep) return { archiveReady: false, reason: null };

  const prUnknown = isPrUnknown(input);

  let reason: RetentionReason | null = null;
  if (input.prState === "merged") {
    reason = "pr-merged";
  } else if (
    input.status === "done" &&
    input.prState !== "open" &&
    !prUnknown &&
    input.doneEntryAt !== null &&
    input.now - input.doneEntryAt >= input.ttlMs
  ) {
    reason = "ttl-expired";
  }
  return { archiveReady: reason !== null && !input.dismissed, reason };
}

/**
 * A PR exists but its state hasn't been observed yet — UNKNOWN, not "no PR",
 * and it must block the TTL the same way "open" does: a very-online open PR
 * would otherwise lose its checkout purely because the watch hadn't caught up.
 */
function isPrUnknown(input: Pick<ArchiveReadinessInput, "prUrl" | "prState">): boolean {
  return input.prUrl !== null && input.prState === null;
}

/** The inputs the automatic worktree reclaim is a pure function of (VC-113). */
export type WorktreeReclaimInput = Omit<ArchiveReadinessInput, "dismissed">;

/**
 * Whether a ticket's worktree DIRECTORY may be reclaimed automatically
 * (VC-113) — deliberately a different question from {@link
 * computeArchiveReadiness}, and a strictly narrower one.
 *
 * The prompt fires on EITHER a merge or the dwell, because a person deciding
 * to wrap a ticket up wants to know about both. The reclaim fires on the DWELL
 * ALONE, because only time is evidence that nobody is coming back. A merge is
 * an event: it arrives while the review is still on screen, often from an agent
 * that merged its own PR, and treating it as permission to delete is what made
 * pushing a PR feel like losing a workspace.
 *
 * So merging never triggers this — but it never blocks it either. A ticket that
 * merged three weeks ago and has sat in Done since is reclaimed on the dwell,
 * exactly as an unmerged, closed, or never-PR'd one is. What blocks is an OPEN
 * or not-yet-observed PR (the work is still live), a Keep pin (an explicit
 * "don't"), a column other than Done, and a Done entry we cannot date.
 *
 * Dismissal is absent from the inputs on purpose: it silences a launch's
 * prompt, and disk policy is not a prompt.
 */
export function computeWorktreeReclaim(input: WorktreeReclaimInput): {
  reclaim: boolean;
  reason: RetentionReason | null;
} {
  if (input.keep) return { reclaim: false, reason: null };
  if (input.status !== "done") return { reclaim: false, reason: null };
  if (input.prState === "open" || isPrUnknown(input)) return { reclaim: false, reason: null };
  if (input.doneEntryAt === null) return { reclaim: false, reason: null };
  const stale = input.now - input.doneEntryAt >= input.ttlMs;
  return stale ? { reclaim: true, reason: "ttl-expired" } : { reclaim: false, reason: null };
}

// ---- trim on finish (VC-340, VC-1156) --------------------------------------

/**
 * The two facts from a ticket's history the trim's finish rule reads. `at` is
 * when the event was recorded (epoch ms, this machine's clock); a merge record's
 * `mergedAt` is when GitHub says the PR merged, when the record carries it.
 */
export type TrimFinishHistoryEntry =
  | { kind: "pr_merged"; url: string; at: number; mergedAt?: number }
  | { kind: "status_changed"; to: TicketStatus; at: number };

/**
 * How far BEFORE GitHub's merge time a column move may be recorded and still
 * count as after the merge (VC-1156). The move is dated by this machine's clock
 * and the merge by GitHub's, and the two drift; a minute covers ordinary clock
 * difference with room to spare. It leans toward keeping on purpose — a move
 * that might have come after the merge is treated as having done so — while
 * staying far shorter than the usual gap between moving a ticket to review and
 * its PR merging, so a ticket that genuinely finished by merging still trims.
 */
export const MERGE_CLOCK_MARGIN_MS = 60_000;

/** The inputs {@link decideTrimFinish} is a pure function of. */
export interface TrimFinishInput {
  status: TicketStatus;
  archived: boolean;
  /**
   * The PR the caller observed merged for this ticket right now — the
   * ticket's current PR — or `null` when it observed no merge.
   */
  mergedPrUrl: string | null;
  /** The ticket's `pr_merged` and `status_changed` events, oldest first. */
  history: readonly TrimFinishHistoryEntry[];
}

/** Whether the ticket is finished for the trim, and which finish says so. */
export type TrimFinishVerdict =
  | { finished: true; trigger: WorktreeTrimTrigger }
  | { finished: false; reason: "not finished" | "moved since the merge" };

/**
 * Whether a ticket is FINISHED in the sense the ignored-artifact trim acts on
 * (VC-340), with the owner's ruling on reactivation applied (VC-1156): an
 * explicit move wins over a merged-PR observation.
 *
 *  - Archived, or in Done: finished. A move into Done is itself the explicit
 *    finish, whatever PR history the ticket has — so a reactivated ticket moved
 *    back to Done by hand, with no new PR, is finished again.
 *  - Otherwise only a merged PR can finish it, and only if no column move came
 *    after the merge. A move after the merge — out of Done, or from Needs
 *    Review back to Doing, to any column but Done — says the work continues,
 *    and the old merge no longer speaks for the worktree. A move counts as
 *    after the merge when it is recorded after the PR's merge record, OR when
 *    that record carries GitHub's merge time and the move is dated at or after
 *    it, less {@link MERGE_CLOCK_MARGIN_MS}. The second test is what catches a
 *    ticket moved back to work between the merge and the watch seeing it: the
 *    watch backs off and `gh` fails, so that gap is not small. A record with no
 *    merge time falls back to order alone.
 *  - A merge the caller observes that has no record yet (its first observation,
 *    or a later PR on the same ticket) is newer than every recorded move, so it
 *    finishes the ticket: a new PR merging after a reactivation is finished
 *    again.
 *
 * Every column change is a deliberate move today (VC-629), so the rule does
 * not ask who moved the ticket; were automation ever to move one, counting it
 * here only ever keeps more, never removes more.
 */
export function decideTrimFinish(input: TrimFinishInput): TrimFinishVerdict {
  if (input.archived) return { finished: true, trigger: { kind: "archived" } };
  if (input.status === "done") return { finished: true, trigger: { kind: "done" } };
  const url = input.mergedPrUrl;
  if (url === null) return { finished: false, reason: "not finished" };
  // The EARLIEST record of this PR merging: a duplicate record is not a new
  // merge, and dating from the first one only ever keeps more.
  const recorded = input.history.findIndex(
    (entry) => entry.kind === "pr_merged" && entry.url === url,
  );
  if (recorded !== -1) {
    // The earliest merge time any record of this PR carries, for the same reason.
    let mergedAt: number | null = null;
    for (const entry of input.history) {
      if (entry.kind !== "pr_merged" || entry.url !== url || entry.mergedAt === undefined) continue;
      if (mergedAt === null || entry.mergedAt < mergedAt) mergedAt = entry.mergedAt;
    }
    const movedSince = input.history.some(
      (entry, index) =>
        entry.kind === "status_changed" &&
        (index > recorded || (mergedAt !== null && entry.at >= mergedAt - MERGE_CLOCK_MARGIN_MS)),
    );
    if (movedSince) return { finished: false, reason: "moved since the merge" };
  }
  return { finished: true, trigger: { kind: "pr_merged", url } };
}
