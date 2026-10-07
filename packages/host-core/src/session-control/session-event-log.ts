/**
 * A Session's committed facts, as log lines (VC-699).
 *
 * The ledger is the one place every Session fact passes, so a line here is
 * the one place a viewer sees a Session's turns, attachments, commands and
 * Attention, whichever door, executor or background job caused them. Lines
 * are written after the transaction commits.
 *
 * **Which trace a fact carries**, in order:
 * 1. its command's, when this host recorded that command under a trace (a
 *    receipt reconciled later, a follow-up's delivery);
 * 2. its turn's, when this host saw the turn start under one (a turn's end,
 *    reported from the executor's own listener);
 * 3. the ambient one: the operation whose promise chain committed it. The
 *    executor's long-lived producers start detached
 *    (`session-runtime/correlated-executor`), so an ambient trace here is the
 *    request's own, not one inherited by a background listener;
 * 4. none. A fact is never filed under a trace it cannot be joined to.
 *
 * Identifiers, kinds and counts only: never a title, a message, a transcript
 * reference's content or a reason a person typed.
 */
import type { SessionEvent } from "@volli/shared";

import { logContext, withRootLogContext } from "../log/context";
import {
  commandTrace,
  rememberCommandTrace,
  rememberTurnTrace,
  turnTrace,
} from "../log/correlation";
import { hostLogger } from "../log/root";

const log = hostLogger("session");

/** The facts a person following an operation wants at `info`; the rest are `debug`. */
const INFO_KINDS: ReadonlySet<string> = new Set([
  "session.created",
  "session.archived",
  "session.stopped",
  "session.signaled",
  "command.recorded",
  "command.receipt.recorded",
  "attachment.opened",
  "attachment.failed",
  "attachment.closed",
  "attachment.exited",
  "run.started",
  "run.completed",
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "context.compacted",
  "context.compaction_failed",
  "attention.raised",
  "attention.cleared",
  "interaction.opened",
  "interaction.resolved",
  "interaction.cancelled",
]);

/** One line per committed fact, each under the trace it can be joined to. */
export function logSessionEvents(events: readonly SessionEvent[]): void {
  const ambient = logContext()["traceId"];
  const ambientTrace = typeof ambient === "string" ? ambient : undefined;
  for (const event of events) {
    const fields = sessionEventFields(event);
    const commandId = typeof fields["commandId"] === "string" ? fields["commandId"] : undefined;
    const turnId = typeof fields["turnId"] === "string" ? fields["turnId"] : undefined;
    const traceId = commandTrace(commandId) ?? turnTrace(event.sessionId, turnId) ?? ambientTrace;
    // Joined whatever the level: a later `info` line may need the join.
    if (traceId !== undefined) {
      if (commandId !== undefined) rememberCommandTrace(commandId, traceId);
      if (turnId !== undefined && event.payload.kind === "turn.started") {
        rememberTurnTrace(event.sessionId, turnId, traceId);
      }
    }
    const level = INFO_KINDS.has(event.payload.kind) ? "info" : "debug";
    if (!log.enabled(level)) continue;
    const write = () => log[level](`session ${event.payload.kind}`, fields);
    if (traceId === ambientTrace) write();
    else withRootLogContext(traceId === undefined ? {} : { traceId }, write);
  }
}

/** The identifiers a fact carries, by name. Nothing a person wrote. */
export function sessionEventFields(event: SessionEvent): Record<string, string | number> {
  const fields: Record<string, string | number> = {
    sessionId: event.sessionId,
    sequence: event.sequence,
  };
  if (event.attachmentId) fields["attachmentId"] = event.attachmentId;
  if (event.commandId) fields["commandId"] = event.commandId;
  const payload = event.payload as unknown as Record<string, unknown>;
  for (const key of ["turnId", "runId", "attachmentId", "attentionId", "signal", "exitCode"]) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number") fields[key] = value;
  }
  switch (event.payload.kind) {
    case "command.recorded":
      fields["commandId"] = event.payload.command.id;
      fields["intent"] = event.payload.command.intent.kind;
      break;
    case "command.receipt.recorded":
      fields["commandId"] = event.payload.receipt.commandId;
      fields["status"] = event.payload.receipt.status;
      break;
    case "attention.raised":
      fields["attentionId"] = event.payload.attention.id;
      fields["attention"] = event.payload.attention.kind;
      break;
    case "session.created":
      fields["projectId"] = event.payload.session.projectId;
      if (event.payload.session.ticketId !== null)
        fields["ticketId"] = event.payload.session.ticketId;
      fields["role"] = event.payload.session.role;
      break;
    case "attachment.opened":
    case "attachment.failed":
      fields["attachmentId"] = event.payload.attachment.id;
      break;
    case "interaction.opened":
      fields["interactionId"] = event.payload.interaction.id;
      break;
    default:
      break;
  }
  return fields;
}
