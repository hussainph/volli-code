/**
 * Restoring a bundle into a clean profile, and every way that must be refused.
 *
 * The invariant every failure case asserts is the same one: the profile that
 * was there before is still there afterwards, unchanged. A restore that half
 * happens is worse than one that does not happen, so the checks run against a
 * staged profile and the swap is the last thing that occurs.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { blobFilePath, blobsRoot } from "../blob-store";
import { packArchive, unpackArchive } from "./archive";
import { MIGRATIONS } from "../db/migrations";
import { openRawDb } from "../db/test-helpers";
import { sessionTranscriptsRoot } from "../session-runtime/transcript-artifacts";
import { createBackupBundle } from "./bundle";
import { restoreBackupBundle } from "./restore";
import { createFixtureProfile } from "./test-fixture";
import type { FixtureProfile } from "./test-fixture";

const HEAD_SCHEMA = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

let source: FixtureProfile;
const scratch: string[] = [];

afterEach(() => {
  source.cleanup();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A destination profile that already holds data of its own, so a merge would show. */
function targetProfile(): { root: string; checkoutPath: string } {
  const root = mkdtempSync(join(tmpdir(), "volli-backup-target-"));
  scratch.push(root);
  const dbPath = join(root, "volli.db");
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  // A profile the app has never opened is the honest starting point for a
  // restore; the file is created so the swap has something to move aside.
  db.pragma("user_version = 0");
  db.close();
  const checkoutPath = join(root, "checkout");
  mkdirSync(checkoutPath, { recursive: true });
  return { root, checkoutPath };
}

function bundleBytes(options: { schemaVersion?: number } = {}): Buffer {
  source = createFixtureProfile(options);
  return createBackupBundle({
    db: source.db,
    blobsRoot: source.blobsRoot,
    transcriptsRoot: source.transcriptsRoot,
    appVersion: "0.2.0-test",
    now: 1_700_000_000_000,
  }).bytes;
}

function mapping(checkoutPath: string): Record<string, string> {
  return { "proj-alpha": join(checkoutPath, "alpha"), "proj-beta": join(checkoutPath, "beta") };
}

function makeCheckouts(paths: Record<string, string>): Record<string, string> {
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return paths;
}

function restoredDb(root: string) {
  const db = openRawDb(join(root, "volli.db"));
  db.pragma("foreign_keys = ON");
  return db;
}

