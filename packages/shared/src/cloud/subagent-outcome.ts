/** Durable delegation outcomes, in the child's ledger order, never wall-clock order. */
import type { SessionEvent, SessionEventPayload, SessionStopActor } from "../session-ledger";
import { readSessionOrigin, type SessionOrigin } from "../session-origin";
import {
  SUBAGENT_NOTICE_COMMAND_ID_SUFFIX,
  SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX,
} from "../session-host-notice";
import type { SessionStopDetail } from "../session-stop";
import type { SubagentOutcomeState } from "../session-notice";

export interface SubagentOutcome {
  state: SubagentOutcomeState;
  stoppedBy: SessionStopActor | null;
  stopDetail: SessionStopDetail | null;
}

const emptyOutcome = (state: SubagentOutcomeState): SubagentOutcome => ({
  state,
  stoppedBy: null,
  stopDetail: null,
});

/**
 * One candidate outcome. The caller keeps the FIRST non-null candidate in
 * accepted sequence order: a later stop cannot overwrite an earlier answer
 * (or turn a kickoff rejection into a parent-stop suppression).
 *
 * The kickoff suffix is durable, shared with the offline delegation path.
 */
export function subagentOutcome(
  payload: SessionEventPayload,
  operationId: string,
  resumed = false,
): SubagentOutcome | null {
  switch (payload.kind) {
    case "command.receipt.recorded":
      return !resumed &&
        payload.receipt.status === "rejected" &&
        payload.receipt.commandId === `${operationId}:kickoff`
        ? emptyOutcome("failed")
        : null;
    case "turn.completed":
      return emptyOutcome("completed");
    case "turn.interrupted":
      return { ...emptyOutcome("interrupted"), stopDetail: payload.stopDetail ?? null };
    case "session.stopped":
      return { ...emptyOutcome("stopped"), stoppedBy: payload.by };
    case "attachment.failed":
      return emptyOutcome("failed");
    case "attachment.closed":
      return payload.outcome === "completed" ? null : emptyOutcome(payload.outcome);
    default:
      return null;
  }
}

/** Which Volli origins tell a child something rather than resume its work. */
const IS_HOST_NOTICE: Record<Extract<SessionOrigin, { kind: "volli" }>["reason"], boolean> = {
  "watch-notice": true,
  "subagent-notice": true,
  "browser-notice": true,
  "shell-notice": true,
  "worktree-notice": true,
  "relaunch-recovery": false,
  "scheduled-resume": false,
  supervision: false,
  "auto-title": false,
};

export function isSubagentHostNoticeOrigin(origin: SessionOrigin | null): boolean {
  return origin?.kind === "volli" && IS_HOST_NOTICE[origin.reason];
}

/** The slim fold's origin when present, else the command door's provenance. */
export function subagentCommandOrigin(event: SessionEvent): SessionOrigin | null {
  if (event.commandOrigin !== undefined) return event.commandOrigin;
  const detail = event.provenance?.source.detail;
  return typeof detail === "object" && detail !== null && !Array.isArray(detail)
    ? readSessionOrigin((detail as Record<string, unknown>).sessionOrigin)
    : null;
}

/** DURABLE, not live: both the local and cloud paths spend these frozen ids. */
export function subagentNoticeIds(
  operationId: string,
  turnId?: string,
): { commandId: string; messageId: string } {
  const prefix = turnId === undefined ? operationId : `${operationId}:resume:${turnId}`;
  return {
    commandId: `${prefix}${SUBAGENT_NOTICE_COMMAND_ID_SUFFIX}`,
    messageId: `${prefix}${SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX}`,
  };
}

/** A parent's own stop settles the slot without spending an answer notice id. */
export function suppressSubagentAnswer(outcome: SubagentOutcome, parentSessionId: string): boolean {
  return (
    outcome.state === "stopped" &&
    outcome.stoppedBy?.kind === "session" &&
    outcome.stoppedBy.sessionId === parentSessionId
  );
}
