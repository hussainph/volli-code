import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { migrationDocument, MigrationRowError } from "@volli/shared/cloud";
import {
  writeMoveProfile,
  MOVE_IDS,
  type MoveFault,
} from "../migration-dry-run/test-support/move-profile";
import { SYNTHETIC_IDS as ids } from "../migration-dry-run/test-support/synthetic-profile";
import { exportMigrationSnapshot, type MigrationExportManifest } from "./exporter";
import { streamRecords } from "./test-support/export-files";
import { verifyMigrationExport } from "./verify";
import { createOrphanCleanupEngine } from "../worktree/cleanup-engine";
import { SqliteOrphanCleanupLedger } from "../worktree/cleanup-ledger";

// Full migrated profiles, VACUUM snapshots and fsynced chunks, like exporter.test.ts.
// A cold CI disk under the packages lane needs the same I/O timeout budget.
vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(artifacts = 3, fault?: MoveFault) {
  const root = mkdtempSync(join(tmpdir(), "volli-move-export-"));
  roots.push(root);
  const profile = writeMoveProfile(root, { artifacts, fault, now: 1_800_000_000_000 });
  return { root, ...profile };
}
function options(f: ReturnType<typeof fixture>, projectIds?: string[]) {
  return {
    sourcePath: f.dbPath,
    outDir: join(f.root, "export"),
    appVersion: "move-test",
    projectIds,
  };
}

function childVisibility(result: Awaited<ReturnType<typeof exportMigrationSnapshot>>) {
  return streamRecords(result.outDir, result.manifest, "sessions").find(
    (s) => s.id === ids.childSession,
  )!.visibility;
}

it("exports only the selected local project closure, with references to projects still local", async () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  try {
    const insert = db.prepare(
      "INSERT INTO automation_commands (id,intent,created_at) VALUES (?,?,1)",
    );
    insert.run("global-ledger", "{}");
    insert.run("other-project-ledger", JSON.stringify({ projectId: ids.project }));
  } finally {
    db.close();
  }
  const before = readFileSync(f.dbPath);
  const { outDir, manifest } = await exportMigrationSnapshot(options(f, [MOVE_IDS.project]));
  expect(readFileSync(f.dbPath)).toEqual(before);
  expect(manifest.projectIds).toEqual([MOVE_IDS.project]);
  expect(manifest.profileStep).toBe(false);
  expect(manifest.prefixClashes).toEqual([
    { prefix: "AL", projectIds: [ids.project, MOVE_IDS.project] },
  ]);
  expect(streamRecords(outDir, manifest, "tickets").map((r) => r.id)).toEqual([MOVE_IDS.ticket]);
  expect(streamRecords(outDir, manifest, "sessions").map((r) => r.id)).toEqual([ids.childSession]);
  expect(streamRecords(outDir, manifest, "delegations")[0]!.parentSessionId).toBe(ids.hotSession);
  expect(manifest.crossProjectReferences).toEqual(
    expect.arrayContaining([
      { kind: "delegation", fromProjectId: MOVE_IDS.project, toProjectId: ids.project, count: 1 },
      { kind: "sharedBlob", fromProjectId: MOVE_IDS.project, toProjectId: ids.project, count: 1 },
      { kind: "ticketKey", fromProjectId: MOVE_IDS.project, toProjectId: ids.project, count: 1 },
    ]),
  );
  expect(streamRecords(outDir, manifest, "configEntries").every((r) => r.level === "project")).toBe(
    true,
  );
  expect(streamRecords(outDir, manifest, "ticketBodies")[0]!.body).toContain("café / cafe\u0301");
  expect(streamRecords(outDir, manifest, "transcriptArtifacts")).toEqual([]);
});

