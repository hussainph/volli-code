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
export { listBranches } from "./state";
export { sweepOrphans } from "./sweep";

// Done-flow (§8): the finer status query, both diff modes, the one-click commit
// safety net, and the async network verbs (fetch/push/gh) with their taxonomy.
export { getWorktreeStatus } from "./status";
export type { WorktreeStatusInput, WorktreeStatusReport } from "./status";
export { diffStat } from "./diff";
export type { DiffMode, DiffStatInput } from "./diff";

// TicketId-in read verbs (CONCEPT #42): resolve ticket→identity, discriminate
// no-worktree / stamped-but-deleted, then compose status.ts/diff.ts. The single
// door both the IPC and CLI status/diff paths go through — never the shallow
// pair directly — so the disk-existence contract can't drift between them again.
export { readWorktreeStatus, readWorktreeDiff } from "./read";
export type { WorktreeReadDeps, WorktreeStatusRead, WorktreeDiffRead } from "./read";
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
export type { RunNet, GhResult, GhFailure, GhFailureKind, PrStatusReport } from "./net";
export { publishTicketBranch, commitTicketRemaining } from "./publish";
export type { PublishDeps, PublishOutcome } from "./publish";

// Retention (CONCEPT #16, issue #76): the Done-TTL setting, the Keep-aware
// archive-readiness verdict, the archive-and-clean composition, and the
// merge-watch poll step + interval driver.
export {
  getRetentionTtlDays,
  setRetentionTtlDays,
  archiveAndClean,
  DEFAULT_RETENTION_TTL_DAYS,
} from "./retention";
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

// The default git runner (captures stderr) — callers build `deps.git` from this.
export { runGitCapturing, GitError } from "./git";

export type {
  WorktreeDeps,
  WorktreePhase,
  WorktreeResult,
  SweepReport,
  WorktreeIdentity,
  RunGit,
} from "./types";
