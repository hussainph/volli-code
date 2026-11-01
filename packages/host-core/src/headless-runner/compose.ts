/**
 * `volli-runner run`: the headless runner's composition. host-core with
 * headless ports, the cloud product store (a runner is always a Volli Cloud
 * runner: there is no local board), the runner's Session runtime over it,
 * the agent socket with the cloud agent routes (`../cloud-agent/routes.ts`),
 * and the box's live connection to Volli Cloud (the link's lifecycle,
 * `cloud-runner/headless-runner.ts`). No Electron, no window, no
 * terminals or browser, no host-protocol listener, operators or host
 * workspaces: everything a person does reaches this box through Volli Cloud.
 *
 * BOOT, in order:
 *
 * 1. **The link.** None saved: the runner is `unlinked`, opens nothing but its
 *    status, and looks for a link every few seconds (`volli-runner link`
 *    while it runs); once one appears it boots on.
 * 2. **host-core.** Opens and migrates the database with
 *    `throwTransactionViolation`. A database that will not open refuses boot
 *    ({@link HeadlessRunnerBootError}): an operator must look.
 * 3. **The owner** (`./owner.ts`): kept from an earlier boot, else read from
 *    the first runner token (the lifecycle's own token source). Until it is known the runner is `connecting`
 *    and the agent socket's requests wait.
 * 4. **The cloud store, the Session runtime and the connection.** The
 *    connection starts BEFORE the runtime recovers: recovery waits for the
 *    first backend connection before it judges an interrupted turn.
 * 5. **Start.** Runtime recovery, then the agent socket answers, then the
 *    maintenance loops.
 *
 * STOP (SIGTERM): `draining` is reported and claims stop; then host-core's
 * full drain: producers stop, the Session runtime closes (open questions are
 * withdrawn, turns interrupted, background shells joined), the connection
 * reports `stopped` and closes, the agent socket closes and its in-flight
 * requests settle, detached work drains, and SQLite is checkpointed and
 * closed. A runner whose link ended (`revoked`, `unlinked`) stays up so
 * `status` can say why; it claims nothing more.
 */
import { availableParallelism } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, unwatchFile, watchFile } from "node:fs";

import type { CodeModeSandboxAssets, PiModelAccess } from "@volli/agent-runtime";
import {
  makeAgentError,
  VOLLI_SOCKET_ENV,
  type AgentRequest,
  type AgentResponse,
} from "@volli/shared";
import type {
  RunnerCapabilityReport,
  RunnerInstallMode,
  RunnerId,
  RunnerLocalCredential,
} from "@volli/shared/cloud";

import { createHostCore, isLiveHost, throwTransactionViolation, type LiveHostCore } from "../index";
import { createHostAgentCommands, createHostAgentSocket } from "../agent-services";
import type { ConvexClientModule } from "../cloud-runner/convex-connection";
import {
  createHeadlessRunner,
  type HeadlessRunner,
  type HeadlessRunnerTarget,
} from "../cloud-runner/headless-runner";
import type { RunnerLink, RunnerLinkStore } from "../cloud-runner/link";
import type { RunnerFetch } from "../cloud-runner/link-client";
import { probeRunnerCapabilities, readRunnerLoad } from "../cloud-runner/platform";
import type { RunnerLinkLoss } from "../cloud-runner/token-source";
import { createCloudProductStore } from "../cloud-store";
import { SecretService } from "../secrets/service";
import type { SecretStore } from "../secrets/store";
import {
  recoveredRuntimeSessionServices,
  recoveredSessionCommandPorts,
} from "../session-runtime/facade";
import { createRunnerComposition, type RunnerReady } from "../session-runtime/runner";
import { liveShellWorktreeSites } from "../worktree/activity";
import { agentSitesWithin, releaseAgentSites } from "../worktree/agent-sites";
import type { BusyWorktreeSites } from "../worktree/activity";
import { resolveRunnerOwner } from "./owner";
import { headlessRunnerPorts, type HeadlessRunnerLogger } from "./ports";
import { headlessRunnerVenue } from "./venue";

/** The backend connection as `volli-runner status` shows it. */
export type HeadlessBackendState = "connecting" | "online" | "offline" | "revoked";

