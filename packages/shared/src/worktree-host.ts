/** Worktree reads, watches and retention vocabulary, independent of transport (VC-556). */
import type {
  OrphanAgeBasis,
  OrphanKeptReason,
  OrphanMetadataKeptReason,
  RetentionReason,
} from "./index";

/**
 * Debounced signal that a live ticket worktree's filesystem changed
 * (`volli:worktree-changed`). The renderer refetches the Change Set; the
 * payload carries only the ticket id (no file list).
 */
export interface WorktreeChangedEvent {
  ticketId: string;
}

/**
 * A ticket's worktree watch faulted and has been torn down
 * (`volli:worktree-watch-error`). Emitted exactly once per fault, right before
 * teardown: after this the renderer will receive no further
 * `volli:worktree-changed` for the ticket, so its Change Set is frozen until
 * something re-establishes the watch. Surfaced, never swallowed — a silently
 * dead watch looks identical to a worktree nobody is touching.
 */
export interface WorktreeWatchErrorEvent {
  ticketId: string;
  error: string;
}

/**
 * A project's branch refs, for the base-branch pickers (the Details rail's and
 * the composer's).
 *
 * `remotes` is a SNAPSHOT, not a live reading: a remote-tracking ref only moves
 * on a fetch, so the list is exactly as old as {@link
 * WorktreeBranchListing.fetchedAt} and a picker has to say so. Nothing in the
 * worktree pipeline fetches on the user's behalf before branching, so a base
 * chosen from `remotes` inherits that same age — which is the whole reason this
 * timestamp crosses the boundary instead of staying a main-process detail.
 */
export interface WorktreeBranchListing {
  /** Local branch short names (`refs/heads`), most-recently-committed first. */
  branches: string[];
  /** The project checkout's own branch; `null` when detached or unreadable. */
  current: string | null;
  /** Remote-tracking short names in `origin/main` form, as of {@link WorktreeBranchListing.fetchedAt}. */
  remotes: string[];
  /** Epoch ms of the repo's last fetch (`FETCH_HEAD`'s mtime); `null` when it has never fetched. */
  fetchedAt: number | null;
}

/** One orphan the scan refuses to propose for cleanup, for the Storage list. */
export interface DirtyWorktreeOrphan {
  path: string;
  projectId?: string;
  /** The project's display name, so a row can name a project and not an id (VC-284 review C6). */
  projectName?: string;
  reason: string;
}

/**
 * One clean, stale orphan a CLEANUP would remove (VC-284). The scan only names
 * it: every field here is what the confirmation has to show before anything is
 * touched — which directory, whose project, and the branch that survives it.
 */
export interface RemovableWorktreeOrphan {
  /**
   * This item's id inside its scan revision — what a cleanup command selects
   * (VC-284 review C1). Scoped by the revision UUID, so an id from a superseded
   * scan can never name work in the current one.
   */
  id: string;
  path: string;
  /** The project whose container held it — every scan tier knows this, so the type says so. */
  projectId: string;
  /** That project's display name, for a row that names a project rather than an id. */
  projectName: string;
  /** The branch the directory is on; retained by the removal, so nothing committed is lost. */
  branch: string | null;
  /** Epoch ms of the last thing that touched it (dir mtime or branch tip). */
  lastTouchedAt: number;
  /** Which of the two clocks that timestamp came from. */
  ageBasis: OrphanAgeBasis;
  /** Epoch ms it became eligible — the basis Storage shows for the verdict. */
  removableAt: number;
}

/**
 * One clean orphan the scan KEEPS: still inside the retention window, its age
 * unreadable (VC-113), or something is live inside it right now. `removableAt`
 * is when it becomes eligible, so the list can say "in 9 days" instead of
 * leaving the user to guess whether it is safe.
 */
export interface KeptWorktreeOrphan {
  path: string;
  projectId: string;
  projectName: string;
  branch: string | null;
  lastTouchedAt: number | null;
  ageBasis: OrphanAgeBasis | null;
  removableAt: number | null;
  reason: OrphanKeptReason;
  /** What is live in it, when `reason` is `active`; `null` otherwise. */
  detail: string | null;
}

/**
 * One stale git ADMIN record a cleanup would prune — read out of the `prunable`
 * marker in `git worktree list --porcelain`, so naming it costs nothing and
 * changes nothing.
 *
 * One record per entry, not one bundle per project (VC-284 review C2): the
 * confirmation shows records, so the plan has to carry records, and every one
 * of them earns its own outcome in the durable history.
 */
export interface PrunableWorktreeMetadata {
  /** This record's id inside its scan revision — what a cleanup command selects. */
  id: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  /** The path git can no longer find. */
  path: string;
  /** Git's own reason, verbatim (`prunable <reason>`). */
  reason: string;
}

/** One stale git record the scan reports but refuses to propose, and why. */
export interface KeptWorktreeMetadata {
  projectId: string;
  projectName: string;
  projectPath: string;
  path: string;
  /** Git's own `prunable` reason. */
  gitReason: string;
  reason: OrphanMetadataKeptReason;
}

/**
 * A project whose worktree listing could not be read (VC-284 review C5). It is
 * reported rather than skipped in silence: without the listing, every checkout
 * in that project's container is unaccounted for, and "we could not look" is a
 * different statement from "there was nothing there".
 */
export interface UnreadableWorktreeProject {
  projectId: string;
  projectName: string;
  projectPath: string;
  error: string;
}

