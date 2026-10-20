/** Electron facts for desktop callers not yet composed through HostCore (VC-556).
 * The dependency bundle itself is built by host-core; this adapter owns no
 * worktree state or behavior. Later cluster moves use host.worktrees.deps.
 */
import { app } from "electron";
import type Database from "better-sqlite3";
import { worktreeDeps as buildWorktreeDeps } from "@volli/host-core/worktree";
import { windowEventBus } from "./broadcast";

export function worktreeDeps(db: Database.Database) {
  return buildWorktreeDeps(db, { events: windowEventBus }, { dataDir: app.getPath("userData") });
}
