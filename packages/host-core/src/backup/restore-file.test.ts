/**
 * The bounded-memory file restore (VC-988), held to the in-memory restore.
 *
 * `restoreBackupBundleFile` exists because `restoreBackupBundle` cannot hold a
 * profile-sized `data.json`. The promise it makes is that it is the SAME
 * restore otherwise: the same profile on success, the same refusals, the same
 * untouched profile on failure. So the central case restores one bundle both
 * ways and compares the two databases table by table and the two artifact
 * stores file by file; the refusal cases compare the two problem lists.
 *
 * The cases only a file restore has are here too: a file that changes between
 * the verifying read and the staging read, a cancellation mid-staging, and the
 * one table order a streaming load cannot take. The large-profile round trip
 * (2.15M rows, a >1.6 GB data document) is `scripts/rehearse-backup-restore.mjs`,
 * run by CI extended.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { blobsRoot } from "../blob-store";
import { MIGRATIONS } from "../db/migrations";
import { openRawDb } from "../db/test-helpers";
import { MCP_CREDENTIAL_FILE_NAME } from "../mcp/credential-store";
import { SECRET_STORE_FILE_NAME } from "../secrets";
import { sessionTranscriptsRoot } from "../session-runtime/transcript-artifacts";
import { packArchive, unpackArchive } from "./archive";
import { createBackupBundle, DATA_PATH, MANIFEST_PATH } from "./bundle";
import type { BackupManifest } from "./bundle";
import { RESTORE_CREDENTIALS, restoreBackupBundle, restoreBackupBundleFile } from "./restore";
import type { RestoreResult } from "./restore";
import { BundleChangedError, stageBundleFile, TRIGGER_FILLED_TABLES } from "./restore-stream";
import { BACKUP_INCLUDED_TABLES } from "./decisions";
import { openVerifiedBackupBundleFile, verifyBackupBundleFile } from "./streaming";
import { createFixtureProfile } from "./test-fixture";
import type { FixtureProfile } from "./test-fixture";
import { digestProfile } from "./test-support/profile-digest";

const HEAD_SCHEMA = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
const NOW = 1_800_000_000_000;

const fixtures: FixtureProfile[] = [];
const scratch: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const created of fixtures.splice(0)) created.cleanup();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function fixture(options: { schemaVersion?: number } = {}): FixtureProfile {
  const created = createFixtureProfile(options);
  fixtures.push(created);
  return created;
}

function bundleOf(source: FixtureProfile): Buffer {
  return createBackupBundle({
    db: source.db,
    blobsRoot: source.blobsRoot,
    transcriptsRoot: source.transcriptsRoot,
    appVersion: "0.3.0-test",
    now: 1_700_000_000_000,
  }).bytes;
}

function bundleFile(bytes: Buffer): string {
  const path = join(tempDir("volli-restore-file-bundle-"), "bundle.tar.gz");
  writeFileSync(path, bytes);
  return path;
}

/** A destination profile the app has never opened, with checkouts to map. */
function targetProfile(): { root: string; checkoutPath: string } {
  const root = tempDir("volli-restore-file-target-");
  const db = openRawDb(join(root, "volli.db"));
  db.pragma("user_version = 0");
  db.close();
  const checkoutPath = join(root, "checkout");
  mkdirSync(checkoutPath, { recursive: true });
  return { root, checkoutPath };
}

function mapping(checkoutPath: string): Record<string, string> {
  const paths = {
    "proj-alpha": join(checkoutPath, "alpha"),
    "proj-beta": join(checkoutPath, "beta"),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return paths;
}

/** Every table of a database, every row, in a stable order. */
function dumpDatabase(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    const dump: Record<string, unknown[]> = {
      user_version: [db.pragma("user_version", { simple: true })],
    };
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string; sql: string }[];
    for (const { name, sql } of tables) {
      const order = /WITHOUT ROWID/i.test(sql) ? "1" : "rowid";
      dump[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).raw().all();
    }
    dump.schema = db
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .raw()
      .all();
    return dump;
  } finally {
    db.close();
  }
}

/**
 * The two restored databases hold the same tables, rows and schema. The mapped
 * project directories differ only because each target has its own checkout.
 */
