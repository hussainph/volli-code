/**
 * Watch rules: which facts a watch reports, and the structured change each
 * one becomes. Written once, so the local in-process watches
 * (`packages/host-core/src/watches.ts`) and the cloud backend's durable watches
 * decide alike.
 *
 * A **Session** watch hears its target's verdicts and stop for as long as it
 * lives, and the end of its next turn once (`turnArmed`). A turn that ends
 * while the target still has subagents pending is DEFERRED: nothing is
 * reported and the arm is kept, so the watcher hears the turn end at which the
 * target is actually done. An interrupted turn is a failure and is never
 * deferred. A stop ends the watch; a stop the watcher made itself is not
 * reported back to it.
 *
 * A **Ticket** watch hears moves, comments and signals, except those the
 * watcher made itself.
 *
 * What kinds a watch hears is project policy, read when it is armed.
 */

import type { BoardEventPayload } from "./cloud/board-events";
import type { SessionAwaitKind } from "./session-await";
import type { SessionEventPayload } from "./session-ledger";
import { noticeProse, type WatchChangeV1, type WatchTicketActor } from "./session-notice";
import { TICKET_AWAIT_EVENT_KINDS, type TicketAwaitKind } from "./ticket-await";
import type { TicketEvent, TicketEventPayload } from "./ticket-events";

/** A watch's kinds, as a live Set (local) or a stored list (cloud). */
export type WatchKinds<K extends string> = ReadonlySet<K> | readonly K[];

function hasKind<K extends string>(kinds: WatchKinds<K>, kind: K): boolean {
  return Array.isArray(kinds)
    ? (kinds as readonly K[]).includes(kind)
    : (kinds as ReadonlySet<K>).has(kind);
}

/** One Session watch, as the rules read it. */
export interface SessionWatchState {
  targetSessionId: string;
  /** The target's title when the watch was armed; `null` names it by handle. */
  title: string | null;
  kinds: WatchKinds<SessionAwaitKind>;
  /** Whether the end of the target's next turn reports. */
  turnArmed: boolean;
}

export interface SessionWatchContext {
  watcherSessionId: string;
  /** The target's subagents that have not answered yet, read when the fact is seen. */
  pendingChildren: readonly string[];
  /** When the fact happened; omit to leave the notice untimed (the local path). */
  occurredAt?: number | null;
  /** Cut other authors' prose at this many characters (a queued notice); omit to keep it whole. */
  proseLimit?: number;
}

export interface SessionWatchStep {
  /** The change to report, or `null` when this fact reports nothing to this watch. */
  change: WatchChangeV1 | null;
  /** Whether the next turn end still reports, after this fact. */
  turnArmed: boolean;
  /** Whether this fact ends the watch. */
  ended: boolean;
}

/**
 * What one accepted fact of a watched Session does to one watch. A turn-end
 * change carries `lastMessage: unread`; a producer that can read the target's
 * last message replaces it before composing.
 */
export function sessionWatchChanges(
  fact: SessionEventPayload,
  watch: SessionWatchState,
  context: SessionWatchContext,
): SessionWatchStep {
  const quiet: SessionWatchStep = { change: null, turnArmed: watch.turnArmed, ended: false };
  const base = {
    subject: "session" as const,
    sessionId: watch.targetSessionId,
    title: watch.title,
    occurredAt: context.occurredAt ?? null,
  };
  const prose = (text: string | null) =>
    text === null ? null : noticeProse(text, context.proseLimit);
  switch (fact.kind) {
    case "turn.completed":
    case "turn.interrupted": {
      if (!watch.turnArmed || !hasKind(watch.kinds, "turn")) return quiet;
      // Between turns, not done: the target's subagents will open its next
      // turn. Keep the arm so the end that really is the end is heard.
      if (fact.kind === "turn.completed" && context.pendingChildren.length > 0) return quiet;
      const pendingSubagents = [...context.pendingChildren];
      const change: WatchChangeV1 =
        fact.kind === "turn.completed"
          ? { ...base, fact: "turn-completed", pendingSubagents, lastMessage: { state: "unread" } }
          : {
              ...base,
              fact: "turn-interrupted",
              pendingSubagents,
              stopDetail: fact.stopDetail ?? null,
              lastMessage: { state: "unread" },
            };
      return { change, turnArmed: false, ended: false };
    }
    case "session.signaled":
      if (!hasKind(watch.kinds, "verdict")) return quiet;
      return {
        change: {
          ...base,
          fact: fact.signal === "done" ? "signaled-done" : "signaled-blocked",
          pendingSubagents: [...context.pendingChildren],
          reason: prose(fact.reason),
        },
        turnArmed: watch.turnArmed,
        ended: false,
      };
    case "session.stopped": {
      // The watcher's own stop was confirmed by its tool result.
      const bySelf = fact.by.kind === "session" && fact.by.sessionId === context.watcherSessionId;
      return {
        change:
          hasKind(watch.kinds, "stopped") && !bySelf
            ? { ...base, fact: "stopped", by: fact.by, reason: prose(fact.reason) }
            : null,
        turnArmed: watch.turnArmed,
        ended: true,
      };
    }
    default:
      return quiet;
  }
}