export interface HeadlessBackendStatus {
  readonly state: HeadlessBackendState;
  /** When it entered `state`, ms since the epoch. */
  readonly since: number;
  readonly lastHeartbeatAt: number | null;
  /** Why it is `offline` or `revoked`, for an operator. Never a credential. */
  readonly detail: string | null;
}

/** What `volli-runner status` reads: the runner's own state, then its backend's. */
export type HeadlessRunnerState =
  | "starting"
  | "unlinked"
  | "connecting"
  | "online"
  | "offline"
  | "revoked"
  | "draining"
  | "stopping"
  | "stopped";

export interface HeadlessRunnerStatus {
  readonly state: HeadlessRunnerState;
  /** The saved link's runner, never its credential; `null` while unlinked. */
  readonly runner: { readonly runnerId: RunnerId; readonly name: string } | null;
  readonly backend: HeadlessBackendStatus | null;
  /** The latest heartbeat's update target and floor; `null` before the first beat. */
  readonly target: {
    readonly targetVersion: string | null;
    readonly minVersion: string | null;
  } | null;
  readonly database: string | null;
}

/** A boot an operator must fix: the database would not open. Not restarted by the unit. */
export class HeadlessRunnerBootError extends Error {
  override name = "HeadlessRunnerBootError";
  constructor(
    readonly reason: "database",
    message: string,
  ) {
    super(message);
  }
}

/** How this runner reaches the deployment it is linked to. */
export interface HeadlessRunnerDeployment {
  /** The Convex deployment URL (`https://<name>.convex.cloud`). */
  readonly url: string;
  /** Its HTTP actions origin (`https://<name>.convex.site`), for `/runner/*`. */
  readonly siteUrl: string;
  /** `convex/browser`'s client and `convex/server`'s references, loaded once linked. */
  readonly convex: ConvexClientModule;
  /** The `/runner/*` client's fetch; a test's scripted one. */
  readonly fetch?: RunnerFetch | undefined;
}

export interface HeadlessRunnerOptions {
  readonly dataDir: string;
  /** The agent socket this runner serves (0600); every Session command is pointed at it. */
  readonly socketPath: string;
  /** Prepended to every Session command's PATH: where the bundled `volli` resolves. */
  readonly binDir: string;
  readonly homeDir: string;
  readonly version: string;
  readonly installMode: Extract<RunnerInstallMode, "system" | "user">;
  /**
   * Whether a service manager keeps this runner up (systemd): it then reports
   * itself always on (C1 `power`). A foreground `volli-runner run` is not.
   */
  readonly service: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: HeadlessRunnerLogger;
  /** The sealed Session secret store the process shell opened at boot. */
  readonly secretStore: SecretStore;
  /**
   * The saved link. The caller holds the data directory's instance lock for
   * the process's life: one token source per link per machine, and one
   * process per database.
   */
  readonly linkStore: RunnerLinkStore;
  /**
   * The deployment a saved link belongs to: a box records it with its link,
   * and an unlinked runner learns it only once a link appears.
   */
  deployment(link: RunnerLink): HeadlessRunnerDeployment | Promise<HeadlessRunnerDeployment>;
  /** This box's model access: its sign-ins, which `volli-runner login` writes. */
  modelAccess(): PiModelAccess;
  /** The file a login or logout rewrites; watched, so the providers are re-reported. */
  readonly signInFile: string;
  readonly codeModeSandbox?: CodeModeSandboxAssets;
  /** The process's additions to a Session command's environment (its git credential helper). */
  sessionEnvironment?(env: Record<string, string>): Record<string, string>;
  /** Every status change, for the status file. */
  onStatus?(status: HeadlessRunnerStatus): void;
  /** Every heartbeat reply's update target and floor, for the updater. */
  onTarget?(target: HeadlessRunnerTarget): void;
  /** How often an unlinked runner looks for a saved link. */
  readonly linkPollMs?: number;
  /** How often the sign-in file is checked for a `volli-runner login` / `logout`. */
  readonly signInPollMs?: number;
}

export interface RunningHeadlessRunner {
  status(): HeadlessRunnerStatus;
  /** The live host once linked and booted; `null` before. */
  host(): LiveHostCore | null;
  /**
   * Settles with the error when the runner failed after it started serving
   * `status` (a link that appeared later opened a database that refused, or
   * recovery failed). The process should stop and exit non-zero.
   */
  readonly failure: Promise<unknown>;
  /** Stops serving and closes the database. Idempotent; `true` when everything closed cleanly. */
  stop(reason: string): Promise<boolean>;
}

