/**
 * Shared types for the worktree module (worktree-support §2). One injected
 * `deps` object threads the SQLite handle, the git runner seam, an optional
 * `~` override (tests), and the phase-broadcast callback the later IPC-wiring
 * stage connects — so nothing in here reaches for a process-global.
 */
import type Database from "better-sqlite3";
import type { WorktreeIdentity } from "@volli/shared";

import type { RunGit } from "../project-base-branch";

export type { RunGit } from "../project-base-branch";
export type { WorktreeIdentity } from "@volli/shared";

/**
 * The transient lifecycle of a worktree's `ensure` pipeline — an in-memory
 * registry value (`phase.ts`), NEVER persisted. On boot, truth is recomputed
 * from disk (`getState`), so a phase surviving a restart would be a lie.
 */
export type WorktreePhase = "creating" | "copying" | "setting-up" | "ready" | "failed";

/**
 * The single injected dependency bundle every public entrypoint takes. `home`
 * overrides `~` so tests can point `.volli/worktrees` at a temp dir; `onPhase`
 * is the broadcast seam (wired to IPC later) invoked on every phase transition.
 */
export interface WorktreeDeps {
  db: Database.Database;
  git: RunGit;
  home?: string;
  onPhase?: (ticketId: string, phase: WorktreePhase) => void;
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

/** Where a worktree dir stands relative to what git knows — the live half of `getState`. */
export type WorktreeDiskState = "present" | "missing" | "unregistered";

/** The single composed answer `getState` returns (DB identity + transient phase + live disk check). */
export interface WorktreeState {
  identity: WorktreeIdentity | null;
  phase: WorktreePhase | null;
  disk: WorktreeDiskState;
}

/** One dirty orphan the startup sweep found but refused to remove (§7). */
export interface DirtyOrphan {
  path: string;
  projectId?: string;
  reason: string;
}

/**
 * The report `sweepOrphans` returns (§7): `pruned` lists the project ids whose
 * metadata was pruned, `removedClean` the worktree paths auto-removed (branch
 * retained), `dirty` the orphans left in place for the user to resolve.
 */
export interface SweepReport {
  pruned: string[];
  removedClean: string[];
  dirty: DirtyOrphan[];
}

export type { Database };
