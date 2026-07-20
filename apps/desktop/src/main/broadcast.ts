/**
 * The ONE `volli:data-changed` fan-out. Any main-side mutation that changes
 * planning data outside the renderer's own request/response cycle (a
 * socket-originated agent command, a worktree remove/ensure/orphan-delete)
 * calls this so every open window re-hydrates from SQLite. Extracted here so
 * index.ts (agent-socket path) and data-ipc.ts (worktree handlers) share a
 * single implementation rather than each rolling their own.
 */
import { BrowserWindow } from "electron";
import type { VolliIpcEvent } from "@volli/shared";

export function broadcastDataChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:data-changed" satisfies VolliIpcEvent, {
      entity: "tickets",
    });
  }
}
