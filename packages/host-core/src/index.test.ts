import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createHostCore,
  defaultDatabasePath,
  isLiveHost,
  logTransactionViolation,
  throwTransactionViolation,
} from "./index";
import { ClientCapabilityUnavailableError, HEADLESS_ATTENTION, NO_POWER_EVENTS } from "./ports";
import type {
  DegradedHostCore,
  HostCore,
  HostCorePorts,
  HostRuntimeOwner,
  LiveHostCore,
} from "./index";
import Database from "better-sqlite3";
import { SCHEMA_HEAD } from "./db/migrations";
import { MIN_READER_VERSION_KEY } from "./db/schema-compatibility";
import { insertProject } from "./db/projects-repo";
import { testProject } from "./db/test-helpers";
import * as sessionLedgerModule from "./session-control/sqlite-ledger";
import * as sessionControl from "./session-control";
import { createHostSessionRuntime, type HostSessionRuntimeOptions } from "./session-runtime";
import { PtyManager, type PtyManagerOptions } from "./pty/manager";
import type { SessionWake } from "./session-control/session-wake";
import { createHostMaintenance, type HostMaintenanceOptions } from "./maintenance-services";
import { createHostRuntimeServices } from "./runtime-services";

/**
 * Each mock below passes through to the real module and only RECORDS: the
 * lifecycle tests read the order the host's own services were stopped in from
 * `calls`, which is the contract `createHostCore` wires and nothing else shows.
 */
const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("./maintenance-services", async (importOriginal) => {
  const original = await importOriginal<typeof import("./maintenance-services")>();
  return {
    ...original,
    createHostMaintenance: vi.fn((options: HostMaintenanceOptions) => {
      const maintenance = original.createHostMaintenance(options);
      const stop = maintenance.stop.bind(maintenance);
      vi.spyOn(maintenance, "stop").mockImplementation(() => {
        calls.push("stop maintenance");
        stop();
      });
      return maintenance;
    }),
    checkpointAndCloseDatabase: vi.fn((db: Database.Database) => {
      calls.push("close database");
      original.checkpointAndCloseDatabase(db);
    }),
  };
});
vi.mock("./session-services", async (importOriginal) => {
  const original = await importOriginal<typeof import("./session-services")>();
  return {
    ...original,
    createHostSessionServices: (...args: Parameters<typeof original.createHostSessionServices>) => {
      const services = original.createHostSessionServices(...args);
      const watch = services.sessionActivityWatch;
      const stop = watch.stop.bind(watch);
      vi.spyOn(watch, "stop").mockImplementation(() => {
        calls.push("stop activity");
        stop();
      });
      return services;
    },
  };
});
// Construction of the runtime services themselves is runtime-services.test.ts's;
// here only WHEN and WITH WHAT the host builds them is under test.
vi.mock("./runtime-services", () => ({
  createHostRuntimeServices: vi.fn(() => ({ built: "runtime services" })),
}));

// Consumer construction must not become optional again. These checks run in
// the package typecheck without making invalid calls against a live database.
type RuntimeRequiresEngine =
  {} extends Pick<HostSessionRuntimeOptions, "sessionEngine"> ? false : true;
const runtimeRequiresEngine: RuntimeRequiresEngine = true;
type TerminalRequiresEngine = {} extends Pick<PtyManagerOptions, "sessionEngine"> ? false : true;
const terminalRequiresEngine: TerminalRequiresEngine = true;
// A degraded host is a variant, not a live host with null services: none of
// the live surface is even nameable on it.
type DegradedHasNoLiveSurface =
  Extract<
    keyof DegradedHostCore,
    | "sessionEngine"
    | "sessionLedger"
    | "runtimeServices"
    | "maintenance"
    | "client"
    | "detachedWork"
    | "worktrees"
  > extends never
    ? true
    : false;
const degradedHasNoLiveSurface: DegradedHasNoLiveSurface = true;
type LiveHasNoFailure = "databaseFailure" extends keyof LiveHostCore ? false : true;
const liveHasNoFailure: LiveHasNoFailure = true;

