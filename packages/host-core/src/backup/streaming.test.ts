/**
 * What the bounded-memory writer and verifier promise, against a real profile.
 *
 * The important assertion is not "the new path works" but "the new path is the
 * SAME format": the bytes it writes are compared entry for entry with
 * `createBackupBundle`'s, and the existing reader is asked to accept them.
 * The failure cases are the ones a real daily backup meets — a file changed
 * under it, an archive cut short, a bundle missing an attachment, a record
 * link that goes nowhere — and each is asserted to be a NAMED problem rather
 * than a crash.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { packArchive, unpackArchive } from "./archive";
import {
  BACKUP_BUNDLE_VERSION,
  blobArtifactPath,
  createBackupBundle,
  DATA_PATH,
  MANIFEST_PATH,
  readBackupBundle,
  transcriptArtifactPath,
} from "./bundle";
import type { BackupManifest } from "./bundle";
import { verifyBackupBundleFile, writeBackupBundleFile } from "./streaming";
import { createFixtureProfile } from "./test-fixture";
import type { FixtureProfile } from "./test-fixture";

const APP_VERSION = "0.3.0-test";
const NOW = 1_700_000_000_000;

let profile: FixtureProfile | undefined;
const tempRoots: string[] = [];

afterEach(() => {
  profile?.cleanup();
  profile = undefined;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Context {
  profile: FixtureProfile;
  outputPath: string;
  workDir: string;
}

function setup(): Context {
  profile = createFixtureProfile();
  const root = mkdtempSync(join(tmpdir(), "volli-backup-streaming-"));
  tempRoots.push(root);
  return {
    profile,
    outputPath: join(root, "volli-backup-test.tar.gz.partial"),
    workDir: join(root, "work"),
  };
}

function writeOptions(context: Context, checkpoint?: () => Promise<void>) {
  return {
    db: context.profile.db,
    blobsRoot: context.profile.blobsRoot,
    transcriptsRoot: context.profile.transcriptsRoot,
    appVersion: APP_VERSION,
    now: NOW,
    outputPath: context.outputPath,
    workDir: context.workDir,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

function oldBundle(context: Context) {
  return createBackupBundle({
    db: context.profile.db,
    blobsRoot: context.profile.blobsRoot,
    transcriptsRoot: context.profile.transcriptsRoot,
    appVersion: APP_VERSION,
    now: NOW,
  });
}

/** Rewrites an archive after a caller has edited its entries. */
function rewriteBundle(
  path: string,
  edit: (entries: ReturnType<typeof unpackArchive>) => void,
): void {
  const entries = unpackArchive(readFileSync(path));
  edit(entries);
  writeFileSync(path, packArchive(entries));
}

function withManifest(
  path: string,
  edit: (manifest: BackupManifest, entries: ReturnType<typeof unpackArchive>) => void,
): void {
  rewriteBundle(path, (entries) => {
    const entry = entries.find((item) => item.path === MANIFEST_PATH);
    if (entry === undefined) throw new Error("no manifest");
    const manifest = JSON.parse(entry.bytes.toString("utf8")) as BackupManifest;
    edit(manifest, entries);
    entry.bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  });
}