/** How often an unlinked runner looks for a link by default. */
export const HEADLESS_LINK_POLL_MS = 5_000;
/** How often a running runner checks its sign-in file for a login or logout. */
export const HEADLESS_SIGN_IN_POLL_MS = 2_000;
/** How long a stop waits for socket requests still executing, after the socket closed. */
export const HEADLESS_DRAIN_TIMEOUT_MS = 10_000;

type Execute = (request: AgentRequest) => Promise<AgentResponse>;

/** Boots the runner; resolves once it is serving `status` (and, when linked, once its database opened). */
export async function startHeadlessRunner(
  options: HeadlessRunnerOptions,
): Promise<RunningHeadlessRunner> {
  const { logger, dataDir } = options;
  let state: HeadlessRunnerState = "starting";
  let runner: HeadlessRunnerStatus["runner"] = null;
  let target: HeadlessRunnerStatus["target"] = null;
  let database: string | null = null;
  /** The link's lifecycle once this boot made one; it alone exchanges this link's tokens. */
  let lifecycle: HeadlessRunner | null = null;
  let backend: HeadlessBackendStatus | null = null;
  let lastHeartbeatAt: number | null = null;
  let lost: RunnerLinkLoss | null = null;
  let live: LiveHostCore | null = null;
  const snapshot = (): HeadlessRunnerStatus => ({
    state,
    runner,
    backend,
    target,
    database,
  });
  let stopRequested = false;
  const publish = (next?: HeadlessRunnerState): void => {
    // Once a stop began, only the stop's own states are published.
    const stopState = next === "draining" || next === "stopping" || next === "stopped";
    if (next !== undefined && (!stopRequested || stopState)) state = next;
    try {
      options.onStatus?.(snapshot());
    } catch (error) {
      logger.error("could not record the runner status", { error });
    }
  };
  /** The runner's state, followed from its lifecycle while it runs. */
  const follow = (): void => {
    const published = lifecycle?.snapshot().state;
    // A lifecycle starts out `unlinked` until it has read the saved link: that
    // is "connecting" here, never a lost credential. It is a loss only once
    // `onLost` named one.
    const seen = published === "unlinked" && lost === null ? "connecting" : published;
    if (seen === undefined || seen === "stopped") return publish();
    // A link whose credential is gone ended as a removal does, and says which.
    const next: HeadlessBackendState = seen === "unlinked" ? "revoked" : seen;
    const detail =
      seen === "offline"
        ? "Volli Cloud is unreachable."
        : seen === "revoked"
          ? "Volli Cloud removed or cut off this runner."
          : seen === "unlinked"
            ? "This runner's saved credential is no longer valid; link it again."
            : null;
    backend = {
      state: next,
      since: backend?.state === next ? backend.since : Date.now(),
      lastHeartbeatAt,
      detail,
    };
    if (state === "draining" || state === "stopping" || state === "stopped") return publish();
    publish(seen);
  };

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const abort = new AbortController();
  /** A boot that failed after `startHeadlessRunner` resolved; the process should stop and exit non-zero. */
  const failed = Promise.withResolvers<unknown>();
  let stopping: Promise<boolean> | undefined;
  /** The boot in progress or done; a stop waits for it before closing what it opened. */
  let booted: Promise<Booted | null> = Promise.resolve(null);

  /**
   * Fail closed until the runtime recovered: no answer to "is this worktree
   * busy" means the automatic reclaim skips rather than deletes.
   */
  const busySites: { current: BusyWorktreeSites } = {
    current: async () => {
      throw new Error("The headless Session runtime is not ready.");
    },
  };

  publish();
  const saved = await options.linkStore.load();
  if (saved === null) {
    publish("unlinked");
    logger.info("not linked: run `volli-runner link` to link this box");
    booted = waitForLink().then((link) => (link === null ? null : bootLinked(link)));
    booted.catch((error: unknown) => {
      logger.error("the runner could not boot", { error });
      failed.resolve(error);
    });
  } else {
    // Opening the database is part of starting: a refusal reaches the caller.
    const opened = openHost(saved);
    booted = connectLinked(saved, opened);
    booted.catch((error: unknown) => {
      logger.error("the runner could not boot", { error });
      failed.resolve(error);
    });
  }

  /** Looks for a saved link until one appears or the runner stops. */
  async function waitForLink(): Promise<RunnerLink | null> {
    const every = options.linkPollMs ?? HEADLESS_LINK_POLL_MS;
    while (!abort.signal.aborted) {
      await delay(every, abort.signal);
      if (abort.signal.aborted) return null;
      const link = await options.linkStore.load().catch((error: unknown) => {
        logger.warn("could not read the saved link", { error });
        return null;
      });
      if (abort.signal.aborted) return null;
      if (link !== null) return link;
    }
    return null;
  }

  async function bootLinked(link: RunnerLink): Promise<Booted | null> {
    publish("starting");
    return connectLinked(link, openHost(link));
  }

  interface Opened {
    host: LiveHostCore;
    ports: ReturnType<typeof headlessRunnerPorts>;
    socket: ReturnType<typeof createHostAgentSocket>;
    settle(execute: Execute): void;
    inflight: Set<Promise<AgentResponse>>;
    /** Read by the host's reclaim seams once the runtime is composed. */
    runtime: { current: ReturnType<typeof createRunnerComposition> | null };
  }

  interface Booted {
    host: LiveHostCore;
    stop(reason: string): Promise<boolean>;
  }

  /** Steps 2 and the socket: synchronous up to the database, so a refusal surfaces at once. */
  function openHost(link: RunnerLink): Opened {
    runner = { runnerId: link.runnerId, name: link.name };
    const ports = headlessRunnerPorts(logger);
    const runtime: Opened["runtime"] = { current: null };
    const host = createHostCore(ports, {
      dataDir,
      onTransactionViolation: throwTransactionViolation,
      devDiagnostics: false,
      secretStore: options.secretStore,
      modelAccess: () => options.modelAccess(),
      venue: headlessRunnerVenue,
      processReaders: {
        liveSessionIds: () => {
          if (runtime.current === null) throw notComposed();
          return runtime.current.tokens.liveSessionIds();
        },
        // No terminals are composed on a box.
        openTerminalCwds: () => [],
      },
      reclaim: {
        busyWorktreeSites: (directory) => busySites.current(directory),
        releaseAgentSites: async (directory) => {
          const sessions = runtime.current?.runtime ?? null;
          if (sessions === null) throw notComposed();
          return releaseAgentSites(sessions, directory, {
            newCommandId: randomUUID,
            onError: (sessionId, error) =>
              logger.error("could not release session from directory", {
                sessionId,
                directory,
                error,
              }),
          });
        },
      },
    });
    if (!isLiveHost(host)) {
      database = host.dbPath;
      throw new HeadlessRunnerBootError(
        "database",
        `The runner's database ${host.dbPath} did not open: ${host.database.error}`,
      );
    }
    database = host.dbPath;
    live = host;
    let settle!: (execute: Execute) => void;
    const ready = new Promise<Execute>((resolve) => {
      settle = resolve;
    });
    const inflight = new Set<Promise<AgentResponse>>();
    const socket = createHostAgentSocket();
    const track = (run: Promise<AgentResponse>): Promise<AgentResponse> => {
      inflight.add(run);
      const forget = () => inflight.delete(run);
      run.then(forget, forget);
      return run;
    };
    // Opened before recovery: a request waits for readiness (bounded by the socket's timeout).
    const opening = socket
      .start({
        socketPath: options.socketPath,
        execute: (request) =>
          track(
            ready.then((execute) =>
              state === "stopping" || state === "stopped"
                ? unreachable("The runner is stopping.")
                : execute(request),
            ),
          ),
      })
      .catch((error: unknown) => {
        logger.error("could not open the agent socket", { socketPath: options.socketPath, error });
      });
    void opening;
    return { host, ports, socket, settle, inflight, runtime };
  }

  /** Steps 3 to 5. Stays up, connecting nothing, when the link has ended. */
  async function connectLinked(link: RunnerLink, opened: Opened): Promise<Booted> {
    const { host } = opened;
    /** Socket requests answer at once rather than waiting for a readiness that will not come. */
    const notServing = (message: string) => opened.settle(async () => unreachable(message));
    /** What this boot opened so far, closed again if it fails partway. */
    const parts: BootParts = {};
    /** A runner that composed no runtime: its lifecycle, socket and database still close. */
    const stopHost = async (reason: string): Promise<boolean> => {
      notServing("The runner is not connected.");
      await stopLifecycle(parts.lifecycle);
      const report = await host.stop(reason);
      await opened.socket.shutdown();
      return report.clean;
    };
    try {
      const deployment = await options.deployment(link);
      if (abort.signal.aborted) return { host, stop: stopHost };
      const linked = createLifecycle(host, deployment, parts);
      publish("connecting");
      const owner = await resolveRunnerOwner({
        dataDir,
        runnerId: link.runnerId,
        // The lifecycle's own token source: one per link per process.
        token: () => linked.token(),
        signal: abort.signal,
        onRetry: (error, waitMs) =>
          logger.warn("could not reach Volli Cloud to learn this runner's owner", {
            error,
            waitMs,
          }),
      });
      if (owner.kind !== "owner" || abort.signal.aborted) {
        if (owner.kind === "lost") {
          publish(lost === "revoked" ? "revoked" : "unlinked");
          logger.warn("this runner's link ended before it connected", { reason: lost });
        }
        notServing("The runner is not connected.");
        return { host, stop: stopHost };
      }
      const composed = compose(link, opened, deployment, owner.ownerUserId, parts);
      return serve(link, opened, linked, composed);
    } catch (error) {
      // Nothing half-booted stays open: the lifecycle, the store, the socket and the database.
      notServing("The runner could not start.");
      try {
        await stopLifecycle(parts.lifecycle);
        parts.cloud?.dispose();
      } finally {
        await host.stop("boot failed");
        await opened.socket.shutdown();
      }
      throw error;
    }
  }

  /** Recorded as each is opened, so a boot that throws partway closes exactly those. */
  interface BootParts {
    lifecycle?: HeadlessRunner;
    cloud?: ReturnType<typeof createCloudProductStore>;
  }

  interface Composed {
    cloud: ReturnType<typeof createCloudProductStore>;
    composition: ReturnType<typeof createRunnerComposition>;
    runtimeOwner: ReturnType<ReturnType<typeof createRunnerComposition>["owner"]>;
  }

  /** `stop` must be awaited and caught: a sync shutdown error surfaces after the link closed. */
  async function stopLifecycle(linked: HeadlessRunner | undefined): Promise<void> {
    await linked?.stop().catch((error: unknown) => {
      logger.warn("the runner connection did not stop cleanly", { error });
    });
  }

  /**
   * The link's lifecycle (`cloud-runner/headless-runner.ts`): its token source,
   * presence, capabilities and reconnects. Built before the owner is known
   * (`token()` reads the claim); its sync rides the cloud store composed after.
   */
  function createLifecycle(
    host: LiveHostCore,
    deployment: HeadlessRunnerDeployment,
    parts: BootParts,
  ): HeadlessRunner {
    const signInPoll = options.signInPollMs ?? HEADLESS_SIGN_IN_POLL_MS;
    const linked = createHeadlessRunner({
      linkStore: options.linkStore,
      convex: {
        ...deployment.convex,
        url: deployment.url,
        siteUrl: deployment.siteUrl,
        ...(deployment.fetch === undefined ? {} : { fetch: deployment.fetch }),
      },
      platform: {
        service: options.service,
        readLoad: () => {
          const work = host.liveWork.current();
          return readRunnerLoad(
            { activeSessions: work.turns, activeTurns: work.turns, queueDepth: 0 },
            dataDir,
          );
        },
        readCapabilities: () =>
          runnerCapabilities(host, options, parts.cloud?.jobCapabilities ?? []),
        // A `volli-runner login` or `logout` rewrites the sign-in file from
        // another process: the providers this runner can serve are re-reported.
        onCapabilitiesChange: (listener) => {
          const changed = () => listener();
          watchFile(options.signInFile, { interval: signInPoll, persistent: false }, changed);
          return () => unwatchFile(options.signInFile, changed);
        },
      },
      log: logger,
      onTarget: (next) => {
        lastHeartbeatAt = Date.now();
        target = { targetVersion: next.targetVersion, minVersion: next.minVersion };
        options.onTarget?.(next);
        follow();
      },
      onChange: () => follow(),
      onLost: (reason) => {
        lost = reason;
        follow();
      },
      // Only reached by `start()`, after the store is composed.
      sync: (connected) => parts.cloud!.connect(connected),
    });
    parts.lifecycle = linked;
    lifecycle = linked;
    return linked;
  }

  /** The cloud store and the Session runtime over it. Synchronous. */
  function compose(
    link: RunnerLink,
    opened: Opened,
    deployment: HeadlessRunnerDeployment,
    ownerUserId: string,
    parts: BootParts,
  ): Composed {
    const { host, ports } = opened;
    const cloud = createCloudProductStore({
      host,
      ownerUserId,
      backendUrl: deployment.url,
      runnerId: () => link.runnerId,
      home: options.homeDir,
      busySites: (directory) => busySites.current(directory),
      environmentRecipes: () => true,
      // A `session.start` for a provider this box is not signed in to says where to sign in.
      signInHint: (providerId) => `run \`volli-runner login ${providerId}\``,
    });
    parts.cloud = cloud;
    const composition = createRunnerComposition({
      store: { kind: "cloud", host, cloud },
      ports,
      version: options.version,
      venue: headlessRunnerVenue(host.database.db),
      homeDir: options.homeDir,
      binDir: options.binDir,
      env: options.env,
      packaged: true,
      // A runner is a Volli Cloud runner: there is no flag-off box.
      cloudEnabled: () => true,
      ...(options.codeModeSandbox === undefined
        ? {}
        : { codeModeSandbox: options.codeModeSandbox }),
      secrets: new SecretService(options.secretStore),
      // Questions reach the person through Volli Cloud (`interaction.resolve`);
      // a secret card needs a secure field on this box, which it has not.
      capabilities: { askUser: true, requestSecret: false },
      // The unit's environment is the operator's; no rc file is executed.
      beforeExecution: async () => {},
      // Every Session command reaches THIS runner's socket through `volli`.
      sessionEnvironment: (budget) => {
        const env = { ...budget, [VOLLI_SOCKET_ENV]: options.socketPath };
        return options.sessionEnvironment?.(env) ?? env;
      },
      doors: (ready) => ({ experiments: null, busyWorktreeSites: busyFor(ready) }),
      installQuitHold: () => {},
    });
    opened.runtime.current = composition;
    function busyFor(ready: RunnerReady): BusyWorktreeSites {
      const { runtime } = recoveredRuntimeSessionServices(ready);
      const busy: BusyWorktreeSites = async (directory) => {
        // No terminals here: background shells and open agent turns are the live work.
        const sites = liveShellWorktreeSites(composition.shells);
        if (runtime !== null) {
          for (const binding of agentSitesWithin(runtime, directory)) {
            if ((await runtime.projection({ sessionId: binding.sessionId })).projection.turnActive)
              sites.push({ directory: binding.directory, surface: "agent" });
          }
        }
        return sites;
      };
      busySites.current = busy;
      return busy;
    }
    return {
      cloud,
      composition,
      runtimeOwner: composition.owner({ bind: (ready) => void composition.handlers(ready) }),
    };
  }

  /** Step 5: connect, then recovery, then the agent socket answers. */
  function serve(
    link: RunnerLink,
    opened: Opened,
    linked: HeadlessRunner,
    composed: Composed,
  ): Booted {
    const { host, ports } = opened;
    const { cloud, composition, runtimeOwner } = composed;
    // Before recovery: interrupted cloud turns wait for the first connection.
    // Its own retries cover an unreachable backend; a throw here is a bug to log.
    linked.start().catch((error: unknown) => {
      logger.error("the runner connection did not start", { error });
    });
    follow();
    // Not awaited here: recovery may wait on the first connection, and a stop
    // must be able to close the runtime that unblocks it.
    const starting = host.start({
      start: async () => {
        await runtimeOwner.start();
        const ready = await composition.ready();
        const commands = createHostAgentCommands(ports, {
          db: host.database.db,
          worktreeReads: host.worktreeReads,
          ...recoveredSessionCommandPorts(ready),
          // Board and remote-Session verbs answer from Volli Cloud (S6 routes).
          ...cloud.agentCommands,
          handlers: composition.handlers(ready),
          appVersion: options.version,
          verifySessionToken: composition.tokens.verify,
          cloudRunner: () => ({ name: link.name, state }),
        });
        opened.settle(commands.execute);
        host.maintenance.start();
        logger.info("serving", { socketPath: options.socketPath, runnerId: link.runnerId });
      },
      stopProducers: () => runtimeOwner.stopProducers(),
      close: async () => {
        try {
          await runtimeOwner.close();
        } finally {
          // `stopped`, then the link closes.
          await stopLifecycle(linked);
        }
      },
      drainRequests: async () => {
        // A request still waiting for readiness (a stop during recovery) answers now.
        opened.settle(async () => unreachable("The runner is stopping."));
        await opened.socket.shutdown();
        const drained = await settledWithin(opened.inflight, HEADLESS_DRAIN_TIMEOUT_MS);
        if (!drained)
          logger.error("abandoned requests still executing", { count: opened.inflight.size });
        return drained;
      },
    });
    starting.catch((error: unknown) => {
      opened.settle(async () => unreachable("The runner could not start."));
      if (abort.signal.aborted) return;
      logger.error("the runner could not start serving", { error });
      failed.resolve(error);
    });
    return {
      host,
      async stop(reason) {
        // `draining`, and no new claims, before the runtime closes.
        await linked.drain().catch((error: unknown) => {
          logger.warn("could not report draining", { error });
        });
        const report = await host.stop(reason);
        return report.clean;
      },
    };
  }

  return {
    status: snapshot,
    host: () => live,
    failure: failed.promise,
    stop(reason) {
      stopping ??= (async () => {
        logger.info("stopping", { reason });
        stopRequested = true;
        if (lifecycle !== null) publish("draining");
        abort.abort();
        let clean = true;
        let boot: Booted | null = null;
        try {
          boot = await booted;
        } catch {
          clean = false;
        }
        publish("stopping");
        if (boot !== null) {
          try {
            clean = (await boot.stop(reason)) && clean;
          } catch (error) {
            clean = false;
            logger.error("the runner did not stop cleanly", { error });
          }
        } else if (live !== null) {
          // Opened but never composed: the database still closes.
          clean = (await live.stop(reason)).clean && clean;
        }
        publish("stopped");
        logger.info("stopped", { clean });
        return clean;
      })();
      return stopping;
    },
  };
}

