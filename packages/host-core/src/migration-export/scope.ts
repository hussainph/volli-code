/** Read-only ownership projections for source queries and window ranks.
 * Profile/ledger mappers also enforce selection; ancestry reads the raw snapshot
 * to preserve visibility across projects. TEMP views never modify the snapshot.
 */
import type Database from "better-sqlite3";
import { localProductRow } from "../db/local-product";
import { SourceCorruptError } from "./sources";

export interface ExportSelection {
  projectIds?: readonly string[];
  includeRemovedProjects?: boolean;
}

export function selectionKey(options: ExportSelection): string {
  return JSON.stringify({
    projectIds:
      options.projectIds === undefined ? null : [...new Set(options.projectIds)].toSorted(),
    includeRemovedProjects: options.includeRemovedProjects ?? false,
  });
}

/** All ids are bound values. The only interpolated identifiers below are constants. */
export function selectLocalProduct(db: Database.Database, options: ExportSelection): void {
  // A broken FK must not disappear in the ownership joins below. Name it before
  // filtering, including when its missing owner makes project attribution impossible.
  const violation = db.prepare("PRAGMA main.foreign_key_check").get() as
    | { table: string; rowid: number | null; parent: string }
    | undefined;
  if (violation !== undefined) {
    const table = `"${violation.table.replaceAll('"', '""')}"`;
    const row =
      violation.rowid === null
        ? undefined
        : (db.prepare(`SELECT * FROM main.${table} WHERE rowid = ?`).get(violation.rowid) as
            | Record<string, unknown>
            | undefined);
    const id = row?.id ?? row?.session_id ?? violation.rowid;
    throw new SourceCorruptError(
      `orphan ${violation.table} ${String(id)}: missing ${violation.parent}`,
    );
  }
  // Some historical snapshots deliberately have no project FK (for example
  // failed Automation attempts). Ownership joins must not erase those orphans.
  for (const table of [
    "tickets",
    "sessions",
    "labels",
    "automations",
    "mcp_servers",
    "mcp_operations",
    "automation_skipped_occurrences",
    "automation_pending_armed_runs",
    "automation_pending_armed_run_attempts",
    "automation_column_arming",
    "automation_column_order",
  ]) {
    const orphan = db
      .prepare(
        `SELECT r.rowid FROM main.${table} r LEFT JOIN main.projects p ON p.id=r.project_id WHERE r.project_id IS NOT NULL AND p.id IS NULL LIMIT 1`,
      )
      .get() as { rowid: number } | undefined;
    if (orphan !== undefined)
      throw new SourceCorruptError(`orphan ${table} row ${orphan.rowid}: missing project`);
  }
  db.exec("CREATE TEMP TABLE selected_projects (id TEXT PRIMARY KEY)");
  const local = localProductRow("p", "project");
  if (options.projectIds === undefined) {
    db.exec(`INSERT INTO selected_projects SELECT p.id FROM main.projects p WHERE ${local}
      ${options.includeRemovedProjects === true ? "" : "AND p.removed_at IS NULL"}`);
  } else {
    const find = db.prepare(`SELECT p.id FROM main.projects p WHERE p.id = ? AND ${local}
      ${options.includeRemovedProjects === true ? "" : "AND p.removed_at IS NULL"}`);
    const insert = db.prepare("INSERT INTO selected_projects VALUES (?)");
    for (const id of new Set(options.projectIds)) {
      if (find.get(id) === undefined)
        throw new SourceCorruptError(`project ${id} is not an eligible local project`);
      insert.run(id);
    }
  }
  const view = (table: string, predicate: string) =>
    db.exec(
      // Both projections need physical order for durable display/filename ties.
      `CREATE TEMP VIEW ${table} AS SELECT ${table === "ticket_labels" || table === "blob_links" ? "r.rowid AS rowid," : ""} r.* FROM main.${table} r WHERE ${predicate}`,
    );
  view("projects", "r.id IN (SELECT id FROM selected_projects)");
  view(
    "tickets",
    `r.project_id IN (SELECT id FROM projects) AND ${localProductRow("r", "ticket")}`,
  );
  // Materialize ownership before the history view exists: the birth-owner
  // discriminator reads raw history and must not recurse through this view.
  db.exec(`CREATE TEMP TABLE local_sessions (id TEXT PRIMARY KEY);
    INSERT INTO local_sessions SELECT r.id FROM main.sessions r WHERE ${localProductRow("r", "session")}`);
  const foreignTicket = db
    .prepare(`SELECT r.id FROM main.sessions r WHERE r.project_id IN (SELECT id FROM projects)
    AND r.id IN (SELECT id FROM local_sessions) AND r.ticket_id IS NOT NULL AND r.ticket_id NOT IN (SELECT id FROM tickets) LIMIT 1`)
    .get() as { id: string } | undefined;
  if (foreignTicket !== undefined)
    throw new SourceCorruptError(
      `Session ${foreignTicket.id} names a ticket outside the selected local project`,
    );
  view(
    "sessions",
    `r.project_id IN (SELECT id FROM projects) AND r.id IN (SELECT id FROM local_sessions)`,
  );
  for (const table of [
    "labels",
    "mcp_servers",
    "mcp_operations",
    "automation_skipped_occurrences",
    "automation_pending_armed_runs",
    "automation_pending_armed_run_attempts",
    "automation_column_arming",
    "automation_column_order",
  ]) {
    view(table, "r.project_id IN (SELECT id FROM projects)");
  }
  for (const table of ["ticket_labels", "ticket_events", "ticket_comments", "ticket_signals"]) {
    view(table, "r.ticket_id IN (SELECT id FROM tickets)");
  }
  for (const table of [
    "session_events",
    "session_attachments",
    "session_read_receipts",
    "session_delegations",
    "session_verb_grants",
    "session_follow_up_queue",
    "automation_runs",
    "host_notice_outbox",
    "automation_run_deliveries",
  ]) {
    view(table, "r.session_id IN (SELECT id FROM sessions)");
  }
  view(
    "worktree_cleanup_commands",
    "EXISTS (SELECT 1 FROM json_each(r.intent,'$.items') item WHERE json_extract(item.value,'$.projectId') IN (SELECT id FROM projects))",
  );
  view(
    "session_delegation_claims",
    `(r.child_session_id IN (SELECT id FROM sessions)) OR
    (r.child_session_id IS NULL AND r.parent_session_id IN (SELECT id FROM sessions))`,
  );
  view("session_delegation_extensions", "r.parent_session_id IN (SELECT id FROM sessions)");
  view(
    "blob_links",
    "r.ticket_id IN (SELECT id FROM tickets) OR r.session_id IN (SELECT id FROM sessions)",
  );
  // An unbound Automation and personal settings belong to the profile step,
  // not to each project move. The whole-profile rehearsal still carries them.
  view(
    "automations",
    `r.project_id IN (SELECT id FROM projects)${options.projectIds === undefined ? " OR r.project_id IS NULL" : ""}`,
  );
}

