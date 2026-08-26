import { SESSION_USER_BLOCKING_ATTENTION_KINDS, sessionAwaitsUser } from "@volli/shared";
import type {
  ChatSessionRecord,
  ChatWaitingReason,
  SessionAttachmentProjection,
  SessionAttentionKind,
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
    // A structured Session that has not yet exchanged a message is simply a
    // chat awaiting its subject — never the indistinguishable `Session` wall
    // the CLI start door used to create.
    title: projection.session.title ?? "Chat",
    projectId: projection.session.projectId,
    ticketId: projection.session.ticketId,
    createdAt: projection.session.createdAt,
    adapterId: attachment?.adapterId ?? null,
    live: attachment?.status === "open",
    activity: chatActivity(projection, attachment),
    waitingOn: chatWaitingOn(projection),
    lastActivityAt: projection.lastActivityAt,
    bornTicketless: projection.bornTicketless,
  };
}

/**
 * Stopped outranks everything (VC-86): a Session whose work was deliberately
 * ended cannot be helped by answering its stale question and is not "working"
 * however the turn flag was left — the stop fact is the newer truth, and the
 * fold already clears it the moment work genuinely resumes.
 *
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
  if (projection.stopped !== null) return "stopped";
  if (sessionAwaitsUser(projection)) return "waiting";
  if (projection.turnActive && attachment?.status === "open") return "working";
  return "idle";
}

/**
 * The user-blocking Attention kinds, in the coarser vocabulary a row can say.
 * Only the three {@link SESSION_USER_BLOCKING_ATTENTION_KINDS} appear: the rest
 * of the Attention vocabulary is the world blocking the agent, which no row
 * should ask a person to go fix.
 */
const WAITING_ON_BY_ATTENTION: Readonly<Partial<Record<SessionAttentionKind, ChatWaitingReason>>> =
  {
    input_required: "question",
    permission_required: "permission",
    auth_required: "auth",
    // `satisfies` against the shared list is the completeness pin: a fourth
    // user-blocking kind added there fails to compile here until it is given a
    // word, rather than silently reading as "not waiting".
  } satisfies Record<(typeof SESSION_USER_BLOCKING_ATTENTION_KINDS)[number], ChatWaitingReason>;

/**
 * What the Session is waiting on, in the same order {@link sessionAwaitsUser}
 * decides THAT it is waiting: an open Interaction is a question already asked
 * and outranks any Attention, then the first user-blocking Attention speaks.
 *
 * Reads the same two projection fields as `sessionAwaitsUser` in the same
 * precedence, so `activity === "waiting"` and `waitingOn !== null` cannot come
 * apart — one saying a human is needed while the other has nothing to tell them
 * to do is exactly the drift the shared predicate exists to prevent. Pinned by
 * a test rather than by comment alone.
 */
function chatWaitingOn(projection: SessionProjection): ChatWaitingReason | null {
  // A stopped Session is not waiting on anyone — the reason must go with the
  // state, or a row would say "Stopped" while handing the reader an errand.
  if (projection.stopped !== null) return null;
  if (projection.interactions.active.length > 0) return "question";
  for (const attention of projection.attention.active) {
    const reason = WAITING_ON_BY_ATTENTION[attention.kind];
    if (reason !== undefined) return reason;
  }
  return null;
}

/** The newest attachment that is not the terminal adapter, or `null` if none has ever attached. */
export function latestStructuredAttachment(
  attachments: readonly SessionAttachmentProjection[],
): SessionAttachmentProjection | null {
  const matching = attachments.filter((attachment) => attachment.adapterId !== "terminal");
  return matching.at(-1) ?? null;
}
