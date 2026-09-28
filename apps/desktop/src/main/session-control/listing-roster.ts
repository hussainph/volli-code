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

import { readSessionProvenances } from "../db/session-provenance-repo";
import { sessionListingRows } from "./listing-row";

export function sessionListingRowsForRoster(
  db: Database.Database,
  sessions: readonly SessionProjection[],
  liveAttachmentIds: ReadonlySet<string>,
): SessionListingRow[] {
  const provenanceOf = readSessionProvenances(
    db,
    sessions.map((session) => ({
      sessionId: session.session.id,
      ticketId: session.session.ticketId,
    })),
  );
  return sessionListingRows(
    sessions,
    (session) => provenanceOf(session.session.id),
    liveAttachmentIds,
  );
}
