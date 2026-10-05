/**
 * What a bundle carries, and what a reader refuses.
 *
 * Every failure case here is one a person could actually meet — a file that
 * did not finish copying, a bundle from a newer build, an archive somebody
 * edited — and each is asserted to produce a NAMED problem rather than a
 * throw, because the report is what a restore shows before it declines to
 * touch anything.
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { blobFilePath } from "../blob-store";
import { packArchive, unpackArchive } from "./archive";
import {
  BACKUP_BUNDLE_FORMAT,
  BACKUP_BUNDLE_VERSION,
  blobArtifactPath,
  createBackupBundle,
  DATA_PATH,
  defaultBackupFilename,
  MANIFEST_PATH,
  readBackupBundle,
  transcriptArtifactPath,
} from "./bundle";
import type { BackupManifest } from "./bundle";
import { createFixtureProfile } from "./test-fixture";
import type { FixtureProfile } from "./test-fixture";

let profile: FixtureProfile;

afterEach(() => {
  profile.cleanup();
});

function build(): ReturnType<typeof createBackupBundle> {
  return createBackupBundle({
    db: profile.db,
    blobsRoot: profile.blobsRoot,
    transcriptsRoot: profile.transcriptsRoot,
    appVersion: "0.2.0-test",
    now: 1_700_000_000_000,
  });
}

/** Rebuilds an archive from its entries after a caller has edited them. */
function repack(bytes: Buffer, edit: (entries: ReturnType<typeof unpackArchive>) => void): Buffer {
  const entries = unpackArchive(bytes);
  edit(entries);
  return packArchive(entries);
}

function manifestOf(bytes: Buffer): BackupManifest {
  const entry = unpackArchive(bytes).find((item) => item.path === MANIFEST_PATH);
  return JSON.parse((entry as { bytes: Buffer }).bytes.toString("utf8")) as BackupManifest;
}

function withManifest(bytes: Buffer, edit: (manifest: BackupManifest) => void): Buffer {
  return repack(bytes, (entries) => {
    const entry = entries.find((item) => item.path === MANIFEST_PATH);
    if (entry === undefined) throw new Error("no manifest");
    const manifest = JSON.parse(entry.bytes.toString("utf8")) as BackupManifest;
    edit(manifest);
    entry.bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  });
}

