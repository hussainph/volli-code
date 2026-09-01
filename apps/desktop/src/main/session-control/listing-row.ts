import { PERSON_STARTED } from "@volli/shared";
import type { SessionListingRow, SessionProjection, SessionProvenance } from "@volli/shared";

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
 * every caller in the app supplies one, and a caller that did not would mark
 * nothing, which is the quiet failure rather than a wrong bolt.
 *
 * `liveAttachmentIds` is the process-local half of the projection. Structured
 * attachments deliberately remain durably open across relaunch so Pi can lazily
 * rehydrate them; only an id present in this set has an executor bound now.
 */
export function sessionListingRow(
  session: SessionProjection,
  provenance: SessionProvenance = PERSON_STARTED,
  /** Attachment ids with an executor binding in this process right now. */
  liveAttachmentIds: ReadonlySet<string> = NO_LIVE_ATTACHMENTS,
): SessionListingRow {
  const terminal = terminalSessionRecord(session);
  // The fold's own total, taken whichever arm the row lands on. A terminal row
  // is normally empty here — a manual companion runs models Volli never
  // mediated — but a Session that chatted before it opened a PTY has real
  // spend, and reading it off the projection is what keeps the two arms from
  // disagreeing about the same Session.
  const usage = session.usage;
  if (terminal !== null) return { kind: "terminal", record: terminal, usage, provenance };
  const structuredAttachment = latestStructuredAttachment(session.attachments);
  const executorBound =
    structuredAttachment !== null && liveAttachmentIds.has(structuredAttachment.id);
  return {
    kind: "chat",
    record: chatSessionRecord(session, executorBound),
    usage,
    provenance,
  };
}

/**
 * {@link sessionListingRow} over a whole listing.
 *
 * `provenanceOf` is asked per Session rather than handed a prebuilt map: the
 * reader behind it is two indexed point queries against SQLite, and a map would
 * have to be built from the same reads plus a second pass to key them.
 */
export function sessionListingRows(
  sessions: readonly SessionProjection[],
  provenanceOf: (session: SessionProjection) => SessionProvenance = () => PERSON_STARTED,
  liveAttachmentIds: ReadonlySet<string> = NO_LIVE_ATTACHMENTS,
): SessionListingRow[] {
  return sessions.map((session) =>
    sessionListingRow(session, provenanceOf(session), liveAttachmentIds),
  );
}
