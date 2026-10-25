import { sessionListingActivity, sessionListingWaitingOn } from "@volli/shared";
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
export function chatSessionRecord(
  projection: SessionProjection,
  /**
   * Whether this process currently holds the attachment's executor binding.
   * Listing callers must supply this host fact: durable attachment openness is
   * intentionally reattachable across relaunch and therefore cannot answer it.
   * Omitted only by activity-only legacy callers, preserving their durable
   * interpretation until they gain a runtime port of their own.
   */
  executorBound = true,
): ChatSessionRecord {
  const attachment = latestStructuredAttachment(projection.attachments);
  const live = attachment?.status === "open" && executorBound;
  return {
    sessionId: projection.session.id,
    latestTurnOrigin: projection.latestTurnOrigin,
    resumedAfterStop: projection.resumedAfterStop,
    // A structured Session that has not yet exchanged a message is simply a
    // chat awaiting its subject — never the indistinguishable `Session` wall
    // the CLI start door used to create.
    title: projection.session.title ?? "Chat",
    projectId: projection.session.projectId,
    ticketId: projection.session.ticketId,
    createdAt: projection.session.createdAt,
    adapterId: attachment?.adapterId ?? null,
    live,
    // The listing rule is shared with the cloud listing row (`syncListing`).
    activity: sessionListingActivity(projection, live),
    waitingOn: sessionListingWaitingOn(projection),
    // Verbatim from the fold (VC-269): the projection already folds the
    // attachment's failure into the turn's outcome, so there is nothing for
    // this row to re-derive and no second reading of "failed" to drift.
    outcome: projection.lastTurnOutcome,
    lastActivityAt: projection.lastActivityAt,
    bornTicketless: projection.bornTicketless,
    role: projection.session.role,
    parentSessionId: projection.session.parentSessionId,
    // Verbatim from the fold, like `outcome` above (VC-416). The policy is
    // durable across attachment and relaunch, so a row carries the model a
    // Session is pinned to whether or not anything is attached to it now.
    model: projection.modelSelection,
  };
}

/** The newest attachment that is not the terminal adapter, or `null` if none has ever attached. */
export function latestStructuredAttachment(
  attachments: readonly SessionAttachmentProjection[],
): SessionAttachmentProjection | null {
  const matching = attachments.filter((attachment) => attachment.adapterId !== "terminal");
  return matching.at(-1) ?? null;
}
