/**
 * ONE explicit backup decision for every persisted thing: include, rebuild, or
 * exclude, with the reason beside it.
 *
 * This is the register the rest of `backup/` reads, and `decisions.test.ts`
 * holds every entry against a live migrated schema. That pairing is the point
 * — a migration that adds a table cannot ship until someone has said what a
 * backup does with it. The failure mode being designed out is the one the
 * JSON export already had: data that is simply absent, with nothing on the
 * page telling a person whether that was a decision or an oversight.
 *
 * The three verbs mean three different things and are never interchangeable:
 *
 * - **include** — the bundle carries the rows. A restore puts them back.
 * - **rebuild** — the bundle carries no rows, because a restore can derive
 *   every one of them from something it does carry, and does. Never a synonym
 *   for "large" or "awkward".
 * - **exclude** — the bundle must NOT carry them: credentials, machine-local
 *   trust, or a handle to a running thing that will not exist on the machine
 *   that reads the bundle.
 *
 * {@link COLUMN_REDACTIONS} is the fourth case, and it is a narrowing of
 * "include" rather than a fourth verb: the row travels, one value in it does
 * not. Every entry there is a local path or a live handle, and each is
 * restored by asking the person (a project directory) or by leaving it empty
 * for the app to fill when it next creates the resource.
 */

/** What a backup does with one persisted table. */
export type BackupDecisionKind = "include" | "rebuild" | "exclude";

export interface TableBackupDecision {
  table: string;
  decision: BackupDecisionKind;
  /** Why — one sentence, read by a person auditing what left their machine. */
  reason: string;
}

/**
 * How a redacted value travels.
 *
 * - `clear` writes SQL NULL.
 * - `blank` writes the empty string, for a NOT NULL column whose real value
 *   the restore obtains from the person (`projects.path`).
 * - `strip-json-keys` removes the named keys anywhere inside a stored JSON
 *   document, at any depth, leaving the rest of the document intact.
 */
export type RedactionRule =
  | { kind: "clear" }
  | { kind: "blank" }
  | { kind: "strip-json-keys"; keys: readonly string[] };

export interface ColumnRedaction {
  table: string;
  column: string;
  rule: RedactionRule;
  reason: string;
}

export interface ProfileFileDecision {
  /** Profile-relative path or glob — what the area is called on disk. */
  area: string;
  decision: BackupDecisionKind;
  reason: string;
}

/**
 * Every table in the schema, with its decision.
 *
 * Order here is presentation only; {@link BACKUP_INCLUDED_TABLES} owns the
 * restore order, because that one has to satisfy foreign keys.
 */
