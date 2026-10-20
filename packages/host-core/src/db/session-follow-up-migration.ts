/** VC-675: expand-only; no new intent or event kind reaches N−1 history readers. */
export const SESSION_FOLLOW_UP_MIGRATION = `
CREATE TABLE IF NOT EXISTS session_follow_up_queue (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (json_valid(state)),
  pending_count INTEGER NOT NULL CHECK (pending_count >= 0)
);
CREATE INDEX IF NOT EXISTS session_follow_up_pending ON session_follow_up_queue(session_id)
  WHERE pending_count > 0;
`;
