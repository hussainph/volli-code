/**
 * The archive a legacy row is kept in (`v1/p/<projectId>/legacy/<name>.ndjson.zst`):
 * the local Automation ledger's three tables share one archive, every other
 * table has its own. Shared by the dry run and the move engine, so a
 * rehearsal and a move write the same keys.
 */

/** The local Automation ledger, kept as one archive per project. */
const AUTOMATION_LEDGER_TABLES: ReadonlySet<string> = new Set([
  "automation_commands",
  "automation_events",
  "automation_command_receipts",
]);

/** The archive name (`legacyArchiveKey`'s `name`) for rows of `table`. */
export function legacyArchiveName(table: string): string {
  return AUTOMATION_LEDGER_TABLES.has(table) ? "automation-ledger" : table.replaceAll("_", "-");
}