export const TABLE_BACKUP_DECISIONS: readonly TableBackupDecision[] = [
  // ---- Board and ticket records -------------------------------------------
  {
    table: "projects",
    decision: "include",
    reason: "The project record itself; its local `path` is redacted and re-mapped at restore.",
  },
  {
    table: "tickets",
    decision: "include",
    reason:
      "The user's work, including archived tickets, `pr_url` and `retention_keep`; `worktree_path` is redacted.",
  },
  { table: "labels", decision: "include", reason: "Per-project labels the tickets reference." },
  {
    table: "ticket_labels",
    decision: "include",
    reason: "The ticket/label junction; without it every ticket restores unlabelled.",
  },
  {
    table: "ticket_events",
    decision: "include",
    reason:
      "Immutable ticket history; local durable history is canonical and cannot be re-derived.",
  },
  {
    table: "ticket_event_sequence",
    decision: "include",
    reason:
      "The durable total order over ticket events; re-deriving it from timestamps would reorder a same-millisecond pair.",
  },
  {
    table: "ticket_signals",
    decision: "include",
    reason: "Verdicts a Session recorded against a ticket, and the ordering readers page by.",
  },
  {
    table: "ticket_comments",
    decision: "include",
    reason: "Comment bodies from people and Sessions alike.",
  },
  // ---- Session ledgers -----------------------------------------------------
  {
    table: "sessions",
    decision: "include",
    reason: "Session identity, role and parentage — durable ahead of any executor.",
  },
  {
    table: "session_events",
    decision: "include",
    reason:
      "The canonical ordered Session history; `provenance` and `payload` have terminal working directories stripped.",
  },
  {
    table: "session_commands",
    decision: "include",
    reason: "Explicit intent, persisted before delivery; receipts and events reference it.",
  },
  {
    table: "session_command_receipts",
    decision: "include",
    reason: "Durable acceptance receipts; without them a replay could duplicate accepted work.",
  },
  {
    table: "session_attachments",
    decision: "include",
    reason:
      "Events reference an attachment id, so the row travels; its live native handle and cwd do not.",
  },
  {
    table: "session_delegations",
    decision: "include",
    reason: "Birth-frozen delegation ancestry; it outlives the ticket and cannot be recomputed.",
  },
  {
    table: "session_verb_grants",
    decision: "include",
    reason: "The frozen per-Session verb grant a restored Session's tool surface is built from.",
  },
  {
    table: "session_delegation_claims",
    decision: "include",
    reason: "Claimed fan-out slots; dropping them would let a replay re-spend a slot.",
  },
  {
    table: "session_delegation_extensions",
    decision: "include",
    reason: "Approved extra delegation slots — a person's decision, not a derivable one.",
  },
  // ---- Blobs ---------------------------------------------------------------
  {
    table: "blobs",
    decision: "include",
    reason: "Attachment metadata; the bytes ride as bundle artifacts keyed by the same hash.",
  },
  {
    table: "blob_links",
    decision: "include",
    reason: "What each attachment is attached to; without it restored bytes belong to nothing.",
  },
  // ---- Automations ---------------------------------------------------------
  {
    table: "automations",
    decision: "include",
    reason: "The Automation records themselves, with their trigger and runtime pins.",
  },
  {
    table: "automation_commands",
    decision: "include",
    reason: "The Automation command ledger the runs and receipts project from.",
  },
  {
    table: "automation_events",
    decision: "include",
    reason: "Immutable Automation facts; the projections below are derived from these.",
  },
  {
    table: "automation_command_receipts",
    decision: "include",
    reason: "Durable Automation acceptance receipts, so a replay stays idempotent.",
  },
  {
    table: "automation_runs",
    decision: "include",
    reason: "Run history with its resolved model and `attendance`.",
  },
  {
    table: "automation_run_deliveries",
    decision: "include",
    reason: "The idempotent first-message intent; losing it would silently drop instructions.",
  },
  {
    table: "automation_session_mint_intents",
    decision: "include",
    reason: "The pre-mint relation that makes an interrupted run recoverable.",
  },
  {
    table: "automation_column_arming",
    decision: "include",
    reason: "Which Automation a column fires on its own — state a person set by hand.",
  },
  {
    table: "automation_column_order",
    decision: "include",
    reason: "The ranked column order a person arranged; it travels with no project.",
  },
  {
    table: "automation_skipped_occurrences",
    decision: "include",
    reason: "Why a scheduled occurrence did not run — history a person reads after the fact.",
  },
  {
    table: "automation_pending_armed_runs",
    decision: "include",
    reason: "The queue of armed runs waiting to open; dropping it loses queued work.",
  },
  {
    table: "automation_pending_armed_run_attempts",
    decision: "include",
    reason: "Retry attempts and their errors behind the pending queue.",
  },
  // ---- Settings ------------------------------------------------------------
  {
    table: "app_state",
    decision: "include",
    reason:
      "Global settings, theme, retention and automation cursors; it holds no credential (see `secrets`).",
  },
  // ---- Rebuilt -------------------------------------------------------------
  {
    table: "session_usage",
    decision: "rebuild",
    reason:
      "An exact index over the `usage.recorded` events the bundle carries; restore rebuilds it and checks the result.",
  },
  {
    table: "session_usage_coverage",
    decision: "rebuild",
    reason:
      "One row, re-established at restore from the metering boundary in the data document; a fresh migration would claim complete coverage.",
  },
  // ---- Excluded ------------------------------------------------------------
  {
    table: "secrets",
    decision: "exclude",
    reason: "Credentials. A backup must never carry them, encrypted or not.",
  },
  {
    table: "legacy_safe_storage_secrets",
    decision: "exclude",
    reason: "Credential ciphertext bound to this machine's safeStorage key.",
  },
  {
    table: "web_access_settings",
    decision: "exclude",
    reason: "Web access configuration is credential-adjacent and machine-local.",
  },
  {
    table: "registered_harnesses",
    decision: "exclude",
    reason: "Harness trust is an exact-hash decision about binaries on THIS machine.",
  },
  {
    table: "harness_channel",
    decision: "exclude",
    reason: "Local channel health timestamps; meaningless on another machine.",
  },
];

/**
 * Included tables in restore order: every table appears after the tables it
 * references.
 *
 * Restore inserts with foreign keys off and runs `foreign_key_check` at the
 * end, so this order is not what makes a restore correct — but a bundle that
 * can only be written back in one order is a bundle whose shape someone has
 * actually thought about, and the test holds the order against
 * `pragma_foreign_key_list`.
 */
