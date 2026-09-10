/**
 * The worktree module (worktree-support §2): the ONLY place in the app that
 * executes worktree git commands. Public interface consumed by `pty.ts`,
 * `data-ipc.ts`, and future callers (the pty/IPC/preload wiring is a later
 * stage). Internals live in focused, unit-tested files; this barrel is the
 * seam everything outside the module imports from.
 */
export { ensure } from "./ensure";
export type { EnsureOutcome } from "./ensure";
export { remove } from "./remove";
export type { WorktreeRemoveOptions } from "./remove";
export { listBranches } from "./state";

// Orphan worktrees (VC-284): the READ-ONLY scan, and the separate confirmed
// cleanup with its durable record. Two verbs, never one — inspection may not
// remove anything, and removal may only act on what a person confirmed.
export { scanOrphans, readOnlyGit, lastTouchedAt } from "./scan";
export type { OrphanScanOptions, OrphanScanReport, WorktreeAge } from "./scan";
export { cleanupOrphans, preservationRuleIds, OrphanCleanupRefused } from "./cleanup";
export type { OrphanCleanupDeps, OrphanCleanupRequest } from "./cleanup";
// The destructive act's durable core: a UUID-keyed command, an acceptance
// receipt, immutable per-item facts, and one projection over them (review S1).
export { createOrphanCleanupEngine, foldCleanupRun, RECENT_CLEANUP_RUNS } from "./cleanup-engine";
export type {
  OrphanCleanupEngine,
  OrphanCleanupFact,
  OrphanCleanupIntent,
  OrphanCleanupLedger,
} from "./cleanup-engine";
export { SqliteOrphanCleanupLedger } from "./cleanup-ledger";
export { reconcileInterruptedCleanups } from "./cleanup-recovery";
// The serialization between a removal and anything that would start work in
// the directory it is removing (review C4).
export {
  acquireDeletionLease,
  acquireWorktreeStartLease,
  isUnderDeletion,
  resetDeletionLeasesForTest,
  UNDER_DELETION_REFUSAL,
} from "./deletion-lease";

// Live work inside a directory — the guard every destructive worktree path
// asks, shared so the automatic and manual routes cannot answer it differently.
export { busyRefusal, busySiteWithin } from "./activity";
export type { BusyWorktreeSite, BusyWorktreeSites } from "./activity";

// What the structured runtime has open inside a worktree: the directory-scoped
// busy question the destructive guards ask, and the release the destroy runs so
// no Session is left pointed at a checkout that no longer exists.
export {
  agentSitesWithin,
  agentTurnOpenWithin,
  countOpenAgentTurns,
  releaseAgentSites,
} from "./agent-sites";
export type { AgentSiteReleaseReport, AgentSiteRuntime } from "./agent-sites";

// Done-flow (§8): the finer status query, both diff modes, the one-click commit
// safety net, and the async network verbs (fetch/push/gh) with their taxonomy.
export { getWorktreeStatus } from "./status";
export type { WorktreeStatusInput, WorktreeStatusReport } from "./status";
export { diffStat } from "./diff";
export type { DiffStatInput } from "./diff";

// TicketId-in read verbs (CONCEPT #42): resolve ticket→identity, discriminate
// no-worktree / stamped-but-deleted, then compose status.ts/diff.ts. The single
// door both the IPC and CLI status/diff paths go through — never the shallow
// pair directly — so the disk-existence contract can't drift between them again.
export {
  readWorktreeStatus,
  readWorktreeDiff,
  readWorktreeChangeSet,
  readWorktreeChangeSetPaths,
  readWorktreeBaseFile,
} from "./read";
export type {
  WorktreeReadDeps,
  WorktreeStatusRead,
  WorktreeDiffRead,
  WorktreeChangeSetRead,
  WorktreeChangeSetPathsRead,
  WorktreeBaseFileRead,
} from "./read";
export { changeSetPaths, changeSetSnapshot, readChangeSetBaseFile } from "./change-set";

// Worktree sync (VC-185): the one worktree verb that writes. It merges the base
// ref this checkout already has, reports conflicts per path, and returns —
// never fetching, never waiting.
export {
  previewSyncWithBase,
  previewTicketWorktree,
  syncTicketWorktree,
  syncWithBase,
} from "./sync";
export type {
  SyncInput,
  SyncMode,
  SyncPreview,
  SyncReport,
  SyncStatus,
  WorktreeSyncPreviewRead,
  WorktreeSyncRead,
} from "./sync";

// The file-collision radar's scan (VC-185): every live ticket worktree's diff,
// joined into the overlap matrix `@volli/shared` computes.
export { scanCollisions } from "./collisions";
export type { CollisionScan, ScannedWorktree, SkippedWorktree } from "./collisions";

