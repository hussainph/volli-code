import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AttentionDeliveryPort, HostEventBus } from "./ports";
import { openTestDb, testProject, testSession, testTicket, type TestDb } from "./db/test-helpers";
import { insertSession } from "./session-control/test-support";
import { insertProject } from "./db/projects-repo";
import { insertTicket } from "./db/tickets-repo";
import { AUTO_REAP_SETTINGS_KEY } from "./process/auto-reap-settings";
import { setAppState } from "./db/app-state-repo";
import { getRetentionWatcher } from "./retention-runtime";
import { createAutoReapWatch } from "./process/auto-reap-watch";
import { DatabaseRecovery } from "./database-recovery";
import { OrphanProcessService } from "./process/orphan-processes";
import { SpawnLedger } from "./process/spawn-ledger";
import {
  checkpointAndCloseDatabase,
  createDatabaseRecovery,
  createHostMaintenance,
  type MaintenanceProcessReaders,
} from "./maintenance-services";

vi.mock("./retention-runtime", () => ({ getRetentionWatcher: vi.fn() }));
vi.mock("./process/auto-reap-watch", () => ({ createAutoReapWatch: vi.fn() }));
vi.mock("./process/orphan-processes", () => ({
  OrphanProcessService: vi.fn(function (this: { deps: unknown }, deps: unknown) {
    this.deps = deps;
  }),
}));
vi.mock("./database-recovery", () => ({
  DatabaseRecovery: vi.fn(function (this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
}));

type CapturedOrphanDeps = {
  ledger: unknown;
  worktrees(): unknown;
  liveSessionIds(): readonly string[];
  liveWorktrees(): unknown;
  openTerminalCwds(): readonly string[];
  policy(): unknown;
  notify(title: string, message: string): void;
};

function capturedDeps(service: unknown): CapturedOrphanDeps {
  return (service as { deps: CapturedOrphanDeps }).deps;
}

/** A promise plus its resolver, so a test can hold a loop's drain open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function recordingLoops() {
  const calls: string[] = [];
  const retention = {
    start: vi.fn(() => calls.push("retention.start")),
    stop: vi.fn(() => calls.push("retention.stop")),
    triggerNow: vi.fn(() => calls.push("retention.triggerNow")),
    settled: vi.fn(async () => {
      calls.push("retention.settled");
    }),
  };
  const autoReap = {
    start: vi.fn(() => calls.push("autoReap.start")),
    stop: vi.fn(() => calls.push("autoReap.stop")),
    tick: vi.fn(async () => {}),
    settled: vi.fn(async () => {
      calls.push("autoReap.settled");
    }),
  };
  vi.mocked(getRetentionWatcher).mockReturnValue(
    retention as unknown as ReturnType<typeof getRetentionWatcher>,
  );
  vi.mocked(createAutoReapWatch).mockReturnValue(autoReap);
  return { calls, retention, autoReap };
}

let testDb: TestDb;
let events: HostEventBus;
let attention: AttentionDeliveryPort;
const worktreeDeps = { marker: "worktree-deps" };
const worktrees = { deps: vi.fn(() => worktreeDeps as never) };

beforeEach(() => {
  testDb = openTestDb();
  events = { publish: vi.fn() } as unknown as HostEventBus;
  attention = { deliver: vi.fn(), focusedSessionIds: () => new Set<string>() };
  vi.mocked(getRetentionWatcher).mockReset();
  vi.mocked(createAutoReapWatch).mockReset();
  vi.mocked(OrphanProcessService).mockClear();
  worktrees.deps.mockClear();
});

afterEach(() => {
  testDb.cleanup();
});

function readers(overrides: Partial<MaintenanceProcessReaders> = {}): MaintenanceProcessReaders {
  return {
    liveSessionIds: () => [],
    openTerminalCwds: () => [],
    ...overrides,
  };
}

function seedWorktree(db: Database.Database, sessionId: string): string {
  const project = testProject({ ticketPrefix: "MNT" });
  insertProject(db, project);
  const path = "/tmp/volli-maintenance-worktree";
  const ticket = testTicket(project.id, { worktreePath: path });
  insertTicket(db, ticket);
  insertSession(db, testSession(project.id, ticket.id, { id: sessionId }));
  return path;
}

describe("createDatabaseRecovery", () => {
  it("scopes recovery to the host's data directory and database path", () => {
    const recovery = createDatabaseRecovery({ dataDir: "/data", dbPath: "/data/volli.db" });
    expect(recovery).toBeInstanceOf(DatabaseRecovery);
    expect(DatabaseRecovery).toHaveBeenLastCalledWith({
      dbPath: "/data/volli.db",
      userData: "/data",
    });
  });
});

describe("checkpointAndCloseDatabase", () => {
  it("truncates the WAL and closes the handle", () => {
    const db = testDb.db;
    db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('k', 'v', 0)").run();
    const pragma = vi.spyOn(db, "pragma");
    checkpointAndCloseDatabase(db);
    expect(pragma).toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
    expect(db.open).toBe(false);
  });

  it("preserves the checkpoint failure without closing the handle", () => {
    const failure = new Error("SQLITE_BUSY");
    const calls: string[] = [];
    const db = {
      pragma: () => {
        calls.push("checkpoint");
        throw failure;
      },
      close: () => {
        calls.push("close");
        throw new Error("close failed too");
      },
    } as unknown as Database.Database;
    expect(() => checkpointAndCloseDatabase(db)).toThrow(failure);
    expect(calls).toEqual(["checkpoint"]);
  });
});

describe("createHostMaintenance", () => {
  it("builds one spawn ledger and an orphan sweep over it, starting nothing", () => {
    const { calls } = recordingLoops();
    const maintenance = createHostMaintenance({
      db: testDb.db,
      ports: { events, attention },
      worktrees,
      processReaders: readers(),
    });
    expect(maintenance.spawnLedger).toBeInstanceOf(SpawnLedger);
    expect(capturedDeps(maintenance.orphanProcesses).ledger).toBe(maintenance.spawnLedger);
    expect(createAutoReapWatch).toHaveBeenCalledWith(maintenance.orphanProcesses, undefined);
    // The retention singleton is not built until a host reads or starts it.
    expect(getRetentionWatcher).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("reads process readers at call time, never at construction", () => {
    recordingLoops();
    let live: readonly string[] = [];
    let cwds: readonly string[] = [];
    const liveSessionIds = vi.fn(() => live);
    const openTerminalCwds = vi.fn(() => cwds);
    const maintenance = createHostMaintenance({
      db: testDb.db,
      ports: { events, attention },
      worktrees,
      processReaders: { liveSessionIds, openTerminalCwds },
    });
    expect(liveSessionIds).not.toHaveBeenCalled();
    expect(openTerminalCwds).not.toHaveBeenCalled();
    const deps = capturedDeps(maintenance.orphanProcesses);
    live = ["session-1"];
    cwds = ["/repo"];
    expect(deps.liveSessionIds()).toEqual(["session-1"]);
    expect(deps.openTerminalCwds()).toEqual(["/repo"]);
  });

  it("answers the sweep's database questions from the live database", () => {
    recordingLoops();
    const path = seedWorktree(testDb.db, "session-live");
    const maintenance = createHostMaintenance({
      db: testDb.db,
      ports: { events, attention },
      worktrees,
      processReaders: readers({ liveSessionIds: () => ["session-live"] }),
    });
    const deps = capturedDeps(maintenance.orphanProcesses);
    expect(deps.worktrees()).toEqual([expect.objectContaining({ path })]);
    expect(deps.liveWorktrees()).toEqual([{ path, sessionId: "session-live" }]);
    expect(deps.policy()).toEqual(expect.objectContaining({ enabled: false }));
    setAppState(
      testDb.db,
      AUTO_REAP_SETTINGS_KEY,
      JSON.stringify({ enabled: true, minimumAgeHours: 48 }),
      1,
    );
    expect(deps.policy()).toEqual({ enabled: true, minimumAgeHours: 48 });
    deps.notify("Reaped 2 processes", "node, gradle");
    expect(attention.deliver).toHaveBeenCalledWith({
      producer: "orphan-processes-reaped",
      title: "Reaped 2 processes",
      body: "node, gradle",
      target: null,
    });
  });

  it("builds retention on first read with the reclaim seams, and shares it after", () => {
    const { retention } = recordingLoops();
    const reclaim = {
      busyWorktreeSites: vi.fn(async () => []),
      releaseAgentSites: vi.fn(async () => ({ released: [], stillOpen: [] })),
    };
    const maintenance = createHostMaintenance({
      db: testDb.db,
      ports: { events, attention },
      worktrees,
      processReaders: readers(),
      reclaim,
    });
    expect(maintenance.retention).toBe(retention);
    expect(maintenance.retention).toBe(retention);
    expect(getRetentionWatcher).toHaveBeenCalledOnce();
    const [db, ports, worktree, seams] = vi.mocked(getRetentionWatcher).mock.calls[0]!;
    expect(db).toBe(testDb.db);
    expect(ports).toEqual({ events, attention });
    expect(seams).toBe(reclaim);
    expect(worktree()).toBe(worktreeDeps);
    expect(worktrees.deps).toHaveBeenCalledWith(testDb.db);
  });

  it("starts both loops once, triggers retention, and stops for good", () => {
    const { calls } = recordingLoops();
    const autoReap = { firstDelayMs: 1, intervalMs: 2 };
    const maintenance = createHostMaintenance({
      db: testDb.db,
      ports: { events, attention },
      worktrees,
      processReaders: readers(),
      autoReap,
    });
    expect(createAutoReapWatch).toHaveBeenCalledWith(maintenance.orphanProcesses, autoReap);
    maintenance.start();
    maintenance.start();
    maintenance.triggerRetention();
    maintenance.stop();
    maintenance.stop();
    // A late first-paint start or focus trigger must not revive a loop over a closed database.
    maintenance.start();
    maintenance.triggerRetention();
    expect(calls).toEqual([
      "retention.start",
      "autoReap.start",
      "retention.triggerNow",
      "retention.stop",
      "autoReap.stop",
    ]);
  });

  it("stops without building a retention watch nobody started", () => {
    const { calls } = recordingLoops();
    const maintenance = createHostMaintenance({
      db: testDb.db,
      ports: { events, attention },
      worktrees,
      processReaders: readers(),
    });
    maintenance.stop();
    expect(getRetentionWatcher).not.toHaveBeenCalled();
    expect(calls).toEqual(["autoReap.stop"]);
  });

  it("builds a read-only retention watch when the host has no reclaim seams", () => {
    recordingLoops();
    const maintenance = createHostMaintenance({
      db: testDb.db,
      ports: { events, attention },
      worktrees,
      processReaders: readers(),
    });
    maintenance.triggerRetention();
    expect(vi.mocked(getRetentionWatcher).mock.calls[0]![3]).toBeUndefined();
  });
});

describe("HostMaintenance.settled (VC-627)", () => {
  function maintenanceOver() {
    return createHostMaintenance({
      db: testDb.db,
      ports: { events, attention },
      worktrees,
      processReaders: readers(),
    });
  }

  it("joins a retention poll and an automatic reap still in flight after stop", async () => {
    const { calls, retention, autoReap } = recordingLoops();
    const poll = deferred();
    const reap = deferred();
    retention.settled.mockImplementation(async () => {
      calls.push("retention.settled");
      await poll.promise;
      calls.push("retention poll finished");
    });
    autoReap.settled.mockImplementation(async () => {
      calls.push("autoReap.settled");
      await reap.promise;
      calls.push("auto reap finished");
    });
    const maintenance = maintenanceOver();
    maintenance.start();
    maintenance.stop();
    const drained = maintenance.settled().then(() => calls.push("maintenance settled"));

    reap.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // One loop finishing is not enough: the poll may still write.
    expect(calls).not.toContain("maintenance settled");

    poll.resolve();
    await drained;
    expect(calls).toEqual([
      "retention.start",
      "autoReap.start",
      "retention.stop",
      "autoReap.stop",
      "retention.settled",
      "autoReap.settled",
      "auto reap finished",
      "retention poll finished",
      "maintenance settled",
    ]);
  });

  it("does not build a retention watch nobody started just to wait on it", async () => {
    const { calls } = recordingLoops();
    const maintenance = maintenanceOver();
    maintenance.stop();
    await maintenance.settled();
    expect(getRetentionWatcher).not.toHaveBeenCalled();
    expect(calls).toEqual(["autoReap.stop", "autoReap.settled"]);
  });

  it("is safe to ask repeatedly, and waits on a retention watch the host only read", async () => {
    const { calls } = recordingLoops();
    const maintenance = maintenanceOver();
    void maintenance.retention;
    maintenance.stop();
    await Promise.all([maintenance.settled(), maintenance.settled()]);
    await maintenance.settled();
    expect(getRetentionWatcher).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "retention.stop",
      "autoReap.stop",
      "retention.settled",
      "autoReap.settled",
      "retention.settled",
      "autoReap.settled",
      "retention.settled",
      "autoReap.settled",
    ]);
  });
});
