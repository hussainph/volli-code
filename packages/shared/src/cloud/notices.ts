/**
 * Session notices as runner jobs (VC-887): the backend builds and coalesces
 * them, the watcher's runner composes and delivers them.
 *
 * A watch notice waits as a queued `session.notice` job for the watcher's
 * runner. While it is still unclaimed, later changes are merged into it
 * ({@link mergeWatchNotice}), so a runner that slept through forty changes
 * wakes to one notice. A notice lists at most {@link WATCH_NOTICE_MAX_CHANGES}
 * changes and stays within {@link JOB_PAYLOAD_MAX_CHARS}; past either, later
 * changes are counted in `overflow` and the facts stay where they happened
 * (the board, each Session's history).
 *
 * The runner composes the text with {@link composeSessionNotice} when it puts
 * the notice into its outbox, minting the envelope nonce there and once.
 */

import {
  SUBAGENT_NOTICE_COMMAND_ID_SUFFIX,
  SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX,
  watchNoticeMessageId,
} from "../session-host-notice";
import {
  composeSubagentNotice,
  composeWatchNotice,
  type ComposedNotice,
  type WatchChangeV1,
  type WatchTicketActor,
} from "../session-notice";
import type { Actor } from "./actor";
import {
  JOB_PAYLOAD_MAX_CHARS,
  SESSION_NOTICE_FORMAT,
  WATCH_NOTICE_MAX_CHANGES,
  type SessionNoticeJobPayload,
  type WatchNoticeJobPayload,
} from "./job-payloads";

/**
 * The message id a notice's message is recorded under, derived from its
 * command id exactly as the local writers derive it: `{commandId}:message` for
 * a watch notice, `{operationId}:answer-message` for a subagent's.
 */
export function sessionNoticeMessageId(payload: SessionNoticeJobPayload): string {
  if (payload.notice === "watch") return watchNoticeMessageId(payload.commandId);
  return `${payload.commandId.slice(0, -SUBAGENT_NOTICE_COMMAND_ID_SUFFIX.length)}${SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX}`;
}

/** An empty watch notice, to merge the first changes into. */
export function newWatchNotice(commandId: string): WatchNoticeJobPayload {
  return { format: SESSION_NOTICE_FORMAT, notice: "watch", commandId, changes: [], overflow: 0 };
}

/**
 * `notice` with `changes` appended in order. A change that would pass
 * {@link WATCH_NOTICE_MAX_CHANGES} or {@link JOB_PAYLOAD_MAX_CHARS} is counted in
 * `overflow` instead, and so is every change after it, so the listed changes
 * are always the earliest ones. Returns a new payload; `notice` is unchanged.
 */
export function mergeWatchNotice(
  notice: WatchNoticeJobPayload,
  changes: readonly WatchChangeV1[],
): WatchNoticeJobPayload {
  const merged: WatchNoticeJobPayload = {
    ...notice,
    changes: [...notice.changes],
    overflow: notice.overflow,
  };
  for (const change of changes) {
    if (merged.overflow === 0 && merged.changes.length < WATCH_NOTICE_MAX_CHANGES) {
      const candidate = { ...merged, changes: [...merged.changes, change] };
      if (JSON.stringify(candidate).length <= JOB_PAYLOAD_MAX_CHARS) {
        merged.changes = candidate.changes;
        continue;
      }
    }
    merged.overflow += 1;
  }
  return merged;
}

/**
 * Who made a board event, as a watch notice names them, and the Session it
 * names as its author (a watcher's own acts are not news to it).
 */
export function boardEventWatchActor(actor: Actor): {
  by: WatchTicketActor;
  actorSessionId: string | null;
} {
  switch (actor.kind) {
    case "person":
      return { by: { kind: "person" }, actorSessionId: null };
    case "agent":
      return {
        by: { kind: "session", sessionId: actor.sessionId },
        actorSessionId: actor.sessionId,
      };
    case "automation":
      return { by: { kind: "automation" }, actorSessionId: actor.sessionId ?? null };
    case "volli":
      return { by: { kind: "volli" }, actorSessionId: null };
    case "legacy": {
      const sessionId = actor.sessionId ?? null;
      switch (actor.was) {
        case "session":
          return { by: { kind: "session", sessionId }, actorSessionId: sessionId };
        case "automation":
          return { by: { kind: "automation" }, actorSessionId: sessionId };
        case "unauthenticated":
          return { by: { kind: "unauthenticated" }, actorSessionId: sessionId };
        case "user":
          return { by: { kind: "person" }, actorSessionId: sessionId };
      }
    }
  }
}

export interface ComposedSessionNotice extends ComposedNotice {
  commandId: string;
  messageId: string;
}

/**
 * The notice a runner puts into its outbox for a `session.notice` job.
 * `sessionId` is the job's Session: the watcher, or the subagent's parent.
 * `nonce` mints untrusted-prose envelope ids (a subagent notice uses none).
 */
export function composeSessionNotice(
  payload: SessionNoticeJobPayload,
  input: { sessionId: string; nonce: () => string },
): ComposedSessionNotice {
  const ids = { commandId: payload.commandId, messageId: sessionNoticeMessageId(payload) };
  if (payload.notice === "watch") {
    return {
      ...ids,
      ...composeWatchNotice({
        watcherSessionId: input.sessionId,
        changes: payload.changes,
        overflow: payload.overflow,
        nonce: input.nonce,
      }),
    };
  }
  return {
    ...ids,
    ...composeSubagentNotice({
      parentSessionId: input.sessionId,
      childSessionId: payload.childSessionId,
      title: payload.title,
      state: payload.state,
      reason: payload.reason,
      stoppedBy: payload.stoppedBy,
      stopDetail: payload.stopDetail,
      answer: payload.answer,
    }),
  };
}
