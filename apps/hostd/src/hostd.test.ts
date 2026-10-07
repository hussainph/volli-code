/**
 * hostd's boot and shutdown, in-process, against real data directories, the
 * real host-core and the real agent socket. CI's artifact job drives the
 * built binary the same way from outside (README.md, "CI").
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import {
  assembleDeviceCredential,
  buildHostHello,
  bytesToBase64Url,
  deviceCredentialSigningInput,
  encodeHostHello,
  HOST_V1_FEATURES,
  mintHostTrace,
  type HostCredentialVerifier,
} from "@volli/host-protocol";
import { expectHostError, recordSubscription } from "@volli/host-protocol/testing";
import { createHostLink } from "@volli/host-protocol/client-link";
import { createLogRing, installHostLog, jsonLineSink, teeSinks } from "@volli/host-core/log";
import type { HostRouter } from "@volli/session-rpc";

import Database from "better-sqlite3";
import type { AgentRequest, AgentResponse, Project } from "@volli/shared";
import { insertProject, SCHEMA_HEAD, MIN_READER_VERSION_KEY } from "@volli/host-core/db";
import { SECRET_KEY_FILE_ENV } from "@volli/host-core/secrets";
import { isLiveHost, type HostCore, type HostCoreOptions } from "@volli/host-core";
import type { DetachedWorkPort } from "@volli/host-core/board";
import { resetRetentionWatcherForTest } from "@volli/host-core/testing";

import { HostdBootError } from "./boot-error";
import { runOperatorToken, writeTokenAsUser } from "./operator-token";
import type { HostdLogger } from "./log";
import { startHostd, type HostdOptions, type RunningHostd } from "./hostd";
import { HOSTD_LISTENER_LIMITS } from "./host-protocol";
import { LIVE_PROBES, readStatus, statusFilePath, type HostdState } from "./status";
import { runEnroll } from "./enroll";
import { dataDirDeviceStore, enrollDevice, rootDeviceStore } from "./enrolled-devices";

/** Faults a test can switch on in the modules hostd composes. */
const faults = vi.hoisted(() => ({
  failStatusOn: null as string | null,
  runtimeReadyError: false,
  runtimeConstructError: false,
  runtimeCloseError: false,
  automationsUnavailable: false,
  runtimeReadyGate: null as Promise<void> | null,
  runtimeOwned: false,
  order: [] as string[],
  socketCloseFails: false,
  busySites: null as ((target: string) => Promise<readonly unknown[]>) | null,
  detachedWork: null as DetachedWorkPort | null,
  host: null as HostCore | null,
  hostOptions: null as HostCoreOptions | null,
  /** When set, every command waits on it before it runs. */
  hold: null as Promise<void> | null,
  /** A path whose `statSync` answers as if another user owned it. */
  foreignOwner: null as string | null,
  /** The host's handler map is built with no Sessions facade, as a degraded one would be. */
  noSessionsFacade: false,
  /** Every verdict the host's handler map gave, by door (VC-668). */
  admissions: [] as { door: string; key: string; admitted: boolean }[],
  /** The execute hostd handed the socket, to call without a connection. */
  execute: null as ((request: AgentRequest) => Promise<AgentResponse>) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const ownedStat = ((path: string, ...rest: unknown[]) => {
    const stat = (actual.statSync as (...args: unknown[]) => import("node:fs").Stats)(
      path,
      ...rest,
    );
    return path === faults.foreignOwner ? Object.assign(stat, { uid: stat.uid + 1 }) : stat;
  }) as typeof actual.statSync;
  return {
    ...actual,
    statSync: ownedStat,
    default: { ...actual, statSync: ownedStat },
  };
});

vi.mock("../../../packages/host-core/src/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../packages/host-core/src/index")>();
  return {
    ...actual,
    createHostCore: (...args: Parameters<typeof actual.createHostCore>) => {
      faults.hostOptions = args[1];
      const host = actual.createHostCore(...args);
      faults.host = host;
      if (actual.isLiveHost(host)) {
        const maintenance = host.maintenance;
        const start = maintenance.start;
        const stop = maintenance.stop;
        vi.spyOn(maintenance, "start").mockImplementation(() => {
          faults.order.push("maintenance.start");
          start();
        });
        vi.spyOn(maintenance, "stop").mockImplementation(() => {
          faults.order.push("maintenance.stop");
          stop();
        });
      }
      return host;
    },
  };
});

// The handler map hostd builds (VC-668): the move's guard and drain are its.
vi.mock("../../../packages/host-core/src/handlers/host-handlers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/host-core/src/handlers/host-handlers")>();
  return {
    ...actual,
    createHostHandlers: (...[ports, options]: Parameters<typeof actual.createHostHandlers>) => {
      faults.busySites = options.busyWorktreeSites;
      faults.detachedWork = options.detachedWork ?? null;
      return actual.createHostHandlers(ports, options);
    },
  };
});

vi.mock("../../../packages/host-core/src/agent-services", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/host-core/src/agent-services")>();
  return {
    ...actual,
    createHostAgentCommands: (
      ...[ports, options]: Parameters<typeof actual.createHostAgentCommands>
    ) => {
      const commands = actual.createHostAgentCommands(ports, options);
      return {
        ...commands,
        execute: async (request: AgentRequest) => {
          if (faults.hold !== null) await faults.hold;
          return commands.execute(request);
        },
      };
    },
  };
});

vi.mock("./status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./status")>();
  return {
    ...actual,
    writeStatus: (...args: Parameters<typeof actual.writeStatus>) => {
      if (args[1].state === faults.failStatusOn) throw new Error("disk full");
      actual.writeStatus(...args);
    },
  };
});

vi.mock("../../../packages/host-core/src/agent-socket", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/host-core/src/agent-socket")>();
  return {
    ...actual,
    startAgentSocket: async (
      options: Parameters<typeof actual.startAgentSocket>[0],
      claim: NonNullable<Parameters<typeof actual.startAgentSocket>[1]>,
    ) => {
      type Server = Awaited<ReturnType<typeof actual.startAgentSocket>>;
      faults.execute = options.execute;
      const failing = (server: Server): Server => ({
        close: async () => {
          faults.order.push("socket.close");
          await server.close();
          if (faults.socketCloseFails) throw new Error("close failed");
        },
      });
      return failing(await actual.startAgentSocket(options, (server) => claim(failing(server))));
    },
  };
});

vi.mock("@volli/host-core/handlers", async (original) => {
  const actual = await original<typeof import("@volli/host-core/handlers")>();
  return {
    ...actual,
    createHostHandlers: (...[ports, options]: Parameters<typeof actual.createHostHandlers>) =>
      actual.createHostHandlers(ports, {
        ...options,
        ...(faults.noSessionsFacade ? { sessions: null } : {}),
        onAdmission: (record) => faults.admissions.push(record),
      }),
  };
});

vi.mock("./session-runtime", async (original) => {
  const actual = await original<typeof import("./session-runtime")>();
  return {
    ...actual,
    createHeadlessSessionRuntime: (
      ...args: Parameters<typeof actual.createHeadlessSessionRuntime>
    ) => {
      if (faults.runtimeConstructError) throw new Error("runtime construction failed");
      const runtime = actual.createHeadlessSessionRuntime(...args);
      faults.runtimeOwned = true;
      return {
        ...runtime,
        ready: async () => {
          if (faults.runtimeReadyGate !== null) await faults.runtimeReadyGate;
          if (faults.runtimeReadyError) throw new Error("Session startup failed");
          const ready = await runtime.ready();
          return {
            ...ready,
            automationsAvailable: !faults.automationsUnavailable && ready.automationsAvailable,
          };
        },
        close: async () => {
          faults.order.push("runtime.close");
          await runtime.close();
          // hostd's drain is sequential: nothing of the socket closes before this.
          faults.order.push("runtime.closed");
          if (faults.runtimeCloseError) throw new Error("runtime close failed");
        },
      };
    },
  };
});

let root: string;
const running: RunningHostd[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-"));
});

