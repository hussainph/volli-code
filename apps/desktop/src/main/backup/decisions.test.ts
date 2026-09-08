/**
 * The guard that makes the decision register a REGISTER rather than a list
 * someone kept up to date for a while.
 *
 * Every persisted table is held against a live migrated schema, so a migration
 * that adds a table without saying what happens to it in a backup fails here
 * — which is the ticket's actual requirement: new persisted data cannot be
 * added without an explicit include/rebuild/exclude decision.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { volliRuntimePaths } from "../agent-runtime";
import { blobsRoot } from "../blob-store";
import { browserPicturesRoot } from "../browser/picture-disk";
import { openTestDb } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { sessionTranscriptsRoot } from "../session-runtime/transcript-artifacts";
import {
  BACKUP_INCLUDED_TABLES,
  COLUMN_REDACTIONS,
  PROFILE_FILE_DECISIONS,
  TABLE_BACKUP_DECISIONS,
  tableBackupDecision,
} from "./decisions";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

function liveTables(db: TestDb["db"]): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

describe("table decisions", () => {
  it("gives every table in the live schema exactly one decision with a reason", () => {
    ctx = openTestDb();

    const tables = liveTables(ctx.db);
    expect(tables.length).toBeGreaterThan(30);
    for (const table of tables) {
      const matches = TABLE_BACKUP_DECISIONS.filter((entry) => entry.table === table);
      expect(matches, `no backup decision declared for table ${table}`).toHaveLength(1);
      expect(matches[0]?.reason.length, `decision for ${table} has no reason`).toBeGreaterThan(10);
    }
  });

  it("declares no decision for a table the schema does not have", () => {
    ctx = openTestDb();

    const tables = new Set(liveTables(ctx.db));
    for (const entry of TABLE_BACKUP_DECISIONS) {
      expect(tables, `${entry.table} is declared but is not in the schema`).toContain(entry.table);
    }
    expect(new Set(TABLE_BACKUP_DECISIONS.map((entry) => entry.table)).size).toBe(
      TABLE_BACKUP_DECISIONS.length,
    );
  });

  it("excludes credentials and machine-local trust, and never includes them", () => {
    ctx = openTestDb();

    for (const table of [
      "secrets",
      "legacy_safe_storage_secrets",
      "web_access_settings",
      "registered_harnesses",
      "harness_channel",
    ]) {
      expect(tableBackupDecision(table)?.decision, `${table} must be excluded`).toBe("exclude");
      expect(BACKUP_INCLUDED_TABLES).not.toContain(table);
    }
  });

  it("rebuilds the two usage projections rather than including or dropping them", () => {
    expect(tableBackupDecision("session_usage")?.decision).toBe("rebuild");
    expect(tableBackupDecision("session_usage_coverage")?.decision).toBe("rebuild");
  });

  it("carries the ledgers a restore of current work needs", () => {
    for (const table of [
      "projects",
      "tickets",
      "labels",
      "ticket_labels",
      "ticket_comments",
      "ticket_events",
      "ticket_event_sequence",
      "ticket_signals",
      "sessions",
      "session_events",
      "session_commands",
      "session_command_receipts",
      "session_attachments",
      "session_delegations",
      "session_delegation_claims",
      "session_delegation_extensions",
      "session_verb_grants",
      "blobs",
      "blob_links",
      "automations",
      "automation_runs",
      "automation_commands",
      "automation_events",
      "automation_command_receipts",
      "automation_run_deliveries",
      "automation_skipped_occurrences",
      "automation_column_arming",
      "automation_column_order",
      "automation_pending_armed_runs",
      "automation_pending_armed_run_attempts",
      "automation_session_mint_intents",
      "app_state",
    ]) {
      expect(BACKUP_INCLUDED_TABLES, `${table} must be included`).toContain(table);
    }
  });

  it("lists included tables in an order every foreign key can be satisfied in", () => {
    ctx = openTestDb();

    const seen = new Set<string>();
    for (const table of BACKUP_INCLUDED_TABLES) {
      const references = (
        ctx.db.prepare(`SELECT "table" FROM pragma_foreign_key_list(?)`).all(table) as Array<{
          table: string;
        }>
      ).map(({ table: target }) => target);
      for (const target of references) {
        if (target === table) continue;
        if (!BACKUP_INCLUDED_TABLES.includes(target)) continue;
        expect(seen, `${table} is restored before ${target}, which it references`).toContain(
          target,
        );
      }
      seen.add(table);
    }
    expect(BACKUP_INCLUDED_TABLES.length).toBe(
      TABLE_BACKUP_DECISIONS.filter((entry) => entry.decision === "include").length,
    );
  });
});

describe("column redactions", () => {
  it("names a real column of an included table, with a reason", () => {
    ctx = openTestDb();

    expect(COLUMN_REDACTIONS.length).toBeGreaterThan(0);
    for (const redaction of COLUMN_REDACTIONS) {
      expect(BACKUP_INCLUDED_TABLES).toContain(redaction.table);
      const columns = (
        ctx.db.prepare("SELECT name FROM pragma_table_info(?)").all(redaction.table) as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
      expect(columns, `${redaction.table}.${redaction.column} is not a column`).toContain(
        redaction.column,
      );
      expect(redaction.reason.length).toBeGreaterThan(10);
    }
  });

  it("redacts every local path and live terminal handle the schema carries", () => {
    const keyed = COLUMN_REDACTIONS.map((entry) => `${entry.table}.${entry.column}`);

    expect(keyed).toContain("projects.path");
    expect(keyed).toContain("tickets.worktree_path");
    expect(keyed).toContain("session_attachments.native_id");
    expect(keyed).toContain("session_attachments.native_detail");
    expect(keyed).toContain("session_provenances.provenance");
    expect(keyed).toContain("session_events.payload");
  });

  it("keeps the fields a restore has to preserve out of the redaction list", () => {
    const keyed = COLUMN_REDACTIONS.map((entry) => `${entry.table}.${entry.column}`);

    expect(keyed).not.toContain("tickets.pr_url");
    expect(keyed).not.toContain("tickets.retention_keep");
    expect(keyed).not.toContain("automation_runs.attendance");
  });
});

describe("profile file decisions", () => {
  it("decides each profile area once and binds the included ones to their store roots", () => {
    const areas = PROFILE_FILE_DECISIONS.map((entry) => entry.area);
    expect(new Set(areas).size).toBe(areas.length);
    for (const entry of PROFILE_FILE_DECISIONS) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }

    const included = PROFILE_FILE_DECISIONS.filter((entry) => entry.decision === "include").map(
      (entry) => entry.area,
    );
    expect(included).toEqual([blobsRoot(""), sessionTranscriptsRoot("")].map(stripLeadingSlash));
  });

  it("never backs up the CLI install, the update cache, or a migration safety copy", () => {
    const byArea = new Map(PROFILE_FILE_DECISIONS.map((entry) => [entry.area, entry]));

    expect(byArea.get("bin")?.decision).toBe("exclude");
    expect(byArea.get("pi-sessions")?.decision).toBe("exclude");
    expect(byArea.get("volli.db.backup-v*")?.decision).toBe("exclude");
    expect(byArea.get("volli.db")?.decision).toBe("rebuild");
  });

  it("decides every runtime area the app materialises under the profile root", () => {
    // Bound to the functions that mint the paths, as the included areas are:
    // a runtime directory that moves or appears takes its declaration with it.
    const runtime = volliRuntimePaths({
      userDataPath: "",
      appPath: "",
      mainProcessDir: "",
      resourcesPath: "",
      isPackaged: true,
    });
    const byArea = new Map(PROFILE_FILE_DECISIONS.map((entry) => [entry.area, entry]));
    const topLevel = (path: string): string => stripLeadingSlash(path).split("/")[0] ?? "";

    for (const path of [
      runtime.binDir,
      runtime.socketPath,
      runtime.harnessRoot,
      runtime.zdotDir,
      browserPicturesRoot(""),
    ]) {
      const area = topLevel(path);
      expect(byArea.get(area)?.decision, `${area} needs a profile-file decision`).toBe("exclude");
    }
  });
});

/** `blobsRoot("")` is `/blobs`; the register stores profile-relative areas. */
function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}
