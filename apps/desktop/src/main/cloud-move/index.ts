/** Production desktop composition: the engine and its real ports, once per profile. */
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { OperationUnavailableError } from "@volli/shared";
import type { LiveHostCore } from "@volli/host-core";
import {
  createMoveBackupPort,
  createMoveEngine,
  createMoveSessionHistory,
  presignedMoveObjects,
  windowReadCheck,
} from "@volli/host-core/cloud-move";
import { withProfileMaintenance } from "@volli/host-core/maintenance";
import { runMigrationExportInWorker } from "@volli/host-core/migration-export";
import type { AccountService } from "../account/service";
import { personMoveBackend } from "./backend";
import { prepareLocalMoves } from "./preflight";
import { createDesktopMovesService, type DesktopMovesService } from "./service";
import { createMoveView, saveMovePreview } from "./view";

async function savedBudget(root: string): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(root, "export-budget.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}
export function createDesktopMoves(options: {
  host: LiveHostCore;
  enabled(): boolean;
  backendUrl: string;
  account: AccountService;
  identity: {
    current(signal?: AbortSignal): Promise<{ userId: string; runnerId: string } | null>;
    release(): Promise<void>;
  };
  workRoot: string;
  workerEntry: string;
  backupWorkerEntry: string;
  stores: { blobsDir: string; transcriptsDir: string; piLogsDir: string };
  homeDir: string;
  appVersion: string;
  artifacts: import("@volli/host-core/cloud-move").MoveSessionHistoryOptions["artifacts"];
  busySessionIds(): ReadonlySet<string>;
  credentials(projectId: string): Promise<string[]>;
  openCloud(projectId: string, workspaceId: string, userId: string): void | Promise<void>;
}): DesktopMovesService {
  const { host } = options;
  const db = host.database.db;
  const workRoot = options.workRoot;
  let service: DesktopMovesService | null = null;
  let laneSignal: AbortSignal | undefined;
  const lifetime = new AbortController();
  const moveFetch: typeof fetch = (input, init) => {
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = AbortSignal.any([
      lifetime.signal,
      ...(laneSignal === undefined ? [] : [laneSignal]),
      ...(caller == null ? [] : [caller]),
    ]);
    return fetch(input, { ...init, signal });
  };
  const backend = personMoveBackend({
    url: options.backendUrl,
    enabled: options.enabled,
    accessToken: () => options.account.accessToken(),
    onSignInLost: () => service?.signInLost(),
    signal: () => laneSignal,
    fetch: moveFetch,
  });
  const history = createMoveSessionHistory({
    db,
    backend,
    artifacts: options.artifacts,
    piDirectory: options.stores.piLogsDir,
    fetch: moveFetch,
    redaction: {
      step: (window, from, final) => host.secretStore.redactStreamStep(window, from, final),
      complete: () => {
        const state = host.secretStore.status().state;
        return state === "ready" || state === "empty";
      },
    },
  });
  const engine: ReturnType<typeof createMoveEngine> = createMoveEngine({
    db,
    profilePath: host.dbPath,
    workRoot,
    stores: options.stores,
    homeDir: options.homeDir,
    appVersion: options.appVersion,
    backend,
    objects: presignedMoveObjects({ backend, fetch: moveFetch }),
    history,
    identity: options.identity,
    realPath: windowReadCheck({ backend, sleep: (ms, signal) => delay(ms, undefined, { signal }) }),
    liveWork: { busySessionIds: options.busySessionIds },
    backup: {
      write: async (signal) => {
        // Only outstanding queues need export space. A completed large move must
        // not permanently prevent a later small move on a nearly full disk.
        let estimatedExportBytes = 0;
        const fallback = await savedBudget(workRoot);
        for (const queue of engine.journal.runningQueues()) {
          if (queue.backup !== null) continue;
          for (const row of engine.journal.moves(queue.queueId)) {
            try {
              const preview = JSON.parse(
                await readFile(join(workRoot, row.moveId, "preview.json"), "utf8"),
              ) as { estimatedExportBytes?: unknown };
              const bytes = preview.estimatedExportBytes;
              estimatedExportBytes +=
                typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0
                  ? bytes
                  : fallback;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              estimatedExportBytes += fallback;
            }
          }
        }
        return createMoveBackupPort({
          workerEntry: options.backupWorkerEntry,
          dataDir: dirname(host.dbPath),
          dbPath: host.dbPath,
          blobsRoot: options.stores.blobsDir,
          transcriptsRoot: options.stores.transcriptsDir,
          appVersion: options.appVersion,
          workRoot,
          estimatedExportBytes,
        }).write(signal);
      },
    },
    maintenance: (work) => withProfileMaintenance(dirname(host.dbPath), work),
    exportProject: (input) =>
      runMigrationExportInWorker(options.workerEntry, input, { signal: input.signal }),
  });
  service = createDesktopMovesService({
    enabled: options.enabled,
    engine,
    backend,
    account: options.account,
    identity: options.identity.current,
    prepare: (input, signal) =>
      prepareLocalMoves(
        {
          db,
          profilePath: host.dbPath,
          workRoot,
          workerEntry: options.workerEntry,
          appVersion: options.appVersion,
          stores: options.stores,
          busySessionIds: options.busySessionIds,
          hasMove: (id) => engine.journal.liveMove(id) !== null,
          hasCloudCopy: (id) =>
            engine.journal.movesIn(["returned"]).some((row) => row.projectId === id),
          eventRecord: history.eventRecord,
        },
        input,
        signal,
      ),
    describe: createMoveView({
      db,
      workRoot,
      workspaceName: () => "Workspace",
      credentials: options.credentials,
    }),
    remember: (row, summary) => saveMovePreview(workRoot, row, summary),
    async setExportBudget(bytes) {
      await mkdir(workRoot, { recursive: true, mode: 0o700 });
      const path = join(workRoot, "export-budget.json");
      await writeFile(`${path}.partial`, JSON.stringify(bytes), {
        mode: 0o600,
      });
      await rename(`${path}.partial`, path);
    },
    assertIdle(projectId) {
      const busy = options.busySessionIds();
      const sessions = db
        .prepare("SELECT id FROM sessions WHERE project_id = ?")
        .all(projectId) as { id: string }[];
      if (sessions.some((session) => busy.has(session.id)))
        throw new OperationUnavailableError(
          "Finish this project’s running turns, shells and terminals first.",
        );
    },
    openCloud: (row) => options.openCloud(row.projectId, row.workspaceId, row.userId),
    track: (work) => host.detachedWork.track(work),
    releaseIdentity: options.identity.release,
    async withSignal(signal, work) {
      const previous = laneSignal;
      laneSignal = signal;
      try {
        return await work();
      } finally {
        laneSignal = previous;
      }
    },
    disposeBackend: () => {
      lifetime.abort();
      backend.dispose();
    },
  });
  return service;
}