function expectSameDatabase([memoryRoot, fileRoot]: [string, string]): void {
  const normalize = (root: string): Record<string, unknown> =>
    JSON.parse(
      JSON.stringify(dumpDatabase(join(root, "volli.db"))).replaceAll(root, "<target>"),
    ) as Record<string, unknown>;
  const memory = normalize(memoryRoot);
  const file = normalize(fileRoot);
  expect(Object.keys(file)).toEqual(Object.keys(memory));
  for (const table of Object.keys(memory)) {
    // A fresh credential lineage per database, by design (VC-643): the one
    // value two restores of one bundle must NOT share.
    if (table === "web_credential_source") {
      expect(file[table]).not.toEqual(memory[table]);
      continue;
    }
    expect(file[table], table).toEqual(memory[table]);
  }
}

/** Every artifact file under a profile's stores, by relative path, by content hash. */
function artifactFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        files[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(blobsRoot(root));
  walk(sessionTranscriptsRoot(root));
  return files;
}

/** A refusal's problems, with its own target directory named generically. */
function problemsAt(result: { problems: unknown[] }, root: string): string {
  return JSON.stringify(result.problems).replaceAll(root, "<target>");
}

/** The claim every refusal makes: the profile is exactly as it was. */
function expectUntouched(root: string, before: Buffer): void {
  expect(readFileSync(join(root, "volli.db")).equals(before)).toBe(true);
  expect(existsSync(blobsRoot(root))).toBe(false);
  expect(readdirSync(root).some((name) => name.startsWith(".volli-restore-"))).toBe(false);
  expect(readdirSync(root).some((name) => name.startsWith(".volli-replaced-"))).toBe(false);
}

/** Restores one bundle both ways, each into its own fresh target, with time pinned. */
async function restoreBothWays(
  bytes: Buffer,
): Promise<{ memory: RestoreResult; file: RestoreResult; roots: [string, string] }> {
  vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
  const path = bundleFile(bytes);
  const memoryTarget = targetProfile();
  const fileTarget = targetProfile();
  const memory = await restoreBackupBundle({
    bundle: bytes,
    profileRoot: memoryTarget.root,
    projectPaths: mapping(memoryTarget.checkoutPath),
    now: NOW,
  });
  const file = await restoreBackupBundleFile({
    bundlePath: path,
    profileRoot: fileTarget.root,
    projectPaths: mapping(fileTarget.checkoutPath),
    now: NOW,
  });
  return { memory, file, roots: [memoryTarget.root, fileTarget.root] };
}

/** Rewrites a bundle's data document and re-stamps the manifest around it. */
function editDocument(bytes: Buffer, edit: (document: Record<string, unknown>) => unknown): Buffer {
  const entries = unpackArchive(bytes);
  const data = entries.find((entry) => entry.path === DATA_PATH);
  const manifestEntry = entries.find((entry) => entry.path === MANIFEST_PATH);
  if (data === undefined || manifestEntry === undefined) throw new Error("bundle is incomplete");
  const document = JSON.parse(data.bytes.toString("utf8")) as Record<string, unknown>;
  const edited = edit(document) ?? document;
  data.bytes = Buffer.from(`${JSON.stringify(edited, null, 2)}\n`, "utf8");
  const manifest = JSON.parse(manifestEntry.bytes.toString("utf8")) as BackupManifest;
  const declared = manifest.entries.find((entry) => entry.path === DATA_PATH);
  if (declared === undefined) throw new Error("manifest does not list data");
  declared.sizeBytes = data.bytes.length;
  declared.sha256 = createHash("sha256").update(data.bytes).digest("hex");
  if (typeof (edited as { schemaVersion?: unknown }).schemaVersion === "number") {
    (manifest as { schemaVersion: number }).schemaVersion = (
      edited as { schemaVersion: number }
    ).schemaVersion;
  }
  manifestEntry.bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return packArchive(entries);
}

/** Adds synthetic Session events, enough to cross the streaming checkpoints. */
function addEvents(source: FixtureProfile, count: number): void {
  const template = source.db
    .prepare("SELECT * FROM session_events WHERE session_id = 'session-root' LIMIT 1")
    .get() as Record<string, unknown>;
  const columns = Object.keys(template);
  const insert = source.db.prepare(
    `INSERT INTO session_events (${columns.map((column) => `"${column}"`).join(",")})
     VALUES (${columns.map(() => "?").join(",")})`,
  );
  source.db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const row: Record<string, unknown> = {
        ...template,
        id: `synthetic-event-${index}`,
        sequence: index + 100,
        command_id: null,
        payload: JSON.stringify({ kind: "synthetic.fixture", index }),
      };
      insert.run(...columns.map((column) => row[column]));
    }
  })();
}

