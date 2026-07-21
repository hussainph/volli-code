/**
 * Shared types for the worktree module (worktree-support §2). One injected
 * `deps` object threads the SQLite handle, the git runner seam, an optional
 * `~` override (tests), and the phase-broadcast callback the later IPC-wiring
 * stage connects — so nothing in here reaches for a process-global.
 */
import type Database from "better-sqlite3";
import type { DirtyWorktreeOrphan, WorktreePhase } from "@volli/shared";

import type { RunGit } from "../project-base-branch";

export type { RunGit } from "../project-base-branch";
// The phase vocabulary is DEFINED in @volli/shared (ipc.ts) because the
// renderer consumes it over `volli:worktree-phase`; the module re-exports it
// so internal callers keep one import site.
export type { WorktreeIdentity, WorktreePhase } from "@volli/shared";

/**
 * The single injected dependency bundle every public entrypoint takes. `home`
 * overrides `~` so tests can point `.volli/worktrees` at a temp dir; `onPhase`
 * is the broadcast seam (wired to IPC later) invoked on every phase transition;
 * `attachmentsRoot` is the userData attachment-bytes root `ensure`'s post-copy
 * materialize step reads from (issue #77 PR 2) — tests/scripted harnesses point
 * it at a temp dir; functions that never touch attachments ignore it.
 */
export interface WorktreeDeps {
  db: Database.Database;
  git: RunGit;
  home?: string;
  onPhase?: (ticketId: string, phase: WorktreePhase) => void;
  attachmentsRoot: string;
}

/**
 * The worktree module's Result: an explicit tagged union rather than the
 * shared intersection-style `Result` (which folds `T` into the success object
 * and can't carry a `void`/`string[]` payload cleanly). The `error` string is
 * the human-facing message the caller toasts.
 */
export type WorktreeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function ok<T>(value: T): WorktreeResult<T> {
  return { ok: true, value };
}

export function err<T>(error: string): WorktreeResult<T> {
  return { ok: false, error };
}

/**
 * The report `sweepOrphans` returns (§7): `pruned` lists the project ids whose
 * metadata was pruned, `removedClean` the worktree paths auto-removed (branch
 * retained), `dirty` the orphans left in place for the user to resolve. The
 * dirty-orphan shape is @volli/shared's `DirtyWorktreeOrphan` (the renderer
 * consumes it over `volli:worktree-orphans`).
 */
export interface SweepReport {
  pruned: string[];
  removedClean: string[];
  dirty: DirtyWorktreeOrphan[];
}

export type { Database };