afterEach(async () => {
  faults.runtimeReadyError = false;
  faults.runtimeConstructError = false;
  faults.runtimeCloseError = false;
  faults.automationsUnavailable = false;
  faults.noSessionsFacade = false;
  faults.admissions = [];
  faults.runtimeReadyGate = null;
  faults.runtimeOwned = false;
  faults.order = [];
  faults.failStatusOn = null;
  faults.socketCloseFails = false;
  faults.hold = null;
  faults.execute = null;
  faults.foreignOwner = null;
  faults.busySites = null;
  faults.detachedWork = null;
  faults.host = null;
  faults.hostOptions = null;
  await Promise.all(running.splice(0).map((host) => host.stop("test over")));
  // Those stops record too; the next test starts from an empty order.
  faults.order = [];
  // The retention watch is a process singleton; each host here is a new process's.
  resetRetentionWatcherForTest();
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

type LogFn = HostdLogger["info"];

function logger() {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
}

/** A device's P-256 key pair, the public half as enrollment takes it. */
function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey,
    spki: bytesToBase64Url(publicKey.export({ format: "der", type: "spki" })),
  };
}

async function boot(
  options: {
    dataDir?: string;
    socketPath?: string;
    env?: Record<string, string>;
    drainTimeoutMs?: number;
    /** Leaves the owner to hostd's own default, root. */
    rootOwnsOperators?: boolean;
    listen?: HostdOptions["listen"];
    devicesFile?: string;
    hostProtocolVerifier?: HostdOptions["hostProtocolVerifier"];
    logRing?: HostdOptions["logRing"];
  } = {},
  log = logger(),
): Promise<RunningHostd> {
  const dataDir = options.dataDir ?? join(root, "data");
  const host = await startHostd({
    dataDir,
    socketPath: options.socketPath ?? join(dataDir, "volli.sock"),
    version: "9.9.9-test",
    env: { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "pi"), ...options.env },
    logger: log,
    // Never the machine's own /etc file: a scratch one, trusted as this user
    // the way production trusts root.
    operatorsFile: join(root, "operators"),
    ...(options.rootOwnsOperators === true ? {} : { operatorsOwnerUid: process.getuid!() }),
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
    ...(options.listen === undefined ? {} : { listen: options.listen }),
    ...(options.devicesFile === undefined ? {} : { devicesFile: options.devicesFile }),
    ...(options.hostProtocolVerifier === undefined
      ? {}
      : { hostProtocolVerifier: options.hostProtocolVerifier }),
    ...(options.logRing === undefined ? {} : { logRing: options.logRing }),
  });
  running.push(host);
  return host;
}

async function refused(
  options: Parameters<typeof boot>[0] = {},
  log = logger(),
): Promise<HostdBootError> {
  const error = await boot(options, log).then(
    () => new Error("expected boot to be refused"),
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HostdBootError);
  return error as HostdBootError;
}

/** One request over the agent socket, as the `volli` CLI sends it. */
function ask(
  socketPath: string,
  cmd: string,
  args: object = {},
  env: AgentRequest["ctx"]["env"] = {},
): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (body += chunk));
    socket.on("end", () => resolve(JSON.parse(body) as AgentResponse));
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.end(`${JSON.stringify({ v: 1, cmd, args, ctx: { cwd: root, env } })}\n`),
    );
  });
}

function project(id: string): Project {
  return {
    id,
    name: `Fixture ${id}`,
    path: join(root, "repo"),
    ticketPrefix: "FX",
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  } as Project;
}

function stateOf(dataDir: string): HostdState | undefined {
  const recorded = readStatus(dataDir);
  return recorded === null || recorded === "unreadable" ? undefined : recorded.state;
}

describe("booting against an empty data directory", () => {
  it("creates it private, migrates, serves the board over the socket and records its health", async () => {
    const log = logger();
    const host = await boot({}, log);
    const dataDir = join(root, "data");
    const socketPath = join(dataDir, "volli.sock");
    expect(await faults.busySites!(root)).toEqual([]);

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(host.status()).toMatchObject({
      v: 1,
      state: "serving",
      pid: process.pid,
      version: "9.9.9-test",
      dataDir,
      socketPath,
      database: { ok: true, path: join(dataDir, "volli.db") },
      capabilities: {
        board: "available",
        sessions: "available",
        terminals: "unavailable",
        browser: "unavailable",
        automations: "available",
      },
    });
    expect(readStatus(dataDir)).toMatchObject({ state: "serving", socketPath });
    expect(host.status().credentials).toEqual({ state: "empty", reason: null, unavailable: [] });
    expect(log.info).toHaveBeenCalledWith("serving", expect.objectContaining({ socketPath }));

    expect(await ask(socketPath, "project.list")).toMatchObject({
      ok: true,
      data: { projects: [] },
    });
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    insertProject(host.host.database.db, project("p1"));
    expect(await ask(socketPath, "project.list")).toMatchObject({
      ok: true,
      data: {
        projects: [expect.objectContaining({ name: "Fixture p1", prefix: "FX", tickets: 0 })],
      },
    });
    // Board writes still need a Session or operator token.
    expect(await ask(socketPath, "identify", { capabilities: true })).toMatchObject({
      ok: true,
      data: expect.objectContaining({ appVersion: "9.9.9-test" }),
    });
  });

  it("stops cleanly: socket gone, WAL folded in, database whole, status stopped", async () => {
    const host = await boot();
    const dataDir = join(root, "data");
    const first = host.stop("SIGTERM");
    expect(host.stop("again")).toBe(first);
    expect(await first).toBe(true);

    expect(existsSync(join(dataDir, "volli.sock"))).toBe(false);
    expect(existsSync(join(dataDir, "volli.db-wal"))).toBe(false);
    expect(stateOf(dataDir)).toBe("stopped");
    const db = new Database(join(dataDir, "volli.db"), { readonly: true });
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
    db.close();
  });

  it("boots again over what it left, keeping its data", async () => {
    const first = await boot();
    if (!isLiveHost(first.host)) throw new Error("database did not open");
    insertProject(first.host.database.db, project("kept"));
    await first.stop("restart");
    const second = await boot();
    expect(await ask(join(root, "data", "volli.sock"), "project.list")).toMatchObject({
      data: { projects: [expect.objectContaining({ name: "Fixture kept" })] },
    });
    expect(second.status().state).toBe("serving");
  });

  it("boots over a stale status file a crashed host left", async () => {
    const dataDir = join(root, "data");
    await boot();
    // What a crash leaves: a "serving" record whose socket nobody answers.
    const recorded = readStatus(dataDir);
    if (recorded === null || recorded === "unreadable") throw new Error("no status recorded");
    const crashed = { ...recorded, socketPath: join(root, "gone.sock") };
    await running.pop()!.stop("crash");
    writeFileSync(statusFilePath(dataDir), JSON.stringify({ ...crashed, state: "serving" }));
    expect((await boot()).status().state).toBe("serving");
  });
});

/**
 * VC-623's acceptance on the real host: an operator token issued by
 * `operator-token` registers a project and creates a ticket over the socket;
 * a token-less caller and a Session-token caller get exactly the refusals they
 * got before.
 */