describe("restoreBackupBundleFile — the same restore as restoreBackupBundle", () => {
  it("restores a fixture into the identical profile, row for row and file for file", async () => {
    const source = fixture();
    const { memory, file, roots } = await restoreBothWays(bundleOf(source));

    expect(memory.ok, JSON.stringify(memory)).toBe(true);
    expect(file.ok, JSON.stringify(file)).toBe(true);
    if (!memory.ok || !file.ok) return;
    const { replacedPath: memoryReplaced, projectPaths: _m, ...memoryReport } = memory.report;
    const { replacedPath: fileReplaced, projectPaths: _f, ...fileReport } = file.report;
    expect(fileReport).toEqual(memoryReport);
    expect(fileReplaced).toBe(join(roots[1], `.volli-replaced-${NOW}`));
    expect(memoryReplaced).toBe(join(roots[0], `.volli-replaced-${NOW}`));

    expectSameDatabase(roots);
    expect(artifactFiles(roots[1])).toEqual(artifactFiles(roots[0]));
    expect(Object.keys(artifactFiles(roots[1])).length).toBe(4);
    for (const root of roots) {
      expect(readdirSync(root).filter((name) => name.startsWith(".volli-restore-"))).toEqual([]);
    }
  });

  it("matches the source profile's counts and digests after the round trip", async () => {
    const source = fixture();
    addEvents(source, 50);
    const { file, roots } = await restoreBothWays(bundleOf(source));
    expect(file.ok, JSON.stringify(file)).toBe(true);

    const before = await digestProfile(source.db, source);
    const restored = new Database(join(roots[1], "volli.db"), { readonly: true });
    try {
      const after = await digestProfile(restored, {
        blobsRoot: blobsRoot(roots[1]),
        transcriptsRoot: sessionTranscriptsRoot(roots[1]),
      });
      // The usage projection is derived: the restore rebuilds it from the
      // events (the fixture never built one), and checks it against them.
      expect({ ...after, usage: null }).toEqual({ ...before, usage: null });
      expect(after.usage.rows).toBe(1);
      expect(after.tables.session_events?.rows).toBeGreaterThan(50);
      expect(after.blobs.rows).toBe(2);
      expect(after.transcripts.rows).toBe(2);
      // Redaction is reapplied by the digest; the mapping is the restore's own.
      expect(restored.prepare("SELECT path FROM projects WHERE id = 'proj-alpha'").get()).toEqual({
        path: join(roots[1], "checkout", "alpha"),
      });
    } finally {
      restored.close();
    }
  });

  it.each([HEAD_SCHEMA - 1, HEAD_SCHEMA - 2])(
    "restores an older schema-%i bundle identically, migrating it up",
    async (version) => {
      const source = fixture({ schemaVersion: version });
      const { memory, file, roots } = await restoreBothWays(bundleOf(source));

      expect(file.ok, JSON.stringify(file)).toBe(true);
      expect(memory.ok).toBe(true);
      if (!file.ok) return;
      expect(file.report.bundleSchemaVersion).toBe(version);
      expect(file.report.schemaVersion).toBe(HEAD_SCHEMA);
      expectSameDatabase(roots);
    },
  );

  it("carries no credential and leaves this profile's own credential files alone", async () => {
    const source = fixture();
    writeFileSync(join(source.root, SECRET_STORE_FILE_NAME), "source-only-sentinel");
    const path = bundleFile(bundleOf(source));
    const target = targetProfile();
    writeFileSync(join(target.root, MCP_CREDENTIAL_FILE_NAME), "target-mcp");
    writeFileSync(join(target.root, SECRET_STORE_FILE_NAME), "target-secrets");

    const result = await restoreBackupBundleFile({
      bundlePath: path,
      profileRoot: target.root,
      projectPaths: mapping(target.checkoutPath),
      now: NOW,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.report.credentials).toEqual(RESTORE_CREDENTIALS);
    expect(readFileSync(join(target.root, MCP_CREDENTIAL_FILE_NAME), "utf8")).toBe("target-mcp");
    expect(readFileSync(join(target.root, SECRET_STORE_FILE_NAME), "utf8")).toBe("target-secrets");
  });

  it("restores a bundle with no attachments to an empty attachment store, as in memory", async () => {
    const source = fixture();
    source.db.exec("DELETE FROM blob_links; DELETE FROM blobs;");
    const { memory, file, roots } = await restoreBothWays(bundleOf(source));

    expect(memory.ok).toBe(true);
    expect(file.ok, JSON.stringify(file)).toBe(true);
    for (const root of roots) {
      expect(readdirSync(blobsRoot(root))).toEqual([]);
    }
    expectSameDatabase(roots);
  });

  it("knows every insert trigger a streamed load order can trip", () => {
    // The file restore loads tables in document order and guards exactly the
    // event -> sequence pairs in TRIGGER_FILLED_TABLES. An insert trigger on
    // an included table that writes ANOTHER table would make the two
    // restores diverge; adding one must update the guard and this list.
    const source = fixture();
    const triggers = source.db
      .prepare(
        "SELECT tbl_name, name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name",
      )
      .all() as { tbl_name: string; name: string; sql: string }[];
    const insertTriggers = triggers
      .filter(
        (trigger) =>
          BACKUP_INCLUDED_TABLES.includes(trigger.tbl_name) &&
          /\b(?:BEFORE|AFTER)\s+INSERT\b/i.test(trigger.sql),
      )
      .map((trigger) => `${trigger.tbl_name}:${trigger.name}`);
    expect(insertTriggers).toEqual([
      "session_events:session_event_sequence_insert",
      "ticket_events:ticket_event_sequence_insert",
      // Same-table, row order only: the document carries rows in key order.
      "workspace_epochs:workspace_epochs_monotonic",
    ]);
    expect(Object.values(TRIGGER_FILLED_TABLES).toSorted()).toEqual([
      "session_events",
      "ticket_events",
    ]);
  });

  it("keeps the previous profile set aside, exactly as it was", async () => {
    const source = fixture();
    const path = bundleFile(bundleOf(source));
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));

    const result = await restoreBackupBundleFile({
      bundlePath: path,
      profileRoot: target.root,
      projectPaths: mapping(target.checkoutPath),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(result.report.replacedPath, "volli.db")).equals(before)).toBe(true);
  });
});

