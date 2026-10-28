/**
 * ONE migration decision for every table in `volli.db`, with the
 * reason beside it. `tables.test.ts` holds this register against a live
 * migrated schema and against the sources, so a migration that adds a table
 * cannot ship until someone has said what moving to Volli Cloud does with it
 * — the same discipline `backup/decisions.ts` applies to backups.
 *
 * - **export** — a source reads the rows and maps them to cloud records.
 * - **legacy** — no cloud table takes the rows; they are copied verbatim into
 *   the project's legacy archive (kept forever).
 * - **runner** — the rows stay in this Mac's runner-local SQLite and are not
 *   exported: the Session working ledger, machine state, local audit.
 * - **drop** — not carried into the cloud. The signed-out (frozen) database
 *   keeps them until it is retired.
 */

/** What the migration does with one table. */
export type MigrationTableDisposition = "export" | "legacy" | "runner" | "drop";

export interface MigrationTableDecision {
  readonly table: string;
  readonly disposition: MigrationTableDisposition;
  readonly reason: string;
}

export const MIGRATION_TABLE_DECISIONS: readonly MigrationTableDecision[] = [
  // ---- board and planner ------------------------------------------
  {
    table: "projects",
    disposition: "export",
    reason:
      "Projects, counters, primary repo, environment, rail prefs and project config; `path` to the runner.",
  },
  {
    table: "tickets",
    disposition: "export",
    reason: "Roster row and body; `worktree_path` becomes a runner-local Working copy path.",
  },
  { table: "labels", disposition: "export", reason: "Verbatim, merge aliases included." },
  { table: "ticket_labels", disposition: "export", reason: "Inlined as `tickets.labelIds`." },
  {
    table: "ticket_events",
    disposition: "export",
    reason: "Board events; a payload that is not JSON goes to the legacy archive.",
  },
  {
    table: "ticket_event_sequence",
    disposition: "export",
    reason: "Read for the durable order that becomes `boardEvents.seq`; not carried itself.",
  },
  { table: "ticket_comments", disposition: "export", reason: "Verbatim; author → Actor." },
  { table: "ticket_signals", disposition: "export", reason: "Verbatim; actor → Actor." },
  {
    table: "app_state",
    disposition: "export",
    reason:
      "Personal settings become config entries; schedule cursors are archived paused; client, runner and retired keys stay local.",
  },
  // ---- blobs ------------------------------------------------------
  {
    table: "blobs",
    disposition: "export",
    reason: "One row per linking project; bytes upload from `blobs/`. Unlinked blobs stay.",
  },
  { table: "blob_links", disposition: "export", reason: "Verbatim; owner columns → `owner`." },
  // ---- Session ledger ---------------------------------------------
  { table: "sessions", disposition: "export", reason: "Listing rows; the ledger stays local." },
  {
    table: "session_events",
    disposition: "export",
    reason: "Every envelope verbatim; the local ledger also stays as the runner's Retry buffer.",
  },
  {
    table: "session_provenances",
    disposition: "export",
    reason: "Read to re-inflate each event's provenance; not carried itself.",
  },
  { table: "session_read_receipts", disposition: "export", reason: "The person's read markers." },
  {
    table: "session_attachments",
    disposition: "runner",
    reason:
      "Its facts are `attachment.*` events; rows stay in the runner ledger. Open ones are a manifest preflight fact.",
  },
  {
    table: "session_commands",
    disposition: "runner",
    reason: "Its facts are `command.recorded` events; the rows stay in the runner ledger.",
  },
  {
    table: "session_command_receipts",
    disposition: "runner",
    reason: "Its facts are `command.receipt.recorded` events; rows stay in the runner ledger.",
  },
  {
    table: "session_event_sequence",
    disposition: "runner",
    reason: "The fleet-wide wait cursor; reactive queries replace it.",
  },
  {
    table: "session_projection_checkpoints",
    disposition: "runner",
    reason: "A local projection cache; the backend keeps its own bounded fold.",
  },
  {
    table: "session_follow_up_queue",
    disposition: "runner",
    reason: "Release stays a runner decision; preflight requires it settled.",
  },
  {
    table: "session_follow_up_identities",
    disposition: "runner",
    reason:
      "Exact follow-up replay proofs stay with the runner queue after its reply payloads are pruned.",
  },
  {
    table: "session_usage",
    disposition: "runner",
    reason: "A rebuildable index over `usage.recorded` events, which are exported.",
  },
  {
    table: "session_usage_coverage",
    disposition: "runner",
    reason: "Its `metered_from` boundary rides in the manifest.",
  },
  {
    table: "host_notice_outbox",
    disposition: "drop",
    reason: "Replaced by watches and notice jobs; preflight requires it drained.",
  },
  // ---- delegation -------------------------------------------------
  {
    table: "session_delegations",
    disposition: "export",
    reason: "Delegations; root rows restate `sessions.ticket_id` and are not carried.",
  },
  { table: "session_verb_grants", disposition: "export", reason: "Verbatim (birth-frozen)." },
  {
    table: "session_delegation_claims",
    disposition: "export",
    reason: "Merged into the child's delegation; an unminted claim goes to the legacy archive.",
  },
  {
    table: "session_delegation_extensions",
    disposition: "export",
    reason: "Verbatim, approved by the migrating person.",
  },
  // ---- Automations ------------------------------------------------
  {
    table: "automations",
    disposition: "export",
    reason: "Project Automations; an unbound one becomes a personal config entry.",
  },
  { table: "automation_runs", disposition: "export", reason: "Started Runs." },
  {
    table: "automation_commands",
    disposition: "legacy",
    reason: "The local Automation ledger is archived, not ported as rows.",
  },
  {
    table: "automation_events",
    disposition: "legacy",
    reason: "The local Automation ledger is archived, not ported as rows.",
  },
  {
    table: "automation_command_receipts",
    disposition: "legacy",
    reason: "The local Automation ledger is archived, not ported as rows.",
  },
  {
    table: "automation_run_deliveries",
    disposition: "runner",
    reason: "Becomes the runner's job journal; preflight requires every row delivered.",
  },
  {
    table: "automation_column_arming",
    disposition: "export",
    reason: "Archived paused with a re-arm reason; never executable after the move.",
  },
  { table: "automation_column_order", disposition: "export", reason: "Verbatim." },
  {
    table: "automation_skipped_occurrences",
    disposition: "export",
    reason: "Skipped Runs.",
  },
  {
    table: "automation_pending_armed_runs",
    disposition: "export",
    reason: "Archived paused with a re-arm reason; never becomes pending runner work.",
  },
  {
    table: "automation_pending_armed_run_attempts",
    disposition: "export",
    reason: "Failed Runs, error kept.",
  },
  {
    table: "automation_session_mint_intents",
    disposition: "drop",
    reason: "Its provenance is carried by the Run row and the Session's origin.",
  },
  // ---- machine, credential, retired, infrastructure ---------------
  {
    table: "worktree_cleanup_commands",
    disposition: "runner",
    reason: "Holds absolute paths; cloud trims are jobs and board events.",
  },
  {
    table: "worktree_cleanup_facts",
    disposition: "runner",
    reason: "Holds absolute paths; cloud trims are jobs and board events.",
  },
  {
    table: "worktree_cleanup_receipts",
    disposition: "runner",
    reason: "Holds absolute paths; cloud trims are jobs and board events.",
  },
  { table: "spawned_processes", disposition: "runner", reason: "Live pids and cwds." },
  { table: "registered_harnesses", disposition: "runner", reason: "Trust of bytes on this Mac." },
  { table: "harness_channel", disposition: "runner", reason: "Trust of bytes on this Mac." },
  {
    table: "mcp_servers",
    disposition: "export",
    reason: "Project config entries (credential references only); the catalog to the runner.",
  },
  {
    table: "mcp_operations",
    disposition: "export",
    reason: "Audit log rows; the local audit also stays.",
  },
  {
    table: "secrets",
    disposition: "runner",
    reason: "Stays sealed on this Mac; uploaded only on explicit opt-in.",
  },
  {
    table: "legacy_safe_storage_secrets",
    disposition: "drop",
    reason: "Only the old machine's keychain can open it.",
  },
  {
    table: "web_access_settings",
    disposition: "runner",
    reason: "Host-level and tied to local keys.",
  },
  {
    table: "web_credential_source",
    disposition: "runner",
    reason: "Lineage of the local sealed mirror.",
  },
  {
    table: "web_credential_mirror",
    disposition: "runner",
    reason: "Lineage of the local sealed mirror.",
  },
  {
    table: "authority_approvals",
    disposition: "drop",
    reason: "Retired: no writer, no reader.",
  },
  {
    table: "authority_decisions",
    disposition: "drop",
    reason: "Retired: no writer, no reader.",
  },
  {
    table: "authority_approval_completions",
    disposition: "drop",
    reason: "Retired: no writer, no reader.",
  },
  {
    table: "authority_approval_commands",
    disposition: "drop",
    reason: "Retired: no writer, no reader.",
  },
  {
    table: "authority_approval_events",
    disposition: "drop",
    reason: "Retired: no writer, no reader.",
  },
  {
    table: "host_identity",
    disposition: "drop",
    reason: "A runner's identity is its cloud runner row.",
  },
  { table: "workspace_epochs", disposition: "drop", reason: "Retired host authority." },
  { table: "workers", disposition: "drop", reason: "Retired host authority." },
  { table: "checkout_leases", disposition: "drop", reason: "Retired host authority." },
  { table: "devices", disposition: "drop", reason: "Retired host authority." },
  { table: "migration_history", disposition: "runner", reason: "Per-file history." },
  {
    table: "session_drain_cursors",
    disposition: "runner",
    reason: "The runner's own accepted cursors; the import writes the backend's side.",
  },
  {
    table: "project_checkout_paths",
    disposition: "runner",
    reason: "Absolute checkout folders belong to the runner, not the cloud project.",
  },
  {
    table: "working_copy_paths",
    disposition: "runner",
    reason: "Absolute Working-copy paths and observed git metadata stay on this runner.",
  },
  {
    table: "cloud_shadow_rows",
    disposition: "runner",
    reason: "Runner-local identity provenance, never authoritative cloud board rows.",
  },
  {
    table: "cloud_move_queues",
    disposition: "runner",
    reason: "This machine's move runs: the move itself, never part of what moves.",
  },
  {
    table: "cloud_moves",
    disposition: "runner",
    reason: "Each project move's journal and freeze marker stay on this machine.",
  },
  {
    table: "job_journal",
    disposition: "runner",
    reason: "Outcomes owed under this runner's leases.",
  },
  {
    table: "board_command_receipts",
    disposition: "drop",
    reason:
      "Seven-day replay receipts; the manifest counts those still in their window for the preflight.",
  },
];
