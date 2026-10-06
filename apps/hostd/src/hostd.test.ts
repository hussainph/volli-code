/**
 * hostd's boot and shutdown, in-process, against real data directories, the
 * real host-core and the real agent socket. CI's artifact job drives the
 * built binary the same way from outside (README.md, "CI").
 */
import { createHash } from "node:crypto";
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
  buildHostHello,
  encodeHostHello,
  HOST_V1_FEATURES,
  type HostCredentialVerifier,
} from "@volli/host-protocol";
import { expectHostError, recordSubscription } from "@volli/host-protocol/testing";
import type { AppRouter } from "@volli/session-rpc";

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
import { readStatus, statusFilePath, type HostdState } from "./status";

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

async function boot(
  options: {
    dataDir?: string;
    socketPath?: string;
    env?: Record<string, string>;
    drainTimeoutMs?: number;
    /** Leaves the owner to hostd's own default, root. */
    rootOwnsOperators?: boolean;
    listen?: HostdOptions["listen"];
    hostProtocolVerifier?: HostdOptions["hostProtocolVerifier"];
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
    ...(options.hostProtocolVerifier === undefined
      ? {}
      : { hostProtocolVerifier: options.hostProtocolVerifier }),
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
    expect(log.error).not.toHaveBeenCalledWith(
      expect.stringContaining("host shutdown failed"),
      expect.anything(),
    );
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
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("host shutdown failed at close-database:"),
      { source: "host-core" },
    );
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
  expect(log.error).toHaveBeenCalledWith(
    expect.stringContaining("host shutdown failed at close-runtime: Error: runtime close failed"),
    { source: "host-core" },
  );
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
  expect(log.error).toHaveBeenCalledWith(
    expect.stringContaining("host shutdown failed at close-runtime: Error: runtime close failed"),
    { source: "host-core" },
  );
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
    const trpc = createTRPCClient<AppRouter>({ links: [wsLink({ client: socket })] });
    return { trpc, close: () => socket.close() };
  }

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
        features: ["sessions", "sessions.subscribe", "session.read"],
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
          "sessions.create",
          "session.subscribe",
        ]),
      );
      expect(reached.every(({ admitted }) => admitted)).toBe(true);
    } finally {
      await close();
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
