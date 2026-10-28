/**
 * The migration exporter against a real migrated profile (`backup/test-fixture.ts`
 * seeds every table the product writes, through the real migrations).
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFixtureProfile, type FixtureProfile } from "../backup/test-fixture";
import { withProfileMaintenance, profileMaintenanceActive } from "../backup/profile-maintenance";
import { MigrationExportError } from "./errors";
import {
  discardPartialMigrationExport,
  exportMigrationSnapshot,
  migrationExportDiskRequirement,
  type MigrationExportManifest,
  type MigrationExportOptions,
  type MigrationExportProgress,
} from "./exporter";
import { JOURNAL_FILE, MANIFEST_FILE, SNAPSHOT_FILE, STATE_FILE, stagingDirOf } from "./staging";
import { mcpOperationId, mcpServerEntryId } from "./transform";
import { verifyMigrationExport } from "./verify";
import { streamRecords as records, streamTexts as contentOf } from "./test-support/export-files";

// Each test exports a whole profile through real files; a cold shared CI box is slow.
vi.setConfig({ testTimeout: 30_000 });

const threadContext = vi.hoisted(() => ({ isMainThread: true }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get isMainThread() {
    return threadContext.isMainThread;
  },
}));

let profile: FixtureProfile;
let work: string;

beforeEach(() => {
  profile = createFixtureProfile();
  profile.db.pragma("journal_mode = WAL");
  work = mkdtempSync(join(tmpdir(), "volli-migration-export-"));
});
afterEach(() => {
  threadContext.isMainThread = true;
  profile.cleanup();
  rmSync(work, { recursive: true, force: true });
});

function options(overrides: Partial<MigrationExportOptions> = {}): MigrationExportOptions {
  return {
    sourcePath: profile.dbPath,
    outDir: join(work, "export"),
    appVersion: "0.3.0-test",
    includeRemovedProjects: true,
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}

function digest(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

function rewriteManifest(dir: string, edit: (manifest: MigrationExportManifest) => void) {
  const manifest = JSON.parse(
    readFileSync(join(dir, MANIFEST_FILE), "utf8"),
  ) as MigrationExportManifest;
  edit(manifest);
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
}

function rewriteChunk(dir: string, file: string, text: string) {
  writeFileSync(join(dir, file), text);
  rewriteManifest(dir, (manifest) => {
    for (const stream of manifest.streams) {
      for (const chunk of stream.chunks) {
        if (chunk.file !== file) continue;
        stream.bytes += Buffer.byteLength(text) - chunk.bytes;
        chunk.bytes = Buffer.byteLength(text);
        chunk.sha256 = createHash("sha256").update(text).digest("hex");
      }
    }
  });
}

describe("a full export", () => {
  it("uses the parent-owned pause lease in worker context without creating a stranded inner lease", async () => {
    threadContext.isMainThread = false;
    await withProfileMaintenance(profile.root, async () => {
      await exportMigrationSnapshot(
        options({
          onProgress: () => {
            expect(readdirSync(join(profile.root, "backups", ".maintenance"))).toHaveLength(1);
          },
        }),
      );
    });
    expect(await profileMaintenanceActive(profile.root)).toBe(false);
    await verifyMigrationExport(options().outDir);
  });
  it("publishes a verified directory with a manifest naming every chunk", async () => {
    const progress: MigrationExportProgress[] = [];
    const result = await exportMigrationSnapshot(
      options({
        onProgress: (report) => {
          expect(readdirSync(join(profile.root, "backups", ".maintenance"))).toHaveLength(1);
          progress.push(report);
        },
      }),
    );
    expect(result.resumed).toBe(false);
    expect(existsSync(stagingDirOf(result.outDir))).toBe(false);
    expect(readdirSync(result.outDir).toSorted()).toEqual([MANIFEST_FILE, "streams"]);

    const verified = await verifyMigrationExport(result.outDir);
    expect(verified.manifest).toEqual(result.manifest);
    expect(verified.records).toBe(result.manifest.streams.reduce((n, s) => n + s.records, 0));

    const manifest = result.manifest;
    expect(manifest.format).toBe("volli.migration-export/1");
    expect(manifest.appVersion).toBe("0.3.0-test");
    expect(manifest.snapshotAt).toBe(1_800_000_000_000);
    expect(manifest.source.schemaVersion).toBeGreaterThanOrEqual(64);
    expect(manifest.source.tableRows.session_events).toBe(5);
    expect(manifest.source.tableRows.secrets).toBe(1);
    expect(manifest.placeholders).toEqual({
      userId: "$local-user",
      runnerId: "$local-runner",
      workspaceId: "$target-workspace",
    });
    expect(manifest.preflight).toEqual({
      pendingFollowUps: 0,
      undeliveredNotices: 0,
      undeliveredRunMessages: 0,
      openCleanupCommands: 0,
      openAttachments: 1,
      recentBoardCommands: 0,
    });
    expect(manifest.tables.length).toBe(Object.keys(manifest.source.tableRows).length);

    const phases = progress.map((report) => report.phase);
    expect(phases[0]).toBe("snapshot");
    expect(phases).toContain("exporting");
    expect(phases.at(-1)).toBe("done");
    const last = progress.at(-1)!;
    expect(last.rowsDone).toBe(last.rowsTotal);
    expect(last.bytesWritten).toBe(verified.bytes);
  });

  it("maps projects with placeholders, counters, repo, prefs and runner-local paths", async () => {
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    const projects = records(outDir, manifest, "projects");
    expect(projects.map((project) => project.id)).toEqual(["proj-alpha", "proj-beta"]);
    expect(projects[0]).toEqual({
      id: "proj-alpha",
      workspaceId: "$target-workspace",
      name: "Alpha",
      colorIndex: 2,
      ticketPrefix: "AL",
      origin: "migrated",
      countsTowardCap: false,
      createdByUserId: "$local-user",
      createdAt: 100,
      updatedAt: 400,
      archivedAt: null,
      removedAt: null,
    });
    expect(records(outDir, manifest, "projectCounters")).toEqual([
      { projectId: "proj-alpha", nextTicketNumber: 42, boardSeq: 3 },
      { projectId: "proj-beta", nextTicketNumber: 7, boardSeq: 0 },
    ]);
    const repos = records(outDir, manifest, "projectRepos");
    expect(repos[0]).toMatchObject({
      projectId: "proj-alpha",
      role: "primary",
      position: "a0",
      provider: "none",
      name: "alpha",
      dirName: "alpha",
      baseBranch: "main",
    });
    expect(records(outDir, manifest, "projectEnvironment")[0]).toEqual({
      projectId: "proj-alpha",
      storedSetup: "pnpm install",
      storedResume: null,
      storedSetupMode: "legacy_command",
      revision: 1,
    });
    expect(
      records(outDir, manifest, "memberProjectPrefs").map((prefs) => prefs.railPosition),
    ).toEqual(["a0", "a1"]);
    expect(records(outDir, manifest, "memberProjectPrefs")[0]!.themeAppearance).toBe("auto");
    expect(records(outDir, manifest, "projectCheckoutPaths")).toEqual([
      {
        projectRepoId: repos[0]!.id,
        projectId: "proj-alpha",
        absPath: "/Users/source/code/alpha",
        kind: "main",
      },
      {
        projectRepoId: repos[1]!.id,
        projectId: "proj-beta",
        absPath: "/Users/source/code/beta",
        kind: "main",
      },
    ]);
    expect(records(outDir, manifest, "projectCheckouts")[0]).toEqual({
      runnerId: "$local-runner",
      projectId: "proj-alpha",
      projectRepoId: repos[0]!.id,
      kind: "main",
      headBranch: null,
      reportedAt: 1_800_000_000_000,
    });
  });

  it("maps tickets: positions, labels, bodies, PRs and Working copies", async () => {
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    const tickets = records(outDir, manifest, "tickets");
    const live = tickets.find((ticket) => ticket.id === "ticket-live")!;
    expect(live).toMatchObject({
      number: 12,
      status: "doing",
      position: "a0",
      labelIds: ["label-bug"],
      checkoutMode: "worktree",
      branch: "volli/AL-12-live",
      baseBranch: null,
      pullRequests: [],
      // Its worktree directory is not on this machine.
      placeRunnerId: null,
      createdBy: { kind: "person", userId: "$local-user" },
      archivedAt: null,
    });
    const archived = tickets.find((ticket) => ticket.id === "ticket-archived")!;
    expect(archived.pullRequests).toEqual([
      {
        projectRepoId: records(outDir, manifest, "projectRepos")[0]!.id,
        url: "https://github.com/example/alpha/pull/9",
        number: 9,
        state: "open",
        mergedAt: null,
      },
    ]);
    expect(archived.retentionKeep).toBe(true);
    expect(archived.archivedAt).toBe(950);
    expect(
      records(outDir, manifest, "ticketBodies")
        .map((body) => body.body)
        .toSorted(),
    ).toEqual(["Body of the live ticket", "Shipped"]);
    const copies = records(outDir, manifest, "workingCopies");
    expect(copies).toHaveLength(2);
    expect(copies.every((copy) => copy.state === "reclaimed")).toBe(true);
    const paths = records(outDir, manifest, "workingCopyPaths");
    expect(paths.map((path) => path.absPath).toSorted()).toEqual([
      "/Users/source/.volli/worktrees/alpha/AL-12",
      "/Users/source/.volli/worktrees/alpha/AL-9",
    ]);
    expect(new Set(paths.map((path) => path.workingCopyId))).toEqual(
      new Set(copies.map((copy) => copy.id)),
    );
  });

  it("marks a Working copy ready when its directory exists here", async () => {
    const worktree = join(work, "AL-12");
    mkdirSync(worktree);
    profile.db
      .prepare("UPDATE tickets SET worktree_path = ? WHERE id = 'ticket-live'")
      .run(worktree);
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    const copy = records(outDir, manifest, "workingCopies").find(
      (entry) => entry.ticketId === "ticket-live",
    )!;
    expect(copy.state).toBe("ready");
    const ticket = records(outDir, manifest, "tickets").find(
      (entry) => entry.id === "ticket-live",
    )!;
    expect(ticket.placeRunnerId).toBe("$local-runner");
  });

  it("orders board events by the durable sequence and keeps paths out of them", async () => {
    profile.db
      .prepare(
        `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
         VALUES ('tevent-4', 'ticket-live', 'worktree_changed', 'automation', ?, 205)`,
      )
      .run(
        JSON.stringify({
          kind: "worktree_changed",
          from: { worktreePath: null, branch: null, baseBranch: null },
          to: {
            worktreePath: "/Users/source/.volli/worktrees/alpha/AL-12",
            branch: "volli/AL-12-live",
            baseBranch: "main",
          },
        }),
      );
    profile.db
      .prepare(
        `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
         VALUES ('tevent-5', 'ticket-live', 'pr_merged', 'automation', '{"kind":"pr_merged","url":"u"}', 300)`,
      )
      .run();
    profile.db
      .prepare(
        `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
         VALUES ('tevent-bad', 'ticket-live', 'retitled', 'user', 'not json', 301)`,
      )
      .run();
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    const events = records(outDir, manifest, "boardEvents");
    // Insertion (sequence) order, not created_at: tevent-4 was written last of these four.
    expect(events.map((event) => [event.id, event.seq])).toEqual([
      ["tevent-1", 1],
      ["tevent-2", 2],
      ["tevent-3", 3],
      ["tevent-4", 4],
      ["tevent-5", 5],
    ]);
    expect(events[3]!.payload).toEqual({
      kind: "worktree_changed",
      from: { branch: null, baseBranch: null, worktree: null },
      to: {
        branch: "volli/AL-12-live",
        baseBranch: "main",
        worktree: { runnerId: "$local-runner", basename: "AL-12" },
      },
    });
    expect(events[3]!.actor).toEqual({ kind: "legacy", was: "automation" });
    expect(events[4]!.actor).toMatchObject({ kind: "volli", reason: "merge_watch" });
    expect(records(outDir, manifest, "projectCounters")[0]!.boardSeq).toBe(5);
    expect(records(outDir, manifest, "legacyRows")).toContainEqual({
      table: "ticket_events",
      projectId: "proj-alpha",
      reason: "payload is not JSON",
      row: {
        id: "tevent-bad",
        ticket_id: "ticket-live",
        kind: "retitled",
        actor: "user",
        payload: "not json",
        created_at: 301,
      },
    });
  });

  it("puts no machine path in a Convex-bound structural stream", async () => {
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    for (const stream of manifest.streams) {
      // Session events and transcripts are content; they keep what they recorded.
      if (stream.destination !== "convex" || stream.name === "sessionEvents") continue;
      const text = contentOf(outDir, manifest)[stream.name]!;
      expect(text, stream.name).not.toContain("/Users/source");
    }
    expect(contentOf(outDir, manifest).workingCopyPaths).toContain("/Users/source");
  });

  it("carries Session history verbatim with provenance re-inflated", async () => {
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    const events = records(outDir, manifest, "sessionEvents");
    expect(events.map((event) => [event.sessionId, event.sequence, event.id])).toEqual([
      ["session-child", 1, "event-child-1"],
      ["session-root", 1, "event-1"],
      ["session-root", 2, "event-2"],
      ["session-root", 3, "event-3"],
      ["session-root", 4, "event-4"],
    ]);
    expect(events[1]).toMatchObject({
      commandId: "command-1",
      attachmentId: "attach-1",
      provenance: {
        source: { kind: "system", id: "backup-fixture", detail: null },
        venue: { id: "local", kind: "local" },
      },
      payload: { kind: "command.accepted", commandId: "command-1" },
    });
    const sessions = records(outDir, manifest, "sessions");
    expect(sessions).toEqual([
      expect.objectContaining({
        id: "session-child",
        ownerUserId: "$local-user",
        visibility: "shared",
        visibilityReason: "ticket",
        lastSequence: 1,
        eventCount: 1,
        lastActivityAt: 260,
      }),
      expect.objectContaining({ id: "session-root", lastSequence: 4, eventCount: 4 }),
    ]);
    expect(records(outDir, manifest, "delegations")).toEqual([
      {
        childSessionId: "session-child",
        parentSessionId: "session-root",
        ticketId: "ticket-live",
        depth: 1,
        toolCallId: "tool-call-1",
        createCommandId: "session-root:tool-call-1:create",
        createdAt: 245,
      },
    ]);
    expect(records(outDir, manifest, "sessionGrants")).toHaveLength(1);
    expect(records(outDir, manifest, "delegationExtensions")).toEqual([
      {
        parentSessionId: "session-root",
        toolCallId: "tool-call-2",
        approvedByUserId: "$local-user",
        createdAt: 246,
      },
    ]);
  });

  it("maps signals, comments, blobs and Automations", async () => {
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    expect(records(outDir, manifest, "ticketSignals")[0]).toMatchObject({
      id: "signal-1",
      projectId: "proj-alpha",
      actor: { kind: "agent", userId: "$local-user", sessionId: "session-root" },
    });
    expect(records(outDir, manifest, "ticketComments")).toEqual([
      {
        id: "comment-1",
        ticketId: "ticket-live",
        projectId: "proj-alpha",
        sessionId: null,
        author: { kind: "person", userId: "$local-user" },
        body: "A comment body",
        createdAt: 220,
        editedAt: null,
        deletedAt: null,
      },
    ]);
    const blobs = records(outDir, manifest, "blobs");
    expect(blobs.map((blob) => blob.key).toSorted()).toEqual(
      [profile.blobHashes.ticket, profile.blobHashes.session]
        .map((hash) => `v1/p/proj-alpha/b/${hash}`)
        .toSorted(),
    );
    expect(records(outDir, manifest, "blobLinks").map((link) => link.owner)).toEqual([
      { kind: "session", id: "session-root" },
      { kind: "ticket", id: "ticket-live" },
    ]);
    expect(records(outDir, manifest, "automations")[0]).toMatchObject({
      id: "automation-1",
      runtime: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      triggerSpec: { kind: "column", statuses: ["needs_review"] },
    });
    const runs = records(outDir, manifest, "automationRuns");
    expect(runs.map((run) => [run.id, run.status, run.trigger])).toEqual([
      ["arun-1", "started", "manual"],
      ["skip-1", "skipped", "schedule"],
      ["attempt-1", "failed", "arrival"],
    ]);
    expect(runs[2]!.error).toBe("runtime unavailable");
    expect(manifest.pendingRunnerWork).toBe(false);
    expect(records(outDir, manifest, "runnerJobs")).toEqual([]);
    expect(records(outDir, manifest, "automationArmings")).toEqual([]);
    expect(records(outDir, manifest, "automationColumnOrder")[0]!.rankedIds).toEqual([
      "automation-1",
    ]);
    const ledger = records(outDir, manifest, "legacyRows").filter((row) =>
      row.table.startsWith("automation_"),
    );
    expect(ledger.map((row) => row.table)).toEqual([
      "automation_pending_armed_runs",
      "automation_column_arming",
      "automation_command_receipts",
      "automation_commands",
      "automation_events",
    ]);
  });

  it("exports settings, unbound Automations and MCP servers as config entries", async () => {
    profile.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)")
      .run("volli:decision-model", '{"providerId":"p","modelId":"m"}');
    profile.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)")
      .run("volli:runtime-preferences:pi", "not json");
    profile.db
      .prepare(
        `INSERT INTO automations (id, project_id, name, instructions, runtime, row_version,
                                  created_at, updated_at, trigger_spec)
         VALUES ('auto-unbound', NULL, 'Loose', 'do it', NULL, 1, 5, 6, NULL)`,
      )
      .run();
    profile.db
      .prepare("UPDATE projects SET session_model = ?, skill_modes = ? WHERE id = 'proj-beta'")
      .run('{"providerId":"x"}', '{"a":"on"}');
    profile.db
      .prepare(
        `INSERT INTO mcp_servers (id, project_id, name, enabled, transport, catalog, stale,
                                  created_at, updated_at)
         VALUES ('mcp-1', 'proj-alpha', 'github', 0, '{"kind":"stdio","command":"gh"}', '[]', 1, 7, 8)`,
      )
      .run();
    profile.db
      .prepare(
        `INSERT INTO mcp_operations (id, project_id, server_id, server_name, operation, outcome,
                                     summary, session_id, created_at)
         VALUES ('op-1', 'proj-alpha', 'mcp-1', 'github', 'install', 'applied', 'ok',
                 'session-root', 9)`,
      )
      .run();
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    const entries = records(outDir, manifest, "configEntries");
    expect(entries.map((entry) => [entry.level, entry.kind, entry.name, entry.state])).toEqual([
      ["project", "skill", "default", "on"],
      ["project", "model_default", "default", "on"],
      ["personal", "automation", "Loose", "on"],
      ["project", "mcp_server", "github", "off"],
      ["personal", "decision_model", "default", "on"],
    ]);
    expect(entries[2]!.id).toBe("auto-unbound");
    expect(entries[3]!.id).toBe(mcpServerEntryId("mcp-1"));
    // A retired key nothing reads is not carried.
    expect(entries.some((entry) => entry.name === "pi")).toBe(false);
    expect(records(outDir, manifest, "automations").map((entry) => entry.id)).toEqual([
      "automation-1",
    ]);
    expect(records(outDir, manifest, "mcpCatalogCache")).toEqual([
      {
        configEntryId: mcpServerEntryId("mcp-1"),
        projectId: "proj-alpha",
        catalog: [],
        stale: true,
        error: null,
        refreshedAt: null,
      },
    ]);
    expect(records(outDir, manifest, "auditLog")[0]).toMatchObject({
      id: mcpOperationId("op-1"),
      kind: "mcp_install",
      targetId: mcpServerEntryId("mcp-1"),
      actor: { kind: "agent", sessionId: "session-root" },
    });
  });

  it("is reproducible: two exports of an unchanged database carry the same records", async () => {
    const first = await exportMigrationSnapshot(options());
    const second = await exportMigrationSnapshot(options({ outDir: join(work, "again") }));
    expect(contentOf(second.outDir, second.manifest)).toEqual(
      contentOf(first.outDir, first.manifest),
    );
    expect(second.manifest.exportId).not.toBe(first.manifest.exportId);
  });
});

describe("consistency and the live database", () => {
  it("snapshots committed state only, while another connection is mid-write", async () => {
    profile.db.exec("BEGIN IMMEDIATE");
    profile.db
      .prepare(
        `INSERT INTO labels (id, project_id, name, color, row_version, created_at, updated_at)
         VALUES ('label-uncommitted', 'proj-alpha', 'wip', NULL, 1, 1, 1)`,
      )
      .run();
    try {
      const { outDir, manifest } = await exportMigrationSnapshot(options());
      expect(records(outDir, manifest, "labels").map((label) => label.id)).toEqual(["label-bug"]);
    } finally {
      profile.db.exec("ROLLBACK");
    }
  });

  it("includes committed rows still in the WAL, and never writes the live database", async () => {
    profile.db.pragma("wal_autocheckpoint = 0");
    profile.db
      .prepare(
        `INSERT INTO labels (id, project_id, name, color, row_version, created_at, updated_at)
         VALUES ('label-wal', 'proj-alpha', 'in wal', NULL, 1, 1, 1)`,
      )
      .run();
    const before = [digest(profile.dbPath), digest(`${profile.dbPath}-wal`)];
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    expect(records(outDir, manifest, "labels").map((label) => label.id)).toContain("label-wal");
    expect([digest(profile.dbPath), digest(`${profile.dbPath}-wal`)]).toEqual(before);
  });
});

describe("resume, cancel and atomicity", () => {
  it("leaves only a staging area when cancelled, and resumes to the same export", async () => {
    const reference = await exportMigrationSnapshot(options({ outDir: join(work, "reference") }));

    const controller = new AbortController();
    let checkpoints = 0;
    const target = join(work, "export");
    await expect(
      exportMigrationSnapshot(
        options({
          outDir: target,
          chunkMaxRecords: 1,
          signal: controller.signal,
          onProgress: (report) => {
            if (report.phase === "exporting" && report.bytesWritten > 0 && ++checkpoints === 3) {
              controller.abort();
            }
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(existsSync(target)).toBe(false);
    const staging = stagingDirOf(target);
    expect(existsSync(join(staging, STATE_FILE))).toBe(true);
    expect(readFileSync(join(staging, JOURNAL_FILE), "utf8").length).toBeGreaterThan(0);

    const progress: MigrationExportProgress[] = [];
    const resumed = await exportMigrationSnapshot(
      options({
        outDir: target,
        chunkMaxRecords: 1,
        onProgress: (report) => progress.push(report),
      }),
    );
    expect(resumed.resumed).toBe(true);
    expect(progress.every((report) => report.resumed)).toBe(true);
    expect(progress.some((report) => report.phase === "snapshot")).toBe(false);
    await verifyMigrationExport(target);
    expect(contentOf(target, resumed.manifest)).toEqual(
      contentOf(reference.outDir, reference.manifest),
    );
    // Resumed from the old snapshot: the snapshot time is the first run's.
    expect(resumed.manifest.snapshotAt).toBe(reference.manifest.snapshotAt);
  });

  it("resumes from the old snapshot even after the live database changed", async () => {
    const target = join(work, "export");
    const controller = new AbortController();
    await expect(
      exportMigrationSnapshot(
        options({
          outDir: target,
          chunkMaxRecords: 1,
          signal: controller.signal,
          onProgress: (report) => {
            if (report.phase === "exporting") controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    profile.db
      .prepare(
        `INSERT INTO labels (id, project_id, name, color, row_version, created_at, updated_at)
         VALUES ('label-later', 'proj-alpha', 'later', NULL, 1, 1, 1)`,
      )
      .run();
    const { manifest } = await exportMigrationSnapshot(options({ outDir: target }));
    expect(records(target, manifest, "labels").map((label) => label.id)).toEqual(["label-bug"]);
  });

  it("redoes a chunk that was damaged, and drops a torn journal line and stray files", async () => {
    const reference = await exportMigrationSnapshot(options({ outDir: join(work, "reference") }));
    const target = join(work, "export");
    const controller = new AbortController();
    await expect(
      exportMigrationSnapshot(
        options({
          outDir: target,
          chunkMaxRecords: 1,
          signal: controller.signal,
          onProgress: (report) => {
            if (report.source === "boardEvents") controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    const staging = stagingDirOf(target);
    const journal = readFileSync(join(staging, JOURNAL_FILE), "utf8").trim().split("\n");
    const damaged = (JSON.parse(journal[1]!) as { chunks: Array<{ file: string }> }).chunks[0]!
      .file;
    writeFileSync(join(staging, damaged), "tampered\n");
    appendFileSync(join(staging, JOURNAL_FILE), '{"source":"torn"');
    mkdirSync(join(staging, "streams", "labels"), { recursive: true });
    writeFileSync(join(staging, "streams", "labels", "000099.ndjson.tmp"), "stray");

    const resumed = await exportMigrationSnapshot(options({ outDir: target, chunkMaxRecords: 1 }));
    await verifyMigrationExport(target);
    expect(contentOf(target, resumed.manifest)).toEqual(
      contentOf(reference.outDir, reference.manifest),
    );
  });

  it("drops a torn final journal line for good, so later checkpoints stay readable", async () => {
    const reference = await exportMigrationSnapshot(options({ outDir: join(work, "reference") }));
    const target = join(work, "export");
    const cancelAfter = async (checkpoints: number) => {
      const controller = new AbortController();
      let seen = 0;
      let bytes = -1;
      await expect(
        exportMigrationSnapshot(
          options({
            outDir: target,
            chunkMaxRecords: 1,
            signal: controller.signal,
            onProgress: (report) => {
              if (report.bytesWritten > bytes && bytes >= 0 && ++seen === checkpoints) {
                controller.abort();
              }
              bytes = report.bytesWritten;
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "cancelled" });
    };
    await cancelAfter(3);
    const staging = stagingDirOf(target);
    // A crash or a full disk mid-append: half a line, nothing else damaged.
    appendFileSync(join(staging, JOURNAL_FILE), '{"source":"labels","rowsThrough":1,"do');
    await cancelAfter(3);
    expect(
      readFileSync(join(staging, JOURNAL_FILE), "utf8")
        .trim()
        .split("\n")
        .every((line) => JSON.parse(line) !== null),
    ).toBe(true);
    const resumed = await exportMigrationSnapshot(options({ outDir: target, chunkMaxRecords: 1 }));
    await verifyMigrationExport(target);
    expect(contentOf(target, resumed.manifest)).toEqual(
      contentOf(reference.outDir, reference.manifest),
    );
  });

  it("snapshots again rather than resume another source's or another build's staging", async () => {
    const target = join(work, "export");
    const stop = async (overrides: Partial<MigrationExportOptions>) => {
      const controller = new AbortController();
      await expect(
        exportMigrationSnapshot(
          options({
            outDir: target,
            signal: controller.signal,
            onProgress: (report) => {
              if (report.phase === "exporting") controller.abort();
            },
            ...overrides,
          }),
        ),
      ).rejects.toMatchObject({ code: "cancelled" });
    };
    await stop({});
    const other = createFixtureProfile();
    try {
      other.db.prepare("DELETE FROM labels").run();
      const fromOther = await exportMigrationSnapshot(
        options({ outDir: target, sourcePath: other.dbPath }),
      );
      expect(fromOther.resumed).toBe(false);
      expect(records(target, fromOther.manifest, "labels")).toEqual([]);
    } finally {
      other.cleanup();
    }
    const second = join(work, "second");
    await stop({ outDir: second });
    const newer = await exportMigrationSnapshot(options({ outDir: second, appVersion: "0.3.1" }));
    expect(newer.resumed).toBe(false);
    expect(newer.manifest.appVersion).toBe("0.3.1");
  });

  it("lets one run at a time export into a target", async () => {
    const target = join(work, "export");
    const first = exportMigrationSnapshot(options({ outDir: target }));
    const second = exportMigrationSnapshot(options({ outDir: target }));
    const [a, b] = await Promise.allSettled([first, second]);
    expect([a.status, b.status].toSorted()).toEqual(["fulfilled", "rejected"]);
    const refusal = (a.status === "rejected" ? a.reason : (b as PromiseRejectedResult).reason) as {
      code: string;
    };
    expect(refusal.code).toBe("in_progress");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("takes over the lock a crashed run left behind", async () => {
    const target = join(work, "export");
    writeFileSync(`${target}.lock`, "2147483646\n");
    const result = await exportMigrationSnapshot(options({ outDir: target }));
    expect(result.resumed).toBe(false);
    writeFileSync(join(work, "busy.lock"), `${process.pid}\n`);
    await expect(
      exportMigrationSnapshot(options({ outDir: join(work, "busy") })),
    ).rejects.toMatchObject({ code: "in_progress" });
  });

  it("names an unexpected failure internal, with its message", async () => {
    await expect(
      exportMigrationSnapshot(
        options({
          onProgress: () => {
            throw new Error("a listener bug");
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "internal", message: "a listener bug" });
    await expect(
      exportMigrationSnapshot(
        options({
          outDir: join(work, "thrown-string"),
          onProgress: () => {
            // oxlint-disable-next-line no-throw-literal -- the case under test
            throw "not an Error";
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "internal", message: "not an Error" });
  });

  it("refuses to resume a snapshot SQLite cannot read", async () => {
    const target = join(work, "export");
    const controller = new AbortController();
    await expect(
      exportMigrationSnapshot(
        options({
          outDir: target,
          signal: controller.signal,
          onProgress: (report) => {
            if (report.phase === "exporting") controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    writeFileSync(join(stagingDirOf(target), SNAPSHOT_FILE), "x".repeat(8192));
    await expect(exportMigrationSnapshot(options({ outDir: target }))).rejects.toMatchObject({
      code: "source_corrupt",
    });
  });

  it("reports a lock it cannot read or write as a filesystem failure", async () => {
    mkdirSync(join(work, "dir.lock"));
    await expect(
      exportMigrationSnapshot(options({ outDir: join(work, "dir") })),
    ).rejects.toMatchObject({ code: "io_failed" });
    writeFileSync(join(work, "garbage.lock"), "not a pid\n");
    const taken = await exportMigrationSnapshot(options({ outDir: join(work, "garbage") }));
    expect(taken.resumed).toBe(false);
    const locked = join(work, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      await expect(
        exportMigrationSnapshot(options({ outDir: join(locked, "export") })),
      ).rejects.toMatchObject({ code: "io_failed" });
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("finishes a run that stopped between the manifest and the rename", async () => {
    const target = join(work, "export");
    const done = await exportMigrationSnapshot(options({ outDir: target }));
    const staging = stagingDirOf(target);
    rmSync(staging, { recursive: true, force: true });
    // Put the complete export back where an interrupted publish would have left it.
    readdirSync(target);
    await import("node:fs/promises").then((fs) => fs.rename(target, staging));
    writeFileSync(join(staging, SNAPSHOT_FILE), "leftover");
    const again = await exportMigrationSnapshot(options({ outDir: target }));
    expect(again.resumed).toBe(true);
    expect(again.manifest).toEqual(done.manifest);
    expect(existsSync(join(target, SNAPSHOT_FILE))).toBe(false);
    await verifyMigrationExport(target);
  });

  it("starts over when asked, and a partial export can be discarded", async () => {
    const target = join(work, "export");
    const controller = new AbortController();
    await expect(
      exportMigrationSnapshot(
        options({
          outDir: target,
          signal: controller.signal,
          onProgress: (report) => {
            if (report.phase === "exporting") controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    const fresh = await exportMigrationSnapshot(options({ outDir: target, fresh: true }));
    expect(fresh.resumed).toBe(false);

    const other = join(work, "other");
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      exportMigrationSnapshot(options({ outDir: other, signal: aborted.signal })),
    ).rejects.toMatchObject({ code: "cancelled" });
    mkdirSync(stagingDirOf(other), { recursive: true });
    await discardPartialMigrationExport(other);
    expect(existsSync(stagingDirOf(other))).toBe(false);
  });

  it("refuses to overwrite a complete export", async () => {
    const target = join(work, "export");
    await exportMigrationSnapshot(options({ outDir: target }));
    await expect(exportMigrationSnapshot(options({ outDir: target }))).rejects.toMatchObject({
      code: "output_exists",
    });
  });

  it("restarts the snapshot when the staged one never completed", async () => {
    const target = join(work, "export");
    const staging = stagingDirOf(target);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, `${SNAPSHOT_FILE}.tmp`), "half a copy");
    writeFileSync(join(staging, STATE_FILE), "{not json");
    const result = await exportMigrationSnapshot(options({ outDir: target }));
    expect(result.resumed).toBe(false);
    await verifyMigrationExport(target);
  });
});

describe("refusals", () => {
  it("refuses when the disk cannot hold the export, before writing anything", async () => {
    const target = join(work, "export");
    await expect(
      exportMigrationSnapshot(
        options({
          outDir: target,
          diskProbe: { fileSize: () => 1024 * 1024 * 1024, freeBytes: () => 1024 },
        }),
      ),
    ).rejects.toMatchObject({ code: "disk_full" });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(stagingDirOf(target), SNAPSHOT_FILE))).toBe(false);
    expect(migrationExportDiskRequirement(100)).toBe(300 + 64 * 1024 * 1024);
  });

  it("proceeds when the disk cannot be measured", async () => {
    const result = await exportMigrationSnapshot(
      options({
        diskProbe: {
          fileSize: () => 0,
          freeBytes: () => {
            throw new Error("statfs unsupported");
          },
        },
      }),
    );
    expect(result.resumed).toBe(false);
  });

  it("refuses a missing or unreadable database", async () => {
    await expect(
      exportMigrationSnapshot(options({ sourcePath: join(work, "missing.db") })),
    ).rejects.toMatchObject({ code: "source_unreadable" });
    const garbage = join(work, "garbage.db");
    writeFileSync(garbage, "this is not a database at all, not even close to one".repeat(100));
    await expect(exportMigrationSnapshot(options({ sourcePath: garbage }))).rejects.toMatchObject({
      code: "source_unreadable",
    });
  });

  it("refuses a schema it was not written for", async () => {
    const old = join(work, "old.db");
    const db = new Database(old);
    db.pragma("user_version = 12");
    db.exec("CREATE TABLE t (x)");
    db.close();
    await expect(exportMigrationSnapshot(options({ sourcePath: old }))).rejects.toMatchObject({
      code: "schema_unsupported",
    });
  });

  it("stops rather than leave a gap in a Session's history", async () => {
    profile.db.pragma("foreign_keys = OFF");
    profile.db
      .prepare(
        `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at,
                                     provenance_id, attachment_id, command_id, payload)
         VALUES ('event-orphan', 'session-child', 2, 1, 1, 999, NULL, NULL, '{"kind":"session.archived"}')`,
      )
      .run();
    const error = await exportMigrationSnapshot(options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationExportError);
    expect(error).toMatchObject({ code: "source_corrupt" });
    expect((error as Error).message).toContain("event-orphan");
    expect(existsSync(join(work, "export"))).toBe(false);
  });
});

describe("verifyMigrationExport", () => {
  async function exported() {
    const { outDir, manifest } = await exportMigrationSnapshot(options());
    const chunk = manifest.streams.find((stream) => stream.name === "tickets")!.chunks[0]!;
    return { outDir, manifest, chunk };
  }

  it("names a tampered chunk", async () => {
    const { outDir, chunk } = await exported();
    const path = join(outDir, chunk.file);
    writeFileSync(path, readFileSync(path, "utf8").replace("Live ticket", "Live tickeT"));
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/does not match its checksum/);
  });

  it("names a missing chunk, a resized one, and a stray file", async () => {
    const { outDir, chunk } = await exported();
    writeFileSync(join(outDir, "streams", "tickets", "000777.ndjson"), "{}\n");
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/not named by the manifest/);
    rmSync(join(outDir, "streams", "tickets", "000777.ndjson"));
    appendFileSync(join(outDir, chunk.file), "{}\n");
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/bytes, not/);
    rmSync(join(outDir, chunk.file));
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/is missing/);
  });

  it("checks every line, and each stream's totals", async () => {
    const { outDir, chunk } = await exported();
    const original = readFileSync(join(outDir, chunk.file), "utf8");
    rewriteChunk(outDir, chunk.file, `${original}not json\n`);
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/holds 3 records, not 2/);
    rewriteManifest(outDir, (manifest) => {
      manifest.streams.find((stream) => stream.name === "tickets")!.chunks[0]!.records = 3;
    });
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/line 3 is not JSON/);
    rewriteChunk(outDir, chunk.file, `${original}[1]\n`);
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/line 3 is not a record/);
    rewriteChunk(outDir, chunk.file, original.slice(0, -1));
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/ends mid-line/);
    rewriteChunk(outDir, chunk.file, original);
    rewriteManifest(outDir, (manifest) => {
      manifest.streams.find((stream) => stream.name === "tickets")!.chunks[0]!.records = 2;
      manifest.streams.find((stream) => stream.name === "tickets")!.records = 9;
    });
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/totals do not match/);
  });

  it("checks the manifest itself", async () => {
    const { outDir } = await exported();
    rewriteManifest(outDir, (manifest) => {
      const tickets = manifest.streams.find((stream) => stream.name === "tickets")!;
      manifest.streams.push(tickets);
    });
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/every stream once/);
    rewriteManifest(outDir, (manifest) => {
      manifest.streams.pop();
      manifest.streams.find((stream) => stream.name === "tickets")!.destination = "runner";
    });
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/wrong destination/);
    rewriteManifest(outDir, (manifest) => {
      manifest.streams.find((stream) => stream.name === "tickets")!.destination = "convex";
      const bodies = manifest.streams.find((stream) => stream.name === "ticketBodies")!;
      bodies.chunks.push(manifest.streams.find((stream) => stream.name === "tickets")!.chunks[0]!);
    });
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/named twice/);
    rewriteManifest(outDir, (manifest) => {
      (manifest as { format: string }).format = "volli-export";
    });
    await expect(verifyMigrationExport(outDir)).rejects.toThrow(/Unknown format/);
    rmSync(join(outDir, MANIFEST_FILE));
    await expect(verifyMigrationExport(outDir)).rejects.toMatchObject({ code: "integrity_failed" });
  });
});