describe("createBackupBundle", () => {
  it("writes a manifest naming the bundle version, app, schema, and every file", () => {
    profile = createFixtureProfile();

    const bundle = build();
    const manifest = manifestOf(bundle.bytes);

    expect(manifest.format).toBe(BACKUP_BUNDLE_FORMAT);
    expect(manifest.format).not.toBe("volli-export");
    expect(manifest.bundleVersion).toBe(BACKUP_BUNDLE_VERSION);
    expect(manifest.appVersion).toBe("0.2.0-test");
    expect(manifest.schemaVersion).toBe(profile.db.pragma("user_version", { simple: true }));
    expect(manifest.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(manifest.entries.map((entry) => entry.path)).toContain(DATA_PATH);
    for (const entry of manifest.entries) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sizeBytes).toBeGreaterThan(0);
    }
    // The manifest deliberately does not hash itself.
    expect(manifest.entries.map((entry) => entry.path)).not.toContain(MANIFEST_PATH);
  });

  it("carries every attachment's bytes and every referenced transcript", () => {
    profile = createFixtureProfile();

    const bundle = build();
    const paths = manifestOf(bundle.bytes).entries.map((entry) => entry.path);

    expect(paths).toContain(blobArtifactPath(profile.blobHashes.ticket));
    expect(paths).toContain(blobArtifactPath(profile.blobHashes.session));
    expect(paths).toContain(transcriptArtifactPath(profile.transcriptIds.prompt));
    expect(paths).toContain(transcriptArtifactPath(profile.transcriptIds.reply));
  });

  it("exports a compressed transcript as canonical version-1 bytes with the canonical hash", () => {
    profile = createFixtureProfile();
    const id = profile.transcriptIds.prompt;
    const digest = id.slice("sha256:".length);
    const plainPath = `${profile.transcriptsRoot}/${digest}.json`;
    const canonical = readFileSync(plainPath);
    writeFileSync(`${plainPath}.gz`, gzipSync(canonical));
    rmSync(plainPath);

    const bundle = build();
    const archivePath = transcriptArtifactPath(id);
    const archived = unpackArchive(bundle.bytes).find((entry) => entry.path === archivePath)?.bytes;
    const manifestEntry = bundle.manifest.entries.find((entry) => entry.path === archivePath);

    expect(archived).toEqual(canonical);
    expect(manifestEntry).toMatchObject({
      kind: "transcript",
      sizeBytes: canonical.length,
      sha256: digest,
    });
    expect(readBackupBundle(bundle.bytes)).toMatchObject({ ok: true });
    expect(bundle.manifest.bundleVersion).toBe(1);
  });

  it("carries no credential, no harness trust, and no channel health", () => {
    profile = createFixtureProfile();

    const bundle = build();
    const text = gunzipSync(bundle.bytes).toString("utf8");

    expect(Object.keys(bundle.document.tables)).not.toContain("secrets");
    expect(Object.keys(bundle.document.tables)).not.toContain("legacy_safe_storage_secrets");
    expect(Object.keys(bundle.document.tables)).not.toContain("registered_harnesses");
    expect(Object.keys(bundle.document.tables)).not.toContain("harness_channel");
    expect(Object.keys(bundle.document.tables)).not.toContain("web_access_settings");
    expect(text).not.toContain("sk-secret-value");
    expect(text).not.toContain("anthropic:api-key");
    expect(text).not.toContain("searxng");
  });

  it("carries no local path and no live terminal handle", () => {
    profile = createFixtureProfile();

    const bundle = build();
    const text = gunzipSync(bundle.bytes).toString("utf8");

    expect(text).not.toContain("/Users/source/code/alpha");
    expect(text).not.toContain("/Users/source/.volli/worktrees");
    expect(text).not.toContain("pty-4711");
    const projects = bundle.document.tables.projects;
    const pathIndex = projects?.columns.indexOf("path") ?? -1;
    expect(projects?.rows.every((row) => row[pathIndex] === "")).toBe(true);
  });

  it("preserves pr_url, retention_keep, run attendance, and the archived ticket", () => {
    profile = createFixtureProfile();

    const bundle = build();
    const tickets = bundle.document.tables.tickets;
    const columns = tickets?.columns ?? [];
    const archived = tickets?.rows.find((row) => row[columns.indexOf("id")] === "ticket-archived");

    expect(archived?.[columns.indexOf("pr_url")]).toBe("https://github.com/example/alpha/pull/9");
    expect(archived?.[columns.indexOf("retention_keep")]).toBe(1);
    expect(archived?.[columns.indexOf("archived_at")]).toBe(950);
    const runs = bundle.document.tables.automation_runs;
    expect(runs?.rows[0]?.[runs.columns.indexOf("attendance")]).toBe("unattended");
  });

  it("carries the metering boundary rather than leaving a restore to invent one", () => {
    profile = createFixtureProfile();
    profile.db.prepare("UPDATE session_usage_coverage SET metered_from = 12345 WHERE id = 1").run();

    expect(build().document.usageCoverage.meteredFrom).toBe(12345);
  });

  it("refuses to write a bundle whose attachment bytes are missing", () => {
    profile = createFixtureProfile();
    rmSync(blobFilePath(profile.blobsRoot, profile.blobHashes.ticket));

    expect(() => build()).toThrow(/missing from the blob store/i);
  });

  it("refuses to write a bundle whose attachment bytes changed under it", () => {
    profile = createFixtureProfile();
    writeFileSync(blobFilePath(profile.blobsRoot, profile.blobHashes.ticket), "tampered");

    expect(() => build()).toThrow(/no longer match their own hash/i);
  });

  it("is deterministic apart from the timestamp the caller supplies", () => {
    profile = createFixtureProfile();

    const first = build();
    const second = build();

    expect(first.bytes.equals(second.bytes)).toBe(true);
  });
});

