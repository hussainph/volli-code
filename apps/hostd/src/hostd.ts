/**
 * hostd's composition root: `createHostCore` with headless ports, the agent
 * socket, and the health file. `main.ts` adds the process (argv, signals,
 * exit codes); this module is everything a test can drive in-process.
 *
 * BOOT, in order. Each step that can fail for an operator's reason throws a
 * {@link HostdBootError} before anything is served:
 *
 * 1. **Data directory.** Created 0700 when absent. Refused when it is not a
 *    directory, another user owns it, or every user can write it: any of them
 *    could then rename the key or the database out from under the host.
 *    Group-writable is a warning (user private groups make that group this
 *    user alone), as is a `--socket` in a world-writable directory.
 * 2. **Another host.** Refused when another process holds the data
 *    directory's instance lock (`instance-lock.ts`), whatever its `--socket`:
 *    two hosts must never open one database. The lock is held until stop.
 * 3. **Secrets, eagerly** (`secrets.ts`). Never a refusal (VC-641): a lost,
 *    wrong or unsafe key, or a damaged store, boots with credentials
 *    `locked`, `refused` or `corrupt` in the status file.
 * 4. **The agent socket**, before the database, so a CLI request during
 *    migrations waits for boot rather than being refused at connect. A live
 *    listener on the same path refuses this host.
 * 5. **host-core.** Opens and migrates the database with
 *    `throwTransactionViolation` (VC-551: nobody watches a server's log while
 *    a bug corrupts a transaction). A database that will not open, including
 *    one from a newer Volli (VC-602), is not a boot failure: the host stays
 *    up, `refusing`, every verb answers `DB_UNAVAILABLE` with the reason, and
 *    the status file carries the typed `databaseFailure`.
 *
 * 6. **Start.** `host.start` runs once and owns serving: Session recovery,
 *    the commands every verb answers through, the status, and then the
 *    maintenance loops (retention and the opt-in automatic reap).
 *
 * SHUTDOWN is host-core's `host.stop` (VC-627), for a normal stop and a
 * failed boot alike: mark stopping; stop the Automation producers and the
 * maintenance loops; drain the Session runtime and its shells; then, in
 * hostd's sequential order, close the socket and join outstanding requests;
 * drain detached work (a Done move's trim); stop the activity watch;
 * checkpoint and close SQLite. hostd then releases the instance lock and
 * marks stopped. Runtime resources never outlive the database. Terminals and
 * the browser are not composed, and there is no periodic backup.
 */
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { makeAgentError, type AgentRequest, type AgentResponse } from "@volli/shared";
import {
  createHostCore,
  isLiveHost,
  throwTransactionViolation,
  type HostCore,
  type HostCorePorts,
} from "@volli/host-core";
import {
  createAgentSocketLifecycle,
  startAgentSocket,
  createHostAgentCommands,
} from "@volli/host-core/agents";
import type Database from "better-sqlite3";

import type { HostCredentialVerifier } from "@volli/host-protocol";
import type { HostProtocolListener } from "@volli/session-rpc/websocket";

import {
  createEnrolledDeviceVerifier,
  dataDirDeviceStore,
  readDeviceStore,
  rootDeviceStore,
  type DeviceStore,
} from "./enrolled-devices";
import {
  cloudEnabled,
  hostdBoardFeed,
  startHostdProtocolListener,
  type HostProtocolBind,
} from "./host-protocol";
import { shellWord } from "@volli/host-core/session-runtime";
import {
  createHeadlessSessionRuntime,
  headlessModelAccess,
  type HeadlessRuntimeOptions,
  type HeadlessSessionRuntime,
} from "./session-runtime";
import { HostdBootError } from "./boot-error";
import { acquireInstanceLock } from "./instance-lock";
import type { LogRing } from "@volli/host-core/log";
import type { HostdLogger } from "./log";
import { openOperators } from "./operators";
import { headlessPorts } from "./ports";
import { hostdVenue } from "./venue";
import { logCredentials, openHeadlessSecrets, type HeadlessSecrets } from "./secrets";
import {
  writeStatus,
  type HostdCapabilities,
  type HostdDatabaseStatus,
  type HostdHostProtocolStatus,
  type HostdState,
  type HostdStatus,
} from "./status";

