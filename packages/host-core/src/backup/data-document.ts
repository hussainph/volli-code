/**
 * The bundle's data document: every included row, column-faithful.
 *
 * Column-faithful rather than model-shaped, which is the opposite of what
 * `db/export.ts` does, and the difference is the whole reason both exist. The
 * export document is for a person to READ, so it renames columns, parses JSON,
 * and drops what a reader would not recognise. This document is for a machine
 * to WRITE BACK, so it carries `pragma_table_info`'s columns under their real
 * names, with values exactly as SQLite returned them. A migration that adds a
 * column therefore travels the day it lands, instead of the day someone
 * remembers to add a field to a hand-written mapper.
 *
 * {@link COLUMN_REDACTIONS} is the one place values are altered, and every
 * entry there is a local path or a live handle. Nothing else is touched.
 *
 * Validation lives here too, and it runs against the DOCUMENT rather than
 * against a database. A restore has to be able to say "this bundle is broken"
 * before it has written a single byte into a profile, so shape and record
 * links are checked in memory, with the schema read from a throwaway migrated
 * database that no restore output ever touches.
 */
import Database from "better-sqlite3";
import { migrate, SCHEMA_HEAD } from "../db/migrations";
import { MIN_READER_VERSION_KEY } from "../db/schema-compatibility";
import { BACKUP_INCLUDED_TABLES, redactionsForTable } from "./decisions";
import type { ColumnRedaction, RedactionRule } from "./decisions";

/** The data document's own format marker — never `volli-export`. */
export const BACKUP_DATA_FORMAT = "volli-backup-data";

/** The data document's version, bumped independently of the bundle's. */
export const BACKUP_DATA_VERSION = 1;

/**
 * A stored SQLite value as JSON.
 *
 * `Buffer` becomes `{ base64 }` and a bigint becomes `{ int }` so that no
 * column type can silently lose precision or turn into `{}` on the way
 * through `JSON.stringify`.
 */
export type BackupValue =
  | null
  | number
  | string
  | { readonly base64: string }
  | { readonly int: string };

export interface BackupTableData {
  columns: readonly string[];
  rows: readonly (readonly BackupValue[])[];
}

export interface BackupDataDocument {
  format: typeof BACKUP_DATA_FORMAT;
  dataVersion: number;
  /** The source database's `PRAGMA user_version`. */
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  /**
   * The source profile's metering boundary.
   *
   * Carried in the envelope rather than as a `session_usage_coverage` row
   * because the row is REBUILT at restore, and the one fact a rebuild cannot
   * derive is how far back the source could answer. A restore that let a fresh
   * migration compute this would write `0` — "every window is complete" — over
   * a profile that knows better.
   */
  usageCoverage: { meteredFrom: number };
  tables: Record<string, BackupTableData>;
}

/** A named problem, in the words a person reads in the failure report. */
export interface BackupProblem {
  kind:
    | "shape"
    | "unsupported-version"
    | "link"
    | "artifact-missing"
    | "artifact-corrupt"
    | "manifest"
    | "archive"
    | "mapping"
    | "verify";
  message: string;
}

function encodeValue(value: unknown): BackupValue {
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return { int: value.toString() };
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
  throw new Error(`Unsupported SQLite value of type ${typeof value}`);
}

/** The value as better-sqlite3 wants it back. */
export function decodeValue(value: BackupValue): null | number | string | Buffer | bigint {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if ("base64" in value) return Buffer.from(value.base64, "base64");
  return BigInt(value.int);
}

function stripKeys(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => stripKeys(item, keys));
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key)) continue;
    result[key] = stripKeys(nested, keys);
  }
  return result;
}

/**
 * Applies one redaction.
 *
 * A `strip-json-keys` value that no longer parses is left exactly as it is
 * rather than thrown away: the column's contract is JSON, but a hand-edited
 * row is still the person's data, and losing it during a BACKUP is the one
 * outcome worse than carrying it forward unchanged.
 */
function redact(value: BackupValue, rule: RedactionRule): BackupValue {
  switch (rule.kind) {
    case "clear":
      return null;
    case "blank":
      return "";
    case "strip-json-keys": {
      if (typeof value !== "string") return value;
      try {
        return JSON.stringify(stripKeys(JSON.parse(value), rule.keys));
      } catch {
        return value;
      }
    }
  }
}

