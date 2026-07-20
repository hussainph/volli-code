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

/**
 * The `~` the worktree tree lives under. `VOLLI_WORKTREE_HOME_DIR` overrides it
 * for the e2e smokes ONLY — a real user's `~/.volli/worktrees` must never be
 * touched by a test run. Threaded as `deps.home` so the module's identity/sweep
 * paths and {@link worktreesHome} always agree.
 */
function resolveHome(): string {
  const override = process.env["VOLLI_WORKTREE_HOME_DIR"];
  return override !== undefined && override.length > 0 ? override : homedir();
}

/** The standard runtime deps bundle for every worktree module call. */
export function worktreeDeps(db: Database.Database): WorktreeDeps {
  return { db, git: runGitCapturing, home: resolveHome(), onPhase: broadcastPhase };
}

/**
 * The app-owned worktree home (`<home>/.volli/worktrees`) — the cwd allowance
 * for worktree PTYs and the orphan-delete channel's containment root.
 */
export function worktreesHome(): string {
  return join(resolveHome(), ".volli", "worktrees");
}
