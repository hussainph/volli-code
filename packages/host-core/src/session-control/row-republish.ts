/**
 * Re-publishing one Session's listing row when no ledger fact moved (VC-30).
 *
 * Two writers change what a row SAYS without changing anything the activity
 * watch can notice: the read-set door (`volli:session-read-set`) and A1's
 * viewing-clears-unread hook in `index.ts`. Both must reach every sidebar in
 * every window, and both must send the row a fetch would return.
 *
 * They had assembled that themselves — the same three ports, the same
 * {@link sessionListingNotice} call, the same broadcast of its result — which
 * is two chances to disagree about what "the same row" means. This is that
 * composition once. `sessionListingNotice` stays the builder; this is the
 * publish beside it.
 *
 * A Session the ledger no longer has publishes nothing: there is no row to
 * send, and the listing holding it drops it on its own next read.
 */
import type Database from "better-sqlite3";
import type { SessionListingRow, SessionProjection } from "@volli/shared";

import { sessionListingNotice } from "./listing-roster";

export interface SessionRowPublishPorts {
  db: Database.Database;
  getSession: (input: { sessionId: string }) => Promise<SessionProjection | null>;
  liveAttachmentIds: () => ReadonlySet<string>;
  /**
   * Where the row goes — `broadcastSessionActivity` in both callers. A port
   * rather than a direct import so this composition is testable without an
   * Electron window list behind it.
   */
  publish: (notice: { projectId: string; ticketId: string | null; row: SessionListingRow }) => void;
}

/** Builds this Session's listing row and broadcasts it, if the ledger still has it. */
export async function publishSessionListingRow(
  ports: SessionRowPublishPorts,
  sessionId: string,
): Promise<void> {
  const notice = await sessionListingNotice(
    {
      db: ports.db,
      getSession: ports.getSession,
      liveAttachmentIds: ports.liveAttachmentIds,
    },
    sessionId,
  );
  if (notice !== null) ports.publish(notice);
}