/** One Ticket watch, as the rules read it. */
export interface TicketWatchState {
  ticketId: string;
  /** The Ticket's display id, e.g. `VC-12`. */
  display: string;
  kinds: WatchKinds<TicketAwaitKind>;
}

export interface TicketWatchContext {
  watcherSessionId: string;
  /** The Session the event names as its author, if any: what the watcher did itself is not news. */
  actorSessionId: string | null | undefined;
  by: WatchTicketActor;
  /** For a `commented` event: the comment's body, or `null` when it was deleted. */
  comment?: string | null;
  occurredAt?: number | null;
  /** Cut other authors' prose at this many characters (a queued notice); omit to keep it whole. */
  proseLimit?: number;
}

/** Whether a Ticket watch hears an event of `eventKind` by `actorSessionId`. */
export function ticketWatchHears(
  watch: Pick<TicketWatchState, "kinds">,
  eventKind: string,
  actorSessionId: string | null | undefined,
  watcherSessionId: string,
): boolean {
  if (actorSessionId === watcherSessionId) return false;
  const kinds: readonly TicketAwaitKind[] = Array.isArray(watch.kinds)
    ? (watch.kinds as readonly TicketAwaitKind[])
    : [...(watch.kinds as ReadonlySet<TicketAwaitKind>)];
  return kinds.some((kind) => TICKET_AWAIT_EVENT_KINDS[kind] === eventKind);
}

/** The Ticket event payloads a watch can report: a local event's or a cloud board event's. */
export type TicketWatchPayload = Extract<
  TicketEventPayload | BoardEventPayload,
  { kind: "status_changed" | "commented" | "signaled" }
>;

function isTicketWatchPayload(
  payload: TicketEventPayload | BoardEventPayload,
): payload is TicketWatchPayload {
  return (
    payload.kind === "status_changed" || payload.kind === "commented" || payload.kind === "signaled"
  );
}

/**
 * The change one Ticket event reports to one watch, or `null` when it is not
 * a kind a watch reports or the watch does not hear it. Takes a local Ticket
 * event's payload or a cloud board event's: the watched kinds share one shape.
 */
export function ticketWatchChanges(
  payload: TicketEventPayload | BoardEventPayload,
  watch: TicketWatchState,
  context: TicketWatchContext,
): WatchChangeV1 | null {
  if (!isTicketWatchPayload(payload)) return null;
  if (!ticketWatchHears(watch, payload.kind, context.actorSessionId, context.watcherSessionId)) {
    return null;
  }
  const base = {
    subject: "ticket" as const,
    ticketId: watch.ticketId,
    display: watch.display,
    by: context.by,
    occurredAt: context.occurredAt ?? null,
  };
  switch (payload.kind) {
    case "status_changed":
      return { ...base, fact: "ticket-moved", from: payload.from, to: payload.to };
    case "commented": {
      const body = context.comment ?? null;
      return {
        ...base,
        fact: "ticket-commented",
        comment: body === null ? null : noticeProse(body, context.proseLimit),
      };
    }
    case "signaled":
      return {
        ...base,
        fact: "ticket-signaled",
        signalKind: payload.signalKind,
        verdict: payload.verdict,
        detail: payload.detail === null ? null : noticeProse(payload.detail, context.proseLimit),
      };
  }
}

/** Who made a local Ticket event, as a watch notice names them. */
export function ticketEventWatchActor(
  event: Pick<TicketEvent, "actor" | "actorContext">,
): WatchTicketActor {
  const session = event.actorContext?.sessionId;
  if (event.actor === "session" && session !== undefined) {
    return { kind: "session", sessionId: session };
  }
  if (event.actor === "automation") return { kind: "automation" };
  if (event.actor === "session") return { kind: "session", sessionId: null };
  if (event.actor === "unauthenticated") return { kind: "unauthenticated" };
  return { kind: "person" };
}
