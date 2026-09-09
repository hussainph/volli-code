/**
 * `session.await` — the watch/wake tool over SESSIONS, host side (VC-324 item 3).
 *
 * `agent-await.ts`'s twin, one ledger over, and deliberately its shape: same
 * field names (`for`, `timeoutSeconds`, `cursor`), same subscribe-then-query
 * race discipline, same opaque total-order cursor, same "a refusal is a
 * sentence the model reads" rule. It is a SEPARATE tool rather than a
 * `sessions` field on `ticket_await`, because registry declaration order is
 * the frozen tool order: appending a tool shifts nothing, while growing an
 * existing tool's schema changes bytes for every Session already born — none
 * of which could ever use the new field anyway (Cache Prefix, CONTEXT.md).
 *
 * ## The gap it closes
 *
 * `ticket_await` wakes on planner facts only. A Board Session supervising a
 * fleet therefore had to make every child post a Ticket Signal at the end of
 * each stage merely to be waited on — and the facts nobody chose to publish
 * could not be waited on at all: on the ticket that produced this module a
 * one-hour host outage interrupted four subagents, and their parent learned it
 * from a steered notice rather than from anything it could park on. Every one
 * of those facts was already durable in each child's own Session ledger.
 *
 * ## Who may await whom
 *
 * Bound to the CALLER's project before any handle is parsed, exactly as
 * `supervise-session.ts` pins its target: no other project's Session is ever a
 * candidate, so a handle elsewhere is not nameable rather than refused. Within
 * that project, Role decides:
 *
 * - `project` (a Board Session) — any Session in its project. Orchestrating a
 *   fleet is what the Role is for.
 * - `ticket` — itself and the Sessions it delegated (`parentSessionId`). An
 *   executor waiting on its own helpers is as legitimate as an orchestrator
 *   waiting on a fleet; waiting on a SIBLING is supervision it does not hold.
 * - `subagent` — nothing. The bundle never hands it this tool (VC-9: a helper
 *   whose answer is its last message must not park), and this refusal is the
 *   second lock rather than the first.
 *
 * A Session awaiting ITSELF is allowed and is not a mistake: its own turn
 * cannot complete while its turn is parked here, but `session.stopped` is
 * written by somebody else, so a self-await is how a Session waits to be told
 * to stop.
 *
 * ## Nothing is ever missed
 *
 * A wake is an in-memory event, but every event a wake reports is ALSO a
 * durable Session Event. An opaque, total-order cursor closes the gap between
 * the two: subscribe first, then ask migration 042's sequence for the first
 * match after the cursor, and only park when that bounded query comes back
 * empty. Every wake and timeout returns a cursor, so chaining calls holds a
 * continuous window even when two events share a millisecond or a timeout
 * falls between the event and the next tool call.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionEngine } from "@volli/session-engine";
import {
  isSessionAwaitFor,
  MAX_SESSION_AWAIT_TARGETS,
  parseSessionAwaitTargets,
  sessionAwaitEventKinds,
  sessionAwaitKindsFor,
  shortSessionId,
  untrustedProseLines,
  type AuthorityPolicy,
  type Project,
  type RuntimeSessionIdentity,
  type RuntimeVerbCall,
  type RuntimeVerbResult,
  type Session,
  type SessionAwaitKind,
  type SessionEvent,
  type SessionStopActor,
} from "@volli/shared";

import {
  currentSessionEventCursor,
  decodeSessionEventCursor,
  firstMatchingSessionEventAfter,
} from "./db/session-events-cursor-repo";
import type { SubscribeSessionWake } from "./session-wake";
import { terminalSessionRecord } from "./session-control/terminal-attachment";
import { optionalPositiveNumber, parkForWake, waitRefusal as refusal } from "./agent-wait";

/** The Session read this tool needs: handles resolve inside one project's listing. */
export type AwaitSessionEngine = Pick<SessionEngine, "listSessions">;

/** What the await handler reaches, beyond the door's own options. */
export interface AwaitSessionPorts {
  db: Database.Database;
  projects: () => readonly Project[];
  /** The caller's project policy, read at call time — a wait is judged when it starts. */
  authorityPolicy: (projectId: string) => AuthorityPolicy;
  /** The post-commit Session wake bus (`session-wake.ts`). */
  subscribeSessionWake: SubscribeSessionWake;
  /**
   * The Session Engine, read per call and `null` when the structured runtime
   * never came up this launch — the same absence every other Session tool
   * reports in words rather than by throwing.
   */
  sessions: () => AwaitSessionEngine | null;
}

