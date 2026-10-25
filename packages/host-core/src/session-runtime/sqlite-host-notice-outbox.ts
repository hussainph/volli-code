/**
 * Main's host-notice storage adapter. All access MUST use the Session writer's
 * synchronous transaction: no callback may yield while SQLite is in a
 * transaction, and put() resolves only after commit.
 * No raw shell output reaches this adapter; producers hand it a complete,
 * sanitized HostNotice, including its already-minted envelope nonce.
 */
import type Database from "better-sqlite3";
import type { SessionLedger } from "@volli/shared";
import type { HostNotice, HostNoticeOutbox, HostNoticeReceipt } from "@volli/session-engine";
import { prepared } from "../db/prepared";
import { settleTransaction } from "../db/transaction-gate";

export function createSqliteHostNoticeOutbox(
  db: Database.Database,
  writer: Pick<SessionLedger, "transaction">,
): HostNoticeOutbox {
  return {
    put: (notice) =>
      writer.transaction(() => {
        prepared(
          db,
          `INSERT INTO host_notice_outbox(command_id, session_id, notice, receipt)
           VALUES (?, ?, ?, NULL) ON CONFLICT(command_id) DO NOTHING`,
        ).run(notice.commandId, notice.sessionId, JSON.stringify(notice));
        const row = prepared(
          db,
          "SELECT session_id, notice FROM host_notice_outbox WHERE command_id = ?",
        ).get(notice.commandId) as { session_id: string; notice: string | null };
        if (row.session_id !== notice.sessionId) {
          throw new Error(`Host notice ${notice.commandId} belongs to a different Session`);
        }
        return row.notice === null ? null : (JSON.parse(row.notice) as HostNotice);
      }),
    pending: () =>
      writer.transaction(() => {
        const rows = prepared(
          db,
          "SELECT notice FROM host_notice_outbox WHERE receipt IS NULL ORDER BY ordinal",
        ).all() as { notice: string }[];
        return rows.map(({ notice }) => JSON.parse(notice) as HostNotice);
      }),
    settle: (commandId: string, receipt: HostNoticeReceipt) =>
      writer.transaction(() => {
        prepared(
          db,
          `UPDATE host_notice_outbox SET notice = NULL, receipt = ?
           WHERE command_id = ? AND receipt IS NULL`,
        ).run(JSON.stringify(receipt), commandId);
      }),
  };
}

/**
 * Scope the machine-state outbox without creating another writer. Candidate
 * session ids are filtered BEFORE decoding notice text, so another owner's
 * malformed payload cannot break this launch's recovery. All mutations still
 * go through the original outbox and its Session transaction owner.
 */
export function scopeSqliteHostNoticeOutbox(
  db: Database.Database,
  outbox: HostNoticeOutbox,
  ownsSession: (sessionId: string) => boolean,
): HostNoticeOutbox {
  const assertOwner = (sessionId: string) => {
    if (!ownsSession(sessionId))
      throw new Error("The host notice is outside this launch's Session scope");
  };
  return {
    async put(notice) {
      assertOwner(notice.sessionId);
      return outbox.put(notice);
    },
    pending: () =>
      settleTransaction(db, () => {
        const rows = prepared<[], { session_id: string; notice: string }>(
          db,
          "SELECT session_id, notice FROM host_notice_outbox WHERE receipt IS NULL ORDER BY ordinal",
        ).all();
        return rows
          .filter((row) => ownsSession(row.session_id))
          .map((row) => {
            const notice = JSON.parse(row.notice) as HostNotice;
            if (notice.sessionId !== row.session_id)
              throw new Error("Host notice belongs to a different Session");
            return notice;
          });
      }),
    async settle(commandId, receipt) {
      const row = prepared<[string], { session_id: string }>(
        db,
        "SELECT session_id FROM host_notice_outbox WHERE command_id = ?",
      ).get(commandId);
      if (row !== undefined) assertOwner(row.session_id);
      return outbox.settle(commandId, receipt);
    },
  };
}

/** What the machine-state outbox already holds for one notice id. */
export type StoredHostNotice =
  | { state: "absent" }
  | { state: "pending"; notice: HostNotice }
  | { state: "settled" };

/**
 * Reads one notice id before a producer composes it, so a replayed producer
 * (a re-leased `session.notice` job) neither rebuilds the text nor mints a
 * new nonce for an id the outbox already holds or has settled. A read, not a
 * claim: the put that follows an `absent` answer is still first-writer-wins.
 */
export function readSqliteHostNotice(
  db: Database.Database,
  commandId: string,
  sessionId: string,
): StoredHostNotice {
  // One statement: a consistent read without taking the Session writer.
  const row = prepared<[string], { session_id: string; notice: string | null }>(
    db,
    "SELECT session_id, notice FROM host_notice_outbox WHERE command_id = ?",
  ).get(commandId);
  if (row === undefined) return { state: "absent" };
  if (row.session_id !== sessionId)
    throw new Error(`Host notice ${commandId} belongs to a different Session`);
  return row.notice === null
    ? { state: "settled" }
    : { state: "pending", notice: JSON.parse(row.notice) as HostNotice };
}
