/**
 * Watches: what a Session hears about work it is not doing itself (VC-457).
 *
 * `session_await` and `ticket_await` were tool calls that PARKED the caller's
 * turn until a watched fact arrived. A parked turn is a chat the person
 * driving cannot use: nothing they type is read until a long tool call
 * resolves. So both are retired, and this module replaces them with the shape
 * the subagent notice already had — the fact arrives as an EVENT:
 *
 * - a watcher mid-turn reads it at its next step, as a `steer` message;
 * - an idle watcher has a turn opened on it;
 * - a watcher between attachments has it parked until it attaches again.
 *
 * Nothing waits. Arming a watch returns at once, and the chat stays usable in
 * between.
 *
 * ## What is watched, and what wakes
 *
 * Two subjects, over the two post-commit buses main already had:
 *
 * - A **Session** (`session-wake.ts`). Arming watches its verdicts
 *   (`session.signaled`) and its stop, for as long as the watch lives, and
 *   the end of its NEXT turn — once. Turn ends re-arm only on purpose: the
 *   `session_start` or `automation_run` that opened the work, a `session_send`
 *   that steered it, or an explicit `watch`. A person chatting with a Session
 *   an orchestrator once started therefore does not wake the orchestrator on
 *   every reply. A verdict is delivered like any other change: when it and
 *   the turn's end land inside one coalescing window they share a notice, and
 *   when they do not, the verdict is not held back for a turn end that may
 *   never come. A stop ends the watch.
 *
 *   A turn end is not always "done". A target that ended its turn while its
 *   own `session_delegate` subagents still run gets a new turn by itself when
 *   each one's answer lands, so the end of such a turn is DEFERRED: nothing is
 *   enqueued and the arm is kept, and the watcher hears the first turn end at
 *   which the target has no subagent pending — when it is actually done. An
 *   interrupted turn is a failure and is never deferred. Any other change
 *   delivered while the target still has subagents pending (an interruption, a
 *   verdict) says so, naming them, so the watcher need not peek to find out.
 *   The pending set is read when the change is seen: a child that settled just
 *   before the parent's turn ended already counts as done, so the watcher may
 *   hear a turn end that the child's answer notice is about to follow with one
 *   more turn. That is accepted rather than raced.
 *
 *   A stop the watcher made itself (`session_stop`) ends the watch and is NOT
 *   reported back: the tool result already confirmed it, and the echo would
 *   cost the watcher a turn. A stop by anyone else — the person, the
 *   watchdog, another Session — is reported.
 * - A **Ticket** (`ticket-wake.ts`). Moves, comments and signals, for as long
 *   as the watch lives, except those the watcher made itself: a Board Session
 *   commenting on a Ticket it watches is not news to it.
 *
 * What kinds a Session may be woken by is still project policy: the same
 * `awaitable` / `awaitableSessions` lists that governed the await tools, read
 * when the watch is armed.
 *
 * ## Coalesced, so a burst is one wake
 *
 * Changes for one watcher are gathered for {@link WATCH_COALESCE_MS} after the
 * first and delivered as ONE notice: five children finishing together, or a
 * move plus a comment from one command, cost the watcher one turn rather than
 * five.
 *
 * The rules (what a fact reports, deferral, the watcher's own acts) and the
 * notice's words live once in `@volli/shared` (`watch-rules.ts`,
 * `session-notice.ts`), shared with the cloud backend's durable watches; this
 * module is the in-process registry, coalescing and delivery around them.
 *
 * ## Process memory, deliberately
 *
 * Watches live here and a relaunch forgets them, which is the same bargain the
 * await tools made (a relaunch cut a parked await too). What survives is what
 * always did: every fact a watch reports is durable in its own ledger, and a
 * watcher that relaunches reads the board or `volli session list` once and
 * watches again. The watcher's stop ends its watches; so does the target's.
 *
 * ## Trust
 *
 * A notice is a `user`-channel message because that is the channel a model is
 * guaranteed to read. Every word another author chose — a comment body, a
 * signal's reason, a Session's last message — arrives inside a nonce-delimited
 * untrusted-prose envelope, marked as that author's; the facts around it are
 * Volli's.
 */