describe("an operator at the host's shell", () => {
  const me = { login: userInfo().username, uid: process.getuid!(), gid: process.getgid!() };

  /** Issues a token for this user, as `sudo volli-hostd operator-token` would. */
  function issue(action: "issue" | "revoke" = "issue"): string {
    const home = join(root, "home");
    const code = runOperatorToken(
      {
        kind: "operator-token",
        action,
        login: me.login,
        operatorsFile: join(root, "operators"),
        serviceUser: "volli-test-service",
      },
      {
        uid: () => me.uid,
        rootUid: me.uid,
        // The service account: another uid, this test's group (so the file's
        // group can be set without root).
        lookupUser: (login) =>
          login === me.login
            ? me
            : login === "volli-test-service"
              ? { login, uid: me.uid + 1, gid: me.gid }
              : null,
        writeTokenAsUser: (user, token) => writeTokenAsUser(user, token, home),
        now: () => new Date(0),
        out: () => undefined,
        err: () => undefined,
      },
    );
    expect(code).toBe(0);
    return readFileSync(join(home, ".config", "volli", "operator-token"), "utf8").trim();
  }

  it("registers a project and creates a ticket, as the person", async () => {
    const token = issue();
    const log = logger();
    await boot({}, log);
    const socketPath = join(root, "data", "volli.sock");
    const repo = join(root, "acme");
    mkdirSync(repo);
    const operator = { operatorToken: token };

    expect(await ask(socketPath, "project.add", { id: repo }, operator)).toMatchObject({
      ok: true,
      data: { created: true, project: { name: "acme", prefix: "AC", path: repo } },
    });
    expect(
      await ask(socketPath, "ticket.create", { title: "Over SSH", project: "AC" }, operator),
    ).toMatchObject({ ok: true, data: { ticket: { id: "AC-1", title: "Over SSH" } } });
    expect(await ask(socketPath, "ticket.events", { id: "AC-1" })).toMatchObject({
      ok: true,
      data: { events: [expect.objectContaining({ actor: "user" })] },
    });
    // One audit line per write, naming who, and never the token.
    expect(log.info).toHaveBeenCalledWith("operator write", {
      login: me.login,
      cmd: "project.add",
      ok: true,
      code: null,
    });
    expect(log.info).toHaveBeenCalledWith(
      "operator write",
      expect.objectContaining({ cmd: "ticket.create", ok: true }),
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(token);
  });

  it("leaves a token-less caller and a Session-token caller exactly where they were", async () => {
    const token = issue();
    await boot();
    const socketPath = join(root, "data", "volli.sock");
    const repo = join(root, "bravo");
    mkdirSync(repo);
    // hostd starts no Session yet, so any Session token it is shown is one it
    // did not mint — the case VC-163 refuses.
    const session = { session: "abcdef12-3456-7890-abcd-ef1234567890", token: "minted-elsewhere" };

    for (const env of [{}, session, { ...session, operatorToken: token }]) {
      for (const [cmd, args] of [
        ["project.add", { id: repo }],
        ["ticket.create", { title: "Nope", project: repo }],
      ] as const) {
        const answer = await ask(socketPath, cmd, args, env);
        expect(answer, `${cmd} ${JSON.stringify(env)}`).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN_ACTOR" },
        });
      }
    }
    expect(await ask(socketPath, "project.list")).toMatchObject({ data: { projects: [] } });
  });

  it("stops accepting a token from the request after it is revoked", async () => {
    const token = issue();
    await boot();
    const socketPath = join(root, "data", "volli.sock");
    const repo = join(root, "charlie");
    mkdirSync(repo);

    issue("revoke");

    expect(
      await ask(socketPath, "project.add", { id: repo }, { operatorToken: token }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
  });

  it("trusts only root's operators file by default", async () => {
    writeFileSync(join(root, "operators"), "", { mode: 0o644 });

    const error = await refused({ rootOwnsOperators: true });

    expect(error.reason).toBe("operators");
    expect(error.message).toContain(`belongs to uid ${process.getuid!()}`);
  });

  it("refuses to boot when the service account could write the operators file", async () => {
    writeFileSync(join(root, "operators"), "", { mode: 0o666 });
    chmodSync(join(root, "operators"), 0o666);

    const error = await refused();

    expect(error.reason).toBe("operators");
    expect(stateOf(join(root, "data"))).toBeUndefined();
  });
});

describe("boot refusals", () => {
  it("refuses a data directory that is a file, or cannot be created", async () => {
    writeFileSync(join(root, "file"), "");
    expect((await refused({ dataDir: join(root, "file") })).message).toMatch(
      /^Could not create the data directory .*\/file: .*EEXIST/,
    );
    const nested = await refused({ dataDir: join(root, "file", "data") });
    expect(nested.reason).toBe("data-dir");
    expect(nested.message).toMatch(/^Could not create the data directory .*file\/data: /);
  });

  it("refuses a data directory every user can write", async () => {
    const dataDir = join(root, "shared");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o777);
    const error = await refused({ dataDir });
    expect(error.reason).toBe("data-dir");
    expect(error.message).toBe(
      `Permissions 0777 on the data directory ${dataDir} let every user write it, so any of them could replace its database or key. Run: chmod 700 ${dataDir}`,
    );
  });

  it("refuses a data directory another user owns", async () => {
    const dataDir = join(root, "theirs");
    mkdirSync(dataDir);
    faults.foreignOwner = dataDir;
    const error = await refused({ dataDir });
    const uid = process.getuid!();
    expect(error.reason).toBe("data-dir");
    expect(error.message).toBe(
      `The data directory ${dataDir} belongs to uid ${uid + 1}, not to the user volli-hostd runs as (uid ${uid}), so it will not use it. Run: chown ${uid} ${dataDir}`,
    );
  });

  it("warns of a socket in a directory every user can write", async () => {
    const shared = join(root, "shared-run");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const log = logger();
    await boot({ socketPath: join(shared, "volli.sock") }, log);
    expect(log.warn).toHaveBeenCalledWith(
      "the socket's directory is world-writable; another user could unlink or squat on it",
      { socketPath: join(shared, "volli.sock"), mode: "0777" },
    );
  });

  it("serves a group-writable data directory, and says so", async () => {
    const dataDir = join(root, "group");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o770);
    const log = logger();
    expect((await boot({ dataDir }, log)).status().state).toBe("serving");
    expect(log.warn).toHaveBeenCalledWith(
      "the data directory is group-writable; its group could replace the database or key",
      { dataDir, mode: "0770", fix: `chmod 700 ${dataDir}` },
    );
  });

  it("refuses a second host on a data directory a live one serves, whatever its socket", async () => {
    const live = await boot({ socketPath: join(root, "a.sock") });
    const error = await refused({ socketPath: join(root, "b.sock") });
    const lockPath = join(root, "data", "hostd.lock");
    expect(error.reason).toBe("already-running");
    expect(error.message).toBe(
      `Another volli-hostd is serving ${join(root, "data")}: its instance lock ${lockPath} is held.`,
    );
    expect(error.fields).toEqual({ lockPath });
    expect(existsSync(join(root, "b.sock"))).toBe(false);
    expect(live.status().state).toBe("serving");
  });

  it("lets exactly one of two simultaneous hosts serve a data directory", async () => {
    const outcomes = await Promise.allSettled([
      boot({ socketPath: join(root, "a.sock") }),
      boot({ socketPath: join(root, "b.sock") }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ reason: "already-running" });
  });

  it("releases the lock when it stops, so the next host can serve", async () => {
    await (await boot()).stop("restart");
    expect((await boot({ socketPath: join(root, "next.sock") })).status().state).toBe("serving");
  });

  it("refuses a lock it cannot take", async () => {
    mkdirSync(join(root, "data", "hostd.lock"), { recursive: true });
    const error = await refused();
    expect(error.reason).toBe("data-dir");
    expect(error.message).toMatch(/^Could not take the instance lock .*hostd\.lock: /);
  });

  it("refuses a socket another process is serving", async () => {
    await boot({ dataDir: join(root, "one"), socketPath: join(root, "shared.sock") });
    const error = await refused({
      dataDir: join(root, "two"),
      socketPath: join(root, "shared.sock"),
    });
    expect(error.reason).toBe("already-running");
    expect(error.message).toBe(
      `Another process is serving the agent socket ${join(root, "shared.sock")}.`,
    );
    // Refused before the database: the second data directory has none.
    expect(existsSync(join(root, "two", "volli.db"))).toBe(false);
  });

  it("refuses a socket it cannot open", async () => {
    const socketPath = join(root, "missing", "volli.sock");
    const error = await refused({ socketPath });
    expect(error.reason).toBe("socket");
    // ENOENT on Linux; macOS answers a missing directory with EACCES.
    expect(error.fields).toEqual({ socketPath, code: expect.any(String) });
    expect(error.message).toMatch(/^Could not open the agent socket .*missing\/volli\.sock: /);
  });

  it("boots with a bad secret key and reports it, never throws (VC-641)", async () => {
    const log = logger();
    const host = await boot({ env: { [SECRET_KEY_FILE_ENV]: "relative.key" } }, log);
    expect(host.status()).toMatchObject({
      state: "serving",
      capabilities: { board: "available" },
      credentials: { state: "refused", reason: "relative-path", unavailable: ["session-env"] },
    });
    expect(readStatus(join(root, "data"))).toMatchObject({ credentials: { state: "refused" } });
    expect(log.warn).toHaveBeenCalledWith(
      "serving without saved credentials",
      expect.objectContaining({ fix: expect.stringMatching(/must be an absolute path/) }),
    );
    expect(await ask(join(root, "data", "volli.sock"), "project.list")).toMatchObject({ ok: true });
  });

  it("closes the socket when boot fails after opening it", async () => {
    faults.failStatusOn = "starting";
    await expect(boot()).rejects.toThrow("disk full");
    expect(existsSync(join(root, "data", "volli.sock"))).toBe(false);
  });

  it("closes the database too when boot fails after opening it", async () => {
    faults.failStatusOn = "serving";
    await expect(boot()).rejects.toThrow("disk full");
    const dataDir = join(root, "data");
    expect(existsSync(join(dataDir, "volli.sock"))).toBe(false);
    expect(existsSync(join(dataDir, "volli.db-wal"))).toBe(false);
  });
});

