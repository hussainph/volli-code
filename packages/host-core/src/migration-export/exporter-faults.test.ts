/**
 * The exporter's failure and recovery paths: a disk that fills mid-write, a
 * staging area damaged in ways a crash can leave it, and a long source
 * resumed deep into its rows.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFixtureProfile, type FixtureProfile } from "../backup/test-fixture";
import {
  exportMigrationSnapshot,
  type MigrationExportManifest,
  type MigrationExportOptions,
} from "./exporter";
import { JOURNAL_FILE, SNAPSHOT_FILE, STATE_FILE, stagingDirOf } from "./staging";
import { verifyMigrationExport } from "./verify";

// Each test exports a whole profile through real files; a cold shared CI box is slow.
vi.setConfig({ testTimeout: 30_000 });

const disk = vi.hoisted(() => ({ full: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (disk.full && String(args[0]).includes("/streams/")) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return actual.open(...args);
    }) as typeof actual.open,
  };
});

let profile: FixtureProfile;
let work: string;

beforeEach(() => {
  disk.full = false;
  profile = createFixtureProfile();
  work = mkdtempSync(join(tmpdir(), "volli-migration-faults-"));
});
afterEach(() => {
  profile.cleanup();
  rmSync(work, { recursive: true, force: true });
});

function options(overrides: Partial<MigrationExportOptions> = {}): MigrationExportOptions {
  return {
    sourcePath: profile.dbPath,
    outDir: join(work, "export"),
    appVersion: "test",
    includeRemovedProjects: true,
    ...overrides,
  };
}

/** Leaves a staging area with a snapshot and a journal, as a cancel does. */
async function cancelledExport(): Promise<string> {
  const controller = new AbortController();
  await expect(
    exportMigrationSnapshot(
      options({
        chunkMaxRecords: 1,
        signal: controller.signal,
        onProgress: (report) => {
          if (report.phase === "exporting" && report.bytesWritten > 0) controller.abort();
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "cancelled" });
  return stagingDirOf(join(work, "export"));
}

function sessionEventText(dir: string, manifest: MigrationExportManifest): string {
  return manifest.streams
    .find((stream) => stream.name === "sessionEvents")!
    .chunks.map((chunk) => readFileSync(join(dir, chunk.file), "utf8"))
    .join("");
}

describe("a disk that fills", () => {
  it("fails as disk_full mid-write and resumes once there is room", async () => {
    let wrote = 0;
    await expect(
      exportMigrationSnapshot(
        options({
          chunkMaxRecords: 1,
          onProgress: (report) => {
            if (report.bytesWritten > 0 && ++wrote === 2) disk.full = true;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "disk_full" });
    expect(existsSync(join(work, "export"))).toBe(false);

    disk.full = false;
    const result = await exportMigrationSnapshot(options({ chunkMaxRecords: 1 }));
    expect(result.resumed).toBe(true);
    await verifyMigrationExport(result.outDir);
  });
});

describe("a damaged staging area", () => {
  it("re-snapshots when state.json is from another format or its snapshot is gone", async () => {
    const staging = await cancelledExport();
    writeFileSync(join(staging, STATE_FILE), JSON.stringify({ format: "something-else/9" }));
    const first = await exportMigrationSnapshot(options({ outDir: join(work, "export") }));
    expect(first.resumed).toBe(false);

    const second = await cancelledExportAt("again");
    rmSync(join(second, SNAPSHOT_FILE));
    const result = await exportMigrationSnapshot(options({ outDir: join(work, "again") }));
    expect(result.resumed).toBe(false);
  });

  async function cancelledExportAt(name: string): Promise<string> {
    const controller = new AbortController();
    await expect(
      exportMigrationSnapshot(
        options({
          outDir: join(work, name),
          signal: controller.signal,
          onProgress: (report) => {
            if (report.phase === "exporting") controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    return stagingDirOf(join(work, name));
  }

  it("surfaces filesystem faults it cannot explain", async () => {
    const staging = await cancelledExport();
    const journal = readFileSync(join(staging, JOURNAL_FILE), "utf8");
    const firstChunk = (JSON.parse(journal.split("\n")[0]!) as { chunks: Array<{ file: string }> })
      .chunks[0]!.file;

    // A chunk's directory replaced by a file: stat fails with ENOTDIR.
    const chunkDir = join(staging, firstChunk, "..");
    rmSync(chunkDir, { recursive: true });
    writeFileSync(chunkDir, "not a directory");
    await expect(exportMigrationSnapshot(options())).rejects.toMatchObject({
      code: "io_failed",
      message: expect.stringContaining("ENOTDIR"),
    });

    // The streams directory replaced by a file: listing fails with ENOTDIR.
    rmSync(join(staging, "streams"), { recursive: true, force: true });
    writeFileSync(join(staging, "streams"), "not a directory");
    writeFileSync(join(staging, JOURNAL_FILE), "");
    await expect(exportMigrationSnapshot(options())).rejects.toMatchObject({
      code: "io_failed",
      message: expect.stringContaining("ENOTDIR"),
    });

    // The journal replaced by a directory.
    rmSync(join(staging, JOURNAL_FILE));
    mkdirSync(join(staging, JOURNAL_FILE));
    await expect(exportMigrationSnapshot(options())).rejects.toMatchObject({
      code: "io_failed",
      message: expect.stringContaining("EISDIR"),
    });

    // state.json replaced by a directory.
    rmSync(join(staging, STATE_FILE));
    mkdirSync(join(staging, STATE_FILE));
    await expect(exportMigrationSnapshot(options())).rejects.toMatchObject({
      code: "io_failed",
      message: expect.stringContaining("EISDIR"),
    });
  });

  it("redoes a journaled chunk that went missing", async () => {
    const staging = await cancelledExport();
    const journal = readFileSync(join(staging, JOURNAL_FILE), "utf8");
    const first = (JSON.parse(journal.split("\n")[0]!) as { chunks: Array<{ file: string }> })
      .chunks[0]!.file;
    rmSync(join(staging, first));
    const result = await exportMigrationSnapshot(options());
    expect(result.resumed).toBe(true);
    await verifyMigrationExport(result.outDir);
  });

  it("refuses a source path it cannot open as a database", async () => {
    const directory = join(work, "a-directory.db");
    mkdirSync(directory);
    await expect(exportMigrationSnapshot(options({ sourcePath: directory }))).rejects.toMatchObject(
      { code: "source_unreadable", message: expect.stringContaining("Cannot open") },
    );
  });
});

describe("a long source", () => {
  it("yields while it works, and resumes thousands of rows in", async () => {
    const insert = profile.db.prepare(
      `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at,
                                   provenance_id, attachment_id, command_id, payload)
       VALUES (?, 'session-child', ?, 1, 1, 3, NULL, NULL, '{"kind":"session.archived"}')`,
    );
    profile.db.transaction(() => {
      for (let sequence = 2; sequence <= 5_001; sequence += 1) {
        insert.run(`bulk-${sequence}`, sequence);
      }
    })();
    const reference = await exportMigrationSnapshot(
      options({ outDir: join(work, "reference"), integrityCheck: false }),
    );

    const controller = new AbortController();
    let eventChunks = 0;
    let lastBytes = 0;
    await expect(
      exportMigrationSnapshot(
        options({
          chunkMaxRecords: 1_000,
          signal: controller.signal,
          onProgress: (report) => {
            if (report.source === "sessionEvents" && report.bytesWritten > lastBytes) {
              if (++eventChunks === 5) controller.abort();
            }
            lastBytes = report.bytesWritten;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });

    const result = await exportMigrationSnapshot(options({ chunkMaxRecords: 1_000 }));
    expect(result.resumed).toBe(true);
    expect(sessionEventText(result.outDir, result.manifest)).toBe(
      sessionEventText(reference.outDir, reference.manifest),
    );
  });
});