const dirs: string[] = [];
const opened: HostCore[] = [];
beforeEach(() => {
  calls.length = 0;
});
afterEach(async () => {
  // stop() is the host's one teardown and never rejects; it is idempotent for
  // a test that already stopped its host.
  for (const core of opened.splice(0)) {
    await core.stop("test teardown");
    if (isLiveHost(core) && core.database.db.open) core.database.db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-host-core-"));
  dirs.push(dir);
  return dir;
}
function compose(
  ports: { log: Pick<Console, "error">; client?: HostCorePorts["client"] },
  options: Parameters<typeof createHostCore>[1],
): HostCore {
  const core = createHostCore(
    { ...sessionPorts(), ...ports, log: { warn: vi.fn(), ...ports.log } },
    options,
  );
  opened.push(core);
  return core;
}
function live(core: HostCore): LiveHostCore {
  if (core.kind !== "live") throw new Error(core.database.error);
  return core;
}
function degraded(core: HostCore): DegradedHostCore {
  if (core.kind !== "degraded") throw new Error("expected a degraded host");
  return core;
}

function sessionPorts(): HostCorePorts {
  return {
    log: { error: vi.fn(), warn: vi.fn() },
    events: { publish: vi.fn() },
    attention: HEADLESS_ATTENTION,
    power: NO_POWER_EVENTS,
    connectivity: {
      isOnline: () => true,
      waitUntilOnline: () => Promise.resolve(),
      onResume: () => () => undefined,
    },
  };
}

/** A host with no live Sessions and no open terminals. */
const NO_PROCESS_READERS = { liveSessionIds: () => [], openTerminalCwds: () => [] };

function headlessOptions(root: string): Parameters<typeof createHostCore>[1] {
  return {
    dataDir: root,
    onTransactionViolation: throwTransactionViolation,
    devDiagnostics: false,
    processReaders: NO_PROCESS_READERS,
  };
}

/** A runtime module whose every step records itself into `calls`. */
function recordingRuntime(overrides: Partial<HostRuntimeOwner> = {}) {
  return {
    start: vi.fn(() => {
      calls.push("runtime start");
    }),
    stopProducers: vi.fn(() => {
      calls.push("stop producers");
    }),
    close: vi.fn(async () => {
      calls.push("close runtime");
    }),
    closeSocket: vi.fn(async () => {
      calls.push("close socket");
    }),
    drainRequests: vi.fn(async () => {
      calls.push("drain requests");
    }),
    ...overrides,
  } satisfies HostRuntimeOwner;
}

function writeDamagedDatabase(root: string): string {
  const databasePath = join(root, "volli.db");
  writeFileSync(databasePath, "not a database, and long enough to have a header to read....");
  return databasePath;
}

describe("createHostCore", () => {
  it("keeps construction private and every composed consumer on one Session writer", async () => {
    expect(runtimeRequiresEngine).toBe(true);
    expect(terminalRequiresEngine).toBe(true);
    expect(degradedHasNoLiveSurface).toBe(true);
    expect(liveHasNoFailure).toBe(true);
    expect(sessionControl).not.toHaveProperty("createDesktopSessionEngine");
    expect(sessionControl).not.toHaveProperty("createHostSessionEngine");
    expect(import.meta.resolve).toBeTypeOf("function");
    expect(() => import.meta.resolve("@volli/host-core/sessions/engine")).toThrowError(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );

    const construct = vi.spyOn(sessionLedgerModule, "createSqliteSessionLedger");
    const ports = sessionPorts();
    const core = live(createHostCore(ports, headlessOptions(dataDir())));
    opened.push(core);
    const db = core.database.db;
    const engine = core.sessionEngine;
    const writer = vi.spyOn(core.sessionLedger, "transaction");
    const project = testProject();
    insertProject(db, project);
    const wakes: SessionWake[] = [];
    const unsubscribe = core.sessionWakeBus.subscribe((wake) => wakes.push(wake));
    const executor = {
      id: "test",
      durableIdNamespace: "test",
      adapterVersion: "1",
      runtime: { path: "test", version: "1", fingerprint: "test" },
      attach: vi.fn(() => {
        throw new Error("This test never attaches an executor");
      }),
    };
    const runtime = createHostSessionRuntime({
      db,
      events: ports.events,
      log: ports.log,
      dataDir: core.dataDir,
      transcriptDirectory: join(core.dataDir, "transcripts"),
      sessionEngine: engine,
      executor,
    });
    const manager = new PtyManager({
      host: {
        events: ports.events,
        worktreeDeps: () => {
          throw new Error("This test never starts a worktree");
        },
        ensureHarnessWorkspaceFiles: async () => ({ refused: [] }),
      },
      db,
      dbError: "",
      sessionEngine: engine,
    });
    try {
      expect(construct).toHaveBeenCalledTimes(1);
      expect(construct.mock.results[0]?.value).toBe(core.sessionLedger);
      writer.mockClear();
      const created = await runtime.command({
        commandId: "create-through-runtime",
        command: {
          kind: "session.create",
          projectId: project.id,
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: "One writer",
        },
      });
      expect(writer).toHaveBeenCalled();
      const sessionId = created.sessionId;
      expect(wakes.some(({ event }) => event.sessionId === sessionId)).toBe(true);
      await core.sessionActivityWatch.flush();
      expect(ports.events.publish).toHaveBeenCalledWith(
        "session-activity",
        expect.objectContaining({
          row: expect.objectContaining({
            record: expect.objectContaining({ sessionId }),
          }),
        }),
      );
      writer.mockClear();
      await core.hostNoticeOutbox.pending();
      expect(writer).toHaveBeenCalledTimes(1);
      writer.mockClear();
      await engine.getSession({ sessionId });
      expect(writer).toHaveBeenCalledTimes(1);
      expect(construct).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      manager.killAll();
      await runtime.close();
      construct.mockRestore();
      writer.mockRestore();
    }
  });
  it("reports a failed automatic follow-up release through the host log port, not the console", async () => {
    const ports = sessionPorts();
    const core = live(createHostCore(ports, headlessOptions(dataDir())));
    opened.push(core);
    const project = testProject();
    insertProject(core.database.db, project);
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
    const runtime = createHostSessionRuntime({
      db: core.database.db,
      events: ports.events,
      log: ports.log,
      dataDir: core.dataDir,
      transcriptDirectory: join(core.dataDir, "transcripts"),
      sessionEngine: core.sessionEngine,
      executor: {
        id: "test",
        durableIdNamespace: "test",
        adapterVersion: "1",
        runtime: { path: "test", version: "1", fingerprint: "test" },
        attach: vi.fn(() => {
          throw new Error("executor offline");
        }),
      },
    });
    try {
      const { sessionId } = await runtime.command({
        commandId: "create",
        command: {
          kind: "session.create",
          projectId: project.id,
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: null,
        },
      });
      await runtime.command({
        commandId: "queue",
        sessionId,
        command: {
          kind: "message.submit",
          delivery: "queue",
          message: { id: "queued", role: "user", parts: [{ type: "text", text: "Later" }] },
        },
      });
      // No Client is attached: the idle Session releases on its own, and the
      // executor refuses the attach.
      await vi.waitFor(() =>
        expect(ports.log.error).toHaveBeenCalledWith("follow-up queue release failed", {
          error: expect.any(Error),
        }),
      );
      expect(console).not.toHaveBeenCalledWith(
        expect.stringContaining("follow-up queue"),
        expect.anything(),
      );
    } finally {
      await runtime.close();
      console.mockRestore();
    }
  });
  it("owns the secret store and lazily constructs one terminal manager from options", async () => {
    const root = dataDir();
    const codec = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    };
    const terminalHost = {
      events: sessionPorts().events,
      worktreeDeps: vi.fn(),
      ensureHarnessWorkspaceFiles: vi.fn(async () => ({ refused: [] })),
    };
    const terminal = vi.fn(() => ({ host: terminalHost }));
    const core = live(
      compose(
        { log: { error: vi.fn() } },
        { ...headlessOptions(root), secretKey: codec, terminal },
      ),
    );
    const terminals = core.terminals;
    if (terminals.kind !== "available") throw new Error("Expected terminal capability.");
    const manager = terminals.manager;
    expect(core.terminals).toEqual({ kind: "available", manager });
    expect(terminal).toHaveBeenCalledOnce();
    core.secretStore.put({ name: "TOKEN", value: "fixture", scope: "always" });
    expect(core.secretStore.list()).toHaveLength(1);
    const adopted = live(
      compose(
        { log: { error: vi.fn() } },
        { ...headlessOptions(dataDir()), secretStore: core.secretStore },
      ),
    );
    expect(adopted.secretStore).toBe(core.secretStore);
    expect(adopted.terminals).toEqual({ kind: "unavailable" });
    const unavailable = live(compose({ log: { error: vi.fn() } }, headlessOptions(dataDir())));
    expect(() =>
      unavailable.secretStore.put({ name: "TOKEN", value: "fixture", scope: "always" }),
    ).toThrow("no secret key port");
    await core.stop("terminal test");
  });

  it("opens and migrates <dataDir>/volli.db, creating the directory", () => {
    const root = join(dataDir(), "nested", "profile");
    const log = { error: vi.fn() };
    const core = compose({ log }, { ...headlessOptions(root), devDiagnostics: true });
    expect(core.kind).toBe("live");
    expect(core.dataDir).toBe(root);
    expect(core.dbPath).toBe(defaultDatabasePath(root));
    expect(core.dbPath).toBe(join(root, "volli.db"));
    const tables = live(core)
      .database.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
      )
      .all();
    expect(tables).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("opens an explicit database path instead of the data directory's", () => {
    const root = dataDir();
    const databasePath = join(dataDir(), "elsewhere", "override.db");
    const core = compose(
      { log: { error: vi.fn() } },
      {
        dataDir: root,
        databasePath,
        onTransactionViolation: throwTransactionViolation,
        devDiagnostics: false,
        processReaders: NO_PROCESS_READERS,
      },
    );
    expect(core.dbPath).toBe(databasePath);
    const host = live(core);
    expect(host.database.ok).toBe(true);
    expect(host).not.toHaveProperty("databaseFailure");
    expect(host.sessionEngine).toBeDefined();
    expect(host.sessionLedger).toBeDefined();
    expect(host.hostNoticeOutbox).toBeDefined();
  });

  it("installs the transaction-ownership handler the host chose", () => {
    const strict = live(
      compose(
        { log: { error: vi.fn() } },
        {
          dataDir: dataDir(),
          onTransactionViolation: throwTransactionViolation,
          devDiagnostics: true,
          processReaders: NO_PROCESS_READERS,
        },
      ),
    );
    const strictDb = strict.database.db;
    expect(() => strictDb.exec("BEGIN")).toThrow("transaction ownership");
    expect(strictDb.inTransaction).toBe(false);

    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const packaged = live(
      compose(
        { log: { error: vi.fn() } },
        {
          dataDir: dataDir(),
          onTransactionViolation: logTransactionViolation,
          devDiagnostics: false,
          processReaders: NO_PROCESS_READERS,
        },
      ),
    );
    packaged.database.db.exec("BEGIN");
    packaged.database.db.exec("ROLLBACK");
    expect(report).toHaveBeenCalled();
    report.mockRestore();
  });

  it("returns the degraded variant with a classified reason instead of throwing", () => {
    const root = dataDir();
    const databasePath = writeDamagedDatabase(root);
    const log = { error: vi.fn() };
    const core = compose(
      { log },
      {
        dataDir: root,
        databasePath,
        onTransactionViolation: throwTransactionViolation,
        devDiagnostics: false,
        processReaders: NO_PROCESS_READERS,
      },
    );
    expect(core.database).toEqual({
      ok: false,
      error: expect.stringContaining("damaged header") as unknown,
    });
    const host = degraded(core);
    expect(host.databaseFailure).toEqual({ kind: "other" });
    // Absent, not null: the degraded variant is its metadata and its lifecycle.
    expect(Object.keys(host).toSorted()).toEqual([
      "dataDir",
      "database",
      "databaseFailure",
      "dbPath",
      "kind",
      "start",
      "stop",
      "warnIfFollowUpCleanCloseSkipped",
    ]);
    for (const field of [
      "sessionEngine",
      "sessionWakeBus",
      "sessionReadWatch",
      "sessionActivityWatch",
      "sessionLedger",
      "hostNoticeOutbox",
      "runtimeServices",
      "maintenance",
      "client",
      "detachedWork",
    ]) {
      expect(host).not.toHaveProperty(field);
    }
    // Nothing that needs a database was constructed for it.
    expect(createHostMaintenance).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith("failed to open database", {
      detail: expect.stringContaining("damaged header"),
    });
  });

  it("refuses client capabilities readably without a client, and hands a client's through", async () => {
    const headless = live(compose({ log: { error: vi.fn() } }, headlessOptions(dataDir())));
    await expect(headless.client.openExternal("https://example.com")).rejects.toBeInstanceOf(
      ClientCapabilityUnavailableError,
    );
    expect(() => headless.client.revealInFolder(headless.dbPath)).toThrow(
      "Revealing a file needs the Volli desktop app, and this host is running without one.",
    );

    const client = {
      openExternal: vi.fn(() => Promise.resolve()),
      revealInFolder: vi.fn(),
      writeClipboardText: vi.fn(() => Promise.resolve()),
      readClipboardText: vi.fn(() => Promise.resolve("")),
      showMenu: vi.fn(() => Promise.resolve(null)),
    };
    const desktop = live(compose({ log: { error: vi.fn() }, client }, headlessOptions(dataDir())));
    expect(desktop.client).toBe(client);
  });

  it("refuses a database from a newer Volli with a typed failure, touching nothing (VC-602)", async () => {
    const root = dataDir();
    const seed = live(compose({ log: { error: vi.fn() } }, { ...headlessOptions(root) }));
    await expect(seed.stop("seeded")).resolves.toEqual({ reason: "seeded", clean: true });
    const stamp = new Database(seed.dbPath);
    stamp.pragma(`user_version = ${SCHEMA_HEAD + 1}`);
    stamp
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)")
      .run(MIN_READER_VERSION_KEY, String(SCHEMA_HEAD + 1));
    stamp.pragma("wal_checkpoint(TRUNCATE)");
    stamp.close();
    const hash = () => createHash("sha256").update(readFileSync(seed.dbPath)).digest("hex");
    const before = hash();

    const log = { error: vi.fn() };
    const core = compose({ log }, { ...headlessOptions(root) });

    expect(core.database).toEqual({
      ok: false,
      error:
        "This database was created by a newer version of Volli. Nothing was changed. Update Volli, or restore an older backup.",
    });
    expect(degraded(core).databaseFailure).toEqual({
      kind: "newer-version",
      schemaVersion: SCHEMA_HEAD + 1,
      supportedVersion: SCHEMA_HEAD,
      minReaderVersion: SCHEMA_HEAD + 1,
    });
    expect(log.error).toHaveBeenCalledWith("failed to open database", {
      detail: expect.stringContaining(`Database schema ${SCHEMA_HEAD + 1} is newer`),
    });
    expect(hash()).toBe(before);
  });
});

describe("createHostCore composition", () => {
  it("hands maintenance the host's process readers, and reclaim seams only when supplied", () => {
    const core = live(compose({ log: { error: vi.fn() } }, headlessOptions(dataDir())));
    expect(createHostMaintenance).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(createHostMaintenance).mock.calls[0]!;
    expect(input.db).toBe(core.database.db);
    expect(input.processReaders).toBe(NO_PROCESS_READERS);
    expect(input).not.toHaveProperty("reclaim");
    expect(core.maintenance).toBe(vi.mocked(createHostMaintenance).mock.results[0]!.value);
    expect(core.worktreeDeps).toBeDefined();
    expect(core.fileServices).toBeDefined();
    expect(core.detachedWork.pending).toBe(0);

    const processReaders = { liveSessionIds: () => ["s"], openTerminalCwds: () => ["/w"] };
    const reclaim = { isBusy: vi.fn(), release: vi.fn() } as unknown as NonNullable<
      Parameters<typeof createHostCore>[1]["reclaim"]
    >;
    compose(
      { log: { error: vi.fn() } },
      { ...headlessOptions(dataDir()), processReaders, reclaim },
    );
    const [supplied] = vi.mocked(createHostMaintenance).mock.calls[1]!;
    expect(supplied.processReaders).toBe(processReaders);
    expect(supplied.reclaim).toBe(reclaim);
  });

  it("narrows the host itself with isLiveHost", () => {
    const root = dataDir();
    const healthy = compose({ log: { error: vi.fn() } }, headlessOptions(dataDir()));
    const broken = compose(
      { log: { error: vi.fn() } },
      { ...headlessOptions(root), databasePath: writeDamagedDatabase(root) },
    );
    expect(isLiveHost(healthy)).toBe(true);
    expect(isLiveHost(broken)).toBe(false);
  });

  it("builds the runtime services once, on first read, with the host's defaults", () => {
    const core = live(compose({ log: { error: vi.fn() } }, headlessOptions(dataDir())));
    expect(createHostRuntimeServices).not.toHaveBeenCalled();
    const services = core.runtimeServices;
    expect(core.runtimeServices).toBe(services);
    expect(createHostRuntimeServices).toHaveBeenCalledTimes(1);
    const [db, engine, ports, options] = vi.mocked(createHostRuntimeServices).mock.calls[0]!;
    expect(db).toBe(core.database.db);
    expect(engine).toBe(core.sessionEngine);
    expect(ports).toEqual({ client: core.client });
    // No key at all: the runtime module's own defaults apply.
    expect(options).toStrictEqual({ dbPath: core.dbPath });
  });

  it("asks the host for model access and venue only when the runtime services are first read", () => {
    const modelAccess = { models: {}, catalogReady: Promise.resolve() } as unknown as ReturnType<
      NonNullable<Parameters<typeof createHostCore>[1]["modelAccess"]>
    >;
    const supplyModels = vi.fn(() => modelAccess);
    const webKeySealing = { keyring: null, mayUnlockUnattended: vi.fn(() => false) };
    const venue = vi.fn(() => ({ id: "cloud-host", kind: "remote" as const }));
    const core = live(
      compose(
        { log: { error: vi.fn() } },
        { ...headlessOptions(dataDir()), modelAccess: supplyModels, venue, webKeySealing },
      ),
    );
    expect(supplyModels).not.toHaveBeenCalled();
    expect(venue).not.toHaveBeenCalled();
    void core.runtimeServices;
    void core.runtimeServices;
    expect(supplyModels).toHaveBeenCalledTimes(1);
    expect(venue).toHaveBeenCalledTimes(1);
    expect(venue).toHaveBeenCalledWith(core.database.db);
    expect(vi.mocked(createHostRuntimeServices).mock.calls[0]![3]).toStrictEqual({
      dbPath: core.dbPath,
      modelAccess,
      webKeySealing,
      venue: { id: "cloud-host", kind: "remote" },
    });
  });
});

describe("createHostCore lifecycle", () => {
  it("uses the host warning logger once for an unstamped stop, including a deadline", async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const close = Promise.withResolvers<void>();
    const core = live(
      compose({ log }, { ...headlessOptions(dataDir()), stopPolicy: "desktop-quit" }),
    );
    await core.start(recordingRuntime({ close: () => close.promise }));
    const stopped = core.stop("quit");
    core.warnIfFollowUpCleanCloseSkipped("quit: shutdown deadline expired after 15000ms");
    core.warnIfFollowUpCleanCloseSkipped("repeat deadline");
    close.reject(new Error("late close failure"));
    expect((await stopped).clean).toBe(false);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      "follow-up clean-close watermark was not stamped",
      { reason: "quit: shutdown deadline expired after 15000ms" },
    );
  });

  it("warns through the host logger for an unclean stop even without a deadline", async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const core = live(compose({ log }, headlessOptions(dataDir())));
    await core.start(
      recordingRuntime({
        close: async () => {
          throw new Error("runtime refused close");
        },
      }),
    );
    expect((await core.stop("SIGTERM")).clean).toBe(false);
    core.warnIfFollowUpCleanCloseSkipped("late deadline");
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      "follow-up clean-close watermark was not stamped",
      { reason: "SIGTERM: close-runtime failed: runtime refused close" },
    );
  });

  it("desktop policy skips detached and maintenance joins and leaves SQLite open", async () => {
    const core = live(
      compose(
        { log: { error: vi.fn() } },
        {
          ...headlessOptions(dataDir()),
          stopPolicy: "desktop-quit",
        },
      ),
    );
    const work = Promise.withResolvers<void>();
    core.detachedWork.track(work.promise);
    const settled = vi.spyOn(core.maintenance, "settled");
    const pragma = vi.spyOn(core.database.db, "pragma");
    const close = vi.spyOn(core.database.db, "close");
    await core.start(recordingRuntime());
    expect(await core.stop("quit")).toEqual({ reason: "quit", clean: true });
    expect(calls).toEqual([
      "runtime start",
      "stop producers",
      "stop maintenance",
      "close runtime",
      "close socket",
      "stop activity",
    ]);
    expect(core.detachedWork.pending).toBe(1);
    expect(settled).not.toHaveBeenCalled();
    expect(pragma).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(core.database.db.open).toBe(true);
    work.resolve();
    await core.detachedWork.drain();
  });

  it("also passes the desktop policy to a degraded host", async () => {
    const root = dataDir();
    const host = degraded(
      compose(
        { log: { error: vi.fn() } },
        {
          ...headlessOptions(root),
          databasePath: writeDamagedDatabase(root),
          stopPolicy: "desktop-quit",
        },
      ),
    );
    await host.start(recordingRuntime());
    await host.stop("quit");
    expect(calls).toEqual(["runtime start", "stop producers", "close runtime", "close socket"]);
  });

  it("boots the adopted runtime, then stops it and the host's own services in order", async () => {
    const log = { error: vi.fn() };
    const core = live(compose({ log }, headlessOptions(dataDir())));
    const db = core.database.db;
    // Detached work (a Done-trim) that settles on a later macrotask than the
    // runtime close: a stop that did not wait for it would close the database first.
    let settleTrim!: () => void;
    core.detachedWork.track(
      new Promise<void>((resolve) => {
        settleTrim = () => {
          calls.push(`detached work settled (database open: ${db.open})`);
          resolve();
        };
      }),
    );
    const runtime = recordingRuntime({
      close: vi.fn(async () => {
        calls.push("close runtime");
        setTimeout(settleTrim, 5);
      }),
    });

    await core.start(runtime);
    expect(calls).toEqual(["runtime start"]);

    const stopping = core.stop("quit");
    expect(core.stop("again")).toBe(stopping);
    await expect(stopping).resolves.toEqual({ reason: "quit", clean: true });
    expect(calls).toEqual([
      "runtime start",
      "stop producers",
      "stop maintenance",
      "close runtime",
      "close socket",
      "drain requests",
      "detached work settled (database open: true)",
      "stop activity",
      "close database",
    ]);
    expect(db.open).toBe(false);
    expect(core.detachedWork.pending).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
    for (const step of Object.values(runtime)) expect(step).toHaveBeenCalledTimes(1);
  });

  it("a rejecting request drain still joins the host's detached writers", async () => {
    const log = { error: vi.fn() };
    const core = live(compose({ log }, headlessOptions(dataDir())));
    const trim = Promise.withResolvers<void>();
    core.detachedWork.track(
      trim.promise.then(() => {
        expect(core.database.db.open).toBe(true);
        calls.push("trim settled");
      }),
    );
    await core.start(
      recordingRuntime({
        drainRequests: async () => {
          throw new Error("transport failed");
        },
      }),
    );
    const stopping = core.stop("quit");
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(core.database.db.open).toBe(true);
    expect(calls).not.toContain("close database");
    trim.resolve();
    expect(await stopping).toEqual({ reason: "quit", clean: false });
    expect(calls.indexOf("trim settled")).toBeLessThan(calls.indexOf("close database"));
    expect(log.error).toHaveBeenCalledWith("host shutdown step failed", {
      step: "drain-detached",
      error: expect.any(Error),
    });
  });

  it("adopts only the first runtime, and a runtime without socket or request drains", async () => {
    const core = live(compose({ log: { error: vi.fn() } }, headlessOptions(dataDir())));
    const {
      closeSocket: _closeSocket,
      drainRequests: _drainRequests,
      ...first
    } = recordingRuntime();
    const second = recordingRuntime();

    const starting = core.start(first);
    expect(core.start(second)).toBe(starting);
    await starting;

    await expect(core.stop("quit")).resolves.toEqual({ reason: "quit", clean: true });
    expect(calls).toEqual([
      "runtime start",
      "stop producers",
      "stop maintenance",
      "close runtime",
      "stop activity",
      "close database",
    ]);
    for (const step of Object.values(second)) expect(step).not.toHaveBeenCalled();
  });

  it("stops a host that never adopted a runtime, and refuses a start once stopping", async () => {
    const core = live(compose({ log: { error: vi.fn() } }, headlessOptions(dataDir())));
    await expect(core.stop("never booted")).resolves.toEqual({
      reason: "never booted",
      clean: true,
    });
    expect(calls).toEqual(["stop maintenance", "stop activity", "close database"]);
    expect(core.database.db.open).toBe(false);

    const late = recordingRuntime();
    await expect(core.start(late)).rejects.toThrow("The host is stopping.");
    expect(late.start).not.toHaveBeenCalled();
  });

  it("reports each failed step and still closes the database", async () => {
    const log = { error: vi.fn() };
    const core = live(compose({ log }, headlessOptions(dataDir())));
    const lost = new Error("trim lost its worktree");
    core.detachedWork.track(Promise.reject(lost));
    const closeFailed = new Error("runtime close failed");
    await core.start(
      recordingRuntime({
        close: vi.fn(async () => {
          throw closeFailed;
        }),
      }),
    );

    await expect(core.stop("quit")).resolves.toEqual({ reason: "quit", clean: false });
    expect(log.error).toHaveBeenCalledWith("host shutdown step failed", {
      step: "close-runtime",
      error: closeFailed,
    });
    // Detached work's own failure is reported, and never fails the drain.
    expect(log.error).toHaveBeenCalledWith("detached work failed", { error: lost });
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(calls.slice(-2)).toEqual(["stop activity", "close database"]);
    expect(core.database.db.open).toBe(false);
  });

  it("is unclean when a request drain reports its own timeout, without a second report", async () => {
    const log = { error: vi.fn() };
    const core = live(compose({ log }, headlessOptions(dataDir())));
    await core.start(recordingRuntime({ drainRequests: vi.fn(async () => false) }));
    await expect(core.stop("quit")).resolves.toEqual({ reason: "quit", clean: false });
    expect(log.error).not.toHaveBeenCalled();
    expect(core.database.db.open).toBe(false);
  });

  it("gives a degraded host the same lifecycle over its runtime, and nothing of its own", async () => {
    const root = dataDir();
    const host = degraded(
      compose(
        { log: { error: vi.fn() } },
        { ...headlessOptions(root), databasePath: writeDamagedDatabase(root) },
      ),
    );
    const runtime = recordingRuntime();
    await host.start(runtime);
    await expect(host.stop("quit")).resolves.toEqual({ reason: "quit", clean: true });
    expect(calls).toEqual([
      "runtime start",
      "stop producers",
      "close runtime",
      "close socket",
      "drain requests",
    ]);
  });

  it("starts and stops a degraded host with no runtime at all", async () => {
    const root = dataDir();
    const host = degraded(
      compose(
        { log: { error: vi.fn() } },
        { ...headlessOptions(root), databasePath: writeDamagedDatabase(root) },
      ),
    );
    await expect(host.start()).resolves.toBeUndefined();
    await expect(host.stop("quit")).resolves.toEqual({ reason: "quit", clean: true });
    expect(calls).toEqual([]);
  });
});