function restampDataEntry(entries: ReturnType<typeof unpackArchive>): void {
  const data = entries.find((entry) => entry.path === DATA_PATH);
  const manifestEntry = entries.find((entry) => entry.path === MANIFEST_PATH);
  if (data === undefined || manifestEntry === undefined) throw new Error("no data entry");
  const manifest = JSON.parse(manifestEntry.bytes.toString("utf8")) as BackupManifest;
  const declared = manifest.entries.find((entry) => entry.path === DATA_PATH);
  if (declared === undefined) throw new Error("manifest does not list data");
  declared.sizeBytes = data.bytes.length;
  declared.sha256 = createHash("sha256").update(data.bytes).digest("hex");
  manifestEntry.bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

describe("writeBackupBundleFile", () => {
  it("writes a bundle the existing reader and the streaming verifier both accept", async () => {
    const context = setup();

    const written = await writeBackupBundleFile(writeOptions(context));

    const bytes = readFileSync(context.outputPath);
    expect(written.sizeBytes).toBe(bytes.length);
    const read = readBackupBundle(bytes);
    expect(read.ok).toBe(true);
    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.bundle.manifest).toMatchObject({
      bundleVersion: BACKUP_BUNDLE_VERSION,
      appVersion: APP_VERSION,
      schemaVersion: context.profile.db.pragma("user_version", { simple: true }),
      entries: { data: 1, blob: 2, transcript: 2 },
    });
    expect(verified.bundle.document.tables.tickets).toBe(2);
    expect(verified.bundle.document.usageCoverage.meteredFrom).toBe(0);
  });

  it("writes the same archive entries, byte for byte, as the in-memory writer", async () => {
    const context = setup();
    const old = oldBundle(context);

    await writeBackupBundleFile(writeOptions(context));

    const expected = unpackArchive(old.bytes);
    const actual = unpackArchive(readFileSync(context.outputPath));
    expect(actual.map((entry) => entry.path)).toEqual(expected.map((entry) => entry.path));
    for (const [index, entry] of actual.entries()) {
      expect(
        entry.bytes.equals(expected[index]?.bytes as Buffer),
        `${entry.path} differs from the in-memory writer`,
      ).toBe(true);
    }
  });

  it("streams an inventory beyond scratch transaction and transcript batch boundaries", async () => {
    const context = setup();
    const { db, transcriptsRoot } = context.profile;
    const template = db
      .prepare("SELECT * FROM session_events WHERE session_id = 'session-root' LIMIT 1")
      .get() as Record<string, unknown>;
    const columns = Object.keys(template);
    const insert = db.prepare(
      `INSERT INTO session_events (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    db.transaction(() => {
      for (let index = 0; index < 4_100; index += 1) {
        const bytes = Buffer.from(
          JSON.stringify({
            version: 1,
            threadId: "thread-1",
            branchId: "branch-1",
            attemptId: "attempt-1",
            turnId: "turn-1",
            message: {
              id: `inventory-${index}`,
              role: "user",
              parts: [{ type: "text", text: `Inventory ${index}` }],
            },
          }),
        );
        const digest = createHash("sha256").update(bytes).digest("hex");
        writeFileSync(join(transcriptsRoot, `${digest}.json`), bytes);
        const row = {
          ...template,
          id: `inventory-event-${index}`,
          sequence: index + 100,
          command_id: null,
          payload: JSON.stringify({
            kind: "synthetic.inventory",
            reference: {
              id: `sha256:${digest}`,
              digest: `sha256:${digest}`,
              mediaType: "application/vnd.volli.transcript+json",
            },
          }),
        };
        insert.run(...columns.map((column) => row[column as keyof typeof row]));
      }
    })();
    await writeBackupBundleFile(writeOptions(context));
    const result = await verifyBackupBundleFile(context.outputPath, context.workDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.manifest.entries.transcript).toBe(4_102);
  }, 30_000);

  it("is deterministic apart from the timestamp the caller supplies", async () => {
    const context = setup();

    await writeBackupBundleFile(writeOptions(context));
    const first = readFileSync(context.outputPath);
    await writeBackupBundleFile(writeOptions(context));

    expect(readFileSync(context.outputPath).equals(first)).toBe(true);
  });

  it("round-trips unicode, escapes and a large payload through writer and verifier", async () => {
    const context = setup();
    const body = `${'emoji 😀🚀, quotes "and" backslash \\ and\nnewline\t'.repeat(4)}${"x".repeat(256 * 1024)}`;
    context.profile.db
      .prepare("UPDATE tickets SET title = ?, body = ? WHERE id = ?")
      .run('Título — «ok» 😀 "quoted"', body, "ticket-live");
    context.profile.db.prepare("UPDATE session_events SET payload = ? WHERE id = ?").run(
      JSON.stringify({
        kind: "transcript.referenced",
        text: '日本語 😀 "escaped" \\ backslash\nline',
        reference: {
          id: context.profile.transcriptIds.reply,
          digest: context.profile.transcriptIds.reply,
        },
      }),
      "event-2",
    );

    await writeBackupBundleFile(writeOptions(context));

    const read = readBackupBundle(readFileSync(context.outputPath));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const tickets = read.bundle.document.tables.tickets;
    if (tickets === undefined) throw new Error("no tickets");
    const bodyIndex = tickets.columns.indexOf("body");
    const ticket = tickets.rows.find((row) => row[tickets.columns.indexOf("id")] === "ticket-live");
    expect(ticket?.[bodyIndex]).toBe(body);
    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);
    expect(verified.ok).toBe(true);
  });

  it("keeps the archive at outputPath when its own verification fails", async () => {
    const context = setup();
    // A dangling link is valid to WRITE (the old writer allows it) and invalid
    // to restore, which is exactly the state a self-verifying writer must
    // report without destroying the evidence.
    context.profile.db.pragma("foreign_keys = OFF");
    context.profile.db
      .prepare("UPDATE tickets SET project_id = ? WHERE id = ?")
      .run("proj-missing", "ticket-live");

    await expect(writeBackupBundleFile(writeOptions(context))).rejects.toThrow(
      /failed verification/i,
    );

    expect(existsSync(context.outputPath)).toBe(true);
    expect(statSync(context.outputPath).size).toBeGreaterThan(0);
    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.problems.some((problem) => problem.kind === "link")).toBe(true);
    expect(verified.problems.map((problem) => problem.message).join(" ")).toContain("proj-missing");
  });

  it("leaves no archive and no scratch files when cancelled before the write finishes", async () => {
    const context = setup();

    await expect(
      writeBackupBundleFile(
        writeOptions(context, async () => {
          throw new Error("cancelled");
        }),
      ),
    ).rejects.toThrow("cancelled");

    expect(existsSync(context.outputPath)).toBe(false);
    expect(readdirSync(context.workDir)).toEqual([]);
  });
});

describe("verifyBackupBundleFile", () => {
  it("accepts a bundle written by the in-memory writer", async () => {
    const context = setup();
    const old = oldBundle(context);
    writeFileSync(context.outputPath, old.bytes);

    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.bundle.manifest.schemaVersion).toBe(old.manifest.schemaVersion);
    expect(verified.bundle.manifest.appVersion).toBe(old.manifest.appVersion);
    expect(verified.bundle.manifest.createdAt).toBe(old.manifest.createdAt);
    expect(verified.bundle.document.schemaVersion).toBe(old.document.schemaVersion);
    for (const [table, data] of Object.entries(old.document.tables)) {
      expect(verified.bundle.document.tables[table]).toBe(data.rows.length);
    }
    expect(verified.bundle.document.usageCoverage).toEqual(old.document.usageCoverage);
  });

  it("reports attachment bytes that no longer match the manifest", async () => {
    const context = setup();
    await writeBackupBundleFile(writeOptions(context));
    rewriteBundle(context.outputPath, (entries) => {
      const entry = entries.find(
        (item) => item.path === blobArtifactPath(context.profile.blobHashes.ticket),
      );
      if (entry === undefined) throw new Error("no blob entry");
      entry.bytes = Buffer.from("ticket attachment bytez", "utf8");
    });

    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.problems[0]?.kind).toBe("artifact-corrupt");
    expect(verified.problems[0]?.message).toMatch(/SHA-256/);
  });

  it("reports a size that disagrees with the bytes present", async () => {
    const context = setup();
    await writeBackupBundleFile(writeOptions(context));
    withManifest(context.outputPath, (manifest) => {
      const entry = manifest.entries.find((item) => item.kind === "blob");
      if (entry === undefined) throw new Error("no blob entry");
      entry.sizeBytes += 1;
    });

    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.problems[0]?.kind).toBe("artifact-corrupt");
    expect(verified.problems[0]?.message).toMatch(/the manifest says/);
  });

  it("reports a manifest entry with no file behind it", async () => {
    const context = setup();
    await writeBackupBundleFile(writeOptions(context));
    rewriteBundle(context.outputPath, (entries) => {
      const index = entries.findIndex(
        (entry) => entry.path === blobArtifactPath(context.profile.blobHashes.ticket),
      );
      entries.splice(index, 1);
    });

    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.problems[0]?.kind).toBe("artifact-missing");
    expect(verified.problems[0]?.message).toContain(context.profile.blobHashes.ticket);
  });

  it("reports a transcript the ledger references that the bundle dropped", async () => {
    const context = setup();
    await writeBackupBundleFile(writeOptions(context));
    const dropped = transcriptArtifactPath(context.profile.transcriptIds.reply);
    rewriteBundle(context.outputPath, (entries) => {
      entries.splice(
        entries.findIndex((entry) => entry.path === dropped),
        1,
      );
    });
    withManifest(context.outputPath, (manifest) => {
      manifest.entries = manifest.entries.filter((entry) => entry.path !== dropped);
    });

    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.problems[0]?.kind).toBe("artifact-missing");
    expect(verified.problems[0]?.message).toMatch(/session ledger/);
  });

  it("reports a file the manifest does not list", async () => {
    const context = setup();
    await writeBackupBundleFile(writeOptions(context));
    rewriteBundle(context.outputPath, (entries) => {
      entries.push({ path: `artifacts/blobs/${"c".repeat(64)}`, bytes: Buffer.from("stow") });
    });

    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.problems[0]?.message).toMatch(/manifest does not list/);
  });

  it("reports data that is not valid JSON, and a data document of the wrong shape", async () => {
    const context = setup();
    await writeBackupBundleFile(writeOptions(context));
    rewriteBundle(context.outputPath, (entries) => {
      const data = entries.find((entry) => entry.path === DATA_PATH);
      if (data === undefined) throw new Error("no data entry");
      data.bytes = Buffer.from("[not json", "utf8");
      restampDataEntry(entries);
    });

    const invalid = await verifyBackupBundleFile(context.outputPath, context.workDir);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.problems[0]?.message).toMatch(/not valid JSON/);

    await writeBackupBundleFile(writeOptions(context));
    rewriteBundle(context.outputPath, (entries) => {
      const data = entries.find((entry) => entry.path === DATA_PATH);
      if (data === undefined) throw new Error("no data entry");
      data.bytes = Buffer.from(JSON.stringify({ format: "volli-backup-data" }), "utf8");
      restampDataEntry(entries);
    });

    const wrongShape = await verifyBackupBundleFile(context.outputPath, context.workDir);
    expect(wrongShape.ok).toBe(false);
    if (wrongShape.ok) return;
    expect(wrongShape.problems.map((problem) => problem.message).join(" ")).toMatch(
      /dataVersion|schemaVersion|tables/,
    );
  });

  it("refuses a truncated archive, and the in-memory reader now does too", async () => {
    const context = setup();
    await writeBackupBundleFile(writeOptions(context));
    const bytes = readFileSync(context.outputPath);
    writeFileSync(context.outputPath, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const truncated = await verifyBackupBundleFile(context.outputPath, context.workDir);
    expect(truncated.ok).toBe(false);
    if (truncated.ok) return;
    expect(truncated.problems[0]?.kind).toBe("archive");

    // A stream that ends exactly at an entry boundary, with the end marker
    // removed, used to look complete. Neither reader may accept it.
    await writeBackupBundleFile(writeOptions(context));
    const tar = gunzipSync(readFileSync(context.outputPath));
    const withoutEnd = gzipSync(tar.subarray(0, tar.length - 1024));
    writeFileSync(context.outputPath, withoutEnd);
    expect(() => unpackArchive(withoutEnd)).toThrow(/end-of-archive marker/i);
    const missingEnd = await verifyBackupBundleFile(context.outputPath, context.workDir);
    expect(missingEnd.ok).toBe(false);
    if (missingEnd.ok) return;
    expect(missingEnd.problems[0]?.kind).toBe("archive");
    expect(missingEnd.problems[0]?.message).toMatch(/end-of-archive marker/i);
  });

  it("refuses a bundle version this build does not know", async () => {
    const context = setup();
    await writeBackupBundleFile(writeOptions(context));
    withManifest(context.outputPath, (manifest) => {
      manifest.bundleVersion = BACKUP_BUNDLE_VERSION + 1;
    });

    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.problems[0]?.kind).toBe("unsupported-version");
    expect(verified.problems[0]?.message).toMatch(/newer version of Volli/);
  });

  it("reports a dangling record link by name", async () => {
    const context = setup();
    const old = oldBundle(context);
    writeFileSync(context.outputPath, old.bytes);
    context.profile.db.pragma("foreign_keys = OFF");
    context.profile.db
      .prepare("UPDATE tickets SET project_id = ? WHERE id = ?")
      .run("proj-missing", "ticket-live");
    writeFileSync(context.outputPath, oldBundle(context).bytes);

    const verified = await verifyBackupBundleFile(context.outputPath, context.workDir);

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.problems.some((problem) => problem.kind === "link")).toBe(true);
    expect(verified.problems.map((problem) => problem.message).join(" ")).toContain("proj-missing");
  });
});