describe("a database this build must not serve", () => {
  it("stays up refusing, with the typed newer-version failure in its status (VC-602)", async () => {
    const dataDir = join(root, "data");
    await (await boot()).stop("seed");
    running.pop();
    const stamp = new Database(join(dataDir, "volli.db"));
    stamp.pragma(`user_version = ${SCHEMA_HEAD + 1}`);
    stamp
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)")
      .run(MIN_READER_VERSION_KEY, String(SCHEMA_HEAD + 1));
    stamp.pragma("wal_checkpoint(TRUNCATE)");
    stamp.close();
    const digest = () =>
      createHash("sha256")
        .update(readFileSync(join(dataDir, "volli.db")))
        .digest("hex");
    const before = digest();

    const log = logger();
    const host = await boot({}, log);
    const failure = {
      kind: "newer-version",
      schemaVersion: SCHEMA_HEAD + 1,
      supportedVersion: SCHEMA_HEAD,
      minReaderVersion: SCHEMA_HEAD + 1,
    };
    expect(host.status()).toMatchObject({
      state: "refusing",
      database: { ok: false, failure, error: expect.stringContaining("newer version of Volli") },
      capabilities: { board: "unavailable" },
    });
    expect(readStatus(dataDir)).toMatchObject({ state: "refusing", database: { failure } });
    expect(log.error).toHaveBeenCalledWith(
      "refusing to serve: the database did not open",
      expect.objectContaining({ failure }),
    );
    expect(await ask(join(dataDir, "volli.sock"), "project.list")).toMatchObject({
      ok: false,
      error: { code: "DB_UNAVAILABLE", message: expect.stringContaining("newer version") },
    });
    expect(await host.stop("SIGTERM")).toBe(true);
    expect(digest()).toBe(before);
  });
});

describe("draining requests at shutdown", () => {
  const request: AgentRequest = { v: 1, cmd: "project.list", args: {}, ctx: { cwd: "/", env: {} } };

  it("waits for a request still executing before it closes the database", async () => {
    const host = await boot();
    let release!: () => void;
    faults.hold = new Promise((resolve) => {
      release = resolve;
    });
    const answer = faults.execute!(request);
    await Promise.resolve(); // Enter execute before stopping rejects new arrivals.
    const stopped = host.stop("SIGTERM");
    // Ordered by events, not time: the socket has closed and the stop is
    // waiting on the held request, with the database still open under it.
    await vi.waitFor(() => expect(faults.order).toContain("socket.close"));
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    expect(host.host.database.db.open).toBe(true);
    expect(stateOf(join(root, "data"))).toBe("stopping");
    release();
    expect(await answer).toMatchObject({ ok: true, data: { projects: [] } });
    expect(await stopped).toBe(true);
    expect(host.host.database.db.open).toBe(false);
  });

  it("abandons one that outlives the drain, and says the stop was not clean", async () => {
    const log = logger();
    const host = await boot({ drainTimeoutMs: 10 }, log);
    faults.hold = new Promise(() => undefined);
    void faults.execute!(request);
    await Promise.resolve();
    expect(await host.stop("SIGTERM")).toBe(false);
    expect(log.error).toHaveBeenCalledWith("abandoned requests still executing", { count: 1 });
    expect(existsSync(join(root, "data", "volli.db-wal"))).toBe(false);
  });
});

describe("shutdown faults", () => {
  it("still closes the database when the status file cannot be written", async () => {
    const log = logger();
    const host = await boot({}, log);
    faults.failStatusOn = "stopping";
    expect(await host.stop("SIGTERM")).toBe(true);
    expect(log.error).toHaveBeenCalledWith("could not write the status file", {
      error: expect.any(Error),
      state: "stopping",
    });
    expect(existsSync(join(root, "data", "volli.db-wal"))).toBe(false);
  });

  it("reports a socket that did not close as an unclean stop, even with the database closed", async () => {
    const log = logger();
    const host = await boot({}, log);
    faults.socketCloseFails = true;
    expect(await host.stop("SIGTERM")).toBe(false);
    expect(log.error).toHaveBeenCalledWith("agent socket did not close cleanly", {
      error: expect.any(Error),
    });
    expect(log.error).not.toHaveBeenCalledWith("host shutdown step failed", expect.anything());
    expect(existsSync(join(root, "data", "volli.db-wal"))).toBe(false);
  });

  it("reports a socket that did not close cleanly, and a database that did not either", async () => {
    const log = logger();
    const host = await boot({}, log);
    faults.socketCloseFails = true;
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    host.host.database.db.close();
    expect(await host.stop("SIGTERM")).toBe(false);
    expect(log.error).toHaveBeenCalledWith("agent socket did not close cleanly", {
      error: expect.any(Error),
    });
    expect(log.error).toHaveBeenCalledWith("host shutdown step failed", {
      source: "host-core",
      step: "close-database",
      error: expect.any(Error),
    });
  });
});

it("settles queued CLI requests on startup rejection and closes every owner", async () => {
  const gate = Promise.withResolvers<void>();
  faults.runtimeReadyGate = gate.promise;
  faults.runtimeReadyError = true;
  const booting = boot().then(
    () => null,
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(faults.runtimeOwned).toBe(true));
  const answer = faults.execute!({
    v: 1,
    cmd: "project.list",
    args: {},
    ctx: { cwd: "/", env: {} },
  });
  gate.resolve();
  expect(await booting).toBeInstanceOf(Error);
  expect(await answer).toMatchObject({ ok: false, error: { code: "APP_UNREACHABLE" } });
  // Never started, still stopped: the host's one stop owns a failed boot too.
  expect(faults.order).toEqual([
    "maintenance.stop",
    "runtime.close",
    "runtime.closed",
    "socket.close",
  ]);
  expect(existsSync(join(root, "data/volli.sock"))).toBe(false);
  expect(existsSync(join(root, "data/volli.db-wal"))).toBe(false);
});
it("retains the startup failure even if runtime drain fails, and still closes socket/DB", async () => {
  faults.runtimeReadyError = true;
  faults.runtimeCloseError = true;
  const log = logger();
  await expect(boot({}, log)).rejects.toThrow("Session startup failed");
  expect(log.error).toHaveBeenCalledWith("host shutdown step failed", {
    source: "host-core",
    step: "close-runtime",
    error: expect.objectContaining({ message: "runtime close failed" }),
  });
  expect(existsSync(join(root, "data/volli.sock"))).toBe(false);
  expect(existsSync(join(root, "data/volli.db-wal"))).toBe(false);
});
it("rejects new requests while stopping and after stop, and reports failed runtime drain", async () => {
  const log = logger();
  const host = await boot({}, log);
  faults.runtimeCloseError = true;
  const stop = host.stop("SIGTERM");
  const request: AgentRequest = { v: 1, cmd: "project.list", args: {}, ctx: { cwd: "/", env: {} } };
  expect(await faults.execute!(request)).toMatchObject({
    ok: false,
    error: { code: "APP_UNREACHABLE" },
  });
  expect(await stop).toBe(false);
  expect(await faults.execute!(request)).toMatchObject({
    ok: false,
    error: { code: "APP_UNREACHABLE" },
  });
  expect(log.error).toHaveBeenCalledWith("host shutdown step failed", {
    source: "host-core",
    step: "close-runtime",
    error: expect.objectContaining({ message: "runtime close failed" }),
  });
  expect(faults.order).toEqual([
    "maintenance.start",
    "maintenance.stop",
    "runtime.close",
    "runtime.closed",
    "socket.close",
  ]);
});

