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
import {
  SESSION_LISTING_BOUNDS,
  type ListSessionsQuery,
  type SessionListingPage,
  type SessionListingRow,
  type SessionProjection,
} from "@volli/shared";

import { readSessionProvenance, readSessionProvenances } from "../db/session-provenance-repo";
import { getTicketRow } from "../db/tickets-repo";
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
 * What a host's Session listing reads: its database, the Session Engine's
 * roster, and which attachments have an executor bound in this process.
 */
export interface SessionListingSources {
  readonly db: Database.Database;
  readonly listSessions: (query: ListSessionsQuery) => Promise<readonly SessionProjection[]>;
  readonly liveAttachmentIds: () => ReadonlySet<string>;
}

/**
 * A project's whole listing: every Session, every scope. The one body both
 * doors read — the desktop's `volli:session-list` and the host protocol's
 * `session.listing` (VC-713) — so a remote row and a local row are built the
 * same way.
 */
export async function projectSessionListing(
  sources: SessionListingSources,
  projectId: string,
): Promise<SessionListingRow[]> {
  const sessions = await sources.listSessions({ projectId, scope: "all" });
  return sessionListingRowsForRoster(sources.db, sessions, sources.liveAttachmentIds());
}

/**
 * One ticket's listing (`volli:session-list-for-ticket`,
 * `session.listingForTicket`). A ticket this host does not have lists nothing.
 */
export async function ticketSessionListing(
  sources: SessionListingSources,
  ticketId: string,
): Promise<SessionListingRow[]> {
  const ticket = getTicketRow(sources.db, ticketId);
  if (ticket === undefined) return [];
  const sessions = await sources.listSessions({
    projectId: ticket.project_id,
    scope: "ticket",
    ticketId,
  });
  return sessionListingRowsForRoster(sources.db, sessions, sources.liveAttachmentIds());
}

/** The most rows one `session.listing` answer carries (VC-713). */
export const SESSION_LISTING_LIMIT = SESSION_LISTING_BOUNDS.rows;

/** A row a reopened app must show: a Session waiting on the person, or running now. */
function urgent(row: SessionListingRow): boolean {
  return (
    row.kind === "chat" && (row.record.activity === "waiting" || row.record.activity === "working")
  );
}

/** A display string past its bound, shortened with an ellipsis, never through a surrogate pair. */
export function clipListingText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function clipNullable(text: string | null, max: number): string | null {
  return text === null ? null : clipListingText(text, max);
}

/** A row with its display strings inside the wire's bounds; ids are never touched. */
function clippedRow(row: SessionListingRow): SessionListingRow {
  const { text, path } = SESSION_LISTING_BOUNDS;
  const provenance =
    row.provenance.kind === "automation"
      ? {
          ...row.provenance,
          automationName: clipNullable(row.provenance.automationName, text),
        }
      : row.provenance.kind === "session"
        ? { ...row.provenance, parentTitle: clipNullable(row.provenance.parentTitle, text) }
        : row.provenance;
  if (row.kind === "terminal") {
    return {
      ...row,
      provenance,
      record: {
        ...row.record,
        title: clipListingText(row.record.title, text),
        cwd: clipListingText(row.record.cwd, path),
      },
    };
  }
  const origin = row.record.latestTurnOrigin;
  return {
    ...row,
    provenance,
    record: {
      ...row.record,
      title: clipListingText(row.record.title, text),
      ...(origin?.kind === "automation"
        ? {
            latestTurnOrigin: {
              ...origin,
              automationName: clipNullable(origin.automationName, text),
            },
          }
        : {}),
    },
  };
}

/** A row's size on the wire: its UTF-8 JSON, escapes included. */
function wireBytes(row: SessionListingRow): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

/**
 * A listing bounded for the wire, in rows and in bytes, order kept. The rows a
 * person must act on (`waiting`) or that are running (`working`) are taken
 * first, since those are what a reopened app must show, then the rest by
 * newest activity, each clipped to the wire's string bounds, until the next
 * would pass {@link SESSION_LISTING_LIMIT} rows or `byteBudget` bytes of JSON.
 * Everything not taken is counted in `omitted`, never silently dropped, and
 * what is taken keeps the listing's own order.
 */
export function boundedSessionListing(
  rows: readonly SessionListingRow[],
  limit: number = SESSION_LISTING_LIMIT,
  byteBudget: number = SESSION_LISTING_BOUNDS.bytes,
): SessionListingPage {
  const ranked = rows.toSorted(
    (a, b) =>
      Number(urgent(b)) - Number(urgent(a)) || b.record.lastActivityAt - a.record.lastActivityAt,
  );
  const kept = new Map<SessionListingRow, SessionListingRow>();
  // The array's brackets; each row after the first adds its comma.
  let bytes = 2;
  for (const row of ranked) {
    if (kept.size >= limit) break;
    const clipped = clippedRow(row);
    const size = wireBytes(clipped) + (kept.size === 0 ? 0 : 1);
    if (bytes + size > byteBudget) break;
    bytes += size;
    kept.set(row, clipped);
  }
  const sessions = rows.flatMap((row) => {
    const clipped = kept.get(row);
    return clipped === undefined ? [] : [clipped];
  });
  return { sessions, omitted: rows.length - sessions.length };
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
