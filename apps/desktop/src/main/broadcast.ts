/**
 * The ONE `volli:data-changed` fan-out. Any main-side mutation that changes
 * planning data outside the renderer's own request/response cycle (a
 * socket-originated agent command, a worktree remove/ensure/orphan-delete)
 * calls this so every open window re-hydrates from SQLite. Extracted here so
 * index.ts (agent-socket path) and data-ipc.ts (worktree handlers) share a
 * single implementation rather than each rolling their own.
 */
import { BrowserWindow } from "electron";
import type { PendingArmedRun } from "@volli/shared";
import type {
  DataChangedEvent,
  HarnessEventNotice,
  SessionActivityNotice,
  SessionHarnessNotice,
  SessionRetitledEvent,
  SessionsInterruptedEvent,
  SessionStartedNotice,
  PendingArmedRunSettledNotice,
  UpdateUiState,
  VolliIpcEvent,
} from "../ipc/contract";

/**
 * One half-frame at 60Hz: long enough to fold a synchronous mutation burst into
 * one recovery read, short enough that a socket-originated change still appears
 * in the next painted frame. This is the same window the PTY output pipeline
 * uses to turn raw chunks into one IPC send (`pty/output.ts`).
 */
export const DATA_CHANGED_BATCH_WINDOW_MS = 8;

type DataChangeScope = Omit<DataChangedEvent, "entity">;

let pendingDataChange: DataChangeScope | null = null;
let dataChangeTimer: NodeJS.Timeout | null = null;

/**
 * Merge two invalidations without ever claiming a scope narrower than either
 * input. A missing/different ticket or project becomes untargeted, so every
 * relevant surface refreshes. `worktree` is the one load-bearing kind: it
 * invalidates cached venue readings, so it survives a mixed-kind batch even at
 * the cost of one harmless extra venue refresh. Other mixed kinds may collapse
 * to no hint because every reader already re-hydrates the board wholesale.
 */
function mergeDataChange(current: DataChangeScope, next: DataChangeScope): DataChangeScope {
  const ticketId =
    current.ticketId !== undefined && current.ticketId === next.ticketId
      ? current.ticketId
      : undefined;
  const projectId =
    current.projectId !== undefined && current.projectId === next.projectId
      ? current.projectId
      : undefined;
  const kind =
    current.kind === "worktree" || next.kind === "worktree"
      ? "worktree"
      : current.kind !== undefined && current.kind === next.kind
        ? current.kind
        : undefined;
  return {
    ...(ticketId === undefined ? {} : { ticketId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(kind === undefined ? {} : { kind }),
  };
}

/** Send the one pending invalidation to every live window, if there is one. */
function flushDataChanged(): void {
  if (dataChangeTimer !== null) {
    clearTimeout(dataChangeTimer);
    dataChangeTimer = null;
  }
  const change = pendingDataChange;
  pendingDataChange = null;
  if (change === null) return;
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

/** Drain module state between tests that exercise mutation handlers indirectly. */
export function flushDataChangedForTest(): void {
  flushDataChanged();
}

/**
 * Queue an invalidation for every open window. `change` carries the best scope
 * the caller knows: a `ticketId` (plus `projectId`/`kind` when it has them) for
 * a change it can pin to one ticket, or `{}` (the default — untargeted) when it
 * genuinely cannot.
 *
 * Invalidations coalesce for one frame window. The renderer answers every event
 * with a full SQLite bootstrap, so sending fifteen mutation notices in one
 * synchronous burst does not make the result fifteen times fresher — it starts
 * fifteen competing recovery reads and hydrations. One conservatively merged
 * notice preserves the same recovery guarantee and scopes only what every call
 * agreed on.
 */
export function broadcastDataChanged(change: DataChangeScope = {}): void {
  pendingDataChange =
    pendingDataChange === null ? { ...change } : mergeDataChange(pendingDataChange, change);
  if (dataChangeTimer !== null) return;
  dataChangeTimer = setTimeout(flushDataChanged, DATA_CHANGED_BATCH_WINDOW_MS);
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

/**
 * Announce a retitle main made on its own behalf (VC-81 auto-titling).
 *
 * Every other retitle is a renderer action that moves its own labels
 * optimistically as it goes. This one has no renderer behind it — the CLI door
 * has no window at all — and `session.retitle` reaches the ledger WITHOUT the
 * runtime publish, so no live subscriber is told. Without this the model's
 * title is durably correct and invisible until an unrelated refresh, which is
 * the whole feature failing to appear.
 */
export function broadcastSessionRetitled(sessionId: string, title: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send(
      "volli:session-retitled" satisfies VolliIpcEvent,
      { sessionId, title } satisfies SessionRetitledEvent,
    );
  }
}

/**
 * Projects main's whole pending armed-column list into every renderer.
 *
 * A whole snapshot rather than an add/remove delta means two windows can never
 * reconstruct different countdowns after one missed an earlier event. Main has
 * already persisted the list before this sends it, and a newly opened window
 * primes itself through the matching list IPC.
 */
export function broadcastPendingArmedRuns(pending: readonly PendingArmedRun[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:pending-armed-runs-changed" satisfies VolliIpcEvent, pending);
  }
}

/** Announces the one main-owned countdown's outcome without giving a renderer a Run door. */
export function broadcastPendingArmedRunSettled(notice: PendingArmedRunSettledNotice): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:pending-armed-run-settled" satisfies VolliIpcEvent, notice);
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
