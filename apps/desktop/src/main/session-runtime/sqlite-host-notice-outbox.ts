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
import { prepared } from "@volli/host-core/db/prepared";

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