interface ColumnInfo {
  name: string;
  pk: number;
}

function hasTable(db: Database.Database, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function columnsOf(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare("SELECT name, pk FROM pragma_table_info(?)").all(table) as ColumnInfo[];
}

/**
 * A deterministic row order: the primary key, or every column when a table has
 * none. Two bundles of an unchanged profile then differ only in `createdAt`.
 */
function orderClause(columns: readonly ColumnInfo[]): string {
  const keyed = columns
    .filter((column) => column.pk > 0)
    .toSorted((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  const order = keyed.length > 0 ? keyed : columns.map((column) => column.name);
  return order.map((name) => `"${name}" COLLATE BINARY`).join(", ");
}

export interface BuildBackupDataOptions {
  appVersion: string;
  now: number;
}

/**
 * Whether a row is the database's minimum reader version (VC-602). That is a
 * fact about one FILE's schema, not data: the migration runner derives it for
 * whatever database a restore builds, so a bundle never carries it and a
 * restore never writes one from a bundle.
 */
export function isSchemaMarkerRow(
  table: string,
  columns: readonly string[],
  row: readonly unknown[],
): boolean {
  return table === "app_state" && row[columns.indexOf("key")] === MIN_READER_VERSION_KEY;
}

/**
 * Reads every included table out of `db` into a data document.
 *
 * The stamped `schemaVersion` always describes the columns and tables the
 * document actually carries (VC-602). A database from a newer, compatible
 * build (`user_version` above this build's head) is stamped with THIS build's
 * head and carries only the columns this build's schema has: a newer build
 * restores that bundle by migrating it up. Stamping the file's own version
 * over this build's table list is how a v57 build once wrote a v58 bundle
 * without `workspace_epochs` that no build could restore.
 */
export function buildBackupDataDocument(
  db: Database.Database,
  options: BuildBackupDataOptions,
): BackupDataDocument {
  const tables: Record<string, BackupTableData> = {};
  for (const plan of planBackupTables(db)) {
    tables[plan.table] = {
      columns: plan.columns,
      rows: [...iterateBackupRows(db, plan)],
    };
  }
  return { ...backupDocumentHeader(db, options), tables };
}

/**
 * The document's envelope — everything except its tables.
 *
 * Split out so the streaming writer can describe the SAME document without
 * building it: `schemaVersion` is still this build's head for a newer source,
 * `createdAt` is still the caller's clock, and the metering boundary is still
 * read from the source's coverage row rather than invented at restore.
 */
export interface BackupDocumentHeader {
  format: typeof BACKUP_DATA_FORMAT;
  dataVersion: number;
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  usageCoverage: { meteredFrom: number };
}

/** One included table as the writer reads it: columns, order and redactions. */
export interface BackupTablePlan {
  readonly table: string;
  readonly columns: readonly string[];
  readonly redactions: readonly ColumnRedaction[];
  /** The `ORDER BY` expression that makes a bundle deterministic. */
  readonly orderBy: string;
}

/**
 * The tables, columns, row order and redactions one backup of `db` carries.
 *
 * The streaming writer and {@link buildBackupDataDocument} both decide what a
 * bundle holds HERE, so a bounded-memory backup cannot quietly carry a
 * different set of rows, a different column subset, or a different row order
 * than the in-memory one.
 */
export function planBackupTables(db: Database.Database): BackupTablePlan[] {
  const sourceVersion = db.pragma("user_version", { simple: true }) as number;
  const ownColumns = sourceVersion > SCHEMA_HEAD ? referenceSchema(SCHEMA_HEAD).columns : null;
  const plans: BackupTablePlan[] = [];
  for (const table of BACKUP_INCLUDED_TABLES) {
    const columns = columnsOf(db, table).filter(
      (column) => ownColumns === null || (ownColumns.get(table) ?? []).includes(column.name),
    );
    // A table a later migration introduces is absent from an older profile.
    // Skipping it is what lets an older build's bundle be a real older
    // profile rather than one with empty tables invented for it; the reader
    // decides whether the absence is legitimate from the schema version.
    if (columns.length === 0) continue;
    plans.push({
      table,
      columns: columns.map((column) => column.name),
      redactions: redactionsForTable(table),
      orderBy: orderClause(columns),
    });
  }
  return plans;
}

/** The document envelope for one backup of `db`. */
export function backupDocumentHeader(
  db: Database.Database,
  options: BuildBackupDataOptions,
): BackupDocumentHeader {
  const sourceVersion = db.pragma("user_version", { simple: true }) as number;
  // Migration 027 introduced the coverage row; a profile older than that has
  // no boundary to carry, and `0` is what it means — every window complete.
  const coverage = hasTable(db, "session_usage_coverage")
    ? (db.prepare("SELECT metered_from FROM session_usage_coverage WHERE id = 1").get() as
        | { metered_from: number }
        | undefined)
    : undefined;
  return {
    format: BACKUP_DATA_FORMAT,
    dataVersion: BACKUP_DATA_VERSION,
    schemaVersion: Math.min(sourceVersion, SCHEMA_HEAD),
    appVersion: options.appVersion,
    createdAt: new Date(options.now).toISOString(),
    usageCoverage: { meteredFrom: coverage?.metered_from ?? 0 },
  };
}

/**
 * Encodes one raw SQLite row for the document, or `null` for the schema marker
 * row that is a property of one FILE rather than of the data (VC-602).
 *
 * The single place the encoder and the redactions meet; the streaming writer
 * calls exactly this, row for row.
 */
export function encodeBackupRow(
  plan: BackupTablePlan,
  row: readonly unknown[],
): BackupValue[] | null {
  if (isSchemaMarkerRow(plan.table, plan.columns, row)) return null;
  return plan.columns.map((name, index) => {
    const encoded = encodeValue(row[index]);
    const redaction = plan.redactions.find((entry) => entry.column === name);
    return redaction === undefined ? encoded : redact(encoded, redaction.rule);
  });
}

/**
 * Streams one table's encoded rows in the order the document records them.
 *
 * `iterate()` rather than `all()` is the whole point: a profile's
ticket/session ledger is millions of rows, and this is the seam that keeps the
write and the verify in bounded memory.
 */
export function* iterateBackupRows(
  db: Database.Database,
  plan: BackupTablePlan,
): IterableIterator<BackupValue[]> {
  const statement = db
    .prepare(
      `SELECT ${plan.columns.map((name) => `"${name}"`).join(", ")} FROM "${plan.table}" ORDER BY ${plan.orderBy}`,
    )
    .raw();
  const rows = statement.iterate() as IterableIterator<unknown[]>;
  try {
    for (const row of rows) {
      const encoded = encodeBackupRow(plan, row);
      if (encoded !== null) yield encoded;
    }
  } finally {
    rows.return?.();
  }
}

/** Serializes the data document the way the bundle stores it. */
export function serializeBackupDataDocument(document: BackupDataDocument): Buffer {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

/** One table handed to the streaming serializer: a name, columns, and a row iterator. */
export interface BackupDataTableSource {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: Iterable<readonly BackupValue[]>;
}

/** Where and how often the streaming writer may be interrupted. */
export interface BackupDataStreamOptions {
  /** Awaited at bounded row/byte intervals — the caller's cancellation and pause point. */
  checkpoint?: () => Promise<void>;
}

/** Rows between checkpoints. */
const CHECKPOINT_ROWS = 2_048;
/** Emitted characters between checkpoints, so one wide table still pauses promptly. */
const CHECKPOINT_CHARACTERS = 8 * 1024 * 1024;
/** Emitted characters held before a chunk is handed to the gzip sink. */
const STREAM_CHUNK_CHARACTERS = 64 * 1024;

/**
 * Buffers emitted fragments and hands the caller whole chunks, so the archive
 * writer sees kilobytes rather than one call per JSON token.
 */
class StreamChunks {
  #pending = "";
  #pushed = 0;

  push = (chunk: string): void => {
    this.#pending += chunk;
    this.#pushed += chunk.length;
  };

  /** The pending text when it reached `threshold`, otherwise `undefined`. */
  takeIfFull(threshold: number): string | undefined {
    if (this.#pending.length < threshold) return undefined;
    const out = this.#pending;
    this.#pending = "";
    return out;
  }

  takeAll(): string | undefined {
    if (this.#pending.length === 0) return undefined;
    const out = this.#pending;
    this.#pending = "";
    return out;
  }

  /** Characters pushed since the sink was created; used only for checkpoint pacing. */
  get pushed(): number {
    return this.#pushed;
  }
}

function jsonIndent(level: number): string {
  return "  ".repeat(level);
}

/**
 * Writes one small JSON value exactly as `JSON.stringify(value, null, 2)`
 * would at this depth.
 *
 * Exported for the bundle's manifest writer, which prints one entry at a time
 * for the same reason the data document is streamed: a manifest over a large
 * profile has one entry per transcript.
 */
export function writeJsonValue(
  value: unknown,
  level: number,
  write: (chunk: string) => void,
): void {
  if (value === null) {
    write("null");
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    write(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      write("[]");
      return;
    }
    write("[\n");
    value.forEach((item, index) => {
      write(jsonIndent(level + 1));
      writeJsonValue(item, level + 1, write);
      write(index === value.length - 1 ? "\n" : ",\n");
    });
    write(`${jsonIndent(level)}]`);
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Cannot serialize a ${typeof value} as JSON`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    write("{}");
    return;
  }
  write("{\n");
  entries.forEach(([key, nested], index) => {
    write(`${jsonIndent(level + 1)}${JSON.stringify(key)}: `);
    writeJsonValue(nested, level + 1, write);
    write(index === entries.length - 1 ? "\n" : ",\n");
  });
  write(`${jsonIndent(level)}}`);
}

/**
 * Streams the data document as the EXACT bytes
 * {@link serializeBackupDataDocument} produces, one bounded chunk at a time.
 *
 * Same envelope order, same two-space indentation, same per-row arrays: a
 * bundle written by the streaming path is byte-for-byte the bundle the
 * in-memory path writes for the same snapshot, which is what lets the existing
 * reader keep accepting it and what makes the deterministic claim testable.
 * No table is held in memory; each row is encoded, printed and released before
 * the next one is read. `checkpoint` is awaited every few thousand rows, at a
 * point where no SQLite iterator is invalidated by the pause.
 */
export async function* backupDataDocumentChunks(
  header: BackupDocumentHeader,
  tables: Iterable<BackupDataTableSource>,
  options: BackupDataStreamOptions = {},
): AsyncGenerator<string> {
  const chunks = new StreamChunks();
  let rowsSinceCheckpoint = 0;
  let charactersSinceCheckpoint = 0;
  let tablesWritten = 0;

  const checkpointIfDue = async (): Promise<void> => {
    if (options.checkpoint === undefined) return;
    if (
      rowsSinceCheckpoint < CHECKPOINT_ROWS &&
      charactersSinceCheckpoint < CHECKPOINT_CHARACTERS
    ) {
      return;
    }
    rowsSinceCheckpoint = 0;
    charactersSinceCheckpoint = 0;
    await options.checkpoint();
  };

  chunks.push("{\n");
  chunks.push(`  "format": ${JSON.stringify(BACKUP_DATA_FORMAT)},\n`);
  chunks.push(`  "dataVersion": ${BACKUP_DATA_VERSION},\n`);
  chunks.push(`  "schemaVersion": ${header.schemaVersion},\n`);
  chunks.push(`  "appVersion": ${JSON.stringify(header.appVersion)},\n`);
  chunks.push(`  "createdAt": ${JSON.stringify(header.createdAt)},\n`);
  chunks.push('  "usageCoverage": {\n');
  chunks.push(`    "meteredFrom": ${header.usageCoverage.meteredFrom}\n`);
  chunks.push("  },\n");
  chunks.push('  "tables": {');

  for (const table of tables) {
    chunks.push(tablesWritten === 0 ? "\n" : ",\n");
    tablesWritten += 1;
    chunks.push(`    ${JSON.stringify(table.name)}: {\n`);
    if (table.columns.length === 0) {
      chunks.push('      "columns": [],\n');
    } else {
      chunks.push('      "columns": [');
      table.columns.forEach((column, index) => {
        chunks.push(index === 0 ? "\n" : ",\n");
        chunks.push(`        ${JSON.stringify(column)}`);
      });
      chunks.push("\n      ],\n");
    }
    chunks.push('      "rows": [');
    let rowsWritten = 0;
    for (const row of table.rows) {
      const charactersBeforeRow = chunks.pushed;
      chunks.push(rowsWritten === 0 ? "\n" : ",\n");
      rowsWritten += 1;
      chunks.push("        [");
      row.forEach((value, index) => {
        chunks.push(index === 0 ? "\n" : ",\n");
        chunks.push("          ");
        writeJsonValue(value, 5, chunks.push);
      });
      chunks.push("\n        ]");
      rowsSinceCheckpoint += 1;
      charactersSinceCheckpoint += chunks.pushed - charactersBeforeRow;
      const ready = chunks.takeIfFull(STREAM_CHUNK_CHARACTERS);
      if (ready !== undefined) yield ready;
      await checkpointIfDue();
    }
    // `JSON.stringify(…, null, 2)` prints an empty array as `[]`, not as an
    // opening bracket with a newline inside it.
    chunks.push(rowsWritten === 0 ? "]\n    }" : "\n      ]\n    }");
  }
  chunks.push("\n  }\n}\n");
  const tail = chunks.takeAll();
  if (tail !== undefined) yield tail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a JSON value is one the document's value encoding allows. */
export function isBackupValue(value: unknown): value is BackupValue {
  if (value === null || typeof value === "number" || typeof value === "string") return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if (keys[0] === "base64") return typeof value.base64 === "string";
  if (keys[0] === "int") return typeof value.int === "string" && /^-?\d+$/.test(value.int);
  return false;
}

/**
 * Checks the document's shape, hard, before anything is written.
 *
 * Total by design: a malformed bundle produces a list of problems, never an
 * exception out of `JSON.parse` several frames above the caller who was going
 * to show them to a person.
 */
export function validateBackupDataDocument(
  value: unknown,
): { ok: true; document: BackupDataDocument } | { ok: false; problems: BackupProblem[] } {
  const problems: BackupProblem[] = [];
  const fail = (message: string): void => void problems.push({ kind: "shape", message });

  if (!isRecord(value)) {
    return { ok: false, problems: [{ kind: "shape", message: "Data document is not an object." }] };
  }
  if (value.format === "volli-export") {
    return {
      ok: false,
      problems: [
        {
          kind: "shape",
          message:
            "This is a volli-export JSON file, not a backup bundle. The JSON export is a limited data export and cannot be restored.",
        },
      ],
    };
  }
  if (value.format !== BACKUP_DATA_FORMAT)
    fail(`Data document format is not ${BACKUP_DATA_FORMAT}.`);
  if (value.dataVersion !== BACKUP_DATA_VERSION) {
    problems.push({
      kind: "unsupported-version",
      message: `Data document version ${String(value.dataVersion)} is not supported (expected ${BACKUP_DATA_VERSION}).`,
    });
  }
  if (typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) {
    fail("Data document has no integer schemaVersion.");
  }
  if (typeof value.appVersion !== "string") fail("Data document has no appVersion.");
  if (typeof value.createdAt !== "string") fail("Data document has no createdAt.");
  if (!isRecord(value.usageCoverage) || typeof value.usageCoverage.meteredFrom !== "number") {
    fail("Data document has no usageCoverage.meteredFrom.");
  }

  const tables = value.tables;
  if (!isRecord(tables)) {
    fail("Data document has no tables object.");
    return { ok: false, problems };
  }
  for (const name of Object.keys(tables)) {
    if (!BACKUP_INCLUDED_TABLES.includes(name)) {
      fail(`Data document carries ${name}, which no backup decision includes.`);
    }
  }
  // Which tables a bundle OWES depends on the schema it was written at: a
  // table introduced after that version cannot be missing, it never existed.
  // Derived from a database migrated to that same version, so the window
  // widens on its own as migrations land.
  const expected =
    typeof value.schemaVersion === "number"
      ? tablesAtVersion(value.schemaVersion)
      : new Set(BACKUP_INCLUDED_TABLES);
  for (const name of BACKUP_INCLUDED_TABLES) {
    const table = tables[name];
    if (!isRecord(table)) {
      if (expected.has(name)) fail(`Data document is missing table ${name}.`);
      continue;
    }
    const columns = table.columns;
    const rows = table.rows;
    if (!Array.isArray(columns) || !columns.every((column) => typeof column === "string")) {
      fail(`Table ${name} has no column list.`);
      continue;
    }
    if (!Array.isArray(rows)) {
      fail(`Table ${name} has no rows array.`);
      continue;
    }
    for (const [index, row] of rows.entries()) {
      if (!Array.isArray(row) || row.length !== columns.length) {
        fail(`Table ${name} row ${index} does not match its ${columns.length} columns.`);
        continue;
      }
      if (!row.every(isBackupValue)) fail(`Table ${name} row ${index} has an unreadable value.`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, document: value as unknown as BackupDataDocument };
}

export interface ForeignKey {
  from: readonly string[];
  table: string;
  to: readonly string[];
}

const tablesByVersion = new Map<number, Set<string>>();

/**
 * The included tables that exist at one schema version.
 *
 * A throwaway in-memory database migrated exactly that far, which is both
 * cheap and impossible to get out of step with the migrations themselves.
 */
export function tablesAtVersion(schemaVersion: number): Set<string> {
  const cached = tablesByVersion.get(schemaVersion);
  if (cached !== undefined) return cached;
  const db = new Database(":memory:");
  try {
    migrate(db, ":memory:", { toVersion: schemaVersion });
    const live = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    const tables = new Set(BACKUP_INCLUDED_TABLES.filter((table) => live.has(table)));
    tablesByVersion.set(schemaVersion, tables);
    return tables;
  } finally {
    db.close();
  }
}

export interface ReferenceSchema {
  foreignKeys: Map<string, ForeignKey[]>;
  columns: Map<string, string[]>;
}

const cachedSchemas = new Map<number, ReferenceSchema>();

/**
 * One bundle version's live schema, read from a throwaway migrated database.
 *
 * Derived rather than hand-listed for the reason the decision register is
 * derived: a link check written out by hand is a link check that stops
 * matching the schema the first time a migration adds a reference nobody
 * remembered to add here. Versioning matters when a migration replaces a
 * column: an older bundle must be validated against the schema that wrote it,
 * before restore migrates those rows forward.
 *
 * Exported for the streaming verifier, which checks the same links against a
 * disk-backed index rather than building every target set in memory.
 */
export function referenceSchema(schemaVersion: number): ReferenceSchema {
  const cached = cachedSchemas.get(schemaVersion);
  if (cached !== undefined) return cached;
  const db = new Database(":memory:");
  try {
    // A fresh (user_version 0) database takes no safety copy, so the path is
    // never touched — see `migrate`.
    migrate(db, ":memory:", { toVersion: schemaVersion });
    const foreignKeys = new Map<string, ForeignKey[]>();
    const columns = new Map<string, string[]>();
    for (const table of BACKUP_INCLUDED_TABLES) {
      columns.set(
        table,
        (
          db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>
        ).map(({ name }) => name),
      );
    }
    const primaryKeyOf = (table: string): string[] =>
      (
        db.prepare("SELECT name, pk FROM pragma_table_info(?)").all(table) as Array<{
          name: string;
          pk: number;
        }>
      )
        .filter((column) => column.pk > 0)
        .toSorted((a, b) => a.pk - b.pk)
        .map((column) => column.name);
    for (const table of BACKUP_INCLUDED_TABLES) {
      const rows = db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(table) as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string | null;
      }>;
      const grouped = new Map<number, typeof rows>();
      for (const row of rows) {
        grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
      }
      const keys: ForeignKey[] = [];
      for (const group of grouped.values()) {
        const ordered = group.toSorted((a, b) => a.seq - b.seq);
        const target = ordered[0]?.table ?? "";
        const to = ordered.every((row) => row.to !== null)
          ? ordered.map((row) => row.to as string)
          : primaryKeyOf(target);
        keys.push({ from: ordered.map((row) => row.from), table: target, to });
      }
      foreignKeys.set(table, keys);
    }
    const schema = { foreignKeys, columns };
    cachedSchemas.set(schemaVersion, schema);
    return schema;
  } finally {
    db.close();
  }
}

export function recordKeyOf(values: readonly BackupValue[]): string {
  return JSON.stringify(values);
}

/**
 * Every reference in the document resolves to a row the document also carries.
 *
 * SQL's MATCH SIMPLE rule holds here too: a reference with any NULL component
 * is unconstrained, because that is exactly what the database it came from
 * would have allowed (`sessions.ticket_id` is `ON DELETE SET NULL`, and a
 * detached Session is a real state, not a broken link).
 */
export function validateRecordLinks(document: BackupDataDocument): BackupProblem[] {
  const { foreignKeys, columns: liveColumns } = referenceSchema(document.schemaVersion);
  const problems: BackupProblem[] = [];
  const indexOf = (table: string, column: string): number =>
    document.tables[table]?.columns.indexOf(column) ?? -1;

  for (const table of BACKUP_INCLUDED_TABLES) {
    const data = document.tables[table];
    if (data === undefined) continue;
    for (const column of data.columns) {
      if (!(liveColumns.get(table) ?? []).includes(column)) {
        problems.push({
          kind: "shape",
          message: `Table ${table} carries column ${column}, which this build's schema does not have.`,
        });
      }
    }
    for (const key of foreignKeys.get(table) ?? []) {
      const target = document.tables[key.table];
      if (target === undefined) continue;
      const targetIndexes = key.to.map((column) => indexOf(key.table, column));
      const sourceIndexes = key.from.map((column) => indexOf(table, column));
      if (targetIndexes.includes(-1) || sourceIndexes.includes(-1)) continue;
      const known = new Set(
        target.rows.map((row) => recordKeyOf(targetIndexes.map((index) => row[index] ?? null))),
      );
      for (const [rowIndex, row] of data.rows.entries()) {
        const values = sourceIndexes.map((index) => row[index] ?? null);
        if (values.some((value) => value === null)) continue;
        if (!known.has(recordKeyOf(values))) {
          problems.push({
            kind: "link",
            message: `${table} row ${rowIndex} references ${key.table}(${key.to.join(", ")}) = ${values
              .map((value) => JSON.stringify(value))
              .join(", ")}, which the bundle does not carry.`,
          });
        }
      }
    }
  }
  return problems;
}

/** Every blob hash the document's rows depend on — the artifacts a bundle must carry. */
export function collectBlobHashes(document: BackupDataDocument): string[] {
  const blobs = document.tables.blobs;
  const index = blobs?.columns.indexOf("hash") ?? -1;
  if (blobs === undefined || index === -1) return [];
  const hashes = new Set<string>();
  for (const row of blobs.rows) {
    const value = row[index];
    if (typeof value === "string") hashes.add(value);
  }
  return [...hashes].toSorted();
}

const TRANSCRIPT_ID = /^sha256:[a-f0-9]{64}$/;

export function walkTranscriptReferences(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) walkTranscriptReferences(item, found);
    return;
  }
  if (!isRecord(value)) return;
  const id = value.id;
  // The ledger's `TranscriptReference` shape: a digest-shaped id beside a
  // digest or media type. Matched structurally rather than by event kind so a
  // payload kind added later cannot quietly stop carrying its transcript.
  if (
    typeof id === "string" &&
    TRANSCRIPT_ID.test(id) &&
    ("digest" in value || "mediaType" in value)
  ) {
    found.add(id);
  }
  for (const nested of Object.values(value)) walkTranscriptReferences(nested, found);
}

/**
 * Every transcript artifact the ledger refers to.
 *
 * Both the events and the commands are scanned: a submitted message's
 * reference lives in the command's intent before any event repeats it, and a
 * bundle that carried only what events name would restore a Session whose
 * first prompt is a dangling id.
 */
export function collectTranscriptReferences(document: BackupDataDocument): string[] {
  const found = new Set<string>();
  for (const [table, column] of [
    ["session_events", "payload"],
    ["session_commands", "intent"],
    ["session_commands", "route"],
  ] as const) {
    const data = document.tables[table];
    const index = data?.columns.indexOf(column) ?? -1;
    if (data === undefined || index === -1) continue;
    for (const row of data.rows) {
      const value = row[index];
      if (typeof value !== "string") continue;
      try {
        walkTranscriptReferences(JSON.parse(value), found);
      } catch {
        // A row whose JSON no longer parses cannot name a transcript; the
        // shape check above has already reported the document's real problem.
      }
    }
  }
  return [...found].toSorted();
}
