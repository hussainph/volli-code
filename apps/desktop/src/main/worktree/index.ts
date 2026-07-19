/**
 * The worktree module (worktree-support §2): the ONLY place in the app that
 * executes worktree git commands. Public interface consumed by `pty.ts`,
 * `data-ipc.ts`, and future callers (the pty/IPC/preload wiring is a later
 * stage). Internals live in focused, unit-tested files; this barrel is the
 * seam everything outside the module imports from.
 */
export { ensure } from "./ensure";
export { remove } from "./remove";
export { getState, listBranches } from "./state";
export { sweepOrphans } from "./sweep";

// Pure helpers the PTY wiring stage consumes for the sentinel-gated setup step.
export { buildSetupSentinelLine, parseSetupSentinel } from "./setup";

// The default git runner (captures stderr) — callers build `deps.git` from this.
export { runGitCapturing, GitError } from "./git";

export type {
  WorktreeDeps,
  WorktreePhase,
  WorktreeState,
  WorktreeDiskState,
  WorktreeResult,
  SweepReport,
  DirtyOrphan,
  WorktreeIdentity,
  RunGit,
} from "./types";
