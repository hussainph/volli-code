/**
 * The ONE `volli:data-changed` fan-out. Any main-side mutation that changes
 * planning data outside the renderer's own request/response cycle (a
 * socket-originated agent command, a worktree remove/ensure/orphan-delete)
 * calls this so every open window re-hydrates from SQLite. Extracted here so
 * index.ts (agent-socket path) and data-ipc.ts (worktree handlers) share a
 * single implementation rather than each rolling their own.
 */
import { BrowserWindow } from "electron";
import type {
  DataChangedEvent,
  HarnessEventNotice,
  SessionHarnessNotice,
  SessionsInterruptedEvent,
  VolliIpcEvent,
} from "@volli/shared";

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
 * Tells every window the OS flipped light↔dark, carrying
 * `nativeTheme.shouldUseDarkColors`.
 *
 * Only main can. Chromium resolves the renderer's `prefers-color-scheme` query
 * against the root element's used `color-scheme`, which the app stamps for
 * itself — so over there the query reports the mode already painted and never
 * moves on its own, and a scope on `auto` would sit on a stale answer forever.
 * `nativeTheme` is the source; this is the only way its change reaches a window.
 */
export function broadcastSystemAppearance(prefersDark: boolean): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:system-appearance-changed" satisfies VolliIpcEvent, prefersDark);
  }
}

/**
 * Announces a backward-move interrupt (issue #78, CONCEPT #20) to every
 * window: automation may de-escalate a ticket's agents, but never silently —
 * the renderer toasts this where the mover is looking. Callers fire it only
 * when sessions were actually interrupted (`sessionIds` non-empty), mirroring
 * the durable Session interrupt-receipt rule.
 */
/**
 * Fans one canonical harness event out to every window (harness-events). The
 * involuntary channel's last hop: a hook fired, `volli hook` carried it over
 * the socket, main resolved the session, and this is how the renderer learns.
 * Sent to every window rather than the session's owner — a session's rows and
 * badges are visible in whichever window has that project open.
 */
export function broadcastHarnessEvent(notice: HarnessEventNotice): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:harness-event" satisfies VolliIpcEvent, notice);
  }
}

/**
 * Fans a harness change out to every window: the wrapper for a DIFFERENT
 * harness ran inside a session's terminal, so what the sidebar names and what
 * the session's harness state is about both have to move. Every window, for the
 * same reason the event fan-out uses: a session's rows are visible wherever its
 * project is open.
 */
export function broadcastSessionHarness(notice: SessionHarnessNotice): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:session-harness" satisfies VolliIpcEvent, notice);
  }
}

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