/** Who ended a Session's work, in the vocabulary the stop fact carries. */
function stoppedBy(by: SessionStopActor): string {
  if (by.kind === "session") return `By session ${shortSessionId(by.sessionId)}.`;
  if (by.kind === "watchdog") return "By Volli's watchdog.";
  return "By the user.";
}

/**
 * Another author's prose, between minted markers.
 *
 * A signal's reason is written by the target Session itself and a stop's
 * reason by whoever stopped it, and an orchestrator waking on one is exactly
 * the reader an injected instruction would like to reach. Same defence
 * `ticket_await` gives a signal detail: the id is minted per wake and never
 * shown to the author, so a line claiming to close the envelope is just more
 * of the prose.
 */
function untrustedProse(kind: string, text: string): string[] {
  return untrustedProseLines({ kind, text, id: randomUUID() });
}

/**
 * One waking event as the model reads it: typed facts bare, prose enveloped,
 * and the opaque cursor last so chaining it into the next call is the obvious
 * move rather than a documented one. `occurredAt` remains useful metadata; it
 * is never used as ledger order.
 *
 * No title, no transcript, no words the target chose — a wake is the handle,
 * the fact, and what to do next, the same bound the delegation notice keeps.
 */
function wakeText(handle: string, event: SessionEvent, cursor: string): string {
  const lines: string[] = [];
  const payload = event.payload;
  if (payload.kind === "turn.completed") {
    lines.push(`Session ${handle} completed its turn.`);
  } else if (payload.kind === "turn.interrupted") {
    // `interrupted`, never `ended`: the ledger separates the two kinds on
    // purpose, and the failure this tool was built for is a fleet that read
    // `idle` in a listing while four of its members had been cut off.
    lines.push(
      `Session ${handle} was interrupted mid-turn; its work did not finish.`,
      `Use session_send on Session ${handle} to continue it when its executor is available; otherwise a person can reattach it in the app.`,
    );
  } else if (payload.kind === "session.signaled") {
    lines.push(`Session ${handle} signaled ${payload.signal}.`);
    if (payload.reason !== null && payload.reason.trim().length > 0) {
      lines.push(...untrustedProse("signal reason", payload.reason));
    }
  } else if (payload.kind === "session.stopped") {
    lines.push(`Session ${handle} was stopped; its work has ended.`, stoppedBy(payload.by));
    if (payload.reason !== null && payload.reason.trim().length > 0) {
      lines.push(...untrustedProse("stop reason", payload.reason));
    }
  } else {
    // Unreachable through the await filter; stated rather than asserted so a
    // widened filter can never produce a wake the model cannot read.
    lines.push(`Session ${handle} recorded a ${payload.kind} event.`);
  }
  lines.push(
    `occurredAt: ${event.occurredAt}.`,
    `cursor: ${cursor}. Pass this cursor unchanged on your next session_await to miss nothing in between.`,
  );
  return lines.join("\n");
}

/** Why one Role may not await one target, or null when it may. */
function awaitBarrier(
  caller: RuntimeSessionIdentity,
  target: Session,
  handle: string,
): string | null {
  if (caller.role === "subagent") {
    return "A subagent Session may not await another Session; report what you found in your last message instead.";
  }
  if (caller.role === "project") return null;
  if (target.id === caller.sessionId || target.parentSessionId === caller.sessionId) return null;
  return `Session ${handle} is not this Session or one it delegated; a ticket Session may await only itself and its own subagents.`;
}

/**
 * Block until a watched Session finishes a turn, signals, or is stopped —
 * then wake with that one event. The tool half lives in the Verb Registry;
 * this is the whole host half.
 */