import { randomUUID } from "node:crypto";
import {
  composeWatchNotice,
  noticeProse,
  sessionWatchChanges,
  shortSessionId,
  ticketEventWatchActor,
  ticketWatchChanges,
  ticketWatchHears,
  watchNoticeCommandId,
  watchNoticeMessageId,
  watchStoppedBy,
  WATCH_ANSWER_NOTICE_LIMIT,
  type NoticeAnswer,
  type SessionAwaitKind,
  type SessionEvent,
  type SessionStopActor,
  type TicketAwaitKind,
  type TranscriptReference,
  type WatchChangeV1,
} from "@volli/shared";
import type {
  SessionEngine,
  SessionRuntime,
  SessionTranscriptArtifact,
} from "@volli/session-engine";
import { readSessionAnswer } from "@volli/session-engine";

import type { SubscribeSessionWake } from "./session-control/session-wake";
import type { TicketWake } from "./ticket-wake";
import type { DetachedWorkPort } from "./detached-work";
import { deliverHostNotice, errorText } from "./session-runtime/host-notice-delivery";
import { hostLogger } from "./log/root";

const log = hostLogger("watches");

/** How long one watcher's changes are gathered before they are delivered as one notice. */
export const WATCH_COALESCE_MS = 1_500;

/** How much of a watched Session's last message a notice carries inline. */
export { WATCH_ANSWER_NOTICE_LIMIT };