/**
 * One ignored path a trim removed, with the apparent bytes it held. Sizes are
 * summed from the walk the removal needed anyway; for a pnpm tree they overstate
 * what the filesystem gets back (the files are hardlinks into the store), which
 * is honest for what this reclaims — files nothing has to walk any more.
 */
export interface WorktreeTrimRemoval {
  path: string;
  bytes: number;
}

/**
 * One ignored path a trim KEPT, and why. Ignored is not the same as disposable:
 * `.env`, `.envrc`, `*.local`, keys and certificates are ignored precisely
 * because they are local configuration, so the report states what survived as
 * plainly as what did not.
 */
export interface WorktreeTrimKeep {
  path: string;
  reason: string;
}

/** What one worktree's trim did — paths are relative to `worktreePath`. */
export interface WorktreeTrimReport {
  worktreePath: string;
  /** Largest first, so "the top offenders" is the head of the list. */
  removed: WorktreeTrimRemoval[];
  kept: WorktreeTrimKeep[];
  totalBytes: number;
  /** A measured preview that deleted nothing. */
  dryRun: boolean;
}

/** One worktree in the Settings table, with the artifact footprint it carries. */
export interface WorktreeTrimScanEntry {
  path: string;
  projectId: string;
  /** The ticket that owns the checkout, or `null` for an orphan git still registers. */
  ticketId: string | null;
  branch: string | null;
  /** How many ignored paths a trim would take. `0` reads as "nothing to trim". */
  artifactCount: number;
  /** Why this worktree is off limits right now (live work, dirty tracked files), else `null`. */
  activeReason: string | null;
}

/**
 * What a manual trim across every non-active worktree did: the per-worktree
 * reports and the worktrees it refused, with the reason.
 *
 * No metadata pruning here on purpose — `git worktree prune` drops every stale
 * record in a repository, so it belongs to the confirmed orphan cleanup that
 * reviews a set before taking it (VC-284), never to a second action running it
 * blind.
 */
export interface WorktreeTrimSweepReport {
  worktrees: WorktreeTrimReport[];
  skipped: { path: string; reason: string }[];
  totalBytes: number;
  removedCount: number;
  dryRun: boolean;
}

/**
 * The trim settings: the preserved-configuration allowlist and whether a ticket
 * reaching Done/Archived trims its own worktree. Both are user-owned — the
 * automatic trim is opt-out, and the allowlist ships with defaults rather than
 * empty.
 */
export interface WorktreeTrimSettings {
  keepPatterns: string[];
  trimOnFinish: boolean;
}

/** `{ trimOnFinish?, keepPatterns? }` — a partial update of the trim settings. */
export interface WorktreeTrimSettingsInput {
  trimOnFinish?: boolean;
  keepPatterns?: string[];
}

/**
 * A worktree diff summary for `volli:worktree-diff` (done-flow §"diff.ts", the
 * two-mode split): `"working-tree"` is "what the agent is doing right now",
 * `"merge-base"` is "what the PR would contain".
 */
export type WorktreeDiffMode = "working-tree" | "merge-base";

/**
 * One PR check, normalized off the two shapes GitHub's rollup mixes together
 * (VC-182): a GitHub Actions `CheckRun` and a legacy `StatusContext`.
 *
 * FOUR states, not gh's nine conclusions crossed with its five status values.
 * The reader's question is "can I merge this?", and the answer has exactly four
 * shapes — it failed, it is still going, it passed, it did not run. Collapsing
 * happens ONCE, in `ghPrStatus`, so every surface reads the same verdict rather
 * than each re-deciding what `NEUTRAL` means.
 */
export type PrCheckState = "passing" | "failing" | "pending" | "skipped";

/** One row of the PR's check rollup, as the rail draws it. */
export interface PrCheck {
  /** Display name — a job name ("Check + Test") or a status context ("ci/legacy"). */
  name: string;
  /** The Actions workflow the job belongs to; `null` for a legacy commit status. */
  workflow: string | null;
  state: PrCheckState;
  /** The run's log page, or `null` when the provider published no link. */
  url: string | null;
}

/**
 * The composed retention state for ONE ticket, returned by
 * `volli:retention-state`. Everything but `keep` is TRANSIENT (decision #42:
 * persist identity, compute state) — recomputed from the merge-watch's last
 * poll plus the live Done-TTL clock, never stored. `keep` is the durable pin
 * (migration 010). `hasConflicts`/`checks` are surfacing-only (the #44/#45
 * button-never-gate rule): they explain why a PR can't merge yet, they do not
 * block the wrap-up prompt.
 */
export interface TicketRetentionState {
  ticketId: string;
  /** The watched PR url, or `null` when the ticket has none yet. */
  prUrl: string | null;
  /** The watched PR's state, or `null` when unknown / no PR. */
  prState: "open" | "merged" | "closed" | null;
  /** The PR's base branch conflicts with it (`mergeStateStatus` DIRTY). */
  hasConflicts: boolean;
  /**
   * The PR's whole check rollup (VC-182), empty when the PR has no checks —
   * which is also how a project with no GitHub Actions pipeline reads, and is
   * what makes the rail's checks row self-detecting rather than a setting.
   */
  checks: PrCheck[];
  /** Whether the Archive & clean prompt should be offered right now. */
  archiveReady: boolean;
  /** The condition behind `archiveReady` (still set when suppressed by dismissal). */
  reason: RetentionReason | null;
  /** The durable Keep pin — exempts the ticket from BOTH retention paths. */
  keep: boolean;
  /** Whether the prompt was dismissed this launch (re-offered next launch). */
  dismissed: boolean;
}
