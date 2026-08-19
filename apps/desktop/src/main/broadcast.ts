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
  SessionActivityNotice,
  SessionHarnessNotice,
  SessionsInterruptedEvent,
  SessionStartedNotice,
  UpdateUiState,
  VolliIpcEvent,
} from "../ipc/contract";

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

/**
 * Announces a socket-originated Session start (VC-13) to every window: the
 * renderer toasts "<actor> started a session on VC-4" with an action that
 * opens the session's chat tab. A notice, never a navigation — without the
 * click nothing moves, and board/sidebar surfaces refresh through the normal
 * `volli:data-changed` path beside it.
 */
export function broadcastSessionStarted(notice: SessionStartedNotice): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:session-started" satisfies VolliIpcEvent, notice);
  }
}

/**
 * Fans one updater state transition (VC-59) out to every window: the sidebar's
 * download icon is per-window chrome, and every window must render the same
 * truth — a badge lit in one window and dark in another would make "is an
 * update ready?" depend on where you happen to be looking. Each push carries
 * the FULL snapshot, never a delta, so a window that missed earlier
 * transitions (it was still loading) is whole again on the next one.
 */
export function broadcastUpdateState(state: UpdateUiState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:update-state" satisfies VolliIpcEvent, state);
  }
}

/**
 * Fans one Session's re-derived listing row out to every window — the push
 * channel that replaced the poll.
 *
 * Chat activity was the one Session fact with no way to reach a renderer on its
 * own: a turn opening in main moved nothing on screen, so every listing that
 * showed it re-read `volli:session-list` on a ten-second timer and was wrong
 * for up to ten seconds by construction. Terminal output has always been push
 * (`volli:terminal-data` bumps the store); this is the structured half finally
 * arriving the same way.
 *
 * Every window, for the reason the harness fan-outs give: a Session's rows are
 * visible wherever its project is open, and a listing lit in one window and
 * stale in another makes "what is running?" depend on where you are looking.
 */
export function broadcastSessionActivity(notice: SessionActivityNotice): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:session-activity" satisfies VolliIpcEvent, notice);
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