/** What this box reports about itself: no terminals or browser, its signed-in providers, its job kinds. */
async function runnerCapabilities(
  host: LiveHostCore,
  options: Pick<HeadlessRunnerOptions, "version" | "installMode" | "logger" | "service">,
  jobCapabilities: readonly string[],
): Promise<RunnerCapabilityReport> {
  const report = await probeRunnerCapabilities({
    version: options.version,
    installMode: options.installMode,
    terminals: false,
    browser: { state: "unavailable", reason: "headless" },
    docker: false,
    maxConcurrentSessions: Math.max(1, availableParallelism()),
    tools: [...jobCapabilities],
    localCredentials: await localCredentials(host, options.logger),
  });
  // A box is on mains power; whether it stays up is its service manager's (C1).
  return {
    ...report,
    capabilities: { ...report.capabilities, power: { source: "ac", alwaysOn: options.service } },
  };
}

/** The providers signed in on this box (Pi's store), by id and kind only. */
async function localCredentials(
  host: LiveHostCore,
  logger: HeadlessRunnerLogger,
): Promise<RunnerLocalCredential[]> {
  const access = host.runtimeServices.modelAccess;
  if (access === null) return [];
  try {
    const stored = await access.credentials.list();
    return stored
      .map((credential): RunnerLocalCredential => ({
        providerId: credential.providerId,
        kind: credential.type === "api_key" ? "api_key" : "subscription",
        expiresAt: null,
      }))
      .toSorted((a, b) => a.providerId.localeCompare(b.providerId));
  } catch (error) {
    logger.warn("could not read this runner's model sign-ins", { error });
    return [];
  }
}

function notComposed(): Error {
  return new Error("The headless Session runtime is not composed yet.");
}

function unreachable(message: string): AgentResponse {
  return { v: 1, ok: false, error: makeAgentError("APP_UNREACHABLE", message) };
}

/** Whether every execution settled within `timeoutMs`. */
async function settledWithin(
  inflight: ReadonlySet<Promise<unknown>>,
  timeoutMs: number,
): Promise<boolean> {
  if (inflight.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([Promise.allSettled(inflight).then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
