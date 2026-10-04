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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import Database from "better-sqlite3";
import type { AgentRequest, AgentResponse, Project } from "@volli/shared";
import { insertProject } from "@volli/host-core/db/projects-repo";
import { SCHEMA_HEAD } from "@volli/host-core/db/migrations";
import { MIN_READER_VERSION_KEY } from "@volli/host-core/db/schema-compatibility";
import { SECRET_KEY_FILE_ENV } from "@volli/host-core/secrets";

import { HostdBootError } from "./boot-error";
import type { HostdLogger } from "./log";
import { startHostd, type RunningHostd } from "./hostd";
import { readStatus, statusFilePath, type HostdState } from "./status";

/** Faults a test can switch on in the modules hostd composes. */
const faults = vi.hoisted(() => ({
  failStatusOn: null as string | null,
  socketCloseFails: false,
  /** When set, every command waits on it before it runs. */
  hold: null as Promise<void> | null,
  /** The execute hostd handed the socket, to call without a connection. */
  execute: null as ((request: AgentRequest) => Promise<AgentResponse>) | null,
}));

vi.mock("@volli/host-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@volli/host-core")>();
  return {
    ...actual,
    createHostCore: (...args: Parameters<typeof actual.createHostCore>) => {
      const host = actual.createHostCore(...args);
      const createCommands: typeof host.agentServices.createCommands = (options) => {
        const commands = host.agentServices.createCommands(options);
        return {
          execute: async (request) => {
            if (faults.hold !== null) await faults.hold;
            return commands.execute(request);
          },
        };
      };
      return { ...host, agentServices: { ...host.agentServices, createCommands } };
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

vi.mock("@volli/host-core/agent-socket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@volli/host-core/agent-socket")>();
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
          await server.close();
          if (faults.socketCloseFails) throw new Error("close failed");
        },
      });
      return failing(await actual.startAgentSocket(options, (server) => claim(failing(server))));
    },
  };
});

let root: string;
const running: RunningHostd[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-"));
});

afterEach(async () => {
  faults.failStatusOn = null;
  faults.socketCloseFails = false;
  faults.hold = null;
  faults.execute = null;
  await Promise.all(running.splice(0).map((host) => host.stop("test over")));
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
  } = {},
  log = logger(),
): Promise<RunningHostd> {
  const dataDir = options.dataDir ?? join(root, "data");
  const host = await startHostd({
    dataDir,
    socketPath: options.socketPath ?? join(dataDir, "volli.sock"),
    version: "9.9.9-test",
    env: options.env ?? {},
    logger: log,
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
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
function ask(socketPath: string, cmd: string, args: object = {}): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (body += chunk));
    socket.on("end", () => resolve(JSON.parse(body) as AgentResponse));
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.end(`${JSON.stringify({ v: 1, cmd, args, ctx: { cwd: root, env: {} } })}\n`),
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
        sessions: "unavailable",
        terminals: "unavailable",
        browser: "unavailable",
        automations: "unavailable",
      },
    });
    expect(readStatus(dataDir)).toMatchObject({ state: "serving", socketPath });
    expect(host.secrets.key).toBe("absent");
    expect(log.info).toHaveBeenCalledWith("serving", expect.objectContaining({ socketPath }));

    expect(await ask(socketPath, "project.list")).toMatchObject({
      ok: true,
      data: { projects: [] },
    });
    if (!host.host.database.ok) throw new Error("database did not open");
    insertProject(host.host.database.db, project("p1"));
    expect(await ask(socketPath, "project.list")).toMatchObject({
      ok: true,
      data: {
        projects: [expect.objectContaining({ name: "Fixture p1", prefix: "FX", tickets: 0 })],
      },
    });
    // Board writes need an authenticated Session; hostd has no runtime to mint one.
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
    if (!first.host.database.ok) throw new Error("database did not open");
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

  it("refuses a bad secret key before it opens the socket or the database", async () => {
    const error = await refused({ env: { [SECRET_KEY_FILE_ENV]: "relative.key" } });
    expect(error.reason).toBe("secret-key");
    expect(existsSync(join(root, "data", "volli.sock"))).toBe(false);
    expect(existsSync(join(root, "data", "volli.db"))).toBe(false);
    // The refusal let go of the instance lock.
    expect((await boot()).status().state).toBe("serving");
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
    const stopped = host.stop("SIGTERM");
    setTimeout(release, 20);
    expect(await answer).toMatchObject({ ok: true, data: { projects: [] } });
    expect(await stopped).toBe(true);
  });

  it("abandons one that outlives the drain, and says the stop was not clean", async () => {
    const log = logger();
    const host = await boot({ drainTimeoutMs: 10 }, log);
    faults.hold = new Promise(() => undefined);
    void faults.execute!(request);
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

  it("reports a socket that did not close cleanly, and a database that did not either", async () => {
    const log = logger();
    const host = await boot({}, log);
    faults.socketCloseFails = true;
    if (!host.host.database.ok) throw new Error("database did not open");
    host.host.database.db.close();
    expect(await host.stop("SIGTERM")).toBe(false);
    expect(log.error).toHaveBeenCalledWith("agent socket did not close cleanly", {
      error: expect.any(Error),
    });
    expect(log.error).toHaveBeenCalledWith("database did not close cleanly", {
      error: expect.any(Error),
    });
  });
});
