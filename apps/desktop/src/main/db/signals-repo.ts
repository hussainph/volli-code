/**
 * `ticket_signals` table repo (migration 028): the typed verdict channel
 * VC-85 replaced the `VERDICT: FIRST-LINE` comment convention with.
 *
 * The comment precedent, deliberately: creating a signal also records a
 * `signaled` event in the SAME transaction, so the two can never drift —
 * either both the row and its event exist, or neither does. What differs from
 * `comments-repo.ts` is the shape of the read. A comment feed is read
 * chronologically because prose accumulates; a signal is STATE, and the
 * question asked of it is almost always "where does this ticket stand now",
 * which is the latest signal per kind and nothing else.
 *
 * There is no update and no delete. A verdict is not edited into a different
 * verdict — it is superseded by a newer signal of the same kind, which is what
 * makes the log worth trusting when someone reads back how a ticket got where
 * it is.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  TicketEventActor,
  TicketSignal,
  TicketSignalKind,
  TicketSignalVerdict,
} from "@volli/shared";
import { recordTicketEvent } from "./events-repo";
import { prepared } from "./prepared";

interface TicketSignalRow {
  id: string;
  ticket_id: string;
  session_id: string | null;
  actor: string;
  kind: string;
  verdict: string;
  detail: string | null;
  created_at: number;
}

function mapSignal(row: TicketSignalRow): TicketSignal {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    sessionId: row.session_id,
    actor: row.actor,
    // The vocabulary is a CHECK constraint in migration 028, so a row that
    // exists is a row whose kind and verdict are in the fixed lists. Narrowing
    // here is a cast rather than a re-validation for that reason.
    kind: row.kind as TicketSignalKind,
    verdict: row.verdict as TicketSignalVerdict,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export interface CreateSignalInput {
  ticketId: string;
  kind: TicketSignalKind;
  verdict: TicketSignalVerdict;
  /** Free prose; `null` when the signer supplied none. */
  detail?: string | null;
  /** {@link USER_ACTOR}, or the `"session"` token a socket write records. */
  actor: string;
  /** The Session that signed it. */
  sessionId?: string | null;
  /** Audit-log attribution for the originating command. */
  eventActor?: TicketEventActor;
}

/**
 * Inserts a signal row and records its `signaled` event in one transaction
 * (rollback leaves neither on failure — an unknown `ticketId`/`sessionId` FK
 * violation, or a kind the CHECK refuses).
 *
 * The event carries the WHOLE typed fact rather than a row id, which is where
 * it parts from `commented`. A comment event points at a body that may be
 * edited afterwards, so the pointer is the honest thing to store; a signal is
 * immutable, so the event can carry it outright — and that is what lets the
 * await tool and the activity feed read a verdict without a join.
 */
export function createSignal(
  db: Database.Database,
  input: CreateSignalInput,
  now: number,
): TicketSignal {
  const run = db.transaction((): TicketSignal => {
    const signal: TicketSignal = {
      id: randomUUID(),
      ticketId: input.ticketId,
      sessionId: input.sessionId ?? null,
      actor: input.actor,
      kind: input.kind,
      verdict: input.verdict,
      detail: input.detail ?? null,
      createdAt: now,
    };
    prepared(
      db,
      `INSERT INTO ticket_signals (id, ticket_id, session_id, actor, kind, verdict, detail, created_at)
       VALUES (@id, @ticketId, @sessionId, @actor, @kind, @verdict, @detail, @createdAt)`,
    ).run(signal);
    recordTicketEvent(
      db,
      input.ticketId,
      {
        kind: "signaled",
        signalKind: signal.kind,
        verdict: signal.verdict,
        detail: signal.detail,
      },
      now,
      input.eventActor,
    );
    return signal;
  });
  return run();
}

/**
 * Where a ticket stands: the newest signal of each kind, oldest first.
 *
 * ONE indexed read, not one per kind. The window function ranks each kind's
 * rows inside SQL over `ticket_signals_latest`, so a ticket signalled a hundred
 * times still answers with a handful of rows and no per-kind round trip — which
 * is the whole point of the table for an orchestrator that polls it.
 *
 * Ordered by when each surviving signal was recorded, so a reader sees the
 * ticket's stages in the order they actually happened rather than in an
 * alphabetical order that means nothing.
 */
export function listLatestSignals(db: Database.Database, ticketId: string): TicketSignal[] {
  const rows = prepared<[string], TicketSignalRow>(
    db,
    // `rowid` is carried into the CTE under a name, because a CTE has no rowid
    // of its own — the insertion-order tiebreak has to travel with the row it
    // describes or the outer ORDER BY has nothing to break the tie with.
    `WITH ranked AS (
       SELECT s.id, s.ticket_id, s.session_id, s.actor, s.kind, s.verdict, s.detail,
              s.created_at, s.rowid AS row_id,
              ROW_NUMBER() OVER (
                PARTITION BY s.kind ORDER BY s.created_at DESC, s.rowid DESC
              ) AS rn
         FROM ticket_signals s
        WHERE s.ticket_id = ?
     )
     SELECT id, ticket_id, session_id, actor, kind, verdict, detail, created_at
       FROM ranked
      WHERE rn = 1
      ORDER BY created_at ASC, row_id ASC`,
  ).all(ticketId);
  return rows.map(mapSignal);
}

/** A ticket's whole signal history, chronological — the audit read behind the latest one. */
export function listSignals(db: Database.Database, ticketId: string): TicketSignal[] {
  const rows = prepared<[string], TicketSignalRow>(
    db,
    "SELECT * FROM ticket_signals WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC",
  ).all(ticketId);
  return rows.map(mapSignal);
}
