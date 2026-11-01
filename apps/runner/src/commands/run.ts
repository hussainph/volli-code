/**
 * `volli-runner run [--data-dir <dir>] [--config-dir <dir>]`: serve in the
 * foreground until SIGTERM. systemd runs exactly this.
 *
 * Under the shell's `runService` (signals, the 30 s deadline, exit codes):
 *
 * 1. The data directory's checks, then its instance lock, held for the
 *    process's life: one process per database, and ONE token source per link
 *    per machine (two would look like a stolen credential and get the
 *    runner cut off).
 * 2. The sealed Session secrets.
 * 3. `@volli/host-core/headless-runner`'s composition over the saved link
 *    (`link/file-store.ts`), which names the deployment the box was linked
 *    to. Unlinked, it serves only its status (`unlinked`) and boots on once
 *    `volli-runner link` saves a link; the Convex client is loaded only then.
 * 4. Every state change is written to the status file `status` reads.
 *
 * Exit codes are the shell's: 0 after a clean stop; 1 after a failure or an
 * unclean stop (the unit restarts it); 78 (`EXIT_CONFIG`) for a boot an
 * operator must fix: another runner on this data directory, an unsafe data
 * directory, an unreadable link, a database that will not open.
 */
import { join } from "node:path";

import {
  HeadlessRunnerBootError,
  startHeadlessRunner,
  type HeadlessRunnerStatus,
} from "@volli/host-core/headless-runner";
import { logLevelFrom } from "@volli/shared";

import type { CommandContext, CommandInput } from "../commands";
import type { RunnerLinkStore } from "@volli/host-core/cloud-runner";
import { CREDENTIAL_INVENTORY_FILE_NAME } from "@volli/host-core/secrets";

import type { RunnerDeployment } from "../link/deployment";
import { fileRunnerLinkStore, UnreadableRunnerLinkError } from "../link/file-store";
import { runnerModelAccess, runnerModelKeyPath } from "../login/model-access";
import { BootError } from "../shell/boot-error";
import { prepareDataDir, warnOfSharedSocketDir } from "../shell/data-dir";
import { RUNNER } from "../shell/identity";
import { acquireInstanceLock } from "../shell/instance-lock";
import { installProcessLog, routeConsole } from "../shell/log";
import { pathsFor, runnerSocketPath } from "../shell/paths";
import type { RunnerStatus } from "../shell/runner-status";
import { logCredentials, openHeadlessSecrets } from "../shell/secrets";
import { runService, type ServiceProcess } from "../shell/service";
import { writeStatus } from "../shell/status";

/** The refusals `run` raises beside the shell's own. */
type RunBootFailure = "link" | "database" | "secrets";