export interface HostdOptions {
  readonly dataDir: string;
  readonly socketPath: string;
  readonly version: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: HostdLogger;
  /**
   * The listening socket systemd bound (`activation.ts`, VC-623). Present, it
   * is served and `socketPath` only names it; absent, hostd binds
   * `socketPath` itself at mode 0600.
   */
  readonly listenFd?: number;
  /**
   * The root-owned operator verifier file (VC-623, `operators.ts`);
   * `--operators`, defaulting to `DEFAULT_OPERATORS_FILE`. A missing file
   * means no operator token is accepted.
   */
  readonly operatorsFile: string;
  /**
   * Who must own the operators file: root. A test seam only, never an argument
   * or a variable — whoever owns that file can mint a person.
   */
  readonly operatorsOwnerUid?: number;
  /**
   * `--listen`: where the host protocol's WebSocket listens (VC-663), served
   * only with the `cloud` flag on (`VOLLI_EXPERIMENTAL=cloud`). Loopback
   * only until VC-575. Absent or `null`: no listener.
   */
  readonly listen?: HostProtocolBind | null;
  /**
   * `--devices`: the root-owned enrolled-devices file a system install's
   * listener admits from (VC-700, `/etc/volli-hostd-devices`), judged as the
   * operators file is and owned by `operatorsOwnerUid` (root). Absent or `null`:
   * the data directory's own `enrolled-devices.json`, as a user install has.
   */
  readonly devicesFile?: string | null;
  /**
   * The host protocol's credential verifier. A test seam only, never an
   * argument or a variable: production composes the enrolled-device
   * verifier (VC-700, `enrolled-devices.ts`), which admits only enrolled
   * devices and so refuses every handshake until one is.
   */
  readonly hostProtocolVerifier?: HostCredentialVerifier;
  readonly runtime?: HeadlessRuntimeOptions;
  /**
   * Volli's git credential helper command (VC-702). A test seam: by default
   * it is this very program, `git-credential --data-dir <dir>`. Installed in
   * every Session command's environment only with the `cloud` flag on.
   */
  readonly gitCredentialHelper?: string;
  /**
   * The host's recent log (VC-699): the ring `main.ts` tees beside stdout.
   * Present, the handler map reads it and the listener offers `host.logs`.
   */
  readonly logRing?: LogRing;
  readonly now?: () => Date;
  /**
   * How long a stop waits, after the socket has closed, for requests still
   * executing. Past it they are abandoned and the stop is not clean.
   */
  readonly drainTimeoutMs?: number;
}

/** The default {@link HostdOptions.drainTimeoutMs}. */
export const DRAIN_TIMEOUT_MS = 10_000;

export interface RunningHostd {
  readonly host: HostCore;
  readonly secrets: HeadlessSecrets;
  status(): HostdStatus;
  /**
   * Stops serving and closes the database. Idempotent: every call answers the
   * first one's promise. Resolves `true` when everything closed cleanly.
   */
  stop(reason: string): Promise<boolean>;
}

type Execute = (request: AgentRequest) => Promise<AgentResponse>;

const UNAVAILABLE: HostdCapabilities = {
  board: "unavailable",
  sessions: "unavailable",
  terminals: "unavailable",
  browser: "unavailable",
  automations: "unavailable",
};

