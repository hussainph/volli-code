/**
 * The app-side construction of the worktree module's injected deps (§2's
 * seam): the open database, the stderr-capturing git runner, and the phase
 * broadcast to every window over `volli:worktree-phase`. Both consumers —
 * `pty.ts` (ensure on session boot) and `data-ipc.ts` (state/remove/branches/
 * orphans) — build their deps HERE so phases always reach the renderer no
 * matter which entrypoint moved them.
 */
import { BrowserWindow } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { VolliIpcEvent, WorktreePhaseEvent } from "@volli/shared";

import { runGitCapturing } from "./worktree";
import type { WorktreeDeps, WorktreePhase } from "./worktree";

/** Pushes a phase transition to every open window (renderer mirrors it in a keyed store map). */
function broadcastPhase(ticketId: string, phase: WorktreePhase): void {
  const payload: WorktreePhaseEvent = { ticketId, phase };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send("volli:worktree-phase" satisfies VolliIpcEvent, payload);
    }
  }
}

/** The standard runtime deps bundle for every worktree module call. */
export function worktreeDeps(db: Database.Database): WorktreeDeps {
  return { db, git: runGitCapturing, onPhase: broadcastPhase };
}

/**
 * The app-owned worktree home (`~/.volli/worktrees`) — registered as an
 * allowed PTY root so worktree cwds pass `isPathWithinRoots`, which otherwise
 * only knows renderer-registered project folders.
 */
export function worktreesHome(): string {
  return join(homedir(), ".volli", "worktrees");
}
