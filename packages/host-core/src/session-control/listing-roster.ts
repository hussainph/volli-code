/**
 * A whole listing's rows, provenance included (VC-392).
 *
 * `sessionListingRows` deliberately knows nothing about where a Session's
 * provenance comes from — it takes an answer per Session and builds a row. This
 * is the one place that joins the two: read the roster's provenance in one
 * batch, then build the rows from it.
 *
 * It lives here rather than in `data-ipc.ts` for two reasons. Electron main is
 * a host, not the product API (`docs/BOUNDARIES.md`), so a roster-shaped read
 * belongs beside the other Session read models rather than inside the
 * transport; and the performance harness that measures this tail
 * (`e2e/bench/session-listing-vc388.mjs`) can then measure the function the
 * handler actually calls. A bench that re-assembles the handler by hand
 * measures a copy, and a copy drifts.
 *
 * It is NOT the push channel's shape. `activity-watch.ts` has one Session in
 * hand, not a roster, and goes on calling `sessionListingRow` with
 * `readSessionProvenance`. That single reader is this same batch with one
 * Session in it, which is what keeps a fetch and a push from ever disagreeing
 * about who started a Session.
 */
import type Database from "better-sqlite3";
import type { SessionListingRow, SessionProjection } from "@volli/shared";

import { readSessionProvenance, readSessionProvenances } from "../db/session-provenance-repo";
import { readSessionUnread, readSessionUnreads } from "../db/session-read-repo";
import { sessionListingRow, sessionListingRows } from "./listing-row";

export function sessionListingRowsForRoster(
  db: Database.Database,
  sessions: readonly SessionProjection[],
  liveAttachmentIds: ReadonlySet<string>,
): SessionListingRow[] {
  const sessionIds = sessions.map((session) => session.session.id);
  const provenanceOf = readSessionProvenances(
    db,
    sessions.map((session) => ({
      sessionId: session.session.id,
      ticketId: session.session.ticketId,
    })),
  );
  // The second per-Session fact a row carries (VC-30), joined here for exactly
  // the reason provenance is: one set-based read for the whole roster, and the
  // same answer the push channel reads one Session at a time.
  const readOf = readSessionUnreads(db, sessionIds);
  return sessionListingRows(
    sessions,
    (session) => provenanceOf(session.session.id),
    liveAttachmentIds,
    (session) => readOf(session.session.id),
  );
}

/**
 * One Session's row, addressed to the windows that hold it — the shape
 * `volli:session-activity` carries (VC-30).
 *
 * The push channel builds its own rows inside `activity-watch.ts`, off a fold
 * it already has in hand. This is for the two writers that move a row WITHOUT
 * moving the ledger, so no durable write exists for that watch to notice: the
 * read-set handler (`volli:session-read-set`) and A1's viewing-clears-unread
 * hook. Both must reach every sidebar in every window, and both must publish
 * the SAME row the fetch would return — which is why this composes the same
 * `sessionListingRow` from the same two repos rather than patching a field onto
 * a row somebody else built.
 *
 * `null` means the ledger has no such Session: there is nothing to publish, and
 * the listing holding it will drop it on its own next read.
 */
export async function sessionListingNotice(
  ports: {
    db: Database.Database;
    getSession: (input: { sessionId: string }) => Promise<SessionProjection | null>;
    liveAttachmentIds: () => ReadonlySet<string>;
  },
  sessionId: string,
): Promise<{ projectId: string; ticketId: string | null; row: SessionListingRow } | null> {
  const projection = await ports.getSession({ sessionId });
  if (projection === null) return null;
  const row = sessionListingRow(
    projection,
    readSessionProvenance(ports.db, {
      sessionId: projection.session.id,
      ticketId: projection.session.ticketId,
    }),
    ports.liveAttachmentIds(),
    readSessionUnread(ports.db, sessionId),
  );
  return {
    projectId: projection.session.projectId,
    ticketId: projection.session.ticketId,
    row,
  };
}
