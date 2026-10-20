import { PERSON_STARTED, SESSION_READ } from "@volli/shared";
import type {
  SessionListingRow,
  SessionProjection,
  SessionProvenance,
  SessionReadState,
} from "@volli/shared";

import { chatSessionRecord, latestStructuredAttachment } from "./chat-attachment";
import { terminalSessionRecord } from "./terminal-attachment";

const NO_LIVE_ATTACHMENTS: ReadonlySet<string> = new Set();

/**
 * One Session, as the renderer's listings see it.
 *
 * PRECEDENCE: a Session that has ever opened a terminal attachment renders as
 * its terminal row, byte-for-byte what `terminalSessionRecord` always returned;
 * only an attachment-less or structured-only Session renders as a chat row.
 * Neither of those two functions has an opinion about the other, which is why
 * the precedence between them needs exactly one home.
 *
 * It lives here rather than inside `data-ipc.ts` because it now has two
 * callers, and they must not be allowed to disagree: the `volli:session-list`
 * fetch builds the rows a listing starts from, and `activity-watch.ts` builds
 * the rows that are pushed into it afterwards. A push shaped even slightly
 * differently from the fetch would make a Session change appearance the moment
 * it moved, which is precisely the bug a push channel exists to remove.
 *
 * `provenance` is passed IN rather than derived here for that same rule read
 * one level down: it is a fact about the Session that neither attachment
 * projection can see (it lives in the Automation records and the planner log,
 * not in the Session ledger), so the host reads it and hands it over. It
 * defaults to {@link PERSON_STARTED} only for callers that have no reader —
 * both app callers supply one, and a caller that did not would mark nothing,
 * which is the quiet failure rather than a wrong bolt.
 *
 * `liveAttachmentIds` is the process-local half of the projection. Structured
 * attachments deliberately remain durably open across relaunch so Pi can lazily
 * rehydrate them; only an id present in this set has an executor bound now.
 *
 * `read` arrives the same way `provenance` does, and for the same reason
 * (VC-30): whether a Session has unread work is a durable fact neither
 * attachment projection can see — it lives in `session_read_receipts` — so the
 * host reads it and hands it over. It defaults to {@link SESSION_READ}, the
 * resting state, so a caller with no receipt reader marks nothing rather than
 * guessing. Both app callers supply one, which is what keeps a fetched row and
 * a pushed row identical.
 *
 * Unlike `provenance`, the resting answer is written as the field's ABSENCE
 * rather than as a value — `SessionListingRow.read` is optional precisely so a
 * row with nothing to say carries nothing, and `sessionReadStateOf` turns the
 * miss back into {@link SESSION_READ}. That is what keeps a read Session's row
 * byte-identical to the row this builder returned before unread existed, which
 * matters because the renderer upserts whole rows and the push channel gates on
 * them differing.
 */
export function sessionListingRow(
  session: SessionProjection,
  provenance: SessionProvenance = PERSON_STARTED,
  /** Attachment ids with an executor binding in this process right now. */
  liveAttachmentIds: ReadonlySet<string> = NO_LIVE_ATTACHMENTS,
  read: SessionReadState = SESSION_READ,
): SessionListingRow {
  const terminal = terminalSessionRecord(session);
  // The fold's own total, taken whichever arm the row lands on. A terminal row
  // is normally empty here — a manual companion runs models Volli never
  // mediated — but a Session that chatted before it opened a PTY has real
  // spend, and reading it off the projection is what keeps the two arms from
  // disagreeing about the same Session.
  const usage = session.usage;
  const unread = read.unreadSince === null ? {} : { read };
  if (terminal !== null)
    return { kind: "terminal", record: terminal, usage, provenance, ...unread };
  const structuredAttachment = latestStructuredAttachment(session.attachments);
  const executorBound =
    structuredAttachment !== null && liveAttachmentIds.has(structuredAttachment.id);
  return {
    kind: "chat",
    record: chatSessionRecord(session, executorBound),
    usage,
    provenance,
    ...unread,
  };
}

/**
 * {@link sessionListingRow} over a whole listing.
 *
 * `provenanceOf` stays a function of one Session so this file keeps having no
 * opinion about where the answers come from. A caller with a whole roster in
 * hand reads them in one batch and closes over the result
 * (`sessionListingRowsForRoster`, VC-392); a caller with one Session asks for
 * one (`activity-watch.ts`). Either way the row is built from an answer handed
 * in, which is what keeps the fetch and the push identical.
 */
export function sessionListingRows(
  sessions: readonly SessionProjection[],
  provenanceOf: (session: SessionProjection) => SessionProvenance = () => PERSON_STARTED,
  liveAttachmentIds: ReadonlySet<string> = NO_LIVE_ATTACHMENTS,
  readOf: (session: SessionProjection) => SessionReadState = () => SESSION_READ,
): SessionListingRow[] {
  return sessions.map((session) =>
    sessionListingRow(session, provenanceOf(session), liveAttachmentIds, readOf(session)),
  );
}
