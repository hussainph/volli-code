/**
 * VC-892: expand-only. Two runner-local tables for Volli Cloud, machine state
 * that never leaves the runner (no board or Session rows):
 *
 * - `session_drain_cursors`: for each Session this runner has claimed, the
 *   last sequence the backend accepted. Every ledger event above it is still
 *   owed (the ledger is the retry buffer). `blocked_*` records a refusal that
 *   stopped the drain, so it is visible and survives a restart.
 * - `job_journal`: job outcomes the runner owes the backend, written before
 *   they are reported and deleted once `complete` answers.
 *
 * No older reader knows either table, and none needs to: an N−1 build never
 * composes the cloud runner and leaves them alone.
 */
export const RUNNER_DRAIN_MIGRATION = `
CREATE TABLE IF NOT EXISTS session_drain_cursors (
  session_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  claim_generation INTEGER NOT NULL,
  accepted_through INTEGER NOT NULL CHECK (accepted_through >= 0),
  blocked_code TEXT,
  blocked_message TEXT,
  blocked_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_journal (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  lease_boot_id TEXT NOT NULL,
  lease_attempt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  received_at INTEGER NOT NULL
);
`;
