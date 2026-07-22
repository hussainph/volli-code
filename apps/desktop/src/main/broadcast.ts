/**
 * The ONE `volli:data-changed` fan-out. Any main-side mutation that changes
 * planning data outside the renderer's own request/response cycle (a
 * socket-originated agent command, a worktree remove/ensure/orphan-delete)
 * calls this so every open window re-hydrates from SQLite. Extracted here so
 * index.ts (agent-socket path) and data-ipc.ts (worktree handlers) share a
 * single implementation rather than each rolling their own.
 */
import { BrowserWindow } from "electron";
import type { DataChangedEvent, SessionsInterruptedEvent, VolliIpcEvent } from "@volli/shared";

/**
 * Fans the invalidation out to every open window. `change` carries the best
 * scope the caller knows: a `ticketId` (plus `projectId`/`kind` when it has
 * them) for a change it can pin to one ticket, or `{}` (the default —
 * untargeted) when it genuinely can't, which the renderer reads as "anything may
 * have changed". The `entity` discriminant is stamped here so call sites only
 * ever pass scope.
 */
export function broadcastDataChanged(change: Omit<DataChangedEvent, "entity"> = {}): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send(
      "volli:data-changed" satisfies VolliIpcEvent,
      {
        entity: "tickets",
        ...change,
      } satisfies DataChangedEvent,
    );
  }
}

/**
 * Announces a backward-move interrupt (issue #78, CONCEPT #20) to every
 * window: automation may de-escalate a ticket's agents, but never silently —
 * the renderer toasts this where the mover is looking. Callers fire it only
 * when sessions were actually interrupted (`sessionIds` non-empty), mirroring
 * the `sessions_interrupted` event-log rule.
 */
export function broadcastSessionsInterrupted(ticketId: string, sessionIds: string[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send(
      "volli:sessions-interrupted" satisfies VolliIpcEvent,
      {
        ticketId,
        sessionIds,
      } satisfies SessionsInterruptedEvent,
    );
  }
}
