/**
 * What a host announces to its clients (VC-554).
 *
 * {@link HostEventMap} names every fact a host announces to all its clients,
 * by topic, with its payload; {@link HostEventBus} sends one. Which wire
 * carries a topic — an Electron channel to every window today, the host
 * protocol tomorrow — is the adapter's business, not the publisher's.
 *
 * A stream one client subscribed to (a watched worktree, a terminal's output,
 * a file watch) goes through HostClientEventSink, over the same topic map.
 * The sink belongs to exactly one client and carries its connection lifetime.
 *
 * Desktop's adapter is `apps/desktop/src/main/broadcast.ts`: each topic goes
 * out on its `volli:<topic>` channel to every live window, exactly as the
 * `broadcastX` functions sent it before this port existed, and `data-changed`
 * keeps folding a burst into one notice per frame window.
 *
 * A moved service that announces something takes `events: HostEventBus` from
 * its ports and adds its topic here, with the payload type in `@volli/shared`.
 */
import type {
  DataChangeScope,
  FileChangedEvent,
  DirChangedEvent,
  HarnessEventNotice,
  PendingArmedRun,
  PendingArmedRunSettledNotice,
  SessionActivityNotice,
  SessionHarnessNotice,
  SessionRetitledEvent,
  SessionsInterruptedEvent,
  SessionStartedNotice,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalParkStateEvent,
  WorktreePhaseEvent,
  WorktreeChangedEvent,
  WorktreeWatchErrorEvent,
} from "@volli/shared";

/** Every fact a host announces, by topic. A topic is the channel name minus `volli:`. */
export interface HostEventMap {
  /** A subscribed client's open file changed; addressed by the watch. */
  "file-changed": FileChangedEvent;
  /** A subscribed client's expanded directory changed; addressed by the watch. */
  "dir-changed": DirChangedEvent;
  /**
   * Planning data changed outside a client's own request. Carries the best
   * scope the publisher knows; `{}` means anything may have changed.
   */
  "data-changed": DataChangeScope;
  /** One Session's listing row, re-derived after its durable history moved. */
  "session-activity": SessionActivityNotice;
  /** A retitle the host made on its own behalf (auto-titling). */
  "session-retitled": SessionRetitledEvent;
  /** A backward move interrupted live Sessions. Never sent with no Sessions. */
  "sessions-interrupted": SessionsInterruptedEvent;
  /** A Session started from outside any client window (the agent socket). */
  "session-started": SessionStartedNotice;
  /** One canonical harness event, resolved to its Session. */
  "harness-event": HarnessEventNotice;
  /** A different harness is now running in a Session's terminal. */
  "session-harness": SessionHarnessNotice;
  /** The whole pending armed-column countdown list, never a delta. */
  "pending-armed-runs-changed": readonly PendingArmedRun[];
  /** One armed countdown's outcome. */
  "pending-armed-run-settled": PendingArmedRunSettledNotice;
  /** A worktree `ensure` moved to its next phase. */
  "worktree-phase": WorktreePhaseEvent;
  /** A subscribed client's worktree changed. Never broadcast by the watch. */
  "worktree-changed": WorktreeChangedEvent;
  /** A subscribed client's worktree watch faulted, before its teardown. */
  "worktree-watch-error": WorktreeWatchErrorEvent;
  /** A batch of a terminal's output, to the one client attached to it (VC-560). Never broadcast. */
  "terminal-data": TerminalDataEvent;
  /** A terminal's shell exited, to its attached client, after its final output. Never broadcast. */
  "terminal-exit": TerminalExitEvent;
  /** A terminal's park/keep-awake state, to its attached client. Never broadcast. */
  "terminal-park-state": TerminalParkStateEvent;
}

export type HostEventTopic = keyof HostEventMap;
/** Subscription events are addressed only; a broadcast port cannot publish them. */
export type HostClientEventTopic =
  | "worktree-changed"
  | "worktree-watch-error"
  | "file-changed"
  | "dir-changed"
  | "terminal-data"
  | "terminal-exit"
  | "terminal-park-state";
export type HostBroadcastEventTopic = Exclude<HostEventTopic, HostClientEventTopic>;

/**
 * Sends a fact to every connected client. Fire-and-forget: a host never waits
 * on, or learns about, delivery. A host with no client connected drops it.
 */
export interface HostEventBus {
  publish<T extends HostBroadcastEventTopic>(topic: T, payload: HostEventMap[T]): void;
}

/**
 * One client's addressed event stream (VC-556). The host supplies a stable,
 * connection-scoped id, typed delivery, and disconnect hooks. A service removes
 * its own hook on unsubscribe; disconnect releases its subscriptions immediately.
 * Desktop adapts exactly the requesting WebContents, never every window.
 */
export interface HostClientEventSink {
  publish<T extends HostClientEventTopic>(topic: T, payload: HostEventMap[T]): void;
  readonly id: string;
  isClosed(): boolean;
  onceClosed(listener: () => void): void;
  removeCloseListener(listener: () => void): void;
}