export async function runRun(input: CommandInput, context: CommandContext): Promise<number> {
  const paths = pathsFor(input.values, context);
  const { daemon } = context;
  const { logger } = installProcessLog(
    RUNNER,
    logLevelFrom(context.env["VOLLI_RUNNER_LOG_LEVEL"]),
    daemon.writeLog,
  );
  routeConsole(logger);
  const socketPath = runnerSocketPath(paths.dataDir);
  const startedAt = new Date().toISOString();
  // A failure after boot reaches the shell as an uncaught one: it stops and exits 1.
  const failureListeners: ((error: Error) => void)[] = [];
  const shellProcess: ServiceProcess = {
    on(event: string, listener: (value: never) => void) {
      if (event === "uncaughtException") failureListeners.push(listener as (error: Error) => void);
      return (daemon.process.on as (event: string, listener: (value: never) => void) => unknown)(
        event,
        listener,
      );
    },
    exit: (code) => daemon.process.exit(code),
  };
  return runService({
    logger,
    process: shellProcess,
    start: async () => {
      prepareDataDir(RUNNER, paths.dataDir, logger);
      warnOfSharedSocketDir(socketPath, paths.dataDir, logger);
      const lock = acquireInstanceLock(RUNNER, paths.dataDir);
      try {
        // Every sealed store on this box (Session secrets, model sign-ins) opens
        // under one key, the config dir's by default, as `volli-runner login` does.
        // A key path this runner cannot use leaves it with no model access at
        // all: that is an operator's fix, not a runner that boots and refuses work.
        let keyPath: string;
        try {
          keyPath = runnerModelKeyPath({
            dataDir: paths.dataDir,
            configDir: paths.configDir,
            env: context.env,
          });
        } catch (error) {
          throw new BootError<RunBootFailure>("secrets", (error as Error).message);
        }
        const storeEnv = { ...context.env, VOLLI_SECRET_KEY_FILE: keyPath };
        const secrets = openHeadlessSecrets(RUNNER, paths.dataDir, storeEnv);
        logCredentials(secrets, logger);
        const links = fileRunnerLinkStore({ configDir: paths.configDir });
        // The deployment rides with the link: whatever load answered, read() named its deployment.
        let deployment: RunnerDeployment | null = null;
        let server: string | null = null;
        const linkStore: RunnerLinkStore = {
          ...links,
          load: async () => {
            const stored = await links.read();
            deployment = stored?.deployment ?? null;
            server = deployment?.url ?? null;
            return stored?.link ?? null;
          },
        };
        const runtime = daemon.runtimePaths();
        const record = (status: HeadlessRunnerStatus): void => {
          const report: RunnerStatus = {
            v: 1,
            state: status.state,
            pid: process.pid,
            version: context.version,
            startedAt,
            updatedAt: new Date().toISOString(),
            dataDir: paths.dataDir,
            socketPath,
            link:
              status.runner === null || server === null
                ? null
                : { runnerId: status.runner.runnerId, name: status.runner.name, server },
            backend:
              status.backend === null
                ? null
                : {
                    state: status.backend.state,
                    since: new Date(status.backend.since).toISOString(),
                    lastHeartbeatAt:
                      status.backend.lastHeartbeatAt === null
                        ? null
                        : new Date(status.backend.lastHeartbeatAt).toISOString(),
                    detail: status.backend.detail,
                  },
            update:
              status.target === null ? null : { ...status.target, phase: "idle", detail: null },
            credentials: secrets.status,
          };
          writeStatus(RUNNER, paths.dataDir, report);
        };
        const running = await startHeadlessRunner({
          dataDir: paths.dataDir,
          socketPath,
          binDir: runtime.binDir,
          codeModeSandbox: runtime.codeModeSandbox,
          homeDir: context.home,
          version: context.version,
          installMode: paths.mode,
          // The runner's own unit says so (`Environment=VOLLI_RUNNER_SERVICE=1`); a
          // foreground `run`, even one started from another unit, does not.
          service: context.env["VOLLI_RUNNER_SERVICE"] === "1",
          env: context.env,
          logger,
          secretStore: secrets.store,
          linkStore,
          deployment: async () => {
            // Asked only after `load` answered a link, so its deployment is known.
            const linked = deployment!;
            return {
              url: linked.url,
              siteUrl: linked.siteUrl,
              convex: await daemon.convex(),
              fetch: daemon.fetch,
            };
          },
          // The same sealed sign-ins `volli-runner login` writes; a login is re-reported live.
          modelAccess: () =>
            runnerModelAccess({
              dataDir: paths.dataDir,
              configDir: paths.configDir,
              env: storeEnv,
            }),
          signInFile: join(paths.dataDir, CREDENTIAL_INVENTORY_FILE_NAME),
          onStatus: record,
        });
        void running.failure.then((error) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          for (const listener of failureListeners) listener(failure);
        });
        return {
          async stop(reason) {
            try {
              return await running.stop(reason);
            } finally {
              lock.release();
            }
          },
        };
      } catch (error) {
        lock.release();
        if (error instanceof UnreadableRunnerLinkError)
          throw new BootError<RunBootFailure>("link", error.message);
        if (error instanceof HeadlessRunnerBootError)
          throw new BootError<RunBootFailure>("database", error.message);
        throw error;
      }
    },
  });
}
