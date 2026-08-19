/**
 * The archive-readiness verdict (CONCEPT #16, issue #76) — pure,
 * dependency-free domain logic. Lives here rather than
 * `apps/desktop/src/main/worktree/retention.ts` per the repo's convention
 * (pure domain computations belong in `@volli/shared`); that main-process
 * module re-exports everything below so the merge-watch and its IPC surface
 * need no changes.
 */
import type { TicketStatus } from "./ticket";

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
 *  1. Keep pin — a HARD exemption from both paths (`reason: null`). This is the
 *     Vibe-Kanban anti-pattern encoded as a guarantee: their TTL sweep ignores
 *     its own pin; ours must not, so the pin short-circuits before any path.
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
