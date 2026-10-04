/**
 * host-core's event bus, delivered to every open window (VC-554).
 *
 * `windowEventBus` is the Electron adapter for `HostEventBus`: each host
 * topic goes out on its own `volli:` channel to every live window. Host code
 * publishes through the bus it is handed; desktop code that has not moved yet
 * calls the `broadcastX` functions below, which publish through the same bus,
 * so every host announcement reaches a window by one path.
 *
 * `volli:data-changed` is the one fan-out for planning invalidations. Any
 * main-side mutation that changes planning data outside the renderer's own
 * request/response cycle (a socket-originated agent command, a worktree
 * remove/ensure/orphan-delete) publishes it so every open window re-hydrates
 * from SQLite.
 *
 * Window-only facts — the OS appearance, the updater's state — are not host
 * events and are sent directly.
 */
import { BrowserWindow } from "electron";
import type { HostEventBus, HostEventMap, HostEventTopic } from "@volli/host-core/ports";
import type { PendingArmedRun } from "@volli/shared";
import { createDataChangeCoalescer, type DataChangeScope } from "./data-change-coalescer";
import type {
  DataChangedEvent,
  HarnessEventNotice,
  SessionActivityNotice,
  SessionHarnessNotice,
  SessionStartedNotice,
  PendingArmedRunSettledNotice,
  UpdateUiState,
  VolliIpcEvent,
} from "../ipc/contract";

/** Sends one message to every window whose page is still alive. */
function sendToEveryWindow(channel: VolliIpcEvent, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

/**
 * The app's one coalescing window, whose sink is every live window. The rule
 * and its state live in `data-change-coalescer.ts`; what is process-global here
 * is only the instance that fans out to `BrowserWindow`, so a second consumer
 * with its own cadence can be given its own.
 */
const dataChanges = createDataChangeCoalescer({
  send(change) {
    sendToEveryWindow("volli:data-changed", {
      entity: "tickets",
      ...change,
    } satisfies DataChangedEvent);
  },
});

/** How each host topic reaches the windows: its channel, and for one, its cadence. */
const WINDOW_DELIVERY: { [T in HostEventTopic]: (payload: HostEventMap[T]) => void } = {
  "data-changed": (change) => dataChanges.queue(change),
  "session-activity": (notice) => sendToEveryWindow("volli:session-activity", notice),
  "session-retitled": (event) => sendToEveryWindow("volli:session-retitled", event),
  "sessions-interrupted": (event) => sendToEveryWindow("volli:sessions-interrupted", event),
  "session-started": (notice) => sendToEveryWindow("volli:session-started", notice),
  "harness-event": (notice) => sendToEveryWindow("volli:harness-event", notice),
  "session-harness": (notice) => sendToEveryWindow("volli:session-harness", notice),
  "pending-armed-runs-changed": (pending) =>
    sendToEveryWindow("volli:pending-armed-runs-changed", pending),
  "pending-armed-run-settled": (notice) =>
    sendToEveryWindow("volli:pending-armed-run-settled", notice),
  "worktree-phase": (event) => sendToEveryWindow("volli:worktree-phase", event),
  "worktree-changed": (event) => sendToEveryWindow("volli:worktree-changed", event),
  "worktree-watch-error": (event) => sendToEveryWindow("volli:worktree-watch-error", event),
  // Addressed topics: the terminal supervisor publishes these only through
  // the attached client's sink (`client-event-sink.ts`), never on the bus.
  "terminal-data": (event) => sendToEveryWindow("volli:terminal-data", event),
  "terminal-exit": (event) => sendToEveryWindow("volli:terminal-exit", event),
  "terminal-park-state": (event) => sendToEveryWindow("volli:terminal-park-state", event),
};

/** host-core's `HostEventBus` over every open window. */
export const windowEventBus: HostEventBus = {
  publish(topic, payload) {
    WINDOW_DELIVERY[topic](payload);
  },
};

/**
 * Deliver whatever this test's handlers queued, so a NEGATIVE assertion means
 * something. Without it `expect(sends).toEqual([])` passes inside any
 * synchronous test body whether or not the handler queued anything at all.
 */
export function flushDataChangedForTest(): void {
  dataChanges.flush();
}

/**
 * Throw away whatever is queued, delivering nothing. The isolation half of the
 * pair, run from `test-setup.ts` after every test in the main project: a
 * pending scope left behind would otherwise be delivered into the NEXT test's
 * window mock, carrying ids that test never created.
 */
export function resetDataChangedForTest(): void {
  dataChanges.dispose();
}

/**
 * Queue an invalidation for every open window. `change` carries the best scope
 * the caller knows: a `ticketId` (plus `projectId`/`kind` when it has them) for
 * a change it can pin to one ticket, or `{}` (the default — untargeted) when it
 * genuinely cannot. The `entity` discriminant is stamped by the fan-out above,
 * so call sites only ever pass scope.
 *
 * Invalidations coalesce for one frame window — see `data-change-coalescer.ts`
 * for why one merged notice is not a weaker guarantee than fifteen.
 */
export function broadcastDataChanged(change: DataChangeScope = {}): void {
  windowEventBus.publish("data-changed", change);
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
  sendToEveryWindow("volli:system-appearance-changed", prefersDark);
}

/**
 * Fans one canonical harness event out to every window (harness-events). The
 * involuntary channel's last hop: a hook fired, `volli hook` carried it over
 * the socket, main resolved the session, and this is how the renderer learns.
 * Sent to every window rather than the session's owner — a session's rows and
 * badges are visible in whichever window has that project open.
 */
export function broadcastHarnessEvent(notice: HarnessEventNotice): void {
  windowEventBus.publish("harness-event", notice);
}

/**
 * Fans a harness change out to every window: the wrapper for a DIFFERENT
 * harness ran inside a session's terminal, so what the sidebar names and what
 * the session's harness state is about both have to move. Every window, for the
 * same reason the event fan-out uses: a session's rows are visible wherever its
 * project is open.
 */
export function broadcastSessionHarness(notice: SessionHarnessNotice): void {
  windowEventBus.publish("session-harness", notice);
}

/**
 * Announces a socket-originated Session start (VC-13) to every window: the
 * renderer toasts "<actor> started a session on VC-4" with an action that
 * opens the session's chat tab. A notice, never a navigation — without the
 * click nothing moves, and board/sidebar surfaces refresh through the normal
 * `volli:data-changed` path beside it.
 */
export function broadcastSessionStarted(notice: SessionStartedNotice): void {
  windowEventBus.publish("session-started", notice);
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
  sendToEveryWindow("volli:update-state", state);
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
  windowEventBus.publish("session-activity", notice);
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
  windowEventBus.publish("session-retitled", { sessionId, title });
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
  windowEventBus.publish("pending-armed-runs-changed", pending);
}

/** Announces the one main-owned countdown's outcome without giving a renderer a Run door. */
export function broadcastPendingArmedRunSettled(notice: PendingArmedRunSettledNotice): void {
  windowEventBus.publish("pending-armed-run-settled", notice);
}

/**
 * Announces a backward-move interrupt (issue #78, CONCEPT #20) to every
 * window: automation may de-escalate a ticket's agents, but never silently —
 * the renderer toasts this where the mover is looking. Callers fire it only
 * when sessions were actually interrupted (`sessionIds` non-empty), mirroring
 * the durable Session interrupt-receipt rule.
 */
export function broadcastSessionsInterrupted(ticketId: string, sessionIds: string[]): void {
  windowEventBus.publish("sessions-interrupted", { ticketId, sessionIds });
}