export async function startHostd(options: HostdOptions): Promise<RunningHostd> {
  const { dataDir, socketPath, logger } = options;
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  let state: HostdState = "starting";
  let database: HostdDatabaseStatus | null = null;
  let capabilities = UNAVAILABLE;
  let credentials: HostdStatus["credentials"] = null;
  let hostProtocol: HostdHostProtocolStatus | null = null;
  let hostId: string | null = null;
  const snapshot = (): HostdStatus => ({
    v: 1,
    state,
    pid: process.pid,
    version: options.version,
    startedAt,
    updatedAt: now().toISOString(),
    dataDir,
    socketPath,
    database,
    capabilities,
    credentials,
    hostProtocol,
    hostId,
  });
  const publish = (next: HostdState): void => {
    state = next;
    writeStatus(dataDir, snapshot());
  };

  logger.info("starting", { version: options.version, dataDir, socketPath, pid: process.pid });
  // The host protocol is behind the `cloud` flag: an address alone opens nothing.
  const listen = options.listen ?? null;
  const cloud = cloudEnabled(options.env);
  if (listen !== null && !cloud) {
    logger.warn("--listen is ignored: the host protocol needs VOLLI_EXPERIMENTAL=cloud", {
      listen: `${listen.host}:${listen.port}`,
    });
  }
  prepareDataDir(dataDir, logger);
  warnOfSharedSocketDir(socketPath, dataDir, logger);
  const lock = acquireInstanceLock(dataDir);
  try {
    return await boot();
  } catch (error) {
    lock.release();
    throw error;
  }

  async function boot(): Promise<RunningHostd> {
    const secrets = openHeadlessSecrets(dataDir, options.env);
    credentials = secrets.status;
    logCredentials(secrets, logger);
    // The person's credential (VC-623): judged now, so an operators file the
    // service account could write refuses boot rather than minting people.
    // Root, who alone may write who is a person here (operators, devices).
    const trustedOwnerUid = options.operatorsOwnerUid ?? 0;
    const operators = openOperators({
      path: options.operatorsFile,
      trustedOwnerUid,
      processUid: process.getuid!(),
      logger,
    });
    // Who the listener admits (VC-700): judged now too, so a system store
    // the service account could write refuses boot rather than minting people.
    const deviceStore =
      cloud && listen !== null
        ? openDeviceStore(dataDir, options.devicesFile ?? null, trustedOwnerUid)
        : null;

    // Every execution the socket accepted, until it settles. The socket's own
    // close stops waiting at its request timeout; the stop below waits for
    // these before it closes the database.
    const inflight = new Set<Promise<AgentResponse>>();
    const track = (run: Promise<AgentResponse>): Promise<AgentResponse> => {
      inflight.add(run);
      const forget = (): void => {
        inflight.delete(run);
      };
      run.then(forget, forget);
      return run;
    };
    // The socket opens before the database, so a request can arrive while
    // migrations run. It waits for boot to settle on its answer, bounded by
    // the socket's own 10 s request timeout.
    let settle!: (execute: Execute) => void;
    const ready = new Promise<Execute>((resolve) => {
      settle = resolve;
    });
    let socketCloseFailed = false;
    const socket = createAgentSocketLifecycle({
      start: startAgentSocket,
      // A socket that did not close is an unclean stop: the exit must say so,
      // so systemd's Restart=on-failure acts on it.
      reportFailure: (error) => {
        socketCloseFailed = true;
        logger.error("agent socket did not close cleanly", { error });
      },
    });
    try {
      await socket.start({
        socketPath,
        listenFd: options.listenFd,
        execute: (request) =>
          track(
            ready.then((execute) =>
              state === "stopping" || state === "stopped"
                ? {
                    v: 1,
                    ok: false,
                    error: makeAgentError("APP_UNREACHABLE", "The host is stopping."),
                  }
                : execute(request),
            ),
          ),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw code === "EADDRINUSE"
        ? new HostdBootError(
            "already-running",
            `Another process is serving the agent socket ${socketPath}.`,
            { socketPath },
          )
        : new HostdBootError(
            "socket",
            `Could not open the agent socket ${socketPath}: ${(error as Error).message}`,
            { socketPath, code },
          );
    }

    const runtimeOptions: HeadlessRuntimeOptions = options.runtime ?? {
      binDir: dirname(process.execPath),
      venue: { id: socketPath, kind: "remote" },
    };
    let sessionRuntime: HeadlessSessionRuntime | undefined;
    let listener: HostProtocolListener | undefined;
    /**
     * The board's change feeds (VC-565), one per Workspace this host serves:
     * its handlers stamp their rows, and the bus feeds it every other
     * writer's `data-changed`. The database is read once it is open.
     */
    let boardDb: Database.Database | undefined;
    const boardFeed = hostdBoardFeed(() => boardDb);

    /** Settles what every verb answers with, and publishes the state that goes with it. */
    const serve = async (host: HostCore, ports: HostCorePorts): Promise<void> => {
      if (isLiveHost(host)) {
        database = { ok: true, path: host.dbPath };
        const venue = hostdVenue(host.database.db);
        boardDb = host.database.db;
        hostId = venue.id;
        sessionRuntime = createHeadlessSessionRuntime({
          host,
          ports,
          boardFeed,
          secrets,
          env: options.env,
          version: options.version,
          socketPath,
          // An address locates this host; only its persisted identity names
          // ownership. Override packaged/source runtime path metadata alike.
          options: {
            ...runtimeOptions,
            venue,
            gitCredentialHelper: cloud
              ? (options.gitCredentialHelper ?? defaultGitCredentialHelper(dataDir))
              : null,
          },
          logs: options.logRing ?? null,
        });
        const { handlers, automationsAvailable, serveSessionReads, ...sessionPorts } =
          await sessionRuntime.ready();
        capabilities = {
          ...UNAVAILABLE,
          board: "available",
          sessions: "available",
          automations: automationsAvailable ? "available" : "unavailable",
        };
        const commands = createHostAgentCommands(ports, {
          db: host.database.db,
          ...sessionPorts,
          // The one object every door projects (VC-668). A Done move's trim,
          // its armed arrival and its drain at stop are the handler's.
          handlers,
          appVersion: options.version,
          verifyOperatorToken: operators.verify,
          // The audit line beside each operator write. `SO_PEERCRED` would
          // add the peer's uid and pid, but Node's `net` cannot read it
          // without a native addon; the login the token names is the
          // attribution (README, "Operators").
          onOperatorWrite: (record) => logger.info("operator write", { ...record }),
        });
        // The map's Session reads (VC-663, D4) are the socket verbs' own,
        // Workspace-scoped: the map reaches them once the service exists.
        serveSessionReads(commands.executeInWorkspace);
        settle(commands.execute);
        if (cloud && listen !== null) {
          try {
            listener = await startHostdProtocolListener({
              db: host.database.db,
              hostId: venue.id,
              version: options.version,
              bind: listen,
              // Devices enrolled over SSH (VC-700); a test may supply its own.
              verifier:
                options.hostProtocolVerifier ??
                createEnrolledDeviceVerifier({
                  store: deviceStore!,
                  hostId: venue.id,
                  onStoreProblem: (problem, reason) =>
                    logger.error("host protocol: the enrolled-devices store admits no one", {
                      problem,
                      reason,
                    }),
                }),
              handlers,
              sessionEngine: sessionPorts.sessionEngine,
              logger,
              offerLogs: options.logRing !== undefined,
            });
          } catch (error) {
            throw new HostdBootError(
              "host-protocol",
              `Could not listen for the host protocol on ${listen.host}:${listen.port}: ${(error as Error).message}`,
              { listen: `${listen.host}:${listen.port}` },
            );
          }
          hostProtocol = { url: listener.url, ...listener.address };
          logger.info("host protocol listening", { url: listener.url });
        }
        publish("serving");
        logger.info("serving", { socketPath, database: host.dbPath, capabilities });
        // Retention and the automatic reap begin at readiness; the host's stop ends them.
        host.maintenance.start();
        return;
      }
      const { error } = host.database;
      database = { ok: false, path: host.dbPath, error, failure: host.databaseFailure };
      settle(async () => ({
        v: 1,
        ok: false,
        error: makeAgentError("DB_UNAVAILABLE", error),
      }));
      publish("refusing");
      logger.error("refusing to serve: the database did not open", {
        database: host.dbPath,
        failure: host.databaseFailure,
        error,
      });
    };

    // Settle queued socket requests on a failed start: shutdown must not wait
    // on a readiness promise that can never resolve.
    const unreachable = (): void =>
      settle(async () => ({
        v: 1,
        ok: false,
        error: makeAgentError("APP_UNREACHABLE", "The host could not start."),
      }));

    let host: HostCore | undefined;
    try {
      publish("starting");
      const ports = headlessPorts(logger, (scope) => boardFeed.noteDataChanged(scope));
      const booting = createHostCore(ports, {
        dataDir,
        onTransactionViolation: throwTransactionViolation,
        devDiagnostics: false,
        // The one sealed store this host opened at boot, never a second handle.
        secretStore: secrets.store,
        modelAccess: () => headlessModelAccess(options.env, runtimeOptions),
        venue: hostdVenue,
        // Read on every scan, and only after readiness (maintenance starts
        // there). Fail closed rather than call every recorded process an orphan.
        processReaders: {
          liveSessionIds: () => {
            if (sessionRuntime === undefined) throw runtimeNotComposed();
            return sessionRuntime.liveSessionIds();
          },
          // No terminals are composed on a headless host.
          openTerminalCwds: () => [],
        },
        reclaim: {
          busyWorktreeSites: (target) =>
            sessionRuntime === undefined
              ? Promise.reject(runtimeNotComposed())
              : sessionRuntime.reclaim.busyWorktreeSites(target),
          releaseAgentSites: (directory) =>
            sessionRuntime === undefined
              ? Promise.reject(runtimeNotComposed())
              : sessionRuntime.reclaim.releaseAgentSites(directory),
        },
      });
      host = booting;
      // The host owns the order things come up and go down in. hostd's drain
      // is SEQUENTIAL: the Session runtime (which joins its shells), then the
      // socket, then the requests it still has executing — so no closeSocket
      // runs beside the runtime; the socket closes inside `drainRequests`.
      await booting.start({
        start: async () => {
          try {
            await serve(booting, ports);
          } catch (error) {
            unreachable();
            throw error;
          }
        },
        stopProducers: () => sessionRuntime?.stopProducers(),
        close: async () => {
          // Every WebSocket stream ends before the runtime that feeds it.
          if (listener !== undefined) {
            await listener.close();
            hostProtocol = null;
          }
          await sessionRuntime?.close();
        },
        drainRequests: async () => {
          await socket.shutdown();
          const drained = await drain(inflight, options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
          if (!drained) {
            logger.error("abandoned requests still executing", { count: inflight.size });
          }
          return drained && !socketCloseFailed;
        },
      });
    } catch (error) {
      // Nothing half-booted stays open: the host's stop closes the runtime,
      // the socket and a database that opened, in its one order.
      unreachable();
      if (host === undefined) {
        await socket.shutdown();
      } else {
        await host.stop("boot failed");
      }
      throw error;
    }
    const booted = host;
    const record = (next: HostdState): void => {
      try {
        publish(next);
      } catch (error) {
        logger.error("could not write the status file", { error, state: next });
      }
    };

    let stopping: Promise<boolean> | undefined;
    return {
      host: booted,
      secrets,
      status: snapshot,
      stop(reason) {
        stopping ??= (async () => {
          logger.info("stopping", { reason });
          // A status file that cannot be written must not keep the database open.
          record("stopping");
          // host-core's stop reports each failed step through the host log.
          const { clean } = await booted.stop(reason);
          lock.release();
          record("stopped");
          logger.info("stopped", { clean });
          return clean;
        })();
        return stopping;
      },
    };
  }
}

/** A process or worktree read that arrived before the Session runtime existed. */
function runtimeNotComposed(): Error {
  return new Error("The headless Session runtime is not composed yet.");
}

/**
 * A socket outside the data directory gets the data directory's warning: in a
 * directory every user can write, another user can unlink it or squat on its
 * path between hostd's runs. The socket itself stays mode 0600 either way.
 * A missing directory is left to the socket's own open to report.
 */
function warnOfSharedSocketDir(socketPath: string, dataDir: string, logger: HostdLogger): void {
  const directory = dirname(socketPath);
  if (directory === dataDir) return;
  let mode: number;
  try {
    mode = statSync(directory).mode & 0o777;
  } catch {
    return;
  }
  if ((mode & 0o002) !== 0) {
    logger.warn(
      "the socket's directory is world-writable; another user could unlink or squat on it",
      {
        socketPath,
        mode: mode.toString(8).padStart(4, "0"),
      },
    );
  }
}

/** Whether every execution settled within `timeoutMs`. */
async function drain(inflight: ReadonlySet<Promise<unknown>>, timeoutMs: number): Promise<boolean> {
  if (inflight.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = Promise.allSettled(inflight).then(() => true as const);
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function prepareDataDir(dataDir: string, logger: HostdLogger): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new HostdBootError(
      "data-dir",
      `Could not create the data directory ${dataDir}: ${(error as Error).message}`,
    );
  }
  // `mkdirSync` has already refused a path that is not a directory (EEXIST).
  const stat = statSync(dataDir);
  // The key file's rule (`file-key.ts`), one level up: a directory another
  // user owns is one they can replace the database or key inside.
  const uid = process.getuid!();
  if (stat.uid !== uid) {
    throw new HostdBootError(
      "data-dir",
      `The data directory ${dataDir} belongs to uid ${stat.uid}, not to the user ` +
        `volli-hostd runs as (uid ${uid}), so it will not use it. Run: chown ${uid} ${dataDir}`,
    );
  }
  const mode = stat.mode & 0o777;
  const octal = mode.toString(8).padStart(4, "0");
  if ((mode & 0o002) !== 0) {
    throw new HostdBootError(
      "data-dir",
      `Permissions ${octal} on the data directory ${dataDir} let every user write it, ` +
        `so any of them could replace its database or key. Run: chmod 700 ${dataDir}`,
    );
  }
  // Group-writable is only a warning: with user private groups (Debian and
  // Ubuntu's default umask 002) the group is this user alone.
  if ((mode & 0o020) !== 0) {
    logger.warn(
      "the data directory is group-writable; its group could replace the database or key",
      {
        dataDir,
        mode: octal,
        fix: `chmod 700 ${dataDir}`,
      },
    );
  }
}

/**
 * This program as git's `credential.helper`: `!<node> [<node flags>] <script>
 * git-credential --data-dir <dir>`, each word shell-quoted. Packaged, that is
 * the bundled Node running `lib/hostd/hostd.cjs`.
 */
export function defaultGitCredentialHelper(dataDir: string): string {
  const program = [process.execPath, ...process.execArgv, ...process.argv.slice(1, 2)];
  return `!${[...program, "git-credential", "--data-dir", dataDir].map(shellWord).join(" ")}`;
}

/**
 * The enrolled-devices store the listener admits from: `--devices`' root
 * file (a system install's), else the data directory's own. A root file
 * hostd could not trust refuses boot, as an unsafe operators file does;
 * one that turns unsafe later admits no one until it is fixed.
 */
function openDeviceStore(
  dataDir: string,
  devicesFile: string | null,
  trustedOwnerUid: number,
): DeviceStore {
  if (devicesFile === null) return dataDirDeviceStore(dataDir);
  const store = rootDeviceStore(devicesFile, trustedOwnerUid);
  const read = readDeviceStore(store);
  if (!read.ok && read.problem === "untrusted") {
    throw new HostdBootError(
      "devices",
      `Refusing the enrolled-devices file: ${read.reason}. Run: sudo chown root:root ${devicesFile} && sudo chmod 644 ${devicesFile}`,
      { devicesFile },
    );
  }
  return store;
}