describe("restoreBackupBundle — a clean restore", () => {
  it("puts back every record, in order, with its fields and artifacts intact", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const paths = makeCheckouts(mapping(target.checkoutPath));

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: paths,
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const db = restoredDb(target.root);
    try {
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count("projects")).toBe(2);
      expect(count("tickets")).toBe(2);
      expect(count("labels")).toBe(1);
      expect(count("ticket_labels")).toBe(1);
      expect(count("ticket_comments")).toBe(1);
      expect(count("ticket_signals")).toBe(2);
      expect(count("sessions")).toBe(2);
      expect(count("session_events")).toBe(5);
      expect(count("session_command_receipts")).toBe(1);
      expect(count("session_delegation_extensions")).toBe(1);
      expect(count("automations")).toBe(1);
      expect(count("automation_runs")).toBe(1);
      expect(count("automation_pending_armed_runs")).toBe(1);
      expect(count("automation_pending_armed_run_attempts")).toBe(1);
      expect(count("blob_links")).toBe(2);

      // Session ledger order.
      expect(
        db
          .prepare(
            "SELECT id FROM session_events WHERE session_id = 'session-root' ORDER BY sequence",
          )
          .all(),
      ).toEqual([{ id: "event-1" }, { id: "event-2" }, { id: "event-3" }, { id: "event-4" }]);
      // Ticket event order, including the two events that share a millisecond.
      expect(
        db
          .prepare("SELECT event_id FROM ticket_event_sequence ORDER BY sequence")
          .all()
          .map((row) => (row as { event_id: string }).event_id),
      ).toEqual(["tevent-1", "tevent-2", "tevent-3"]);

      // Ticket fields a restore must not lose.
      const archived = db
        .prepare("SELECT pr_url, retention_keep, archived_at FROM tickets WHERE id = ?")
        .get("ticket-archived") as { pr_url: string; retention_keep: number; archived_at: number };
      expect(archived).toEqual({
        pr_url: "https://github.com/example/alpha/pull/9",
        retention_keep: 1,
        archived_at: 950,
      });
      expect(
        (
          db.prepare("SELECT attendance FROM automation_runs WHERE id = 'arun-1'").get() as {
            attendance: string;
          }
        ).attendance,
      ).toBe("unattended");
      expect(
        (
          db
            .prepare("SELECT trigger_spec, runtime FROM automations WHERE id = 'automation-1'")
            .get() as {
            trigger_spec: string;
            runtime: string;
          }
        ).trigger_spec,
      ).toBe(JSON.stringify({ kind: "column", statuses: ["needs_review"] }));
    } finally {
      db.close();
    }

    // Attachment bytes and transcript bodies, by content.
    expect(
      readFileSync(blobFilePath(blobsRoot(target.root), source.blobHashes.ticket)).toString("utf8"),
    ).toBe("ticket attachment bytes");
    const transcriptPath = join(
      sessionTranscriptsRoot(target.root),
      `${source.transcriptIds.prompt.slice("sha256:".length)}.json`,
    );
    expect(JSON.parse(readFileSync(transcriptPath, "utf8"))).toMatchObject({
      message: { id: "message-1", parts: [{ type: "text", text: "restore me" }] },
    });
    expect(result.report.artifactsVerified).toBe(4);
  });

  it("rebuilds the usage projection from the events and keeps the metering boundary", async () => {
    source = createFixtureProfile();
    source.db.prepare("UPDATE session_usage_coverage SET metered_from = 99 WHERE id = 1").run();
    const bytes = createBackupBundle({
      db: source.db,
      blobsRoot: source.blobsRoot,
      transcriptsRoot: source.transcriptsRoot,
      appVersion: "0.2.0-test",
      now: 1_700_000_000_000,
    }).bytes;
    const target = targetProfile();

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: makeCheckouts(mapping(target.checkoutPath)),
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const db = restoredDb(target.root);
    try {
      const usage = db.prepare("SELECT * FROM session_usage").all() as Array<{
        event_id: string;
        project_id: string;
        ticket_id: string;
        cost_usd: number;
        cache_read_tokens: number;
      }>;
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        event_id: "event-4",
        project_id: "proj-alpha",
        ticket_id: "ticket-live",
        cost_usd: 0.25,
        cache_read_tokens: 400,
      });
      expect(
        (
          db.prepare("SELECT metered_from FROM session_usage_coverage WHERE id = 1").get() as {
            metered_from: number;
          }
        ).metered_from,
      ).toBe(99);
    } finally {
      db.close();
    }
    expect(result.report.usage).toEqual({ rows: 1, meteredFrom: 99 });
  });

  it("restores no credential, no harness trust, and no reused local path or handle", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const paths = makeCheckouts(mapping(target.checkoutPath));

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: paths,
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(true);
    const db = restoredDb(target.root);
    try {
      for (const table of [
        "secrets",
        "legacy_safe_storage_secrets",
        "registered_harnesses",
        "harness_channel",
        "web_access_settings",
      ]) {
        expect(
          (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
          `${table} must be empty after a restore`,
        ).toBe(0);
      }
      const projects = db.prepare("SELECT id, path FROM projects ORDER BY id").all();
      expect(projects).toEqual([
        { id: "proj-alpha", path: paths["proj-alpha"] },
        { id: "proj-beta", path: paths["proj-beta"] },
      ]);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE worktree_path IS NOT NULL").get(),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM session_attachments WHERE native_id IS NOT NULL")
          .get(),
      ).toEqual({ n: 0 });
      const detail = (
        db.prepare("SELECT native_detail FROM session_attachments WHERE id = 'attach-1'").get() as {
          native_detail: string;
        }
      ).native_detail;
      expect(JSON.parse(detail)).toEqual({ kind: "volli.terminal.v1", harnessId: "claude-code" });
      const provenance = (
        db
          .prepare(
            `SELECT p.provenance
               FROM session_events e
               JOIN session_provenances p ON p.id = e.provenance_id
              WHERE e.id = 'event-1'`,
          )
          .get() as { provenance: string }
      ).provenance;
      expect(provenance).not.toContain("/Users/source");
    } finally {
      db.close();
    }
  });

  it("keeps distinct intern rows when redaction collapses their provenance text", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: makeCheckouts(mapping(target.checkoutPath)),
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(true);
    const db = restoredDb(target.root);
    try {
      expect(
        db
          .prepare(
            `SELECT provenance, COUNT(*) AS n
               FROM session_provenances
              GROUP BY provenance
             HAVING COUNT(*) > 1`,
          )
          .get(),
      ).toEqual({
        provenance: JSON.stringify({
          source: { kind: "adapter", id: "terminal", detail: {} },
          venue: { id: "local", kind: "local" },
        }),
        n: 2,
      });
    } finally {
      db.close();
    }
  });

  it("moves the previous profile aside instead of merging into it", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: makeCheckouts(mapping(target.checkoutPath)),
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(result.report.replacedPath)).toBe(true);
    expect(readFileSync(join(result.report.replacedPath, "volli.db")).equals(before)).toBe(true);
    // No staging left behind.
    expect(readdirSync(target.root).some((name) => name.startsWith(".volli-restore-"))).toBe(false);
  });

  it("puts the previous profile back when the swap fails partway through", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const now = 1_800_000_000_000;
    // The live profile has a blob directory of its own, and the place it
    // would be set aside to is already a non-empty directory, so the swap's
    // FIRST move succeeds for volli.db and then fails on `blobs`. Every check
    // has passed by this point; the only thing left to go wrong is the swap.
    mkdirSync(join(blobsRoot(target.root), "aa"), { recursive: true });
    writeFileSync(join(blobsRoot(target.root), "aa", "old-blob"), "old");
    const replacedPath = join(target.root, `.volli-replaced-${now}`);
    mkdirSync(join(replacedPath, "blobs", "occupied"), { recursive: true });
    writeFileSync(join(replacedPath, "blobs", "occupied", "file"), "x");
    const before = readFileSync(join(target.root, "volli.db"));

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: makeCheckouts(mapping(target.checkoutPath)),
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toMatch(/current profile is unchanged/);
    // The claim in that message has to be true: the database is back where it
    // was, with the same bytes, and the old blob directory is intact.
    expect(readFileSync(join(target.root, "volli.db")).equals(before)).toBe(true);
    expect(existsSync(join(blobsRoot(target.root), "aa", "old-blob"))).toBe(true);
    expect(readdirSync(target.root).some((name) => name.startsWith(".volli-restore-"))).toBe(false);
  });
});

