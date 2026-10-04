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
 * 3. **Secrets, eagerly** (`secrets.ts`).
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
 * SHUTDOWN ({@link RunningHostd.stop}): mark `stopping`; close the socket,
 * which refuses new connections and waits up to its 10 s request bound; wait
 * up to {@link DRAIN_TIMEOUT_MS} more for executions still running (an
 * abandoned one makes the stop unclean); checkpoint the WAL and close the
 * database; release the instance lock; mark `stopped`.
 *
 * What hostd does not compose yet: the Session runtime (Pi, tools, MCP,
 * skills, `createSessions`), so Session verbs answer `APP_UNREACHABLE` exactly
 * as desktop's do when its runtime did not come up; the automation scheduler,
 * which starts Sessions; terminals; the browser (VC-619); and backup,
 * retention and the maintenance loops (VC-618).
 */
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type Database from "better-sqlite3";
import { makeAgentError, type AgentRequest, type AgentResponse } from "@volli/shared";
import { createHostCore, throwTransactionViolation, type HostCore } from "@volli/host-core";
import { createAgentSocketLifecycle, startAgentSocket } from "@volli/host-core/agent-socket";

import { HostdBootError } from "./boot-error";
import { acquireInstanceLock } from "./instance-lock";
import type { HostdLogger } from "./log";
import { headlessPorts } from "./ports";
import { openHeadlessSecrets, type HeadlessSecrets } from "./secrets";
import {
  writeStatus,
  type HostdCapabilities,
  type HostdDatabaseStatus,
  type HostdState,
  type HostdStatus,
} from "./status";

export interface HostdOptions {
  readonly dataDir: string;
  readonly socketPath: string;
  readonly version: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: HostdLogger;
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
  });
  const publish = (next: HostdState): void => {
    state = next;
    writeStatus(dataDir, snapshot());
  };

  logger.info("starting", { version: options.version, dataDir, socketPath, pid: process.pid });
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
    logger.info("secrets ready", { keyPath: secrets.keyPath, key: secrets.key });

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
        execute: (request) => track(ready.then((execute) => execute(request))),
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

    /** Settles what every verb answers with, and publishes the state that goes with it. */
    const serve = (host: HostCore): void => {
      const handle = host.database;
      if (handle.ok) {
        database = { ok: true, path: host.dbPath };
        capabilities = { ...UNAVAILABLE, board: "available" };
        settle(
          host.agentServices.createCommands({
            db: handle.db,
            // Non-null whenever the database opened (`createHostSessionServices`).
            sessionEngine: host.sessionEngine!,
            appVersion: options.version,
          }).execute,
        );
        publish("serving");
        logger.info("serving", { socketPath, database: host.dbPath, capabilities });
        return;
      }
      database = {
        ok: false,
        path: host.dbPath,
        error: handle.error,
        failure: host.databaseFailure,
      };
      settle(async () => ({
        v: 1,
        ok: false,
        error: makeAgentError("DB_UNAVAILABLE", handle.error),
      }));
      publish("refusing");
      logger.error("refusing to serve: the database did not open", {
        database: host.dbPath,
        failure: host.databaseFailure,
        error: handle.error,
      });
    };

    let host: HostCore | undefined;
    try {
      publish("starting");
      host = createHostCore(headlessPorts(logger), {
        dataDir,
        onTransactionViolation: throwTransactionViolation,
        devDiagnostics: false,
      });
      serve(host);
    } catch (error) {
      // Nothing half-booted stays open: the socket closes, and so does a
      // database that opened.
      await socket.shutdown();
      if (host?.database.ok === true) {
        host.sessionActivityWatch?.stop();
        closeDatabase(host.database.db, logger);
      }
      throw error;
    }
    const handle = host.database;
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
          // Refuses new connections and waits, up to its request timeout, for
          // the ones already executing.
          await socket.shutdown();
          const drained = await drain(inflight, options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
          if (!drained) {
            logger.error("abandoned requests still executing", { count: inflight.size });
          }
          // The activity watch's flush timer is the one thing left that reads
          // the database on its own.
          booted.sessionActivityWatch?.stop();
          const closed = handle.ok ? closeDatabase(handle.db, logger) : true;
          lock.release();
          record("stopped");
          const clean = drained && closed && !socketCloseFailed;
          logger.info("stopped", { clean });
          return clean;
        })();
        return stopping;
      },
    };
  }
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
 * Folds the WAL back into the database file, then closes it. Nothing else holds
 * the database by now: the socket has drained, and hostd composes nothing that
 * writes on its own.
 */
function closeDatabase(db: Database.Database, logger: HostdLogger): boolean {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    return true;
  } catch (error) {
    logger.error("database did not close cleanly", { error });
    return false;
  }
}
