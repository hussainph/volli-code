/** The host's persistence, live services and lifecycle, composed without Electron. */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import type { ConnectivityPort, PiModelAccess } from "@volli/agent-runtime";
import type { SessionExecutionVenue } from "@volli/shared";
import { openVolliDb } from "./db";
import { createWorktreeRuntime, type WorktreeRuntime } from "./worktree-runtime";
import type { WorktreePorts } from "./worktree";
import type { TransactionViolationHandler } from "./db/transaction-gate";
import { clientCapabilities, type ClientCapabilityPort } from "./ports/client";
import type { PowerPort } from "./ports/power";
import type { TrashPort } from "./ports/trash";
import { createHostFileServices, type HostFileServices } from "./file-services";
import {
  createHostRuntimeServices,
  type HostRuntimeServices,
  type WebKeySealingOptions,
} from "./runtime-services";
import {
  createHostMaintenance,
  checkpointAndCloseDatabase,
  type HostMaintenance,
  type MaintenanceProcessReaders,
} from "./maintenance-services";
import type { RetentionReclaimSeams } from "./retention-runtime";
import {
  classifyDbOpenFailure,
  dbOpenFailureLogLine,
  describeDbOpenFailure,
  type DbOpenFailure,
} from "./db-open-failure";
import {
  createHostSessionServices,
  type HostSessionPorts,
  type HostSessionServices,
} from "./session-services";
import { createHostLifecycle, type HostStopPolicy, type HostStopReport } from "./host-lifecycle";
import { stampFollowUpCleanClose } from "./db/session-follow-up-repo";
import { createDetachedWorkTracker, type DetachedWorkTracker } from "./detached-work";
import { SecretStore } from "./secrets/store";
import { SecretKeyUnavailableError, type SecretKeyPort } from "./ports/secret-key";
import { PtyManager, type PtyManagerOptions } from "./pty/manager";
import { blobsRoot } from "./blob-store";
export type { HostSessionPorts, HostSessionServices } from "./session-services";
export type { DbOpenFailure } from "./db-open-failure";
export {
  logTransactionViolation,
  throwTransactionViolation,
  type TransactionViolationHandler,
} from "./db/transaction-gate";

/** Transport adapter handle. Live services themselves never carry null databases. */
export type DbHandle = { ok: true; db: Database.Database } | { ok: false; error: string };

export interface HostCorePorts extends HostSessionPorts {
  power: PowerPort;
  connectivity: ConnectivityPort;
  client?: ClientCapabilityPort;
  trash?: TrashPort;
}

/** A recovered runtime module, adopted before start can yield. */
export interface HostRuntimeOwner {
  start(): Promise<void> | void;
  stopProducers(): void;
  close(): Promise<void>;
  /** Desktop closes this concurrently; hostd supplies its sequential socket/request drain. */
  closeSocket?(): Promise<boolean | void>;
  drainRequests?(): Promise<boolean | void>;
}

export interface HostCoreOptions {
  readonly dataDir: string;
  /** Defaults to a full drain/close. Desktop preserves its process-exit quit behavior. */
  readonly stopPolicy?: HostStopPolicy;
  readonly databasePath?: string;
  readonly onTransactionViolation: TransactionViolationHandler;
  readonly devDiagnostics: boolean;
  readonly processReaders: MaintenanceProcessReaders;
  readonly reclaim?: RetentionReclaimSeams;
  /** Lazy so model/catalog construction keeps the host's former boot point. */
  readonly modelAccess?: () => PiModelAccess;
  readonly webKeySealing?: WebKeySealingOptions;
  readonly venue?: (db: Database.Database) => SessionExecutionVenue;
  readonly secretStore?: SecretStore;
  readonly secretKey?: SecretKeyPort;
  readonly terminal?: () => Pick<
    PtyManagerOptions,
    "host" | "agentRuntime" | "concurrencyEnvReader"
  >;
}

interface HostLifecycleOwner {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly database: DbHandle;
  start(runtime?: HostRuntimeOwner): Promise<void>;
  stop(reason: string): Promise<HostStopReport>;
  /** Host-edge deadline diagnostics; never changes the drain or stamp policy. */
  warnIfFollowUpCleanCloseSkipped(reason: string): void;
}

/** Failure is one variant, not a live host with six null Session services. */
export interface DegradedHostCore extends HostLifecycleOwner {
  readonly kind: "degraded";
  readonly database: { ok: false; error: string };
  readonly databaseFailure: DbOpenFailure;
}

export interface LiveHostCore extends HostLifecycleOwner, HostSessionServices {
  readonly kind: "live";
  readonly database: { ok: true; db: Database.Database };
  readonly worktrees: WorktreeRuntime;
  readonly worktreeDeps: WorktreePorts;
  readonly runtimeServices: HostRuntimeServices;
  readonly maintenance: HostMaintenance;
  readonly client: ClientCapabilityPort;
  readonly fileServices: HostFileServices;
  readonly detachedWork: DetachedWorkTracker;
  readonly secretStore: SecretStore;
  readonly terminals:
    | { readonly kind: "unavailable" }
    | { readonly kind: "available"; readonly manager: PtyManager };
}
export type HostCore = LiveHostCore | DegradedHostCore;

/** Narrow the host itself, not just its transport database handle. */
export function isLiveHost(host: HostCore): host is LiveHostCore {
  return host.database.ok;
}

export function defaultDatabasePath(dataDir: string): string {
  return join(dataDir, "volli.db");
}