describe("restoreBackupBundle — an older bundle from a supported app version", () => {
  it("migrates the bundle's schema up and rebuilds the usage views there", async () => {
    const olderVersion = HEAD_SCHEMA - 1;
    const bytes = bundleBytes({ schemaVersion: olderVersion });
    const target = targetProfile();

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: makeCheckouts(mapping(target.checkoutPath)),
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.bundleSchemaVersion).toBe(olderVersion);
    expect(result.report.schemaVersion).toBe(HEAD_SCHEMA);
    const db = restoredDb(target.root);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(HEAD_SCHEMA);
      expect(db.prepare("SELECT COUNT(*) AS n FROM session_usage").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  // Three whole restores in one case, each a migrate-write-migrate-verify
  // walk; comfortably under a second alone, tens of seconds under a loaded CI
  // runner, so the budget is stated rather than left to the default.
  it(
    "walks every supported schema step, not only the newest one",
    { timeout: 60_000 },
    async () => {
      // Each supported step is exercised as its own restore: the point of the
      // window is that EVERY documented version still restores, and a loop that
      // only checked the newest would pass on a build where the older ones do not.
      for (const version of [HEAD_SCHEMA, HEAD_SCHEMA - 1, HEAD_SCHEMA - 2]) {
        const bytes = bundleBytes({ schemaVersion: version });
        const target = targetProfile();

        const result = await restoreBackupBundle({
          bundle: bytes,
          profileRoot: target.root,
          projectPaths: makeCheckouts(mapping(target.checkoutPath)),
          now: 1_800_000_000_000,
        });

        expect(result.ok, `schema ${version} should restore`).toBe(true);
        const db = restoredDb(target.root);
        try {
          expect(db.pragma("user_version", { simple: true })).toBe(HEAD_SCHEMA);
          expect(db.prepare("SELECT COUNT(*) AS n FROM session_usage").get()).toEqual({ n: 1 });
        } finally {
          db.close();
        }
        source.cleanup();
      }
      // The afterEach cleanup expects a live fixture; give it the last one.
      source = createFixtureProfile();
    },
  );
});

/** The claim every refusal makes: the profile is exactly as it was. */
function expectUntouched(root: string, before: Buffer): void {
  expect(readFileSync(join(root, "volli.db")).equals(before)).toBe(true);
  expect(existsSync(blobsRoot(root))).toBe(false);
  expect(readdirSync(root).some((name) => name.startsWith(".volli-restore-"))).toBe(false);
  expect(readdirSync(root).some((name) => name.startsWith(".volli-replaced-"))).toBe(false);
}

describe("restoreBackupBundle — refusals", () => {
  it("requires a mapping for every project and never reuses the saved path", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));
    const alpha = join(target.checkoutPath, "alpha");
    mkdirSync(alpha, { recursive: true });

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: { "proj-alpha": alpha },
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.kind).toBe("mapping");
    expect(result.problems[0]?.message).toContain("proj-beta");
    expectUntouched(target.root, before);
  });

  it("refuses a directory that does not exist, rather than creating one", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: {
        "proj-alpha": join(target.checkoutPath, "nope"),
        "proj-beta": join(target.checkoutPath, "beta"),
      },
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.every((problem) => problem.kind === "mapping")).toBe(true);
    expectUntouched(target.root, before);
  });

  it("refuses two projects mapped to one directory", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));
    const shared = join(target.checkoutPath, "shared");
    mkdirSync(shared, { recursive: true });

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: { "proj-alpha": shared, "proj-beta": shared },
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toMatch(/same directory/i);
    expectUntouched(target.root, before);
  });

  it("refuses a relative directory", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));

    const result = await restoreBackupBundle({
      bundle: bytes,
      profileRoot: target.root,
      projectPaths: { "proj-alpha": "alpha", "proj-beta": join(target.checkoutPath, "beta") },
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(false);
    expectUntouched(target.root, before);
  });

  it("refuses a bundle with a missing artifact before touching the profile", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));
    const withoutBlob = packArchive(
      unpackArchive(bytes).filter(
        (entry) => entry.path !== `artifacts/blobs/${source.blobHashes.session}`,
      ),
    );

    const result = await restoreBackupBundle({
      bundle: withoutBlob,
      profileRoot: target.root,
      projectPaths: makeCheckouts(mapping(target.checkoutPath)),
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.kind).toBe("artifact-missing");
    expect(result.problems[0]?.message).toContain(source.blobHashes.session);
    expectUntouched(target.root, before);
  });

  it("refuses a corrupt bundle before touching the profile", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));
    const damaged = Buffer.from(bytes);
    damaged[damaged.length - 20] ^= 0xff;

    const result = await restoreBackupBundle({
      bundle: damaged,
      profileRoot: target.root,
      projectPaths: makeCheckouts(mapping(target.checkoutPath)),
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(false);
    expectUntouched(target.root, before);
  });

  it("refuses a bundle whose database schema is newer than this build knows", async () => {
    const bytes = bundleBytes();
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));
    // Bend the data document's schemaVersion past this build's newest
    // migration, and re-stamp the manifest so the ONLY problem is the schema.
    const forged = forgeSchemaVersion(bytes, HEAD_SCHEMA + 5);

    const result = await restoreBackupBundle({
      bundle: forged,
      profileRoot: target.root,
      projectPaths: makeCheckouts(mapping(target.checkoutPath)),
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.kind).toBe("unsupported-version");
    expect(result.problems[0]?.message).toMatch(/newer version of Volli/);
    expectUntouched(target.root, before);
  });

  it("refuses the volli-export JSON file as a backup", async () => {
    source = createFixtureProfile();
    const target = targetProfile();
    const before = readFileSync(join(target.root, "volli.db"));

    const result = await restoreBackupBundle({
      bundle: Buffer.from(JSON.stringify({ format: "volli-export", schemaVersion: 41 }), "utf8"),
      profileRoot: target.root,
      projectPaths: {},
      now: 1_800_000_000_000,
    });

    expect(result.ok).toBe(false);
    expectUntouched(target.root, before);
  });
});

/** Rewrites the data document's schemaVersion and re-stamps the manifest around it. */
function forgeSchemaVersion(bytes: Buffer, schemaVersion: number): Buffer {
  const entries = unpackArchive(bytes);
  const data = entries.find((entry) => entry.path === "data.json");
  const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
  if (data === undefined || manifestEntry === undefined) throw new Error("bundle is incomplete");
  const document = JSON.parse(data.bytes.toString("utf8")) as { schemaVersion: number };
  document.schemaVersion = schemaVersion;
  data.bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  const manifest = JSON.parse(manifestEntry.bytes.toString("utf8")) as {
    schemaVersion: number;
    entries: Array<{ path: string; sizeBytes: number; sha256: string }>;
  };
  manifest.schemaVersion = schemaVersion;
  const entry = manifest.entries.find((item) => item.path === "data.json");
  if (entry === undefined) throw new Error("manifest has no data entry");
  entry.sizeBytes = data.bytes.length;
  entry.sha256 = createHash("sha256").update(data.bytes).digest("hex");
  manifestEntry.bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return packArchive(entries);
}