it("excludes removed/shadow projects, shadow tickets, drained and cloud-born Sessions in every stream", async () => {
  const f = fixture();
  const { outDir, manifest } = await exportMigrationSnapshot(options(f));
  expect(manifest.projectIds).toEqual([ids.project, MOVE_IDS.project]);
  const all = manifest.streams
    .flatMap((s) => s.chunks.map((c) => readFileSync(join(outDir, c.file), "utf8")))
    .join("");
  for (const id of [
    ids.removedProject,
    MOVE_IDS.shadowProject,
    MOVE_IDS.shadowTicket,
    MOVE_IDS.shadowAutomation,
    MOVE_IDS.drainedSession,
    MOVE_IDS.bornCloudSession,
  ])
    expect(all).not.toContain(id);
  expect(
    streamRecords(outDir, manifest, "projectCounters").find((r) => r.projectId === ids.project)!
      .nextTicketNumber,
  ).toBe(6);
  expect(
    streamRecords(outDir, manifest, "tickets").find((r) => r.id === ids.tickets[3])!.archivedAt,
  ).not.toBeNull();
  expect(streamRecords(outDir, manifest, "labels").some((r) => r.mergedIntoId === ids.label)).toBe(
    true,
  );
  expect(streamRecords(outDir, manifest, "runnerJobs")).toEqual([]);
  expect(streamRecords(outDir, manifest, "automationArmings")).toHaveLength(1);
  expect(streamRecords(outDir, manifest, "automationScheduleCursors")).toEqual([]);
  expect(streamRecords(outDir, manifest, "legacyRows").map((r) => r.table)).toEqual(
    expect.arrayContaining([
      "automation_pending_armed_runs",
      "automation_column_arming",
      "automation_schedule_cursors",
    ]),
  );
  expect(manifest.pendingRunnerWork).toBe(false);
  expect((await verifyMigrationExport(outDir)).manifest).toEqual(manifest);
});

it("offers removed projects only explicitly and rejects an ineligible selection", async () => {
  const f = fixture();
  await expect(exportMigrationSnapshot(options(f, [ids.removedProject]))).rejects.toThrow(
    /eligible local project/,
  );
  const result = await exportMigrationSnapshot({
    ...options(f, [ids.removedProject]),
    includeRemovedProjects: true,
  });
  expect(result.manifest.projectIds).toEqual([ids.removedProject]);
});

it.each(["comment", "transcript", "pi", "blob"] as const)(
  "names a %s orphan rather than dropping it",
  async (fault) => {
    const f = fixture(3, fault);
    await expect(exportMigrationSnapshot(options(f))).rejects.toMatchObject({
      code: "source_corrupt",
      message: expect.stringMatching(new RegExp(fault === "pi" ? "Pi attachment" : fault)),
    });
  },
);

it("refuses a non-UUID row by name in the real import mapper, without changing its id", async () => {
  const f = fixture(1, "nonUuid");
  const { outDir, manifest } = await exportMigrationSnapshot(options(f, [ids.project]));
  const row = streamRecords(outDir, manifest, "labels").find((r) => r.id === "not-a-uuid")!;
  expect(() =>
    migrationDocument(
      "labels",
      row,
      { userId: ids.project, workspaceId: ids.removedProject, runnerId: MOVE_IDS.project },
      1,
    ),
  ).toThrow(MigrationRowError);
});

it("does not reuse staged checkpoints when project selection changes", async () => {
  const f = fixture();
  const controller = new AbortController();
  await expect(
    exportMigrationSnapshot({
      ...options(f, [ids.project]),
      chunkMaxRecords: 1,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "exporting" && p.bytesWritten > 0) controller.abort();
      },
    }),
  ).rejects.toMatchObject({ code: "cancelled" });
  const result = await exportMigrationSnapshot(options(f, [MOVE_IDS.project]));
  expect(result.resumed).toBe(false);
  expect(result.manifest.projectIds).toEqual([MOVE_IDS.project]);
});

it("does not publish a completed partial manifest for another selection", async () => {
  const f = fixture();
  const first = await exportMigrationSnapshot(options(f, [ids.project]));
  renameSync(first.outDir, `${first.outDir}.partial`);
  const result = await exportMigrationSnapshot(options(f, [MOVE_IDS.project]));
  expect(result.resumed).toBe(false);
  expect(result.manifest.projectIds).toEqual([MOVE_IDS.project]);
});

it("refuses queued follow-ups but does not treat historical open attachments as live work", async () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  try {
    db.prepare(
      "INSERT INTO session_follow_up_queue (session_id,pending_count,state) VALUES (?,1,'{}')",
    ).run(ids.hotSession);
  } finally {
    db.close();
  }
  await expect(exportMigrationSnapshot(options(f))).rejects.toThrow(/pendingFollowUps/);
  // Another project's queue does not block the selected child project.
  const result = await exportMigrationSnapshot(options(f, [MOVE_IDS.project]));
  expect(result.manifest.preflight.pendingFollowUps).toBe(0);
});