/** Opens once, choosing the failure variant before constructing any live service. */
export function createHostCore(ports: HostCorePorts, options: HostCoreOptions): HostCore {
  const dbPath = options.databasePath ?? defaultDatabasePath(options.dataDir);
  let db: Database.Database;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = openVolliDb(dbPath, { onTransactionViolation: options.onTransactionViolation });
  } catch (error) {
    const failure = classifyDbOpenFailure(error);
    const message = describeDbOpenFailure(error, { dev: options.devDiagnostics });
    ports.log.error("failed to open database", { detail: dbOpenFailureLogLine(error) });
    const owner = lifecycleOwner(ports, {}, options.stopPolicy);
    return {
      kind: "degraded",
      dataDir: options.dataDir,
      dbPath,
      database: { ok: false, error: message },
      databaseFailure: failure,
      ...owner,
    };
  }
  const sessionServices = createHostSessionServices(db, ports);
  const worktrees = createWorktreeRuntime(ports, options);
  const client = clientCapabilities(ports.client);
  const detachedWork = createDetachedWorkTracker({
    reportFailure: (error) => ports.log.error("detached work failed", { error }),
  });
  const maintenance = createHostMaintenance({
    db,
    ports,
    worktrees,
    processReaders: options.processReaders,
    ...(options.reclaim === undefined ? {} : { reclaim: options.reclaim }),
  });
  let runtimeServices: HostRuntimeServices | undefined;
  let ptyManager: PtyManager | undefined;
  const secretStore =
    options.secretStore ??
    new SecretStore(
      join(dirname(dbPath), "session-secrets.enc"),
      options.secretKey ?? unavailableSecretKey,
    );
  const owner = lifecycleOwner(
    ports,
    {
      stopMaintenance: () => {
        maintenance.stop();
        ptyManager?.stopParkSweep();
      },
      drainDetached: async () => {
        await maintenance.settled();
        await detachedWork.drain();
      },
      stopActivity: sessionServices.sessionActivityWatch.stop,
      stampCleanClose: () => stampFollowUpCleanClose(db, Date.now()),
      closeDatabase: () => checkpointAndCloseDatabase(db),
    },
    options.stopPolicy,
  );
  return {
    kind: "live",
    dataDir: options.dataDir,
    dbPath,
    database: { ok: true, db },
    ...sessionServices,
    ...owner,
    worktrees,
    worktreeDeps: worktrees.deps(db),
    client,
    maintenance,
    detachedWork,
    secretStore,
    get terminals() {
      if (options.terminal === undefined) return { kind: "unavailable" as const };
      return {
        kind: "available" as const,
        manager: (ptyManager ??= new PtyManager({
          ...options.terminal(),
          db,
          dbError: "",
          sessionEngine: sessionServices.sessionEngine,
          blobsRootPath: blobsRoot(options.dataDir),
          spawnLedger: maintenance.spawnLedger,
        })),
      };
    },
    fileServices: createHostFileServices(ports),
    get runtimeServices() {
      return (runtimeServices ??= createHostRuntimeServices(
        db,
        sessionServices.sessionEngine,
        { client },
        {
          dbPath,
          ...(options.modelAccess === undefined ? {} : { modelAccess: options.modelAccess() }),
          ...(options.webKeySealing === undefined ? {} : { webKeySealing: options.webKeySealing }),
          ...(options.venue === undefined ? {} : { venue: options.venue(db) }),
        },
      ));
    },
  };
}

const refuseSecretKey = (): never => {
  throw new SecretKeyUnavailableError("unavailable", "This host has no secret key port.");
};
const unavailableSecretKey: SecretKeyPort = {
  isEncryptionAvailable: refuseSecretKey,
  encryptString: refuseSecretKey,
  decryptString: refuseSecretKey,
};

function lifecycleOwner(
  ports: Pick<HostCorePorts, "log">,
  services: {
    stopMaintenance?(): void;
    drainDetached?(): Promise<void>;
    stopActivity?(): void;
    closeDatabase?(): void;
    stampCleanClose?(): void;
  },
  stopPolicy: HostStopPolicy | undefined,
): Pick<HostLifecycleOwner, "start" | "stop" | "warnIfFollowUpCleanCloseSkipped"> {
  let runtime: HostRuntimeOwner | undefined;
  let adopted = false;
  const lifecycle = createHostLifecycle(
    {
      start: () => runtime?.start(),
      stopProducers: () => runtime?.stopProducers(),
      stopMaintenance: () => services.stopMaintenance?.(),
      closeRuntime: async () => {
        await runtime?.close();
      },
      closeSocket: async () => {
        return await runtime?.closeSocket?.();
      },
      drainDetached: async () => {
        try {
          return await runtime?.drainRequests?.();
        } finally {
          // A transport refusal must not skip the host's own writer joins.
          await services.drainDetached?.();
        }
      },
      stopActivity: () => services.stopActivity?.(),
      stampCleanClose: services.stampCleanClose,
      closeDatabase: () => services.closeDatabase?.(),
      reportSkippedCleanClose: (reason) =>
        ports.log.warn("follow-up clean-close watermark was not stamped", { reason }),
      reportFailure: (step, error) => ports.log.error("host shutdown step failed", { step, error }),
    },
    stopPolicy,
  );
  return {
    start(owner) {
      if (!adopted) {
        runtime = owner;
        adopted = true;
      }
      return lifecycle.start();
    },
    stop: lifecycle.stop,
    warnIfFollowUpCleanCloseSkipped: lifecycle.warnIfCleanCloseSkipped,
  };
}