export const BACKUP_INCLUDED_TABLES: readonly string[] = [
  "projects",
  "labels",
  "tickets",
  "ticket_labels",
  "ticket_events",
  "ticket_event_sequence",
  "sessions",
  "session_delegations",
  "session_verb_grants",
  "session_delegation_claims",
  "session_delegation_extensions",
  "session_attachments",
  "session_commands",
  "session_events",
  "session_command_receipts",
  "ticket_comments",
  "ticket_signals",
  "blobs",
  "blob_links",
  "app_state",
  "automations",
  "automation_commands",
  "automation_events",
  "automation_command_receipts",
  "automation_runs",
  "automation_run_deliveries",
  "automation_session_mint_intents",
  "automation_column_arming",
  "automation_column_order",
  "automation_skipped_occurrences",
  "automation_pending_armed_runs",
  "automation_pending_armed_run_attempts",
];

/**
 * Values that never leave this machine, inside rows that do.
 *
 * Every entry is a local path or a handle to something running. Reusing one on
 * another machine is not merely useless, it is unsafe: a restored ticket
 * pointing at `/Users/someone/code/thing` would have Volli create worktrees
 * and run setup commands against whatever happens to be at that path there.
 *
 * `session_events.payload` and `.provenance` are stripped by KEY rather than
 * cleared, because they are immutable facts a restore must keep — an
 * `attachment.opened` fact stays a complete fact after the terminal's working
 * directory is removed from the adapter's open-shaped `detail`.
 */
export const COLUMN_REDACTIONS: readonly ColumnRedaction[] = [
  {
    table: "projects",
    column: "path",
    rule: { kind: "blank" },
    reason:
      "The source machine's checkout. Restore requires the person to map each project to a local directory.",
  },
  {
    table: "tickets",
    column: "worktree_path",
    rule: { kind: "clear" },
    reason: "A worktree directory on the source machine; the app creates a new one on demand.",
  },
  {
    table: "session_attachments",
    column: "native_id",
    rule: { kind: "clear" },
    reason: "A handle to a terminal process that does not exist on the restoring machine.",
  },
  {
    table: "session_attachments",
    column: "native_detail",
    rule: { kind: "strip-json-keys", keys: ["cwd"] },
    reason: "Adapter-native detail carries the terminal's working directory on the source machine.",
  },
  {
    table: "session_events",
    column: "provenance",
    rule: { kind: "strip-json-keys", keys: ["cwd"] },
    reason: "An adapter's provenance detail can repeat the terminal working directory.",
  },
  {
    table: "session_events",
    column: "payload",
    rule: { kind: "strip-json-keys", keys: ["cwd"] },
    reason: "Attachment facts embed the adapter's native detail, working directory included.",
  },
  {
    table: "session_commands",
    column: "route",
    rule: { kind: "strip-json-keys", keys: ["cwd"] },
    reason: "A frozen delivery route names the attachment it addressed, never a live directory.",
  },
];

/**
 * Files and directories under the profile root (Electron `userData`).
 *
 * The two included areas are bound to the functions that build them, so a
 * store that moves takes its declaration with it rather than leaving a stale
 * string here.
 */
export const PROFILE_FILE_DECISIONS: readonly ProfileFileDecision[] = [
  {
    area: "blobs",
    decision: "include",
    reason: "Attachment bytes. A restored ticket without them has lost its attachments.",
  },
  {
    area: "session-transcripts",
    decision: "include",
    reason: "Transcript artifacts; session events hold only references to these files.",
  },
  {
    area: "volli.db",
    decision: "rebuild",
    reason:
      "The database file itself is never copied; restore migrates a fresh one and writes the data document into it.",
  },
  {
    area: "volli.db.backup-v*",
    decision: "exclude",
    reason: "Migration safety copies of an older schema on this machine only.",
  },
  {
    area: "bin",
    decision: "exclude",
    reason: "The installed `volli` CLI shim — a machine-local install, re-created on demand.",
  },
  {
    area: "pi-sessions",
    decision: "exclude",
    reason: "Agent runtime scratch for live sessions; a runtime handle, not durable history.",
  },
  {
    area: "browser-pictures",
    decision: "exclude",
    reason: "Bounded capture cache for browser tabs; re-captured, never recovered.",
  },
];

/** The decision for one table, or `undefined` when nobody has declared one. */
export function tableBackupDecision(table: string): TableBackupDecision | undefined {
  return TABLE_BACKUP_DECISIONS.find((entry) => entry.table === table);
}

/** Every redaction that applies to one table. */
export function redactionsForTable(table: string): readonly ColumnRedaction[] {
  return COLUMN_REDACTIONS.filter((entry) => entry.table === table);
}
