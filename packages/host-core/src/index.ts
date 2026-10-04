/**
 * `@volli/host-core` — the host's services, composed without Electron.
 *
 * Volli Cloud (docs/plans/volli-cloud.md) runs one host program everywhere:
 * Electron main today, `hostd` next. Both call {@link createHostCore} and wire
 * what it returns. Everything that decides how a host behaves on THIS machine
 * — where its data lives, whether a transaction-ownership bug throws, who
 * reads a failure — comes in as {@link HostCoreOptions}; everything it must
 * ask its host to do comes in as {@link HostCorePorts}. Nothing in this
 * package imports `electron` (`scripts/check-host-electron-imports.mjs`).
 *
 * Persistence (VC-553) and Session composition (VC-612) live here. The repos
 * and ledger are exported under `db/*` and `session-control/*`. See README.md
 * for how later slices move a cluster.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import type { ConnectivityPort } from "@volli/agent-runtime";
import { openVolliDb } from "./db";
import type { TransactionViolationHandler } from "./db/transaction-gate";
import { clientCapabilities, type ClientCapabilityPort } from "./ports/client";
import type { PowerPort } from "./ports/power";
import {
  classifyDbOpenFailure,
  dbOpenFailureLogLine,
  describeDbOpenFailure,
} from "./db-open-failure";
import type { DbOpenFailure } from "./db-open-failure";
import {
  createHostSessionServices,
  type HostSessionPorts,
  type HostSessionServices,
} from "./session-services";
export type { HostSessionPorts, HostSessionServices } from "./session-services";
export * from "./ports";
export type { DbOpenFailure } from "./db-open-failure";

export {
  logTransactionViolation,
  throwTransactionViolation,
  type TransactionViolationHandler,
} from "./db/transaction-gate";

/**
 * The database, or the one sentence that says why it is not there. A host
 * keeps serving with a degraded database: every data surface answers with
 * `error` instead of failing to start.
 */
export type DbHandle = { ok: true; db: Database.Database } | { ok: false; error: string };

/**
 * What host-core asks of the process hosting it. The README's "Ports" section
 * is the vocabulary; `src/ports/` holds each port and its headless answer.
 */
export interface HostCorePorts extends HostSessionPorts {
  /** Sleep and wake. A host that never sleeps passes `NO_POWER_EVENTS`. */
  power: PowerPort;
  /**
   * The network, for the Agent Runtime's retry policy. Desktop builds it from
   * Electron's `net` and {@link HostCorePorts.power}; a headless host passes
   * `ALWAYS_ONLINE` from `@volli/agent-runtime`.
   */
  connectivity: ConnectivityPort;
  /**
   * What only a person's machine can do: open a link, reveal a file, the
   * clipboard, menus. Absent on a headless host, where every request is
   * refused with a `ClientCapabilityUnavailableError`.
   */
  client?: ClientCapabilityPort;
}

/** How this host behaves. No defaults for policy: every host states it. */
export interface HostCoreOptions {
  /**
   * The host's durable data directory. Desktop passes Electron's `userData`;
   * a headless host passes its own state directory.
   */
  readonly dataDir: string;
  /** Overrides {@link defaultDatabasePath}. Desktop dev/e2e passes `VOLLI_DB_PATH`. */
  readonly databasePath?: string;
  /**
   * What a SQLite transaction-ownership violation does (VC-551). Desktop passes
   * `throwTransactionViolation` in tests and dev and `logTransactionViolation`
   * when packaged; a headless host passes `throwTransactionViolation`.
   */
  readonly onTransactionViolation: TransactionViolationHandler;
  /**
   * Who reads a failed open: `true` adds the dev-loop remedy (a repository,
   * nvm, pnpm), `false` speaks to someone running a packaged build.
   */
  readonly devDiagnostics: boolean;
}

export interface HostCore extends HostSessionServices {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly database: DbHandle;
  /** The client's capabilities, or one that refuses each readably when there is none. */
  readonly client: ClientCapabilityPort;
  /**
   * Why the database did not open, typed for routing (VC-602): `null` when it
   * opened. `database.error` is the sentence every degraded surface answers
   * with; this is what a host branches on, such as desktop's "database is
   * from a newer Volli" screen.
   */
  readonly databaseFailure: DbOpenFailure | null;
}

/** `<dataDir>/volli.db`: where a host keeps its database unless told otherwise. */
export function defaultDatabasePath(dataDir: string): string {
  return join(dataDir, "volli.db");
}

/**
 * Opens (creating and migrating if needed) the host's database, installs
 * the transaction-ownership guard, and composes its Session services.
 *
 * Never throws for a database that will not open: the failure is classified
 * once, logged through `ports.log`, and returned as `{ ok: false, error }`.
 *
 * Boot-window rule: migrations and the open checks run on the raw handle,
 * before `openVolliDb` installs the guard. A statement handle created in that
 * window must not outlive boot — the guard wraps statements in the `prepared`
 * cache, but nothing else made before it exists.
 */
export function createHostCore(ports: HostCorePorts, options: HostCoreOptions): HostCore {
  const dbPath = options.databasePath ?? defaultDatabasePath(options.dataDir);
  let database: DbHandle;
  let databaseFailure: DbOpenFailure | null = null;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openVolliDb(dbPath, { onTransactionViolation: options.onTransactionViolation });
    database = { ok: true, db };
  } catch (error) {
    // The recorded reason is what every degraded handler answers with, so it
    // is classified here, once: a native-ABI failure names the Node
    // incompatibility and a fix its reader can carry out instead of a bare
    // NODE_MODULE_VERSION number (VC-76). Which fix that is depends on who is
    // looking, so the audience is stated rather than assumed (VC-160) — and the
    // log keeps the raw message plus the dev-loop remedy either way, so a
    // packaged user's report is still diagnosable.
    database = { ok: false, error: describeDbOpenFailure(error, { dev: options.devDiagnostics }) };
    databaseFailure = classifyDbOpenFailure(error);
    ports.log.error("[volli] failed to open database:", dbOpenFailureLogLine(error));
  }
  return {
    dataDir: options.dataDir,
    dbPath,
    database,
    client: clientCapabilities(ports.client),
    databaseFailure,
    ...createHostSessionServices(database.ok ? database.db : null, ports),
  };
}