it.each(["completed", "interrupted"])(
  "blocks unfinished cleanups until %s through the real engine",
  async (outcome) => {
    const f = fixture();
    const db = new Database(f.dbPath);
    try {
      let next = 0;
      const engine = createOrphanCleanupEngine({
        ledger: new SqliteOrphanCleanupLedger(db),
        now: () => 1,
        nextId: () => `cleanup-fact-${++next}`,
      });
      const accepted = await engine.accept({
        commandId: "cleanup",
        source: "settings",
        scanRevision: "rev",
        requestedItemIds: ["item"],
        retentionDays: 14,
        preservation: [],
        items: [
          {
            id: "item",
            kind: "worktree",
            path: join(f.root, "worktree"),
            projectId: ids.project,
            projectName: "Alpha",
            projectPath: f.root,
            branch: null,
            gitReason: null,
          },
        ],
      });
      expect(accepted.ok).toBe(true);
      await expect(exportMigrationSnapshot(options(f, [ids.project]))).rejects.toThrow(
        /openCleanupCommands/,
      );
      const other = await exportMigrationSnapshot({
        ...options(f, [MOVE_IDS.project]),
        outDir: join(f.root, "other"),
      });
      expect(other.manifest.preflight.openCleanupCommands).toBe(0);
      await engine.beginItem({ commandId: "cleanup", itemId: "item" });
      if (outcome === "completed") {
        await engine.settleItem({
          commandId: "cleanup",
          itemId: "item",
          state: "completed",
          detail: "done",
        });
        await engine.finish({ commandId: "cleanup" });
      } else {
        await engine.markInterrupted({ commandId: "cleanup" });
      }
      const complete = await exportMigrationSnapshot({ ...options(f, [ids.project]), fresh: true });
      expect(complete.manifest.preflight.openCleanupCommands).toBe(0);
    } finally {
      db.close();
    }
  },
);

it("keeps cross-project private ancestry identical for project and profile exports", async () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  try {
    db.prepare("UPDATE sessions SET role='project',ticket_id=NULL WHERE id=?").run(ids.hotSession);
  } finally {
    db.close();
  }
  const all = await exportMigrationSnapshot(options(f));
  const child = await exportMigrationSnapshot({
    ...options(f, [MOVE_IDS.project]),
    outDir: join(f.root, "child"),
  });
  expect(childVisibility(all)).toBe("private");
  expect(childVisibility(child)).toBe("private");
});

it("names local Sessions whose ticket would fall outside the selected closure", async () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  try {
    db.prepare("UPDATE sessions SET ticket_id=? WHERE id=?").run(ids.tickets[0], ids.childSession);
  } finally {
    db.close();
  }
  await expect(exportMigrationSnapshot(options(f, [MOVE_IDS.project]))).rejects.toThrow(
    /Session .* outside the selected local project/,
  );
});

it("names historical attempt orphans that have no database foreign key", async () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  try {
    db.prepare(
      `INSERT INTO automation_pending_armed_run_attempts (id,command_id,ticket_id,project_id,ticket_display_id,automation_id,automation_name,status,origin,opened_at,start_at,error) VALUES ('orphan','command','deleted-ticket','deleted-project','AL-9','automation','Run','todo','armed',1,2,'failed')`,
    ).run();
  } finally {
    db.close();
  }
  await expect(exportMigrationSnapshot(options(f))).rejects.toThrow(
    /orphan automation_pending_armed_run_attempts .*missing project/,
  );
});

it("detects a wholly omitted Pi file, not just gaps in files still present", async () => {
  const f = fixture();
  const { outDir, manifest } = await exportMigrationSnapshot(options(f));
  const stream = manifest.streams.find((s) => s.name === "piLogs")!;
  for (const chunk of stream.chunks) rmSync(join(outDir, chunk.file));
  stream.chunks = [];
  stream.bytes = 0;
  stream.records = 0;
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest));
  await expect(verifyMigrationExport(outDir)).rejects.toThrow(/Pi log coverage is incomplete/);
});

