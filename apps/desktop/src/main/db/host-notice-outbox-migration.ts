/** VC-495: the complete sanitized notice precedes delivery, even while live. */
export const HOST_NOTICE_OUTBOX_MIGRATION = `
CREATE TABLE host_notice_outbox (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  notice TEXT CHECK (notice IS NULL OR json_valid(notice)),
  receipt TEXT CHECK (receipt IS NULL OR json_valid(receipt)),
  CHECK ((notice IS NOT NULL AND receipt IS NULL) OR
         (notice IS NULL AND receipt IS NOT NULL))
);
CREATE INDEX host_notice_outbox_pending ON host_notice_outbox(ordinal)
  WHERE receipt IS NULL;
`;