it("reports a missing automation runner without hiding the ready Session runtime", async () => {
  faults.automationsUnavailable = true;
  expect((await boot()).status().capabilities).toMatchObject({
    sessions: "available",
    automations: "unavailable",
  });
});

describe("the host lifecycle hostd composes (VC-627)", () => {
  it("starts maintenance only once serving, and stops it before anything drains", async () => {
    const host = await boot();
    expect(host.status().state).toBe("serving");
    expect(faults.order).toEqual(["maintenance.start"]);
    expect(await host.stop("SIGTERM")).toBe(true);
    expect(faults.order).toEqual([
      "maintenance.start",
      "maintenance.stop",
      "runtime.close",
      "runtime.closed",
      "socket.close",
    ]);
  });

  it("hands its handlers the host's detached work, and drains it after the socket, before the database", async () => {
    const host = await boot();
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    const live = host.host;
    expect(faults.detachedWork).toBe(live.detachedWork);
    const trim = Promise.withResolvers<void>();
    faults.detachedWork!.track(trim.promise);
    const stopped = host.stop("SIGTERM");
    await vi.waitFor(() => expect(faults.order).toContain("socket.close"));
    // Still draining: the database outlives the enrolled work.
    expect(live.database.db.open).toBe(true);
    expect(live.detachedWork.pending).toBe(1);
    trim.resolve();
    expect(await stopped).toBe(true);
    expect(live.detachedWork.pending).toBe(0);
    expect(live.database.db.open).toBe(false);
  });

  it("starts the host exactly once, and never maintenance on a database it refused", async () => {
    const dataDir = join(root, "data");
    await (await boot()).stop("seed");
    running.pop();
    const stamp = new Database(join(dataDir, "volli.db"));
    stamp.pragma(`user_version = ${SCHEMA_HEAD + 1}`);
    stamp
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)")
      .run(MIN_READER_VERSION_KEY, String(SCHEMA_HEAD + 1));
    stamp.pragma("wal_checkpoint(TRUNCATE)");
    stamp.close();
    faults.order = [];
    const log = logger();
    const host = await boot({}, log);
    expect(host.host.kind).toBe("degraded");
    expect(host.status().state).toBe("refusing");
    // A second start answers the first: no second serve.
    await host.host.start();
    const refusals = log.error.mock.calls.filter(
      ([message]) => message === "refusing to serve: the database did not open",
    );
    expect(refusals).toHaveLength(1);
    expect(await host.stop("SIGTERM")).toBe(true);
    expect(faults.order).toEqual(["socket.close"]);
  });

  it("reads live Sessions and busy worktrees from the runtime, failing closed until it recovers", async () => {
    const gate = Promise.withResolvers<void>();
    faults.runtimeReadyGate = gate.promise;
    const booting = boot().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(faults.runtimeOwned).toBe(true));
    const options = faults.hostOptions!;
    expect(options.processReaders.openTerminalCwds()).toEqual([]);
    // No attachment token is minted yet: nothing is live in this process.
    expect(options.processReaders.liveSessionIds()).toEqual([]);
    // Composed but not recovered: a reclaim asks, and is refused.
    await expect(options.reclaim!.busyWorktreeSites!(root)).rejects.toThrow("not ready");
    await expect(options.reclaim!.releaseAgentSites!(root)).rejects.toThrow("not ready");
    gate.resolve();
    expect(await booting).toBeNull();
    // Recovered: the reclaim reads the same supplier the commands guard with.
    expect(await options.reclaim!.busyWorktreeSites!(root)).toEqual([]);
    expect(await options.reclaim!.releaseAgentSites!(root)).toEqual({
      released: [],
      stillOpen: [],
    });
  });

  it("refuses process and worktree reads when the runtime was never composed", async () => {
    faults.runtimeConstructError = true;
    await expect(boot()).rejects.toThrow("runtime construction failed");
    const options = faults.hostOptions!;
    expect(() => options.processReaders.liveSessionIds()).toThrow("not composed yet");
    await expect(options.reclaim!.busyWorktreeSites!(root)).rejects.toThrow("not composed yet");
    await expect(options.reclaim!.releaseAgentSites!(root)).rejects.toThrow("not composed yet");
    expect(faults.order).toEqual(["maintenance.stop", "socket.close"]);
  });
});

