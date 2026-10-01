/**
 * Whether a Session has unread work, read and written as a durable receipt
 * (VC-30 × VC-108).
 *
 * The same shape as `session-provenance-repo.ts`, deliberately: a per-Session
 * fact the Session ledger does not own, answered as a BATCH for the fetch path
 * (`listing-roster.ts`) and as ONE for the push path (`activity-watch.ts`), so
 * a fetched row and a pushed row can never disagree about a Session's dot. A
 * Session with no row rests at {@link SESSION_READ}, which is why an app where
 * nobody has ever left an agent running unattended stores nothing here.
 *
 * ── WHY A TABLE AND NOT A LEDGER FACT ─────────────────────────────────────
 * Reading is not work. A `session.read` command would append to
 * `session_events`, invalidate the projection checkpoint beside it and move
 * `lastActivityAt` — a Session would climb its own listing because somebody
 * looked at it. The whole state is one nullable stamp, its loss costs one wrong
 * dot, and nothing else in the app derives from it.
 *
 * ── WHY `markSessionUnread` IS NOT `writeSessionUnread` ───────────────────
 * "Unread since" answers "how long has this been waiting on me", so the FIRST
 * unfinished turn is the honest stamp. A second turn ending while the Session
 * is already unread must not restamp it back to now, which is exactly what an
 * unconditional write would do — and the rule that decides the edge
 * (`session-read-watch.ts`) fires once per turn boundary, not once per Session.
 * The conditional lives here, in SQL, so two writers racing cannot both win.
 */
import type Database from "better-sqlite3";
import { SESSION_READ, type SessionReadState } from "@volli/shared";

import { prepared } from "./prepared";

/**
 * A roster's answers, as a total function of Session id.
 *
 * A function rather than the `Map` it closes over, for `readSessionProvenances`'
 * reason: its caller wants exactly this shape (`sessionListingRows`' `readOf`),
 * and the `Map` then never leaves this module. A Session the batch was never
 * asked about answers the resting state, which is a defined answer rather than
 * a fallback — no receipt means nobody has left work here.
 */
export type SessionReadLookup = (sessionId: string) => SessionReadState;

/** The one shape a stored receipt comes back in. */
interface ReceiptRow {
  session_id: string;
  unread_since: number | null;
}

/**
 * Every named Session's read state, in one set-based query.
 *
 * The fetch path reads a whole roster (`volli:session-list` can answer sixty
 * Sessions), and a point query per row is what `readSessionProvenances` was
 * rewritten to stop doing. `json_each` over one bound array keeps the SQL text
 * identical for every roster size, so `prepared` caches one statement and no
 * roster can reach SQLite's bound-parameter limit — the idiom this file's
 * neighbours already use.
 */
export function readSessionUnreads(
  db: Database.Database,
  sessionIds: readonly string[],
): SessionReadLookup {
  const answers = new Map<string, SessionReadState>();
  const lookup: SessionReadLookup = (sessionId) => answers.get(sessionId) ?? SESSION_READ;
  if (sessionIds.length === 0) return lookup;
  for (const row of prepared<[string], ReceiptRow>(
    db,
    `SELECT session_id, unread_since
       FROM session_read_receipts
      WHERE session_id IN (SELECT value FROM json_each(?))`,
  ).iterate(JSON.stringify([...new Set(sessionIds)]))) {
    // A row whose stamp is NULL is READ, and storing it as the resting answer
    // rather than as an entry keeps one vocabulary for "nothing to say".
    if (row.unread_since === null) continue;
    answers.set(row.session_id, { unreadSince: row.unread_since });
  }
  return lookup;
}

/**
 * One Session's read state — the batch above with a single id in it, so there
 * is exactly one implementation of this question in the process (VC-392's rule,
 * applied to the second per-Session fact a listing row carries).
 */
export function readSessionUnread(db: Database.Database, sessionId: string): SessionReadState {
  return readSessionUnreads(db, [sessionId])(sessionId);
}

/**
 * Sets a Session's receipt outright. `at === null` marks it read.
 *
 * Idempotent, and the door a PERSON's decision goes through: `U`, the context
 * menu, opening a Session, answering from a peek card. A person saying "unread"
 * means "as of now", so this one does restamp — unlike {@link markSessionUnread}
 * below, which is the automatic edge and must not.
 */
export function writeSessionUnread(
  db: Database.Database,
  sessionId: string,
  at: number | null,
): void {
  prepared<[string, number | null], unknown>(
    db,
    `INSERT INTO session_read_receipts (session_id, unread_since) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET unread_since = excluded.unread_since`,
  ).run(sessionId, at);
}

/**
 * Marks a Session unread ONLY if it is currently read.
 *
 * The automatic edge's door (`session-read-watch.ts`): a turn that ended while
 * nobody was looking. A Session that is already unread keeps the stamp of the
 * first such turn, because the dot's age answers "how long has this been
 * waiting on me" and a busy agent finishing four turns unattended has been
 * waiting since the first one.
 *
 * Written as one conditional statement rather than a read-then-write so the
 * rule holds even if two folds land in the same tick.
 */
export function markSessionUnread(db: Database.Database, sessionId: string, at: number): void {
  prepared<[string, number], unknown>(
    db,
    `INSERT INTO session_read_receipts (session_id, unread_since) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET unread_since = excluded.unread_since
        WHERE session_read_receipts.unread_since IS NULL`,
  ).run(sessionId, at);
}
