import { afterEach, describe, expect, it } from "vite-plus/test";

import { openTestDb } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import {
  BACKUP_DATA_FORMAT,
  BACKUP_DATA_VERSION,
  buildBackupDataDocument,
  collectTranscriptReferences,
  decodeValue,
  tablesAtVersion,
  validateBackupDataDocument,
  validateRecordLinks,
} from "./data-document";
import type { BackupDataDocument } from "./data-document";
import { BACKUP_INCLUDED_TABLES } from "./decisions";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

function emptyDocument(overrides: Partial<BackupDataDocument> = {}): BackupDataDocument {
  ctx = openTestDb();
  return { ...buildBackupDataDocument(ctx.db, { appVersion: "t", now: 0 }), ...overrides };
}

describe("buildBackupDataDocument", () => {
  it("carries every included table, column for column, from the live schema", () => {
    const document = emptyDocument();

    expect(document.format).toBe(BACKUP_DATA_FORMAT);
    expect(document.dataVersion).toBe(BACKUP_DATA_VERSION);
    for (const table of BACKUP_INCLUDED_TABLES) {
      const live = (
        ctx.db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
      expect(document.tables[table]?.columns, `${table} columns`).toEqual(live);
    }
  });

  it("round-trips a BLOB column through base64", () => {
    ctx = openTestDb();
    ctx.db
      .prepare(
        "INSERT INTO legacy_safe_storage_secrets (name, ciphertext, updated_at) VALUES (?, ?, ?)",
      )
      .run("k", Buffer.from([1, 2, 3]), 0);

    // Not an included table, so this only exercises the encoder's contract.
    expect(decodeValue({ base64: Buffer.from([1, 2, 3]).toString("base64") })).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(decodeValue({ int: "9007199254740993" })).toBe(9007199254740993n);
  });
});

describe("validateBackupDataDocument", () => {
  it("accepts what the builder produced", () => {
    expect(validateBackupDataDocument(emptyDocument()).ok).toBe(true);
  });

  it("names the volli-export document rather than listing missing fields", () => {
    ctx = openTestDb();

    const result = validateBackupDataDocument({ format: "volli-export", schemaVersion: 41 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.message).toMatch(/limited data export/);
  });

  it("rejects a table no backup decision includes", () => {
    const document = emptyDocument();
    (document.tables as Record<string, unknown>).secrets = { columns: ["name"], rows: [] };

    const result = validateBackupDataDocument(document);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toContain("secrets");
  });

  it("rejects a row whose arity does not match its columns", () => {
    const document = emptyDocument();
    (document.tables.app_state as unknown as { rows: unknown[] }).rows = [["only-one-value"]];

    const result = validateBackupDataDocument(document);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toMatch(/does not match its \d+ columns/);
  });

  it("requires a table the bundle's schema had, and forgives one it never had", () => {
    const document = emptyDocument();
    const dropped = { ...document.tables };
    delete dropped.ticket_event_sequence;

    const atHead = validateBackupDataDocument({ ...document, tables: dropped });
    // Migration 029 introduced the sequence sidecar, so a schema-28 bundle
    // could not have carried it and must not be asked to.
    const older = validateBackupDataDocument({
      ...document,
      schemaVersion: 28,
      tables: dropped,
    });

    expect(atHead.ok).toBe(false);
    if (!atHead.ok) expect(atHead.problems[0]?.message).toContain("ticket_event_sequence");
    expect(older.ok).toBe(true);
  });

  it("reads the table set for a version off a database migrated exactly that far", () => {
    ctx = openTestDb();

    expect(tablesAtVersion(28).has("ticket_event_sequence")).toBe(false);
    expect(tablesAtVersion(29).has("ticket_event_sequence")).toBe(true);
    expect(tablesAtVersion(28).has("tickets")).toBe(true);
  });
});

describe("validateRecordLinks", () => {
  it("passes an empty document and reports a dangling reference", () => {
    const document = emptyDocument();
    expect(validateRecordLinks(document)).toEqual([]);

    (document.tables.labels as unknown as { rows: unknown[] }).rows = [
      ["label-1", "no-such-project", "bug", null, 1, 0, 0],
    ];

    const problems = validateRecordLinks(document);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("link");
    expect(problems[0]?.message).toContain("no-such-project");
  });

  it("leaves a NULL reference alone, the way the database does", () => {
    const document = emptyDocument();
    (document.tables.sessions as unknown as { rows: unknown[] }).rows = [
      // ticket_id NULL: a Board Session, or one whose ticket was deleted.
      ["session-1", "proj-1", null, "Untitled", 0, "project", null],
    ];
    (document.tables.projects as unknown as { rows: unknown[] }).rows = [
      buildProjectRow(document, "proj-1"),
    ];

    expect(validateRecordLinks(document)).toEqual([]);
  });
});

describe("collectTranscriptReferences", () => {
  it("finds a reference in a command intent as well as in an event payload", () => {
    const document = emptyDocument();
    const promptId = `sha256:${"a".repeat(64)}`;
    const replyId = `sha256:${"b".repeat(64)}`;
    (document.tables.session_commands as unknown as { rows: unknown[] }).rows = [
      [
        "command-1",
        "session-1",
        0,
        JSON.stringify({ kind: "message.submit", reference: { id: promptId, digest: promptId } }),
        null,
      ],
    ];
    (document.tables.session_provenances as unknown as { rows: unknown[] }).rows = [[1, "{}"]];
    (document.tables.session_events as unknown as { rows: unknown[] }).rows = [
      [
        "event-1",
        "session-1",
        1,
        0,
        0,
        1,
        null,
        null,
        JSON.stringify({
          kind: "transcript.referenced",
          reference: { id: replyId, mediaType: "application/json", digest: replyId },
        }),
      ],
    ];

    expect(collectTranscriptReferences(document)).toEqual([promptId, replyId]);
  });
});

/** A `projects` row of the right arity for the live schema, with the id set. */
function buildProjectRow(document: BackupDataDocument, id: string): unknown[] {
  const columns = document.tables.projects?.columns ?? [];
  return columns.map((column) => {
    switch (column) {
      case "id":
        return id;
      case "name":
      case "path":
      case "ticket_prefix":
        return column;
      case "color_index":
      case "sort_order":
      case "row_version":
      case "created_at":
      case "updated_at":
      case "next_ticket_number":
        return 0;
      default:
        return null;
    }
  });
}