export async function awaitSessionTool(
  ports: AwaitSessionPorts,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  signal: AbortSignal,
): Promise<RuntimeVerbResult> {
  const sessionsRaw = request.input.sessions;
  const targets = typeof sessionsRaw === "string" ? parseSessionAwaitTargets(sessionsRaw) : [];
  if (targets.length === 0) {
    return refusal(
      "`sessions` must name at least one short session id, for example 'a1b2c3d4 e5f6a7b8'.",
    );
  }
  if (targets.length > MAX_SESSION_AWAIT_TARGETS) {
    return refusal(
      `\`sessions\` may name at most ${MAX_SESSION_AWAIT_TARGETS} sessions in one wait; split this fleet into smaller waits.`,
    );
  }
  const forRaw = request.input.for ?? "any";
  if (!isSessionAwaitFor(forRaw)) {
    return refusal("`for` must be one of: turn, verdict, stopped, any.");
  }
  const timeout = optionalPositiveNumber(request.input, "timeoutSeconds");
  if (!timeout.ok) return refusal(timeout.text);
  const cursorRaw = request.input.cursor;
  let cursor: string | undefined;
  if (cursorRaw !== undefined && cursorRaw !== null) {
    if (typeof cursorRaw !== "string" || decodeSessionEventCursor(cursorRaw) === null) {
      return refusal(
        "`cursor` must be an opaque cursor returned by a previous session_await call.",
      );
    }
    cursor = cursorRaw;
  }

  // Scoped to the caller's own project BEFORE any handle is parsed — the same
  // authority bound `session_stop` and `session_send` hold: no other project
  // is ever a candidate, so a Session elsewhere is not nameable rather than
  // refused.
  const project = ports.projects().find(({ id }) => id === session.projectId);
  if (project === undefined) {
    return refusal("This Session's project is no longer registered, so nothing can be awaited.");
  }
  const engine = ports.sessions();
  if (engine === null) {
    return refusal("The structured session runtime is not available, so nothing was awaited.");
  }

  const projections = await engine.listSessions({ projectId: project.id, scope: "all" });
  const watched = new Map<string, string>();
  for (const handle of targets) {
    const matches = projections.filter(
      (projection) => shortSessionId(projection.session.id) === handle,
    );
    if (matches.length === 0) {
      return refusal(
        `No session ${handle} in this project, so nothing was awaited. \`volli session list\` prints the handles.`,
      );
    }
    if (matches.length > 1) {
      return refusal(`Session id ${handle} is ambiguous in this project, so nothing was awaited.`);
    }
    const target = matches[0]!;
    const barrier = awaitBarrier(session, target.session, handle);
    if (barrier !== null) return refusal(barrier);
    if (terminalSessionRecord(target) !== null) {
      return refusal(
        `Session ${handle} is a terminal session, which records no turns, signals or stops to wake on.`,
      );
    }
    watched.set(target.session.id, handle);
  }

  // The per-call policy judgement VC-92 separated from bundle membership: the
  // caller is an authenticated Session by construction (the attachment bound
  // its identity), so its row is the one consulted. `awaitableSessions` is a
  // list of its own beside `awaitable`, because Ticket and Session facts are
  // two vocabularies over two ledgers and one merged list would give a project
  // no way to say "wait on your children, not on my board".
  const awaitable = ports.authorityPolicy(project.id).actors.session.awaitableSessions;
  const kinds = sessionAwaitKindsFor(forRaw).filter((kind: SessionAwaitKind) =>
    awaitable.includes(kind),
  );
  if (kinds.length === 0) {
    return refusal(
      awaitable.length === 0
        ? "This project's policy lets Sessions await no Session facts, so the wait was refused."
        : `This project's policy does not allow waiting for ${String(forRaw)}; it allows: ${awaitable.join(", ")}.`,
    );
  }
  const eventKinds = sessionAwaitEventKinds(kinds);
  const eventKindSet = new Set<string>(eventKinds);
  const handles = [...watched.values()].join(", ");

  // Subscribe first, establish/replay the cursor second: the shared wait
  // lifecycle guarantees an event is included in the durable query or arrives
  // through the live subscription — never neither.
  const continuousCursor = cursor ?? currentSessionEventCursor(ports.db);
  return parkForWake({
    signal,
    subscribe: ports.subscribeSessionWake,
    onWake: (wake) => {
      const handle = watched.get(wake.event.sessionId);
      return handle === undefined || !eventKindSet.has(wake.event.payload.kind)
        ? undefined
        : { text: wakeText(handle, wake.event, wake.cursor) };
    },
    ...(cursor === undefined
      ? {}
      : {
          replay: () => {
            const replayed = firstMatchingSessionEventAfter(
              ports.db,
              [...watched.keys()],
              eventKinds,
              cursor,
            );
            const handle =
              replayed === undefined ? undefined : watched.get(replayed.event.sessionId);
            return replayed === undefined || handle === undefined
              ? undefined
              : { text: wakeText(handle, replayed.event, replayed.cursor) };
          },
        }),
    ...(timeout.value === undefined
      ? {}
      : {
          timeoutMs: timeout.value * 1000,
          onTimeout: () => ({
            text: [
              `No matching event within ${timeout.value} seconds on ${handles} (waiting for: ${kinds.join(", ")}).`,
              `cursor: ${continuousCursor}. Pass this cursor unchanged to the next session_await; events committed after this wait began will be replayed.`,
            ].join("\n"),
          }),
        }),
  });
}