function tamper(
  dir: string,
  manifest: MigrationExportManifest,
  name: "transcriptArtifacts" | "piLogs",
  edit: (row: Record<string, unknown>) => void,
) {
  const stream = manifest.streams.find((s) => s.name === name)!;
  const chunk = stream.chunks[0]!;
  const lines = readFileSync(join(dir, chunk.file), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l));
  edit(lines[0]);
  const bytes = Buffer.from(lines.map((l) => JSON.stringify(l) + "\n").join(""));
  stream.bytes += bytes.length - chunk.bytes;
  chunk.bytes = bytes.length;
  chunk.sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(dir, chunk.file), bytes);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}
it.each(["transcriptArtifacts", "piLogs"] as const)(
  "verifies %s semantically even if chunk checksums are rewritten",
  async (name) => {
    const f = fixture();
    const { outDir, manifest } = await exportMigrationSnapshot(options(f));
    tamper(outDir, manifest, name, (row) => {
      if (name === "piLogs") row.startOffset = 1;
      else row.digest = `sha256:${"0".repeat(64)}`;
    });
    await expect(verifyMigrationExport(outDir)).rejects.toMatchObject({ code: "integrity_failed" });
  },
);

it("streams a 50 MiB transcript Session and multi-slice Pi log with complete digest coverage", async () => {
  const f = fixture(2048);
  const { outDir, manifest } = await exportMigrationSnapshot(options(f));
  const stream = manifest.streams.find((s) => s.name === "transcriptArtifacts")!;
  expect(stream.records).toBe(2048);
  expect(stream.bytes).toBeGreaterThan(50 * 1024 * 1024);
  expect(stream.chunks.length).toBeGreaterThan(5);
  const pi = streamRecords(outDir, manifest, "piLogs");
  expect(pi.length).toBeGreaterThan(1);
  expect(pi[0]!.startOffset).toBe(0);
  expect(pi.at(-1)!.endOffset).toBe(pi[0]!.fileBytes);
  await verifyMigrationExport(outDir);
}, 60000);

it("exports the profile step alone: personal settings and unbound Automations, no project", async () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  try {
    db.prepare(
      `INSERT INTO automations (id, project_id, name, instructions, runtime, created_at, updated_at)
       VALUES ('7a1f0c2e-0000-4000-8000-000000000049', NULL, 'Everywhere', '/sweep', NULL, 1, 1)`,
    ).run();
  } finally {
    db.close();
  }
  const { outDir, manifest } = await exportMigrationSnapshot({
    ...options(f, []),
    profileStep: true,
  });
  expect(manifest.projectIds).toEqual([]);
  expect(manifest.profileStep).toBe(true);
  for (const stream of ["projects", "tickets", "sessions", "sessionEvents"] as const) {
    expect(streamRecords(outDir, manifest, stream)).toEqual([]);
  }
  const entries = streamRecords(outDir, manifest, "configEntries");
  expect(entries.length).toBeGreaterThan(0);
  expect(new Set(entries.map((entry) => entry.level))).toEqual(new Set(["personal"]));
  expect(entries.map((entry) => entry.name)).toContain("Everywhere");
});