describe("the host protocol listener (VC-663)", () => {
  const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  const OTHER_WORKSPACE = "7a2e3d4c-5b6f-4071-9b8c-0d1e2f3a4b5c";
  const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
  const CLOUD = { VOLLI_EXPERIMENTAL: "cloud" };
  const LOOPBACK = { host: "127.0.0.1", port: 0 };

  /** The test verifier: one credential, for a device in WORKSPACE, revocable. */
  function device() {
    let valid = true;
    let push: (() => void) | null = null;
    const verifier: HostCredentialVerifier = {
      verify: ({ credential }) =>
        credential === "device-token"
          ? {
              actor: { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE },
              current: () => valid,
              watch: (revoked) => {
                push = revoked;
                return () => (push = null);
              },
            }
          : null,
    };
    return {
      verifier,
      revoke: () => {
        valid = false;
        push?.();
      },
    };
  }

  function client(url: string, credential = "device-token") {
    const socket = createWSClient({
      url,
      connectionParams: () =>
        encodeHostHello(
          buildHostHello({
            client: { kind: "cli", version: "test" },
            workspaceId: WORKSPACE,
            credential,
            features: [...HOST_V1_FEATURES],
            lastSeen: null,
          }),
        ),
    });
    const trpc = createTRPCClient<HostRouter>({ links: [wsLink({ client: socket })] });
    return { trpc, close: () => socket.close() };
  }

  it("serves the board to a verified device: reads, receipted writes and the change feed (VC-565)", async () => {
    const lever = device();
    const host = await boot(
      { env: CLOUD, listen: LOOPBACK, hostProtocolVerifier: lever.verifier },
      logger(),
    );
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    const { db } = host.host.database;
    insertProject(db, { ...project(WORKSPACE), path: join(root, "workspace") });
    insertProject(db, { ...project(OTHER_WORKSPACE), path: join(root, "other") });
    const { trpc, close } = client(host.status().hostProtocol!.url);
    try {
      const empty = await trpc.board.snapshot.query({ projectId: WORKSPACE });
      // The sidebar's signals come from this host's Session ledger.
      expect(await trpc.board.latestSignals.query({ projectId: WORKSPACE })).toEqual([]);
      expect(empty).toMatchObject({ project: { id: WORKSPACE }, tickets: [], labels: [] });
      const feed = recordSubscription((handlers) =>
        trpc.board.changes.subscribe({ projectId: WORKSPACE, lastEventId: empty.cursor }, handlers),
      );
      await feed.started;
      const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
      const created = await trpc.board.createTicket.mutate({
        commandId,
        projectId: WORKSPACE,
        status: "todo",
        title: "Over the wire",
        labels: ["remote"],
      });
      expect(created.receipt).toEqual({ commandId, status: "completed", replayed: false });
      expect(created.ticket).toMatchObject({ title: "Over the wire", labels: ["remote"] });
      // A retry of the same command answers its receipt and writes nothing.
      const retried = await trpc.board.createTicket.mutate({
        commandId,
        projectId: WORKSPACE,
        status: "todo",
        title: "Over the wire",
        labels: ["remote"],
      });
      expect(retried).toEqual({ ...created, receipt: { ...created.receipt, replayed: true } });
      expect((await trpc.board.roster.query({ projectId: WORKSPACE })).tickets).toHaveLength(1);
      // The same id for another intent is the Client's conflict.
      expect(
        await expectHostError(
          trpc.board.createTicket.mutate({
            commandId,
            projectId: WORKSPACE,
            status: "todo",
            title: "Something else",
          }),
        ),
      ).toMatchObject({ code: "CONFLICT", reason: "command-conflict" });
      // The feed carries the committed row, naming the command behind it.
      await vi.waitFor(() =>
        expect(
          feed.frames.flatMap((frame) => (frame as { data: { changes: unknown[] } }).data.changes),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "ticket",
              op: "upsert",
              id: created.ticket.id,
              commandId,
              ticket: expect.objectContaining({ title: "Over the wire" }),
            }),
            expect.objectContaining({ kind: "label", commandId }),
          ]),
        ),
      );
      // Another Workspace's board answers exactly as an absent one.
      expect(
        await expectHostError(trpc.board.snapshot.query({ projectId: OTHER_WORKSPACE })),
      ).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
      // So does every resource a write only refers to: a comment on this
      // Workspace's ticket linking another Workspace's Session, or a Session
      // that does not exist, is refused before anything is written.
      db.prepare(
        "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("foreign-session", OTHER_WORKSPACE, null, "Elsewhere", 1);
      for (const [sessionId, linkCommand] of [
        ["foreign-session", "7d444840-9dc0-4c2c-9bd1-0e3fdb6e6c7c"],
        ["no-such-session", "a3bb189e-8bf9-4888-9912-ace4e6543002"],
      ] as const) {
        expect(
          await expectHostError(
            trpc.board.createComment.mutate({
              commandId: linkCommand,
              ticketId: created.ticket.id,
              body: "Linked",
              sessionId,
            }),
          ),
        ).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
      }
      expect(await trpc.board.comments.query({ ticketId: created.ticket.id })).toEqual([]);
      // A cursor this feed never minted resnapshots instead of pretending to resume.
      const stale = recordSubscription((handlers) =>
        trpc.board.changes.subscribe(
          { projectId: WORKSPACE, lastEventId: "0:not-this-instance:4" },
          handlers,
        ),
      );
      expect(await stale.ended).toMatchObject({
        kind: "error",
        error: { code: "PRECONDITION_FAILED", reason: "subscription-resnapshot-required" },
      });
      feed.unsubscribe();
    } finally {
      await close();
      await host.stop("test over");
    }
  });

  it("serves nothing with the flag off, whatever --listen says, and says why", async () => {
    const log = logger();
    const host = await boot({ listen: LOOPBACK }, log);
    expect(host.status().hostProtocol).toBeNull();
    expect(readStatus(join(root, "data"))).toMatchObject({ hostProtocol: null });
    expect(log.warn).toHaveBeenCalledWith(
      "--listen is ignored: the host protocol needs VOLLI_EXPERIMENTAL=cloud",
      { listen: "127.0.0.1:0" },
    );
  });

  it("serves nothing with the flag on and no address", async () => {
    const host = await boot({ env: CLOUD });
    expect(host.status().hostProtocol).toBeNull();
  });

  it("listens on loopback with the flag on, names it in the status file, and refuses every credential", async () => {
    const log = logger();
    const host = await boot({ env: CLOUD, listen: LOOPBACK }, log);
    const listening = host.status().hostProtocol!;
    expect(listening).toMatchObject({ host: "127.0.0.1", url: `ws://127.0.0.1:${listening.port}` });
    expect(listening.port).toBeGreaterThan(0);
    expect(readStatus(join(root, "data"))).toMatchObject({ hostProtocol: listening });
    // No production verifier exists before VC-575/577 (D5).
    const { trpc, close } = client(listening.url);
    try {
      expect(await expectHostError(trpc.protocol.welcome.query())).toMatchObject({
        code: "UNAUTHORIZED",
        reason: "credential-invalid",
      });
    } finally {
      await close();
    }
    expect(log.info).toHaveBeenCalledWith(
      "host protocol: handshake-refused",
      expect.objectContaining({ reason: "credential-invalid" }),
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("device-token");
    await host.stop("test over");
    expect(readStatus(join(root, "data"))).toMatchObject({ state: "stopped", hostProtocol: null });
  });

  // VC-700's contract: a device enrolled over SSH (`volli-hostd enroll`) is
  // admitted by the verifier hostd composes, on a credential it signs.
  it("admits a device enrolled in its data directory, once per credential, until revoked", async () => {
    const host = await boot({ env: CLOUD, listen: LOOPBACK });
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    insertProject(host.host.database.db, { ...project(WORKSPACE), path: join(root, "workspace") });
    const dataDir = join(root, "data");
    const hostId = readStatus(dataDir) as { hostId: string };
    expect(hostId.hostId).toMatch(/^[0-9a-f-]{36}$/u);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = bytesToBase64Url(publicKey.export({ format: "der", type: "spki" }));
    const enrolled = await runEnroll(
      { kind: "enroll", mode: null, dataDir, publicKey: spki, name: "Test Mac" },
      {
        uid: () => process.getuid!(),
        layouts: { system: { dataDir: join(root, "system-data") } } as never,
        probes: LIVE_PROBES,
        version: "9.9.9-test",
        now: () => new Date(),
        newId: randomUUID,
        trustedOwnerUid: 0,
      },
    );
    expect(enrolled).toMatchObject({ ok: true, hostId: hostId.hostId, created: true });
    const credential = (jti: string, workspaceId = WORKSPACE): string => {
      const iat = Math.floor(Date.now() / 1000);
      const input = deviceCredentialSigningInput({
        hostId: hostId.hostId,
        deviceId: enrolled.deviceId,
        workspaceId,
        iat,
        exp: iat + 60,
        jti,
      });
      const signature = sign("sha256", Buffer.from(input), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      });
      return assembleDeviceCredential(input, signature);
    };
    const url = host.status().hostProtocol!.url;
    const once = credential("first-credential-jti-0001");
    const accepted = client(url, once);
    try {
      expect(await accepted.trpc.protocol.welcome.query()).toMatchObject({
        host: { id: hostId.hostId },
        actor: { kind: "device", deviceId: enrolled.deviceId, workspaceId: WORKSPACE },
      });
    } finally {
      await accepted.close();
    }
    for (const refusedCredential of [once, credential("other-workspace-jti-0001", DEVICE)]) {
      const replayed = client(url, refusedCredential);
      try {
        expect(await expectHostError(replayed.trpc.protocol.welcome.query())).toMatchObject({
          reason: "credential-invalid",
        });
      } finally {
        await replayed.close();
      }
    }
    // Revocation is the entry's: the next handshake is refused.
    const file = join(dataDir, "enrolled-devices.json");
    const store = JSON.parse(readFileSync(file, "utf8")) as {
      devices: { revokedAt: string | null }[];
    };
    store.devices[0]!.revokedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(store));
    const revoked = client(url, credential("after-revocation-jti-001"));
    try {
      expect(await expectHostError(revoked.trpc.protocol.welcome.query())).toMatchObject({
        reason: "credential-invalid",
      });
    } finally {
      await revoked.close();
    }
  });

  it("serves the Session router from the headless runtime to a verified device", async () => {
    const lever = device();
    const log = logger();
    const host = await boot(
      { env: CLOUD, listen: LOOPBACK, hostProtocolVerifier: lever.verifier },
      log,
    );
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    const { db } = host.host.database;
    insertProject(db, { ...project(WORKSPACE), path: join(root, "workspace") });
    db.prepare(
      "INSERT INTO workspace_epochs (workspace_id, epoch, host_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(WORKSPACE, 3, DEVICE, 1);
    const created = await host.host.sessionEngine.createSession({
      commandId: "create-1",
      projectId: WORKSPACE,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Over the wire",
      provenance: { source: { kind: "user", id: "test", detail: null }, venue: null },
    });
    const sessionId = created.session.id;
    const { trpc, close } = client(host.status().hostProtocol!.url);
    try {
      const welcome = await trpc.protocol.welcome.query();
      expect(welcome).toMatchObject({
        workspace: { id: WORKSPACE, epoch: 3 },
        features: [
          "sessions",
          "sessions.queue",
          "sessions.subscribe",
          "sessions.history",
          "session.read",
          "board.read",
          "board.write",
          "sign-ins",
          "auth.callback",
        ],
      });
      // The socket's own handler, scoped to this Workspace.
      const listed = await trpc.session.list.query({ projectId: WORKSPACE, all: true });
      expect(listed.sessions.map((row) => row["id"])).toEqual([sessionId.slice(0, 8)]);
      expect(
        await expectHostError(
          trpc.session.show.query({ projectId: WORKSPACE, session: "ffffffff" }),
        ),
      ).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
      expect((await trpc.session.projection.query({ sessionId })).projection.session?.title).toBe(
        "Over the wire",
      );
      expect(
        await expectHostError(trpc.session.projection.query({ sessionId: "no-such-session" })),
      ).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
      // The window and the history above it (VC-315): a young Session's
      // window reaches its first event, so it names no cursor above it, and
      // a page below its first event is empty.
      const opened = await trpc.session.snapshot.query({ sessionId });
      expect(opened).not.toHaveProperty("before");
      expect(await trpc.session.history.query({ sessionId, before: 1 })).toEqual({
        frames: [],
        before: null,
      });
      // The create door is the Sessions facade's; with no model it says so.
      expect(
        await expectHostError(
          trpc.sessions.create.mutate({
            operationId: "op-1",
            projectId: WORKSPACE,
            ticketId: null,
            title: null,
          }),
        ),
      ).not.toMatchObject({ reason: "operation-unavailable" });
      // Revoked mid-stream: the stream hears why, and the host says so.
      const stream = recordSubscription((handlers) =>
        trpc.session.subscribe.subscribe({ sessionId }, handlers),
      );
      await stream.started;
      lever.revoke();
      expect(await stream.ended).toMatchObject({
        kind: "error",
        error: { code: "UNAUTHORIZED", reason: "credential-invalid" },
      });
      expect(log.warn).toHaveBeenCalledWith(
        "host protocol: revoked",
        expect.objectContaining({ streams: 1 }),
      );
      // Every handler the WebSocket reached, it reached through the router's
      // policy at the host's one map (VC-668): none without it.
      const reached = faults.admissions.filter(({ door }) => door === "router");
      expect(reached.map(({ key }) => key)).toEqual(
        expect.arrayContaining([
          "session.list",
          "session.show",
          "session.projection",
          "session.snapshot",
          "session.history",
          "sessions.create",
          "session.subscribe",
        ]),
      );
      expect(reached.every(({ admitted }) => admitted)).toBe(true);
    } finally {
      await close();
    }
  });

  it("keeps the sign-ins a device sends in the host's own stores, and never logs one (VC-702)", async () => {
    const API_KEY = "sk-ant-api03-SENT-OVER-THE-HOST-LINK-0123456789";
    const GIT_TOKEN = "ghp_SENTOVERTHEHOSTLINK0123456789ab";
    const lever = device();
    const log = logger();
    const host = await boot(
      { env: CLOUD, listen: LOOPBACK, hostProtocolVerifier: lever.verifier },
      log,
    );
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    insertProject(host.host.database.db, { ...project(WORKSPACE), path: join(root, "workspace") });
    const { trpc, close } = client(host.status().hostProtocol!.url);
    try {
      const keyed = await trpc.signIns.setApiKey.mutate({ providerId: "anthropic", key: API_KEY });
      expect(keyed.providers.find((row) => row.providerId === "anthropic")).toMatchObject({
        state: "signed-in",
        kind: "api-key",
      });
      const pushed = await trpc.signIns.setGitCredential.mutate({
        host: "github.com",
        username: "x-access-token",
        password: GIT_TOKEN,
      });
      expect(pushed.git).toEqual([{ host: "github.com", state: "signed-in", kind: "git" }]);
      // Into Pi's own auth storage for the service account, and the push
      // store under the data directory: each the service user's alone.
      const auth = join(root, "pi", "auth.json");
      expect(JSON.parse(readFileSync(auth, "utf8"))).toMatchObject({
        anthropic: { type: "api_key", key: API_KEY },
      });
      const pushStore = join(root, "data", "credentials", "git-push.json");
      expect(statSync(pushStore).mode & 0o777).toBe(0o600);
      expect(statSync(auth).mode & 0o077).toBe(0);
      // No flow on another connection is this one's to see.
      expect(
        await expectHostError(trpc.signIns.cancel.mutate({ flowId: "not-mine" })),
      ).toMatchObject({ code: "NOT_FOUND", reason: "sign-in-unknown" });
      const wire = JSON.stringify([keyed, pushed, await trpc.signIns.status.query()]);
      expect(wire).not.toContain(API_KEY);
      expect(wire).not.toContain(GIT_TOKEN);
    } finally {
      await close();
    }
    const logged = JSON.stringify([
      log.debug.mock.calls,
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
    ]);
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(GIT_TOKEN);
  });

  it("writes the Client's trace on every line it logs for a request, joined to the Session and command (VC-699)", async () => {
    const lines: Record<string, unknown>[] = [];
    const logRing = createLogRing();
    const undo = installHostLog({
      level: "debug",
      sink: teeSinks(
        jsonLineSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>)),
        logRing,
      ),
    });
    const lever = device();
    try {
      const host = await boot({
        env: CLOUD,
        listen: LOOPBACK,
        hostProtocolVerifier: lever.verifier,
        logRing,
      });
      if (!isLiveHost(host.host)) throw new Error("database did not open");
      const { db } = host.host.database;
      insertProject(db, { ...project(WORKSPACE), path: join(root, "workspace") });
      const created = await host.host.sessionEngine.createSession({
        commandId: "create-trace",
        projectId: WORKSPACE,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        provenance: { source: { kind: "user", id: "test", detail: null }, venue: null },
      });
      const sessionId = created.session.id;
      const flow = mintHostTrace();
      const link = createHostLink({
        url: host.status().hostProtocol!.url,
        workspaceId: WORKSPACE,
        client: { kind: "desktop", version: "test" },
        features: ["sessions", "host.logs"],
        credential: () => "device-token",
        traceId: flow.traceId,
      });
      try {
        await new Promise<void>((resolve) => {
          const stop = link.subscribeState((state) => {
            if (state.status === "ready") {
              stop();
              resolve();
            }
          });
        });
        lines.length = 0;
        const commandId = "0b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d";
        await link.mutate("session.command", {
          sessionId,
          commandId,
          command: {
            kind: "model.select",
            selection: {
              providerId: "anthropic",
              modelId: "claude-sonnet-4",
              reasoningLevel: "medium",
            },
          },
        });
        const traced = lines.filter((line) => line["traceId"] === flow.traceId);
        // The door's line, and the Session's committed facts, all under the Client's trace.
        expect(traced.map(({ component, msg }) => `${String(component)}: ${String(msg)}`)).toEqual(
          expect.arrayContaining([
            "rpc: rpc call",
            "session: session command.recorded",
            "session: session model.selected",
            "session: session command.receipt.recorded",
            "rpc: rpc call answered",
          ]),
        );
        const session = traced.filter(({ component }) => component === "session");
        for (const line of session) {
          expect(line).toMatchObject({
            sessionId,
            commandId,
            door: "websocket",
            operation: "session.command",
          });
          expect(line["connection"]).toEqual(expect.any(String));
          expect(line["spanId"]).toMatch(/^[0-9a-f]{16}$/u);
        }
        expect(JSON.stringify(lines)).not.toContain("device-token");
        // The same lines, read back over the host protocol (host.logs): no SSH.
        const page = (await link.query("logs.tail", { limit: 500 })) as {
          entries: { record: Record<string, unknown> }[];
        };
        expect(
          page.entries
            .filter(({ record }) => record["traceId"] === flow.traceId)
            .map(({ record }) => record["msg"]),
        ).toEqual(expect.arrayContaining(["session command.recorded", "rpc call answered"]));
      } finally {
        link.close();
      }
    } finally {
      undo();
    }
  });

  it("answers create as unavailable when the host's map has no Sessions facade", async () => {
    faults.noSessionsFacade = true;
    const lever = device();
    const host = await boot({ env: CLOUD, listen: LOOPBACK, hostProtocolVerifier: lever.verifier });
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    const url = host.status().hostProtocol!.url;
    // A Workspace is a project this host has; before it does, the hello is refused.
    const early = client(url);
    try {
      expect(await expectHostError(early.trpc.protocol.welcome.query())).toMatchObject({
        code: "NOT_FOUND",
        reason: "workspace-unknown",
      });
    } finally {
      await early.close();
    }
    insertProject(host.host.database.db, { ...project(WORKSPACE), path: join(root, "workspace") });
    const { trpc, close } = client(url);
    try {
      expect((await trpc.protocol.welcome.query()).workspace.epoch).toBe(0);
      expect(
        await expectHostError(
          trpc.sessions.create.mutate({
            operationId: "op",
            projectId: WORKSPACE,
            ticketId: null,
            title: null,
          }),
        ),
      ).toMatchObject({ reason: "operation-unavailable" });
    } finally {
      await close();
    }
  });

  // S-B1: on a system install the listener admits root's devices only.
  it("admits a system install's devices from root's store, never from the data directory", async () => {
    const etc = join(root, "etc");
    mkdirSync(etc, { mode: 0o755 });
    chmodSync(etc, 0o755);
    const devicesFile = join(etc, "volli-hostd-devices");
    const log = logger();
    const host = await boot({ env: CLOUD, listen: LOOPBACK, devicesFile }, log);
    if (!isLiveHost(host.host)) throw new Error("database did not open");
    insertProject(host.host.database.db, { ...project(WORKSPACE), path: join(root, "workspace") });
    const hostId = host.status().hostId!;
    const mint = { now: () => new Date(), newId: randomUUID };
    const signed = (privateKey: ReturnType<typeof deviceKey>["privateKey"], deviceId: string) => {
      const iat = Math.floor(Date.now() / 1000);
      const input = deviceCredentialSigningInput({
        hostId,
        deviceId,
        workspaceId: WORKSPACE,
        iat,
        exp: iat + 60,
        jti: randomUUID().replaceAll("-", ""),
      });
      return assembleDeviceCredential(
        input,
        sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }),
      );
    };
    // What an agent running as the service account could do: write the data directory.
    const agent = deviceKey();
    const planted = enrollDevice(
      dataDirDeviceStore(join(root, "data")),
      { publicKey: agent.spki, name: "Alice's Mac", via: "ssh" },
      mint,
    ).device;
    const url = host.status().hostProtocol!.url;
    const impostor = client(url, signed(agent.privateKey, planted.deviceId));
    try {
      expect(await expectHostError(impostor.trpc.protocol.welcome.query())).toMatchObject({
        reason: "credential-invalid",
      });
    } finally {
      await impostor.close();
    }
    // What root enrolled.
    const person = deviceKey();
    const enrolled = enrollDevice(
      rootDeviceStore(devicesFile, process.getuid!()),
      { publicKey: person.spki, name: "Alice's Mac", via: "ssh" },
      mint,
    ).device;
    const admitted = client(url, signed(person.privateKey, enrolled.deviceId));
    try {
      expect(await admitted.trpc.protocol.welcome.query()).toMatchObject({
        actor: { kind: "device", deviceId: enrolled.deviceId },
      });
    } finally {
      await admitted.close();
    }
    // A store that turns writable by others admits no one, and says why.
    chmodSync(devicesFile, 0o666);
    const unsafe = client(url, signed(person.privateKey, enrolled.deviceId));
    try {
      expect(await expectHostError(unsafe.trpc.protocol.welcome.query())).toMatchObject({
        reason: "credential-invalid",
      });
    } finally {
      await unsafe.close();
    }
    expect(log.error).toHaveBeenCalledWith(
      "host protocol: the enrolled-devices store admits no one",
      expect.objectContaining({ problem: "untrusted" }),
    );
  });

  it("refuses to boot on a devices file the service account could write", async () => {
    const etc = join(root, "etc");
    mkdirSync(etc, { mode: 0o755 });
    chmodSync(etc, 0o755);
    const devicesFile = join(etc, "volli-hostd-devices");
    writeFileSync(devicesFile, '{"v":1,"devices":[]}\n', { mode: 0o666 });
    chmodSync(devicesFile, 0o666);
    const error = await refused({ env: CLOUD, listen: LOOPBACK, devicesFile });
    expect(error.reason).toBe("devices");
    expect(error.message).toMatch(/can be written by its group or other users/u);
    // The flag off, nothing listens and the file is not judged: as before.
    await boot({ dataDir: join(root, "flag-off"), listen: LOOPBACK, devicesFile });
  });

  // B9: while this verifier is hostd's, its own bounds are the budget.
  it("composes the listener with hostd's limits: 32 connections, the 33rd refused", async () => {
    const log = logger();
    const host = await boot({ env: CLOUD, listen: LOOPBACK }, log);
    const { port } = host.status().hostProtocol!;
    const sockets: ReturnType<typeof createConnection>[] = [];
    const answers: { text: string }[] = [];
    try {
      for (let index = 0; index < HOSTD_LISTENER_LIMITS.maxConnections + 1; index += 1) {
        const socket = createConnection({ host: "127.0.0.1", port });
        const answer = { text: "" };
        sockets.push(socket);
        answers.push(answer);
        socket.on("data", (chunk) => (answer.text += chunk.toString()));
        socket.on("error", () => undefined);
        await new Promise((resolve) => socket.once("connect", resolve));
      }
      // The 33rd is refused; the defaults (128 connections, a burst of 64) would take it.
      await vi.waitFor(() => expect(answers.at(-1)!.text).toMatch(/^HTTP\/1\.1 503/u));
      expect(answers.slice(0, -1).every((answer) => answer.text === "")).toBe(true);
      expect(log.warn).toHaveBeenCalledWith("host protocol: connection-refused", {
        reason: "connection-limit",
      });
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  // B9: a device admitted here acts as the person; never off the box until VC-575.
  it("refuses to serve the enrolled-device verifier on any non-loopback address", async () => {
    for (const address of ["0.0.0.0", "192.168.1.5", "localhost", "::"]) {
      const error = await refused({
        dataDir: join(root, `bind-${address.replaceAll(/[^a-z0-9]/gu, "_")}`),
        env: CLOUD,
        listen: { host: address, port: 0 },
      });
      expect(error.reason).toBe("host-protocol");
      expect(error.message).toMatch(/loopback address only until VC-575; refusing/u);
    }
  });

  it("refuses to boot when it cannot listen where it was told", async () => {
    const first = await boot({ env: CLOUD, listen: LOOPBACK });
    const taken = first.status().hostProtocol!;
    const error = await refused({
      dataDir: join(root, "second"),
      env: CLOUD,
      listen: { host: "127.0.0.1", port: taken.port },
    });
    expect(error.reason).toBe("host-protocol");
    expect(error.fields).toEqual({ listen: `127.0.0.1:${taken.port}` });
  });
});