describe("restoreBackupBundleFile — the same refusals", () => {
  const cases: Array<{
    name: string;
    bytes: (source: FixtureProfile) => Buffer;
    paths: (checkout: string) => Record<string, string>;
  }> = [
    {
      name: "a project with no directory",
      bytes: bundleOf,
      paths: (checkout) => ({ "proj-alpha": mapping(checkout)["proj-alpha"]! }),
    },
    {
      name: "a directory that does not exist, a relative one, and a stranger",
      bytes: bundleOf,
      paths: (checkout) => ({
        "proj-alpha": join(checkout, "missing"),
        "proj-beta": "relative/beta",
        "proj-unknown": join(checkout, "alpha"),
      }),
    },
    {
      name: "two projects mapped to one directory",
      bytes: bundleOf,
      paths: (checkout) => {
        const alpha = mapping(checkout)["proj-alpha"]!;
        return { "proj-alpha": alpha, "proj-beta": alpha };
      },
    },
    {
      name: "a database newer than this build",
      bytes: (source) =>
        editDocument(bundleOf(source), (document) => {
          document.schemaVersion = HEAD_SCHEMA + 5;
        }),
      paths: mapping,
    },
    {
      name: "a missing artifact",
      bytes: (source) => {
        const entries = unpackArchive(bundleOf(source)).filter(
          (entry) => !entry.path.endsWith(source.blobHashes.session),
        );
        return packArchive(entries);
      },
      paths: mapping,
    },
    {
      name: "a dangling record link",
      bytes: (source) => {
        source.db.pragma("foreign_keys = OFF");
        source.db
          .prepare("UPDATE tickets SET project_id = 'proj-gone' WHERE id = 'ticket-live'")
          .run();
        return bundleOf(source);
      },
      paths: mapping,
    },
  ];

  it.each(cases)("refuses $name with the same problems, touching nothing", async (entry) => {
    const source = fixture();
    const bytes = entry.bytes(source);
    const memoryTarget = targetProfile();
    const fileTarget = targetProfile();
    const memoryBefore = readFileSync(join(memoryTarget.root, "volli.db"));
    const fileBefore = readFileSync(join(fileTarget.root, "volli.db"));

    const memory = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: memoryTarget.root,
      projectPaths: entry.paths(memoryTarget.checkoutPath),
      now: NOW,
    });
    const file = await restoreBackupBundleFile({
      bundlePath: bundleFile(bytes),
      profileRoot: fileTarget.root,
      projectPaths: entry.paths(fileTarget.checkoutPath),
      now: NOW,
    });

    expect(memory.ok).toBe(false);
    expect(file.ok).toBe(false);
    if (memory.ok || file.ok) return;
    expect(problemsAt(file, fileTarget.root)).toBe(problemsAt(memory, memoryTarget.root));
    expectUntouched(memoryTarget.root, memoryBefore);
    expectUntouched(fileTarget.root, fileBefore);
  });

  it("refuses a damaged archive and the JSON export, touching nothing", async () => {
    const source = fixture();
    const damaged = Buffer.from(bundleOf(source));
    damaged[damaged.length - 20] ^= 0xff;
    for (const bytes of [
      damaged,
      Buffer.from(JSON.stringify({ format: "volli-export", schemaVersion: 41 }), "utf8"),
    ]) {
      const target = targetProfile();
      const before = readFileSync(join(target.root, "volli.db"));
      const result = await restoreBackupBundleFile({
        bundlePath: bundleFile(bytes),
        profileRoot: target.root,
        projectPaths: mapping(target.checkoutPath),
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.problems[0]?.kind).toBe("archive");
      expectUntouched(target.root, before);
    }
  });

  it("refuses a file that does not exist, touching nothing", async () => {
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));
    const result = await restoreBackupBundleFile({
      bundlePath: join(target.root, "no-such-bundle.tar.gz"),
      profileRoot: target.root,
      projectPaths: {},
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toMatch(/could not be read/);
    expectUntouched(target.root, before);
  });

  it("bounds the mapping report for a bundle with many projects", async () => {
    const source = fixture();
    const template = source.db
      .prepare("SELECT * FROM projects WHERE id = 'proj-alpha'")
      .get() as Record<string, unknown>;
    const columns = Object.keys(template);
    const copy = source.db.prepare(
      `INSERT INTO projects (${columns.map((column) => `"${column}"`).join(",")})
       VALUES (${columns.map(() => "?").join(",")})`,
    );
    source.db.transaction(() => {
      for (let index = 0; index < 150; index += 1) {
        const row: Record<string, unknown> = {
          ...template,
          id: `proj-extra-${index}`,
          name: `Extra ${index}`,
          path: `/nowhere/${index}`,
          ticket_prefix: `X${index}`,
        };
        copy.run(...columns.map((column) => row[column]));
      }
    })();
    const target = targetProfile();
    const result = await restoreBackupBundleFile({
      bundlePath: bundleFile(bundleOf(source)),
      profileRoot: target.root,
      projectPaths: {},
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(101);
    expect(result.problems[100]?.message).toMatch(/more problems than this report lists/);
  });

  it("refuses a sequence table listed before its event table, which only the stream needs", async () => {
    const source = fixture();
    const reordered = editDocument(bundleOf(source), (document) => {
      const tables = document.tables as Record<string, unknown>;
      const moved: Record<string, unknown> = {};
      moved.session_event_sequence = tables.session_event_sequence;
      for (const [name, value] of Object.entries(tables)) {
        if (name !== "session_event_sequence") moved[name] = value;
      }
      document.tables = moved;
    });
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));

    const result = await restoreBackupBundleFile({
      bundlePath: bundleFile(reordered),
      profileRoot: target.root,
      projectPaths: mapping(target.checkoutPath),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      {
        kind: "shape",
        message:
          "Bundle data lists session_event_sequence before session_events; a file restore needs session_events first, as Volli writes it.",
      },
    ]);
    expectUntouched(target.root, before);
  });
});

