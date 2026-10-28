import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vite-plus/test";
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
  expect(streamRecords(outDir, manifest, "automationArmings")).toEqual([]);
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
  expect(stream.chunks.length).toBeGreaterThan(10);
  const pi = streamRecords(outDir, manifest, "piLogs");
  expect(pi.length).toBeGreaterThan(1);
  expect(pi[0]!.startOffset).toBe(0);
  expect(pi.at(-1)!.endOffset).toBe(pi[0]!.fileBytes);
  await verifyMigrationExport(outDir);
}, 60000);
