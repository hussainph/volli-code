/**
 * VC-565: expand-only. The board's command receipts: one row per accepted
 * board command id, so a Client retrying a command whose answer it never
 * received gets the original answer instead of a second effect. No older
 * reader knows the table, and none needs it: an N−1 build writes the board
 * as it always has and leaves this table alone.
 */
export const BOARD_COMMAND_RECEIPTS_MIGRATION = `
CREATE TABLE IF NOT EXISTS board_command_receipts (
  workspace_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  reply TEXT NOT NULL CHECK (json_valid(reply)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, command_id)
);
CREATE INDEX IF NOT EXISTS board_command_receipts_created ON board_command_receipts(created_at);
`;