export interface WatchesPorts {
  /** A timer's in-flight delivery must finish before the host closes SQLite. */
  detachedWork?: DetachedWorkPort;
  subscribeSessionWake: SubscribeSessionWake;
  subscribeTicketWake: (listener: (wake: TicketWake) => void) => () => void;
  runtime: Pick<SessionRuntime, "command" | "subscribe" | "projection">;
  sessionEngine: Pick<SessionEngine, "listEvents">;
  /** Reads a watched Session's last message; absent means the notice names the read command. */
  readTranscriptArtifact?: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
  /** A Ticket comment's body, or null when it was deleted before delivery. */
  readComment: (commentId: string) => string | null;
  /**
   * The `session_delegate` subagents of a Session that have not answered yet:
   * full Session ids, in start order. Absent means none — a build without a
   * delegation host never defers a turn end.
   */
  pendingSubagents?: (sessionId: string) => readonly string[];
  newId?: () => string;
  report?: (message: string) => void;
  coalesceMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface WatchSessionInput {
  watcherSessionId: string;
  targetSessionId: string;
  title: string | null;
  /** What policy lets this watcher be woken by. Empty arms nothing. */
  kinds: readonly SessionAwaitKind[];
  /** Whether the end of the target's next turn should notify. */
  armTurn: boolean;
}

export interface WatchTicketInput {
  watcherSessionId: string;
  ticketId: string;
  display: string;
  kinds: readonly TicketAwaitKind[];
}

export interface Watches {
  watchSession(input: WatchSessionInput): void;
  watchTicket(input: WatchTicketInput): void;
  /** Stop watching the named targets; returns how many watches ended. */
  unwatch(
    watcherSessionId: string,
    targets: { sessions?: readonly string[]; tickets?: readonly string[] },
  ): number;
  /** What one watcher is watching now, for receipts and tests. */
  watching(watcherSessionId: string): {
    sessions: readonly { id: string; turnArmed: boolean }[];
    tickets: readonly { id: string; display: string }[];
  };
  /** Stop listening to both buses. */
  dispose(): void;
}

interface SessionWatch {
  targetSessionId: string;
  title: string | null;
  kinds: Set<SessionAwaitKind>;
  turnArmed: boolean;
}

interface TicketWatch {
  ticketId: string;
  display: string;
  kinds: Set<TicketAwaitKind>;
}

interface Watcher {
  sessionId: string;
  sessions: Map<string, SessionWatch>;
  tickets: Map<string, TicketWatch>;
  outbox: WatchChangeV1[];
  timer: unknown;
}

/**
 * Who stopped a watched Session, as the reader reads it. A notice never names
 * a stop by its watcher (the shared watch rules do not report one), so only
 * the watch receipt passes `readerSessionId` to say "by this Session".
 */
export function stoppedBy(by: SessionStopActor, readerSessionId?: string): string {
  return watchStoppedBy(by, readerSessionId);
}

export function createWatches(ports: WatchesPorts): Watches {
  const report =
    ports.report ?? ((message) => log.error("watch notice failed", { detail: message }));
  const newId = ports.newId ?? randomUUID;
  const coalesceMs = ports.coalesceMs ?? WATCH_COALESCE_MS;
  const setTimer = ports.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = ports.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const pendingSubagents = ports.pendingSubagents ?? (() => []);
  const watchers = new Map<string, Watcher>();

  function watcherFor(sessionId: string): Watcher {
    let watcher = watchers.get(sessionId);
    if (watcher === undefined) {
      watcher = {
        sessionId,
        sessions: new Map(),
        tickets: new Map(),
        outbox: [],
        timer: undefined,
      };
      watchers.set(sessionId, watcher);
    }
    return watcher;
  }

  /** Forget a watcher that holds nothing and owes nothing. */
  function prune(watcher: Watcher): void {
    if (
      watcher.sessions.size === 0 &&
      watcher.tickets.size === 0 &&
      watcher.outbox.length === 0 &&
      watcher.timer === undefined
    ) {
      watchers.delete(watcher.sessionId);
    }
  }

  function enqueue(watcher: Watcher, changes: readonly WatchChangeV1[]): void {
    if (changes.length === 0) return;
    watcher.outbox.push(...changes);
    if (watcher.timer !== undefined) return;
    watcher.timer = setTimer(() => {
      watcher.timer = undefined;
      const work = flush(watcher).catch((error: unknown) => {
        report(`watch notice for ${shortSessionId(watcher.sessionId)} failed: ${errorText(error)}`);
      });
      ports.detachedWork?.track(work);
    }, coalesceMs);
  }

  /** A watched Session's last message, read at delivery. */
  async function lastMessageOf(sessionId: string): Promise<NoticeAnswer> {
    if (ports.readTranscriptArtifact === undefined) return { state: "unread" };
    try {
      const answer = await readSessionAnswer(
        {
          listEvents: (query) => ports.sessionEngine.listEvents(query),
          readArtifact: ports.readTranscriptArtifact,
        },
        { sessionId },
      );
      if (answer.text === null) {
        return answer.unreadable ? { state: "unreadable", error: null } : { state: "none" };
      }
      return { state: "text", message: noticeProse(answer.text, WATCH_ANSWER_NOTICE_LIMIT) };
    } catch (error) {
      return { state: "unreadable", error: errorText(error) };
    }
  }

  async function flush(watcher: Watcher): Promise<void> {
    const gathered = watcher.outbox.splice(0);
    prune(watcher);
    if (gathered.length === 0) return;
    const changes: WatchChangeV1[] = [];
    for (const change of gathered) {
      changes.push(
        change.subject === "session" &&
          (change.fact === "turn-completed" || change.fact === "turn-interrupted")
          ? { ...change, lastMessage: await lastMessageOf(change.sessionId) }
          : change,
      );
    }
    const notice = composeWatchNotice({
      watcherSessionId: watcher.sessionId,
      changes,
      nonce: randomUUID,
    });
    const commandId = watchNoticeCommandId(watcher.sessionId, newId());
    await deliverHostNotice(
      { runtime: ports.runtime, report },
      {
        sessionId: watcher.sessionId,
        commandId,
        messageId: watchNoticeMessageId(commandId),
        metadata: notice.metadata,
        text: notice.text,
        label: `watch notice to ${shortSessionId(watcher.sessionId)}`,
      },
    );
  }

  function onSessionWake(event: SessionEvent): void {
    const payload = event.payload;
    // A watcher that stopped hears nothing more; whatever it had gathered
    // would be refused by a stopped Session anyway.
    if (payload.kind === "session.stopped") {
      const stopped = watchers.get(event.sessionId);
      if (stopped !== undefined) {
        if (stopped.timer !== undefined) clearTimer(stopped.timer);
        watchers.delete(event.sessionId);
      }
    }
    for (const watcher of watchers.values()) {
      const watch = watcher.sessions.get(event.sessionId);
      if (watch === undefined) continue;
      // The pending set is read when the change is seen, and only for a fact
      // that defers on it or names it.
      const readsPending =
        payload.kind === "session.signaled"
          ? watch.kinds.has("verdict")
          : (payload.kind === "turn.completed" || payload.kind === "turn.interrupted") &&
            watch.turnArmed &&
            watch.kinds.has("turn");
      const step = sessionWatchChanges(payload, watch, {
        watcherSessionId: watcher.sessionId,
        pendingChildren: readsPending ? pendingSubagents(event.sessionId) : [],
      });
      watch.turnArmed = step.turnArmed;
      if (step.ended) watcher.sessions.delete(event.sessionId);
      if (step.change !== null) enqueue(watcher, [step.change]);
      if (step.ended) prune(watcher);
    }
  }

  function onTicketWake(wake: TicketWake): void {
    const event = wake.event;
    for (const watcher of watchers.values()) {
      const watch = watcher.tickets.get(event.ticketId);
      if (watch === undefined) continue;
      const actorSessionId = event.actorContext?.sessionId;
      // What the watcher did itself is not news to it.
      if (!ticketWatchHears(watch, event.payload.kind, actorSessionId, watcher.sessionId)) continue;
      const change = ticketWatchChanges(event.payload, watch, {
        watcherSessionId: watcher.sessionId,
        actorSessionId,
        by: ticketEventWatchActor(event),
        comment:
          event.payload.kind === "commented" ? ports.readComment(event.payload.commentId) : null,
      });
      if (change !== null) enqueue(watcher, [change]);
    }
  }

  const unsubscribeSessions = ports.subscribeSessionWake((wake) => onSessionWake(wake.event));
  const unsubscribeTickets = ports.subscribeTicketWake(onTicketWake);

  return {
    watchSession(input) {
      if (input.kinds.length === 0 || input.watcherSessionId === input.targetSessionId) return;
      const watcher = watcherFor(input.watcherSessionId);
      const existing = watcher.sessions.get(input.targetSessionId);
      if (existing !== undefined) {
        for (const kind of input.kinds) existing.kinds.add(kind);
        existing.turnArmed ||= input.armTurn;
        if (input.title !== null) existing.title = input.title;
        return;
      }
      watcher.sessions.set(input.targetSessionId, {
        targetSessionId: input.targetSessionId,
        title: input.title,
        kinds: new Set(input.kinds),
        turnArmed: input.armTurn,
      });
    },
    watchTicket(input) {
      if (input.kinds.length === 0) return;
      const watcher = watcherFor(input.watcherSessionId);
      const existing = watcher.tickets.get(input.ticketId);
      if (existing !== undefined) {
        for (const kind of input.kinds) existing.kinds.add(kind);
        return;
      }
      watcher.tickets.set(input.ticketId, {
        ticketId: input.ticketId,
        display: input.display,
        kinds: new Set(input.kinds),
      });
    },
    unwatch(watcherSessionId, targets) {
      const watcher = watchers.get(watcherSessionId);
      if (watcher === undefined) return 0;
      let removed = 0;
      for (const id of targets.sessions ?? []) {
        if (watcher.sessions.delete(id)) removed += 1;
      }
      for (const id of targets.tickets ?? []) {
        if (watcher.tickets.delete(id)) removed += 1;
      }
      prune(watcher);
      return removed;
    },
    watching(watcherSessionId) {
      const watcher = watchers.get(watcherSessionId);
      return {
        sessions: [...(watcher?.sessions.values() ?? [])].map((watch) => ({
          id: watch.targetSessionId,
          turnArmed: watch.turnArmed,
        })),
        tickets: [...(watcher?.tickets.values() ?? [])].map((watch) => ({
          id: watch.ticketId,
          display: watch.display,
        })),
      };
    },
    dispose() {
      unsubscribeSessions();
      unsubscribeTickets();
      for (const watcher of watchers.values()) {
        if (watcher.timer !== undefined) clearTimer(watcher.timer);
      }
      watchers.clear();
    },
  };
}