describe("readBackupBundle", () => {
  it("accepts a bundle it just wrote and hands back verified artifacts", () => {
    profile = createFixtureProfile();

    const result = readBackupBundle(build().bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.document.tables.tickets?.rows).toHaveLength(2);
    expect(result.bundle.artifacts.get(blobArtifactPath(profile.blobHashes.ticket))).toBeDefined();
    expect(
      result.bundle.artifacts.get(transcriptArtifactPath(profile.transcriptIds.prompt)),
    ).toBeDefined();
  });

  it("reports a missing artifact by name", () => {
    profile = createFixtureProfile();
    const tampered = repack(build().bytes, (entries) => {
      const index = entries.findIndex(
        (entry) => entry.path === blobArtifactPath(profile.blobHashes.ticket),
      );
      entries.splice(index, 1);
    });

    const result = readBackupBundle(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((problem) => problem.kind === "artifact-missing")).toBe(true);
    expect(result.problems[0]?.message).toContain(profile.blobHashes.ticket);
  });

  it("reports artifact bytes that changed", () => {
    profile = createFixtureProfile();
    const tampered = repack(build().bytes, (entries) => {
      const entry = entries.find(
        (item) => item.path === blobArtifactPath(profile.blobHashes.ticket),
      );
      if (entry === undefined) throw new Error("no blob entry");
      entry.bytes = Buffer.from("ticket attachment bytez", "utf8");
    });

    const result = readBackupBundle(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.kind)).toContain("artifact-corrupt");
    expect(result.problems[0]?.message).toMatch(/SHA-256/);
  });

  it("reports a size that disagrees with the bytes present", () => {
    profile = createFixtureProfile();
    const tampered = withManifest(build().bytes, (manifest) => {
      const entry = manifest.entries.find((item) => item.kind === "blob");
      if (entry === undefined) throw new Error("no blob entry");
      entry.sizeBytes += 1;
    });

    const result = readBackupBundle(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toMatch(/the manifest says/);
  });

  it("reports a manifest hash that no longer describes the data document", () => {
    profile = createFixtureProfile();
    const tampered = withManifest(build().bytes, (manifest) => {
      const entry = manifest.entries.find((item) => item.kind === "data");
      if (entry === undefined) throw new Error("no data entry");
      entry.sha256 = "0".repeat(64);
    });

    const result = readBackupBundle(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.kind).toBe("artifact-corrupt");
    expect(result.problems[0]?.message).toContain(DATA_PATH);
  });

  it("reports a file the manifest does not list", () => {
    profile = createFixtureProfile();
    const tampered = repack(build().bytes, (entries) => {
      entries.push({ path: "artifacts/blobs/" + "c".repeat(64), bytes: Buffer.from("stow") });
    });

    const result = readBackupBundle(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toMatch(/manifest does not list/);
  });

  it("reports malformed data", () => {
    profile = createFixtureProfile();
    const broken = Buffer.from("{ this is not json", "utf8");
    const tampered = repack(build().bytes, (entries) => {
      const entry = entries.find((item) => item.path === DATA_PATH);
      if (entry === undefined) throw new Error("no data entry");
      entry.bytes = broken;
    });
    // Re-stamp the manifest so the failure under test is the SHAPE, not the hash.
    const restamped = withManifest(tampered, (manifest) => {
      const entry = manifest.entries.find((item) => item.kind === "data");
      if (entry === undefined) throw new Error("no data entry");
      entry.sizeBytes = broken.length;
      entry.sha256 = createHash("sha256").update(broken).digest("hex");
    });

    const result = readBackupBundle(restamped);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toMatch(/not valid JSON/);
  });

  it("reports a record link the bundle cannot satisfy", () => {
    profile = createFixtureProfile();
    profile.db.pragma("foreign_keys = OFF");
    profile.db
      .prepare("UPDATE tickets SET project_id = 'proj-missing' WHERE id = ?")
      .run("ticket-live");

    const result = readBackupBundle(build().bytes);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((problem) => problem.kind === "link")).toBe(true);
    expect(result.problems.map((problem) => problem.message).join(" ")).toContain("proj-missing");
  });

  it("reports a transcript reference with no artifact behind it", () => {
    profile = createFixtureProfile();
    const bundle = build();
    const tampered = withManifest(
      repack(bundle.bytes, (entries) => {
        const index = entries.findIndex(
          (entry) => entry.path === transcriptArtifactPath(profile.transcriptIds.reply),
        );
        entries.splice(index, 1);
      }),
      (manifest) => {
        manifest.entries = manifest.entries.filter(
          (entry) => entry.path !== transcriptArtifactPath(profile.transcriptIds.reply),
        );
      },
    );

    const result = readBackupBundle(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.kind).toBe("artifact-missing");
    expect(result.problems[0]?.message).toMatch(/session ledger/);
  });

  it("refuses a bundle version this build does not know, and says which way", () => {
    profile = createFixtureProfile();

    const newer = readBackupBundle(
      withManifest(build().bytes, (manifest) => {
        manifest.bundleVersion = BACKUP_BUNDLE_VERSION + 1;
      }),
    );
    const older = readBackupBundle(
      withManifest(build().bytes, (manifest) => {
        manifest.bundleVersion = 0;
      }),
    );

    expect(newer.ok).toBe(false);
    expect(older.ok).toBe(false);
    if (newer.ok || older.ok) return;
    expect(newer.problems[0]?.kind).toBe("unsupported-version");
    expect(newer.problems[0]?.message).toMatch(/newer version of Volli/);
    expect(older.problems[0]?.kind).toBe("unsupported-version");
    expect(older.problems[0]?.message).toMatch(/not supported/);
  });

  it("refuses an unsafe archive path without unpacking it", () => {
    profile = createFixtureProfile();
    const tar = gunzipSync(build().bytes);
    // Rewrite the first header's name in place, then repair its checksum, so
    // the archive is well-formed in every respect except the path.
    tar.fill(0, 0, 100);
    tar.write("../../../../etc/cron.d/evil", 0, "utf8");
    tar.fill(" ", 148, 156);
    let sum = 0;
    for (const byte of tar.subarray(0, 512)) sum += byte;
    tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");

    const result = readBackupBundle(gzipSync(tar));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.kind).toBe("archive");
    expect(result.problems[0]?.message).toMatch(/unsafe path/i);
  });

  it("refuses the volli-export JSON document by name", () => {
    profile = createFixtureProfile();
    const exportish = packArchive([
      {
        path: MANIFEST_PATH,
        bytes: Buffer.from(JSON.stringify({ format: "volli-export", schemaVersion: 41 }), "utf8"),
      },
    ]);

    const result = readBackupBundle(exportish);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toMatch(/limited data export and cannot be restored/);
  });

  it("refuses an artifact filed under a name that is not its own hash", () => {
    profile = createFixtureProfile();
    const wrongName = `artifacts/blobs/${"d".repeat(64)}`;
    const tampered = withManifest(
      repack(build().bytes, (entries) => {
        const entry = entries.find(
          (item) => item.path === blobArtifactPath(profile.blobHashes.ticket),
        );
        if (entry === undefined) throw new Error("no blob entry");
        entry.path = wrongName;
      }),
      (manifest) => {
        const entry = manifest.entries.find(
          (item) => item.path === blobArtifactPath(profile.blobHashes.ticket),
        );
        if (entry === undefined) throw new Error("no blob entry");
        entry.path = wrongName;
      },
    );

    const result = readBackupBundle(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toMatch(/named for a different hash/);
  });

  it("refuses bytes that are not an archive at all", () => {
    profile = createFixtureProfile();

    const result = readBackupBundle(Buffer.from("hello", "utf8"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.kind).toBe("archive");
  });
});

describe("defaultBackupFilename", () => {
  it("is a dated tarball, never a .json", () => {
    expect(defaultBackupFilename(new Date(2026, 0, 5))).toBe("volli-backup-2026-01-05.tar.gz");
  });
});