describe("a dry run's export (VC-1029)", () => {
  it("measures the history a copy carries, checking it the same way, and stages none of it", async () => {
    const f = fixture(256);
    const copy = await exportMigrationSnapshot(options(f));
    const measured = await exportMigrationSnapshot({
      ...options(f),
      outDir: join(f.root, "measured"),
      measureHistory: true,
    });
    const history = measured.manifest.historyMeasured!;
    const copied = streamRecords(copy.outDir, copy.manifest, "transcriptArtifacts");
    const slices = streamRecords(copy.outDir, copy.manifest, "piLogs");
    expect(history).toEqual({
      transcripts: copied.length,
      transcriptBytes: copied.reduce(
        (sum, record) => sum + Buffer.byteLength(record.canonicalJson as string),
        0,
      ),
      piSlices: slices.length,
      piLogBytes: slices.reduce((sum, record) => sum + (record.sourceBytes as number), 0),
    });
    expect(history.transcripts).toBe(256);
    expect(copy.manifest.historyMeasured).toBeUndefined();
    for (const name of ["transcriptArtifacts", "piLogs"])
      expect(measured.manifest.streams.find((stream) => stream.name === name)).toMatchObject({
        records: 0,
        bytes: 0,
        chunks: [],
      });
    expect(existsSync(join(measured.outDir, "streams", "transcriptArtifacts"))).toBe(false);
    expect(measured.manifest.piLogFiles).toEqual(copy.manifest.piLogFiles);
    await expect(verifyMigrationExport(measured.outDir)).resolves.toMatchObject({
      manifest: { historyMeasured: history },
    });
  }, 60000);
  it.each(["transcript", "pi"] as const)(
    "refuses a %s fault while measuring, exactly as a copy does",
    async (fault) => {
      const f = fixture(3, fault);
      await expect(
        exportMigrationSnapshot({ ...options(f), measureHistory: true }),
      ).rejects.toMatchObject({
        code: "source_corrupt",
        message: expect.stringMatching(new RegExp(fault === "pi" ? "Pi attachment" : fault)),
      });
    },
  );
  it("refuses a measured manifest that claims a different coverage", async () => {
    const f = fixture(8);
    const { outDir, manifest } = await exportMigrationSnapshot({
      ...options(f),
      measureHistory: true,
    });
    const tampered = {
      ...manifest,
      historyMeasured: { ...manifest.historyMeasured!, transcripts: 7 },
    };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(tampered));
    await expect(verifyMigrationExport(outDir)).rejects.toThrow("Transcript digest coverage");
  });
  it.each([
    ["transcripts", { transcripts: 1.5 }, "carries no history"],
    ["transcriptBytes", { transcriptBytes: -0.5 }, "carries no history"],
    ["piSlices", { piSlices: Number.NaN }, "carries no history"],
    ["piLogBytes", { piLogBytes: 2 ** 60 }, "carries no history"],
    ["Pi coverage", { piLogBytes: 1 }, "Pi log coverage is incomplete"],
  ] as const)("refuses a measured manifest with a forged %s", async (_name, forged, message) => {
    const f = fixture(2);
    const { outDir, manifest } = await exportMigrationSnapshot({
      ...options(f),
      measureHistory: true,
    });
    const tampered = { ...manifest, historyMeasured: { ...manifest.historyMeasured!, ...forged } };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(tampered));
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(message);
  });
  it("refuses a copy that claims to be a measure", async () => {
    const f = fixture(2);
    const { outDir, manifest } = await exportMigrationSnapshot(options(f));
    const tampered = {
      ...manifest,
      historyMeasured: { transcripts: 2, transcriptBytes: 1, piSlices: 1, piLogBytes: 1 },
    };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(tampered));
    await expect(verifyMigrationExport(outDir)).rejects.toThrow("carries no history");
  });
  it("takes one snapshot for several projects: later exports link it instead of copying", async () => {
    const f = fixture();
    const kept = join(f.root, "kept.db");
    const first = await exportMigrationSnapshot({
      ...options(f),
      outDir: join(f.root, "first"),
      measureHistory: true,
      sharedSnapshot: { keepAt: kept },
    });
    // The kept file is the first export's own snapshot, linked rather than copied.
    expect(statSync(kept).nlink).toBe(1);
    const later = exportMigrationSnapshot({
      ...options(f, [MOVE_IDS.project]),
      outDir: join(f.root, "second"),
      measureHistory: true,
      sharedSnapshot: { from: kept },
      onProgress: (progress) => {
        if (progress.phase !== "verifying") return;
        const staged = join(f.root, "second.partial", "snapshot.db");
        expect(statSync(staged).ino).toBe(statSync(kept).ino);
      },
    });
    const second = await later;
    expect(second.manifest.snapshotAt).toBe(first.manifest.snapshotAt);
    expect(second.manifest.projectIds).toEqual([MOVE_IDS.project]);
    expect(readdirSync(join(f.root, "second"))).not.toContain("snapshot.db");
    expect(existsSync(kept)).toBe(true);
    await expect(
      exportMigrationSnapshot({
        ...options(f, [MOVE_IDS.project]),
        outDir: join(f.root, "third"),
        sharedSnapshot: { from: join(f.root, "missing.db") },
      }),
    ).rejects.toMatchObject({ code: "source_unreadable" });
    // A kept snapshot of another database is never someone else's export.
    const other = fixture();
    await expect(
      exportMigrationSnapshot({
        ...options(other, [MOVE_IDS.project]),
        outDir: join(other.root, "fourth"),
        sharedSnapshot: { from: kept },
      }),
    ).rejects.toMatchObject({
      code: "source_unreadable",
      message: expect.stringMatching(/another/),
    });
  });
});
