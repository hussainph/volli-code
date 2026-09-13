import type Database from "better-sqlite3";

import { prepared } from "./prepared";

/** One opaque base-36 cursor family over a host-private sequence. */
export interface SequenceCursorCodec {
  encode(sequence: number): string;
  decode(cursor: unknown): number | null;
}

export function createSequenceCursorCodec(prefix: string, label: string): SequenceCursorCodec {
  return {
    encode(sequence) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error(`Invalid ${label} sequence: ${String(sequence)}`);
      }
      return `${prefix}${sequence.toString(36)}`;
    },
    decode(cursor) {
      if (typeof cursor !== "string" || !cursor.startsWith(prefix)) return null;
      const encoded = cursor.slice(prefix.length);
      if (!/^(?:0|[1-9a-z][0-9a-z]*)$/.test(encoded)) return null;
      const sequence = Number.parseInt(encoded, 36);
      return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
    },
  };
}

/** AUTOINCREMENT's high-water mark, which does not move backwards after deletes. */
export function currentSqliteSequence(db: Database.Database, sequenceTable: string): number {
  const row = prepared<[string], { sequence: number }>(
    db,
    "SELECT seq AS sequence FROM sqlite_sequence WHERE name = ?",
  ).get(sequenceTable);
  return row?.sequence ?? 0;
}

export interface SequencedEventQuery {
  /** Trusted SQL identifiers and projection text supplied by a repository module. */
  select: string;
  sequenceTable: string;
  eventTable: string;
  ownerColumn: string;
}

/**
 * The common indexed fleet query behind Ticket Await and Session Await.
 * Domain repositories still decode their own row and mint their own cursor.
 */
export function firstMatchingSequencedRow<Row>(
  db: Database.Database,
  query: SequencedEventQuery,
  ownerIds: readonly string[],
  eventKinds: readonly string[],
  afterSequence: number,
): Row | undefined {
  if (ownerIds.length === 0 || eventKinds.length === 0) return undefined;
  return prepared<[number, string, string], Row>(
    db,
    `SELECT ${query.select}
       FROM ${query.sequenceTable} ordered
       JOIN ${query.eventTable} e ON e.id = ordered.event_id
      WHERE ordered.sequence > ?
        AND ordered.${query.ownerColumn} IN (SELECT value FROM json_each(?))
        AND ordered.kind IN (SELECT value FROM json_each(?))
      ORDER BY ordered.sequence ASC
      LIMIT 1`,
  ).get(afterSequence, JSON.stringify(ownerIds), JSON.stringify(eventKinds));
}