export interface PrefixClash {
  prefix: string;
  projectIds: string[];
}

/** Prefixes are not unique in the target Workspace; surface ambiguous keys. */
export function prefixClashes(db: Database.Database): PrefixClash[] {
  const selected = new Set(
    (db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>).map((row) => row.id),
  );
  const groups = new Map<string, string[]>();
  for (const row of db
    .prepare(
      `SELECT p.id,p.ticket_prefix FROM main.projects p WHERE ${localProductRow("p", "project")} AND (p.removed_at IS NULL OR p.id IN (SELECT id FROM projects)) ORDER BY p.id`,
    )
    .iterate() as Iterable<{ id: string; ticket_prefix: string }>) {
    const ids = groups.get(row.ticket_prefix) ?? [];
    ids.push(row.id);
    groups.set(row.ticket_prefix, ids);
  }
  return [...groups]
    .filter(([, ids]) => ids.length > 1 && ids.some((id) => selected.has(id)))
    .map(([prefix, projectIds]) => ({ prefix, projectIds }));
}

export interface CrossProjectReference {
  kind: "delegation" | "sharedBlob" | "ticketKey";
  fromProjectId: string;
  toProjectId: string;
  count: number;
}

/** Content is never rewritten; this report lets the move queue order dependencies. */
export function crossProjectReferences(db: Database.Database): CrossProjectReference[] {
  const counts = new Map<string, CrossProjectReference>();
  const add = (kind: CrossProjectReference["kind"], fromProjectId: string, toProjectId: string) => {
    if (fromProjectId === toProjectId) return;
    const key = JSON.stringify([kind, fromProjectId, toProjectId]);
    const entry = counts.get(key) ?? { kind, fromProjectId, toProjectId, count: 0 };
    entry.count++;
    counts.set(key, entry);
  };
  for (const row of db
    .prepare(`SELECT child.project_id AS child, parent.project_id AS parent
    FROM session_delegations d JOIN sessions child ON child.id = d.session_id
    JOIN main.sessions parent ON parent.id = d.parent_session_id
    JOIN main.projects p ON p.id = parent.project_id
    WHERE parent.id IN (SELECT id FROM local_sessions) AND ${localProductRow("p", "project")}`)
    .iterate() as Iterable<{ child: string; parent: string }>) {
    add("delegation", row.child, row.parent);
  }
  for (const row of db
    .prepare(`SELECT DISTINCT l.blob_hash, COALESCE(t.project_id,s.project_id) AS own,
      COALESCE(ot.project_id,os.project_id) AS other FROM blob_links l
      LEFT JOIN tickets t ON t.id=l.ticket_id LEFT JOIN sessions s ON s.id=l.session_id
      JOIN main.blob_links o ON o.blob_hash=l.blob_hash
      LEFT JOIN main.tickets ot ON ot.id=o.ticket_id LEFT JOIN main.sessions os ON os.id=o.session_id
      JOIN main.projects op ON op.id=COALESCE(ot.project_id,os.project_id)
      WHERE ${localProductRow("op", "project")} AND ((ot.id IS NOT NULL AND ${localProductRow("ot", "ticket")})
         OR (os.id IN (SELECT id FROM local_sessions)))`)
    .iterate() as Iterable<{ own: string; other: string }>) {
    add("sharedBlob", row.own, row.other);
  }
  const targets = db
    .prepare(`SELECT t.project_id, p.ticket_prefix, t.ticket_number FROM main.tickets t
    JOIN main.projects p ON p.id=t.project_id WHERE ${localProductRow("t", "ticket")} AND ${localProductRow("p", "project")}`)
    .all() as Array<{ project_id: string; ticket_prefix: string; ticket_number: number }>;
  const byKey = new Map<string, Set<string>>();
  for (const t of targets) {
    const key = `${t.ticket_prefix}-${t.ticket_number}`;
    const projects = byKey.get(key) ?? new Set<string>();
    projects.add(t.project_id);
    byKey.set(key, projects);
  }
  for (const row of db
    .prepare(`SELECT project_id, title || char(10) || body AS text FROM tickets
    UNION ALL SELECT t.project_id,c.body FROM ticket_comments c JOIN tickets t ON t.id=c.ticket_id
    UNION ALL SELECT t.project_id,e.payload FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id
    UNION ALL SELECT s.project_id,e.payload FROM session_events e JOIN sessions s ON s.id=e.session_id`)
    .iterate() as Iterable<{ project_id: string; text: string }>) {
    for (const match of row.text.matchAll(/\b[A-Za-z][A-Za-z0-9]*-[0-9]+\b/g)) {
      for (const target of byKey.get(match[0]) ?? []) add("ticketKey", row.project_id, target);
    }
  }
  return [...counts.values()].toSorted((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
