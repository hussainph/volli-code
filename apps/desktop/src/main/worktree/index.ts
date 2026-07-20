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
export { commitRemaining } from "./commit";
export type { CommitRemainingInput } from "./commit";
export { runNet, fetchBase, pushBranch, ghCreateDraftPr, ghFindPr } from "./net";
export type { RunNet, GhResult, GhFailure, GhFailureKind } from "./net";
export { publishTicketBranch, commitTicketRemaining } from "./publish";
export type { PublishDeps, PublishOutcome } from "./publish";

// The PTY wiring drives the transient phase directly across the setup-command
// step (`setting-up → ready | failed`), which happens in the terminal after
// `ensure` resolves — hence the phase registry is part of the module's seam.
export { setPhase, clearPhase } from "./phase";

// Pure helpers the PTY wiring stage consumes for the sentinel-gated setup step.
export { buildSetupSentinelLine, parseSetupSentinel } from "./setup";

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
