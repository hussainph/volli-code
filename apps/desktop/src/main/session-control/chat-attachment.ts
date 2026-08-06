import { sessionAwaitsUser } from "@volli/shared";
import type {
  ChatSessionRecord,
  SessionAttachmentProjection,
  SessionProjection,
} from "@volli/shared";

/**
 * Temporary IPC/UI compatibility projection, the structured sibling of
 * `terminalSessionRecord`. Unlike that one, this never returns `null`: a
 * Session with no structured attachment yet still has an honest identity to
 * name it by, so `adapterId` reads `null` and `live` reads `false` rather than
 * the caller getting nothing.
 *
 * PRECEDENCE: a Session that has ever opened a terminal attachment renders as
 * the terminal row (`terminalSessionRecord`), byte-for-byte unchanged — this
 * function is only ever reached for an attachment-less or structured-only
 * Session. The two are combined into a `SessionListingRow` at the renderer
 * seam (`data-ipc.ts`), not here: this function has no opinion about terminal
 * attachments at all, so that precedence has exactly one place to live.
 */
export function chatSessionRecord(projection: SessionProjection): ChatSessionRecord {
  const attachment = latestStructuredAttachment(projection.attachments);
  return {
    sessionId: projection.session.id,
    title: projection.session.title ?? "Session",
    projectId: projection.session.projectId,
    ticketId: projection.session.ticketId,
    createdAt: projection.session.createdAt,
    adapterId: attachment?.adapterId ?? null,
    live: attachment?.status === "open",
    activity: chatActivity(projection, attachment),
    lastActivityAt: projection.lastActivityAt,
  };
}

/**
 * Waiting outranks working, because an agent that has asked a question is still
 * inside an open turn: a row that said "working" there would hide the one thing
 * the user could actually do about it.
 *
 * Working then needs the attachment open as well as the turn, so a durable turn
 * that outlived its executor reads as what it is — nothing running — instead of
 * a Session that spins forever.
 */
function chatActivity(
  projection: SessionProjection,
  attachment: SessionAttachmentProjection | null,
): ChatSessionRecord["activity"] {
  if (sessionAwaitsUser(projection)) return "waiting";
  if (projection.turnActive && attachment?.status === "open") return "working";
  return "idle";
}

/** The newest attachment that is not the terminal adapter, or `null` if none has ever attached. */
export function latestStructuredAttachment(
  attachments: readonly SessionAttachmentProjection[],
): SessionAttachmentProjection | null {
  const matching = attachments.filter((attachment) => attachment.adapterId !== "terminal");
  return matching.at(-1) ?? null;
}
