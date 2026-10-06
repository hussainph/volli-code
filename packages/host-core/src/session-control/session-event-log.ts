/**
 * A Session's committed facts, as log lines (VC-699).
 *
 * The ledger is the one place every Session fact passes, so a line here is
 * the one place a viewer sees a Session's turns, attachments, commands and
 * Attention, whichever door, executor or background job caused them. Lines
 * are written after the transaction commits, inside the operation that
 * appended the facts: a turn a Client's message opened carries that
 * message's trace.
 *
 * Identifiers, kinds and counts only: never a title, a message, a transcript
 * reference's content or a reason a person typed.
 */
import type { SessionEvent } from "@volli/shared";

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

/** One line per committed fact. */
export function logSessionEvents(events: readonly SessionEvent[]): void {
  for (const event of events) {
    const level = INFO_KINDS.has(event.payload.kind) ? "info" : "debug";
    if (!log.enabled(level)) continue;
    log[level](`session ${event.payload.kind}`, sessionEventFields(event));
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
