/** Compact runner-local proof, not a second queue or a Session message index. */
export const SESSION_FOLLOW_UP_IDENTITIES_MIGRATION = `
CREATE TABLE IF NOT EXISTS session_follow_up_identities (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
) WITHOUT ROWID;
`;