describe("restoreBackupBundleFile — two reads of one file", () => {
  it("stages only the bytes that were verified: a changed file is refused", async () => {
    const source = fixture();
    const original = bundleOf(source);
    const path = bundleFile(original);
    const work = tempDir("volli-restore-file-work-");
    const opened = await openVerifiedBackupBundleFile(path, work);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const changedBundles = [
      // A different, internally consistent bundle: one row edited and re-stamped.
      editDocument(original, (document) => {
        const tickets = (document.tables as Record<string, { rows: unknown[][] }>).tickets!;
        tickets.rows[0]![1] = "edited after verification";
      }),
      // An extra artifact the verified inventory never saw.
      packArchive([
        ...unpackArchive(original),
        { path: "artifacts/blobs/" + "0".repeat(64), bytes: Buffer.from("x") },
      ]),
    ];
    try {
      for (const changed of changedBundles) {
        writeFileSync(path, changed);
        const staging = tempDir("volli-restore-file-staging-");
        const db = new Database(join(staging, "volli.db"));
        try {
          const { migrate } = await import("../db/migrations");
          db.pragma("foreign_keys = OFF");
          migrate(db, join(staging, "volli.db"), {
            toVersion: opened.inventory.bundle.document.schemaVersion,
          });
          await expect(
            stageBundleFile({
              filePath: path,
              db,
              staging,
              inventory: opened.inventory,
              projectPaths: mapping(tempDir("volli-restore-file-checkout-")),
            }),
          ).rejects.toBeInstanceOf(BundleChangedError);
        } finally {
          db.close();
        }
      }
    } finally {
      opened.inventory.close();
    }
  });

  it("refuses a file replaced while it was being verified, touching nothing", async () => {
    const source = fixture();
    // Enough rows that the verifier reaches a checkpoint inside its read.
    addEvents(source, 5_000);
    const original = bundleOf(source);
    const path = bundleFile(original);
    const replacement = join(tempDir("volli-restore-file-replacement-"), "next.tar.gz");
    writeFileSync(
      replacement,
      editDocument(original, (document) => {
        const tickets = (document.tables as Record<string, { rows: unknown[][] }>).tickets!;
        tickets.rows[0]![1] = "a different bundle";
      }),
    );
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));
    let calls = 0;

    const result = await restoreBackupBundleFile({
      bundlePath: path,
      profileRoot: target.root,
      projectPaths: mapping(target.checkoutPath),
      now: NOW,
      // The first read holds the old file open; the second opens the new one.
      checkpoint: async () => {
        calls += 1;
        if (calls === 1) renameSync(replacement, path);
      },
    });

    expect(calls).toBeGreaterThan(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.message).toMatch(
      /^The restore did not happen and the current profile is unchanged: The backup file changed after it was verified/,
    );
    expectUntouched(target.root, before);
  });

  it("reports a cancel during verification as a cancel, not a damaged bundle", async () => {
    const source = fixture();
    addEvents(source, 5_000);
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));

    const result = await restoreBackupBundleFile({
      bundlePath: bundleFile(bundleOf(source)),
      profileRoot: target.root,
      projectPaths: mapping(target.checkoutPath),
      now: NOW,
      checkpoint: async () => {
        throw new Error("cancelled by the person");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      {
        kind: "verify",
        message:
          "The restore did not happen and the current profile is unchanged: cancelled by the person",
      },
    ]);
    expectUntouched(target.root, before);
  });

  it("cancels mid-staging when the checkpoint rejects, touching nothing", async () => {
    const source = fixture();
    addEvents(source, 5_000);
    const path = bundleFile(bundleOf(source));
    // Count the verifier's own checkpoints, so the cancellation lands in staging.
    let verifyCalls = 0;
    const verified = await verifyBackupBundleFile(
      path,
      tempDir("volli-restore-file-count-"),
      async () => {
        verifyCalls += 1;
      },
    );
    expect(verified.ok).toBe(true);
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));
    let calls = 0;

    const result = await restoreBackupBundleFile({
      bundlePath: path,
      profileRoot: target.root,
      projectPaths: mapping(target.checkoutPath),
      now: NOW,
      checkpoint: async () => {
        calls += 1;
        if (calls > verifyCalls) throw new Error("cancelled by the person");
      },
    });

    expect(calls).toBe(verifyCalls + 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toBe(
      "The restore did not happen and the current profile is unchanged: cancelled by the person",
    );
    expectUntouched(target.root, before);
  });
});