// The venue read (VC-55): the checkout a Session runs in, measured — the file
// partition the empty chat draws and the loose count the Home rail shows.
// `readVenue` resolves the directory by the Session runtime's own rule, so the
// two can never disagree about which tree a Session is standing in.
export { readVenue, venueSnapshot } from "./venue";
export type { VenueReadDeps, VenueSnapshotInput, VenueTarget } from "./venue";
export type { ChangeSetInput, ChangeSetBaseFileInput, ChangeSetBaseFile } from "./change-set";
export {
  WorktreeChangeWatchManager,
  WATCH_DEBOUNCE_MS,
  WATCH_MAX_WAIT_MS,
} from "./change-set-watch";
export { createCoalescer } from "./coalesce";
export type { Coalescer } from "./coalesce";
export { commitRemaining } from "./commit";
export type { CommitOutcome, CommitRemainingInput } from "./commit";
export {
  runNet,
  fetchBase,
  pushBranch,
  ghCreateDraftPr,
  ghFindPr,
  ghPrStatus,
  ghDiscoverPr,
} from "./net";
export type {
  ExplainCredentialHelpers,
  RunNet,
  GhResult,
  GhFailure,
  GhFailureKind,
  PrStatusReport,
} from "./net";
export { publishTicketBranch, commitTicketRemaining } from "./publish";
export type { PublishDeps, PublishOutcome } from "./publish";

// Retention (CONCEPT #16, issue #76): the Done-TTL setting, the Keep-aware
// archive-readiness verdict, the archive-and-clean composition, and the
// merge-watch poll step + interval driver.
export {
  getRetentionTtlDays,
  setRetentionTtlDays,
  archiveAndClean,
  reclaimIfStale,
  trimFinishedWorktree,
  DEFAULT_RETENTION_TTL_DAYS,
} from "./retention";
export type { ReclaimDeps, ReclaimOutcome, TrimFinishDeps, TrimFinishOutcome } from "./retention";

// Trim (VC-340): the git-ignored artifacts a finished worktree keeps carrying,
// removed without removing the checkout. Enumerated the way git defines
// "ignored", minus a preserved-configuration allowlist that is a user setting.
export {
  countIgnoredArtifacts,
  DEFAULT_TRIM_KEEP_PATTERNS,
  keepReasonFor,
  listIgnoredPaths,
  trimIgnoredArtifacts,
} from "./trim";
export type { TrimInput, WorktreeTrimKeep, WorktreeTrimRemoval, WorktreeTrimReport } from "./trim";
export {
  defaultTrimSettings,
  getTrimSettings,
  setTrimSettings,
  TRIM_SETTINGS_KEY,
} from "./trim-settings";
// The manual pass over every owned worktree — the Settings surface for what is
// already on disk. It removes ignored CONTENT only and never prunes git
// metadata: `git worktree prune` takes no path argument, so it acts on the whole
// repository, and VC-284 earned the right to run it with a synchronous gate that
// re-lists the prunable set and refuses unless it is exactly the set the user
// confirmed (`cleanup.ts`). Running it blind from here would hand that back.
export { scanTrimTargets, trimAllWorktrees } from "./trim-sweep";
export type { TrimSweepDeps } from "./trim-sweep";
// Worktree OWNERSHIP (VC-113): which containers under the shared
// `~/.volli/worktrees` root belong to THIS database, and therefore which paths
// any destructive route may touch.
export {
  isOwnedWorktreePath,
  ownedContainers,
  projectContainerName,
  projectContainerPath,
} from "./containers";
export type { OwnedContainer } from "./containers";
export {
  RetentionWatcher,
  createRetentionStore,
  pollRetention,
  getRetentionState,
  retentionConfigFromEnv,
} from "./watch";
export type {
  RetentionPollDeps,
  RetentionStore,
  RetentionWatchConfig,
  TicketRetentionState,
} from "./watch";

// The PTY wiring drives the transient phase directly across the setup-command
// step (`setting-up → ready | failed`), which happens in the terminal after
// `ensure` resolves — hence the phase registry is part of the module's seam.
export { setPhase, clearPhase } from "./phase";

// Pure helpers the sentinel-gated setup step is built from.
export { buildSetupSentinelLine, parseSetupSentinel } from "./setup";

// The stateful sentinel-gated setup-command machine (§6): pty.ts drives it
// through a narrow handle (feed output, notify exit) instead of owning the
// tail-scan / phase-transition / worktree_failed(setup) emission inline.
export { createSetupRun } from "./setup-run";
export type { SetupRun, SetupRunDeps, SetupRunParams, SetupFeedResult } from "./setup-run";

// The default git runners (both capture stderr) — callers build `deps.git` /
// `deps.gitAsync` from these. The async one exists because the Change Set reads
// must never block main; see git.ts.
export { runGitCapturing, runGitCapturingAsync, GitError } from "./git";

export type {
  WorktreeDeps,
  WorktreePhase,
  WorktreeResult,
  WorktreeIdentity,
  RunGit,
  RunGitAsync,
  StatMtimeMs,
} from "./types";
