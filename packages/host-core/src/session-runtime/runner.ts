/**
 * The runner composition (VC-671): the Session runtime a host assembles.
 *
 * A host hands it the host it opened and the adapters only its environment
 * can answer — where a Session's commands find `volli`, what a person can be
 * asked, which browser a Session drives, the quit hold — and gets back the
 * services its doors read, the host-runtime owner `host.start` adopts, and
 * the recovered proof every ledger consumer needs. Everything between is
 * private staging: the attachment identities and their tokens, the
 * concurrency budget, the delegation store, observability, the background
 * shells, the attachment assembly, the facade/tool-door cycle, Automations
 * and the recovery lifecycle. Construction is synchronous and inert; the quit
 * hold is installed before anything can yield (`lifecycle.ts`). The drain
 * follows the host's own stop policy.
 *
 * The one fork is the product store: where projects, the board and Session
 * history live: frozen local SQLite, or the owner's cloud store over the runner ledger.
 */
import type { CodeModeSandboxAssets } from "@volli/agent-runtime";
import type { HostedSessionRuntime } from "@volli/session-engine";
import {
  DEFAULT_CODE_MODE_POLICY,
  displayTicketId,
  harnessAdapters,
  scrubInheritedSessionEnv,
  type RunnerIdentity,
} from "@volli/shared";
import { isLiveHost, type HostCore, type HostCorePorts, type HostRuntimeOwner } from "../index";
import { getProjectById } from "../db/projects-repo";
import { getTicket } from "../db/tickets-repo";
import { hostLogger } from "../log/root";
import { SESSION_RUNTIME } from "../session-services";
import { hostMcpDispatch } from "../mcp/dispatch-policy";
import { hostCodeMode } from "../codemode/dev-config";
import { AgentObservability } from "../observability/settings";
import type { SecretService } from "../secrets/service";
import {
  createSessionConcurrencyEnvReader,
  type SessionConcurrencyEnvReader,
} from "../session-concurrency";
import { createSessionTokenRegistry, type SessionTokenRegistry } from "../session-tokens";
import { BackgroundShellHost, type BackgroundShellHostPorts } from "../shell/background-shell-host";
import type { BrowserPictureStore } from "../browser/picture-store";
import type { HostHandlerMap } from "../handlers/handler-map";
import { createHostHandlers, type HostHandlerOptions } from "../handlers/host-handlers";
import { createAttachmentIdentities } from "./attachment-identity";
import { createRuntimeAssembly, type RuntimeAssemblyOptions } from "./assembly";
import { createRuntimeAutomations, type RuntimeAutomations } from "./automations";
import { createRuntimeContextResolver } from "./context";
import { createTicketSessionDelegationStore } from "./delegation-store";
import {
  createRuntimeSessionFacade,
  recoveredRuntimeSessionServices,
  recoveredSessionAutomationPorts,
  type RuntimeSessionFacade,
} from "./facade";
import {
  createSessionRuntimeLifecycle,
  type BootRecoveryReport,
  type RecoveredSessionServices,
  type SessionRuntimeLifecycle,
} from "./lifecycle";
import { readCodeModePolicy } from "./model-access-preferences";
import type { PiRuntimeHost } from "./pi-adapter";
import type { CloudProductStore } from "../cloud-store";
import { createLocalSessionEngine } from "../cloud-store/owner";
import { createCloudEnvironmentPreparation } from "../cloud-store/environment";
import { prepared } from "../db/prepared";
import { localSessionRow } from "../db/local-product";

/**
 * Where a runner's product state lives: projects, the board and Session
 * history. `local` is the host's own SQLite. A store is chosen here, once;
 * nothing below it forks on where state lives.
 */
export type RunnerProductStore =
  | { readonly kind: "local"; readonly host: HostCore }
  | { readonly kind: "cloud"; readonly host: HostCore; readonly cloud: CloudProductStore };

/** The recovered proof every ledger consumer requires (`lifecycle.ts`). */
export type RunnerReady = RecoveredSessionServices<RuntimeSessionFacade>;

/** The handler options the runner fills from the host and its recovered services. */
type RunnerHandlerServices =
  | "db"
  | "dataDir"
  | "pictures"
  | "runtime"
  | "sessions"
  | "submitSessionMessage"
  | "refineAutoTitle"
  | "modelAccess"
  | "automations"
  | "worktreeReads"
  | "detachedWork"
  | "sessionListing"
  | "ticketSignals";
/** Everything else a host's handler map needs: what its environment answers. */
export type RunnerDoorCapabilities = Omit<HostHandlerOptions, RunnerHandlerServices>;

export interface RunnerCompositionInput {
  store: RunnerProductStore;
  ports: Pick<HostCorePorts, "events" | "attention" | "power" | "connectivity" | "log">;
  /** The build, as the observability exporter names its service. */
  version: string;
  venue: RunnerIdentity;
  /** Upgrade-only ownership of a runner an older build recorded (`boot-recovery.ts`). */
  ownsLegacyRunner?(runner: RunnerIdentity): boolean;
  homeDir: string;
  /** Prepended to every Session command's PATH: where `volli` resolves. */
  binDir: string;
  /**
   * The process environment: developer opt-ins (MCP parallel reads, Code
   * Mode) and the no-clobber reference for each Session's concurrency budget.
   */
  env: Readonly<Record<string, string | undefined>>;
  /** A packaged build ignores the developer opt-ins above. */
  packaged: boolean;
  /** Whether the `cloud` flag is on now; read at every prompt-template load and by environment recipes. */
  cloudEnabled(): boolean;
  /**
   * Whether this launch shows Volli Cloud's board rather than this host's
   * (VC-889): its interrupted turns are then not resumed on their own.
   */
  cloudLaunch?(): boolean;
  /** Where Code Mode's worker and WebAssembly are; absent offers no Code Mode. */
  codeModeSandbox?: CodeModeSandboxAssets;
  secrets: SecretService;
  /** What a person at this host can answer for a Session, and the browser it can drive. */
  capabilities: {
    askUser: boolean;
    requestSecret: boolean;
    browser?: RuntimeAssemblyOptions["browser"];
    /** The screenshot store, when the host shows pictures outside the runtime. */
    pictures?: BrowserPictureStore;
  };
  /** Before a Session command runs: desktop's login-PATH adoption. */
  beforeExecution(): Promise<unknown>;
  /** The host's additions to a Session command's environment, over its concurrency budget. */
  sessionEnvironment?(budget: Record<string, string>): Record<string, string>;
  /** A client's live feed of background shells; the host's live work is always fed. */
  shellFeed?: Pick<BackgroundShellHostPorts, "publishState" | "publishRemoved">;
  /**
   * What only this host's doors know, for the one handler map the runner
   * builds over the recovered services (VC-668, VC-923): its worktree guard,
   * experiments, terminals, sign-ins, relays and logs. The Session services,
   * the database and the host's own readers are the runner's to supply.
   */
  doors(ready: RunnerReady): RunnerDoorCapabilities;
  /** A transport built from ready services, closed inside the Session drain. */
  transport?(): { close(): Promise<void> } | null;
  /** Synchronous: desktop installs its accepted-quit hold over `close`. */
  installQuitHold(close: () => Promise<void>): void;
  /** The host's own producers, stopped beside the scheduler and the agent watches. */
  stopProducers?(): void;
}

/** What the host's edge adds when `host.start` adopts the runner. */
export interface RunnerHostEdge {
  /** Binds the recovered services, after Automations start and before the tool door. */
  bind?(ready: RunnerReady): void | Promise<void>;
  closeSocket?(): Promise<boolean | void>;
  drainRequests?(): Promise<boolean | void>;
  /** Runs before the runner's own close (a transport that streams from it). */
  beforeClose?(): Promise<void>;
}

export interface RunnerComposition {
  /** The Session runtime; null when the host or its model access did not come up. */
  readonly runtime: HostedSessionRuntime | null;
  readonly piRuntimeHost: PiRuntimeHost | null;
  readonly piSessionsDirectory: string;
  readonly pictures: BrowserPictureStore;
  readonly transcriptArtifacts: ReturnType<typeof createRuntimeAssembly>["transcriptArtifacts"];
  readonly shells: BackgroundShellHost;
  /** Minted per attachment, verified at the agent socket. */
  readonly tokens: SessionTokenRegistry;
  /** Null when there is no Session Engine to count the fleet with. */
  readonly concurrency: SessionConcurrencyEnvReader | null;
  readonly observability: AgentObservability | null;
  readonly automations: RuntimeAutomations;
  /** The host's one handler map over the recovered services, built on first ask. */
  handlers(ready: RunnerReady): HostHandlerMap;
  /** The owner `host.start` adopts: recovery, Automations, the tool door, then `edge.bind`. */
  owner(edge?: RunnerHostEdge): HostRuntimeOwner;
  /** The recovered proof; starts or joins recovery. */
  ready(): Promise<RunnerReady>;
  /** What this launch's boot recovery did, for a support report; `null` until it finished. */
  bootRecovery(): BootRecoveryReport | null;
}

/** Synchronous and inert: no ledger is read until `owner().start` or `ready()`. */
export function createRunnerComposition(input: RunnerCompositionInput): RunnerComposition {
  const { store, ports, venue } = input;
  const host = store.host;
  const live = isLiveHost(host) ? host : undefined;
  const db = live?.database.db ?? null;
  const localTicketDisplayIdOf = (ticketId: string): string | null => {
    if (db === null) return null;
    const ticket = getTicket(db, ticketId);
    const project = ticket === undefined ? undefined : getProjectById(db, ticket.projectId);
    return ticket && project ? displayTicketId(project.ticketPrefix, ticket.ticketNumber) : null;
  };
  // The one store fork. Every consumer below receives the selected ports,
  // including the facade, agent door, recovery and listing readers.
  const product =
    store.kind === "cloud"
      ? {
          engine: store.cloud.engine,
          brief: store.cloud.brief,
          locations: store.cloud.locations,
          sessionBirth: store.cloud.sessionBirth,
          ticketDisplayIdOf: store.cloud.ticketDisplayIdOf,
          recordSessionStarted: null,
          ownsSession: store.cloud.ownsSession,
          projectIds: store.cloud.projectIds,
          projects: () =>
            store.cloud.projectIds().flatMap((id) => {
              const project = db === null ? undefined : getProjectById(db, id);
              return project === undefined ? [] : [project];
            }),
          inProcessWatches: false,
          bindRuntime: store.cloud.bindRuntime,
          bindNotices: store.cloud.bindNotices,
          bindEnvironment: store.cloud.bindEnvironment,
          dispose: store.cloud.dispose,
        }
      : {
          engine:
            db === null || live === undefined
              ? null
              : createLocalSessionEngine({ db, engine: live.sessionEngine }),
          brief: undefined,
          locations: undefined,
          sessionBirth: undefined,
          ticketDisplayIdOf: localTicketDisplayIdOf,
          recordSessionStarted: undefined,
          ownsSession:
            db === null
              ? undefined
              : (id: string) =>
                  prepared(
                    db,
                    `SELECT 1 FROM sessions WHERE id = ? AND ${localSessionRow("sessions.id")}`,
                  ).get(id) !== undefined,
          projectIds: undefined,
          projects: undefined,
          inProcessWatches: true,
          bindRuntime: undefined,
          bindNotices: undefined,
          bindEnvironment: undefined,
          dispose: undefined,
        };
  const sessionEngine = product.engine;
  // One runtime per host's Session services, claimed before anything is built.
  const bindSessionRuntime = live?.[SESSION_RUNTIME].claim();
  const runtimeServices = live?.runtimeServices;

  const delegation = db === null ? null : createTicketSessionDelegationStore(db);
  const tokens = createSessionTokenRegistry();
  // One identity per attachment, shared by `execute` and background shells
  // (VC-270): a second mint would retire the token already exported.
  const identities = createAttachmentIdentities({
    mint: tokens.mint,
    revoke: tokens.revoke,
    ticketDisplayIdOf: product.ticketDisplayIdOf,
  });
  // The opt-in export (VC-119): a profile that never asked builds no exporter.
  const observability =
    db === null ? null : new AgentObservability({ db, serviceVersion: input.version });
  observability?.start();
  const mcpDispatch = hostMcpDispatch({
    env: input.env,
    packaged: input.packaged,
    log: hostLogger("mcp").warn,
  });
  const codeMode = hostCodeMode({
    env: input.env,
    packaged: input.packaged,
    log: hostLogger("codemode").warn,
    policy: () => (db === null ? DEFAULT_CODE_MODE_POLICY : readCodeModePolicy(db)),
    sandboxAvailable: input.codeModeSandbox !== undefined,
  });
  // Where a shell's exit or match is steered (VC-495): the lifecycle below.
  let lifecycle: SessionRuntimeLifecycle<RuntimeSessionFacade>;
  const shells = new BackgroundShellHost({
    redactOutput: (text) => input.secrets.store.redact(text),
    redactNoticeOutput: (text) => input.secrets.store.redactPartial(text),
    onNotice: (notice) => lifecycle.relayShellNotice(notice),
    // The host's live work counts running shells (VC-577) off the same feed
    // a client gets, so the two can never disagree about one shell.
    publishState: (started) => {
      live?.liveWork.observeShell(started);
      input.shellFeed?.publishState(started);
    },
    publishRemoved: (shellId) => {
      live?.liveWork.forgetShell(shellId);
      input.shellFeed?.publishRemoved(shellId);
    },
    // One row per started shell (VC-341).
    ...(live === undefined ? {} : { ledger: live.maintenance.spawnLedger }),
  });
  // This process's one reader of who is working (VC-403).
  const concurrency: SessionConcurrencyEnvReader | null =
    sessionEngine === null
      ? null
      : createSessionConcurrencyEnvReader({
          listAttachedSessions: () => sessionEngine.listAttachedSessions(),
        });
  // One Session's share of the machine (VC-339), under the host's additions.
  const concurrencyEnvFor = async (sessionId: string): Promise<Record<string, string>> => {
    const budget =
      concurrency === null
        ? {}
        : await concurrency({ excludeSessionId: sessionId, environment: input.env });
    return input.sessionEnvironment?.(budget) ?? budget;
  };
  if (db !== null && product.bindEnvironment !== undefined) {
    product.bindEnvironment(
      createCloudEnvironmentPreparation({
        db,
        home: input.homeDir,
        power: ports.power,
        environment: async (sessionId) => {
          await input.beforeExecution();
          const inherited = scrubInheritedSessionEnv(process.env, harnessAdapters);
          const path = inherited["PATH"];
          return {
            shellPath: process.env["SHELL"] || "/bin/sh",
            env: {
              ...inherited,
              ...(await concurrencyEnvFor(sessionId)),
              PATH:
                path === undefined || path.length === 0 ? input.binDir : `${input.binDir}:${path}`,
            },
          };
        },
      }),
    );
  }
  const assemblyInputs: Omit<RuntimeAssemblyOptions, "resolveRuntimeContext"> = {
    dbHandle: host.database,
    sessionEngine,
    ...(product.locations === undefined ? {} : { locations: product.locations }),
    ...(product.ownsSession === undefined ? {} : { ownsSession: product.ownsSession }),
    sessionWake: live?.sessionWakeBus.subscribe ?? null,
    dataDir: host.dataDir,
    binDir: input.binDir,
    venue,
    hostPorts: ports,
    environmentRecipes: { enabled: () => input.cloudEnabled(), power: ports.power },
    modelAccess: runtimeServices?.modelAccess ?? null,
    decisions: runtimeServices?.decisions ?? null,
    webAccess: runtimeServices?.webAccess ?? null,
    mcpSettings: runtimeServices?.mcp ?? null,
    mcpDispatch,
    codeMode,
    ...(input.codeModeSandbox === undefined ? {} : { codeModeSandbox: input.codeModeSandbox }),
    ...(input.capabilities.pictures === undefined ? {} : { pictures: input.capabilities.pictures }),
    observability,
    delegation,
    secrets: input.secrets,
    attachmentIdentities: identities,
    shells,
    ...(input.capabilities.browser === undefined ? {} : { browser: input.capabilities.browser }),
    askUser: input.capabilities.askUser,
    requestSecret: input.capabilities.requestSecret,
    beforeExecution: input.beforeExecution,
    concurrencyEnvFor,
    // The facade/tool-door cycle: no verb runs before both exist, and every
    // acquisition still passes ready().
    callVerb: async (caller, request, signal, budgetAsk) => {
      const door = agents.toolDoor(await lifecycle.ready());
      if (door === null) throw new Error("This host has no Volli verb handlers.");
      signal.throwIfAborted();
      return door(caller, request, signal, budgetAsk);
    },
  };
  const assembly: ReturnType<typeof createRuntimeAssembly> =
    db !== null && sessionEngine !== null && delegation !== null
      ? createRuntimeAssembly({
          ...assemblyInputs,
          resolveRuntimeContext: createRuntimeContextResolver({
            db,
            sessionEngine,
            venue,
            mcpDispatch,
            // Boot reconciliation is itself an internal consumer; awaiting
            // ready here would make recovery wait on its own promise.
            waitForBirth: (sessionId) => facade.waitForBirth(sessionId),
            toolSurface: () => assembly.sessionToolSurface,
            ...(product.brief === undefined ? {} : { brief: product.brief }),
          }),
        })
      : createRuntimeAssembly({ ...assemblyInputs, resolveRuntimeContext: async () => null });
  const automations = createRuntimeAutomations({
    // Its metadata, never the host bag.
    host: { database: host.database, dataDir: host.dataDir },
    events: ports.events,
    piRuntimeHost: assembly.piRuntimeHost,
    homeDir: input.homeDir,
    cloudEnabled: () => input.cloudEnabled(),
    log: hostLogger("automations"),
  });
  const facade = createRuntimeSessionFacade({
    host,
    assembly,
    homeDir: input.homeDir,
    venue,
    decisions: runtimeServices?.decisions ?? null,
    delegation,
    ...(sessionEngine === null ? {} : { sessionEngine }),
    ...(product.sessionBirth === undefined ? {} : { sessionBirth: product.sessionBirth }),
    ...(product.recordSessionStarted === undefined
      ? {}
      : { recordSessionStarted: product.recordSessionStarted }),
  });
  product.bindRuntime?.(assembly.sessionRuntime, assembly.transcriptArtifacts);
  const agents = facade.agents({
    host,
    delegation,
    automations,
    mcpSettings: runtimeServices?.mcp ?? null,
    events: ports.events,
    log: hostLogger("session-agents"),
    handlers: (ready) => handlersFor(ready),
    ...(product.projects === undefined ? {} : { projects: product.projects }),
    inProcessWatches: product.inProcessWatches,
    ...(store.kind === "cloud" ? { cloudSessionVerbs: store.cloud.cloudSessionVerbs } : {}),
  });
  let handlerMap: HostHandlerMap | undefined;
  /** Built once, from the first recovered proof a door or the tool door brings. */
  const handlersFor = (ready: RunnerReady): HostHandlerMap => {
    if (handlerMap !== undefined) return handlerMap;
    // The host's answers first: a host that cannot serve refuses here.
    const doors = input.doors(ready);
    const { runtime, sessions, submitKickoffMessage, autoTitler } =
      recoveredRuntimeSessionServices(ready);
    handlerMap = createHostHandlers(ports, {
      ...doors,
      db,
      dataDir: host.dataDir,
      runtime,
      sessions,
      // The start every agent door reaches (VC-923): its kickoff and its title.
      ...(submitKickoffMessage === undefined ? {} : { submitSessionMessage: submitKickoffMessage }),
      ...(autoTitler === null
        ? {}
        : { refineAutoTitle: (request) => void autoTitler.refine(request) }),
      pictures: assembly.pictures,
      modelAccess: assembly.piRuntimeHost,
      environmentRecipes: () => input.cloudEnabled(),
      automations,
      // The host's one worktree read service (VC-788): a scope switch's
      // materialization and a Done trim retire the answers it holds.
      worktreeReads: live?.worktreeReads ?? null,
      ...(live === undefined ? {} : { detachedWork: live.detachedWork }),
      // The listing rows (VC-713), live-ness from this process's executor bindings.
      sessionListing:
        sessionEngine === null || db === null
          ? null
          : {
              db,
              listSessions: (query) => sessionEngine.listSessions(query),
              liveAttachmentIds: () =>
                new Set(
                  (runtime?.openNativeBindings() ?? []).map((binding) => binding.attachmentId),
                ),
            },
      ticketSignals:
        sessionEngine === null
          ? null
          : (projectId) => sessionEngine.listLatestTicketSignals({ projectId }),
    });
    return handlerMap;
  };
  const stopProducers = (): void => {
    try {
      input.stopProducers?.();
    } finally {
      automations.stop();
      agents.stop();
    }
  };
  // The host's policy decides the drain: `desktop-quit` joins only the Session
  // lifecycle (and `transport`); `drain-and-close` also closes the background
  // shells before the database and settles Automations.
  const fullDrain = host.stopPolicy === "drain-and-close";
  lifecycle = createSessionRuntimeLifecycle<RuntimeSessionFacade>({
    venue,
    ...(input.ownsLegacyRunner === undefined ? {} : { ownsLegacyRunner: input.ownsLegacyRunner }),
    ...(input.cloudLaunch === undefined ? {} : { cloudLaunch: input.cloudLaunch }),
    host,
    ports,
    ...(sessionEngine === null ? {} : { sessionEngine }),
    ...(product.ownsSession === undefined ? {} : { ownsSession: product.ownsSession }),
    ...(product.projectIds === undefined ? {} : { projectIds: product.projectIds }),
    runtime: assembly.sessionRuntime,
    rpc: () => {
      const transport = input.transport?.() ?? null;
      if (!fullDrain) return transport;
      // A full drain joins shell termination before SQLite closes.
      return {
        close: async () => {
          try {
            if (transport !== null) await transport.close();
          } finally {
            await shells.close();
          }
        },
      };
    },
    observability,
    delegation,
    delegationsFor: agents.recoveryDelegationsFor,
    services: () => facade,
    stopProducers,
    installQuitHold: (close) => input.installQuitHold(close),
  });
  // Backend-queued notices (`session.notice` jobs) enter the same owner-scoped
  // outbox and delivery as this machine's own producers (VC-887).
  product.bindNotices?.({ enqueue: (intent) => lifecycle.enqueueHostNotice(intent) });
  // The host's Session services hear what only the runtime and its lifecycle
  // know: open bindings, pending starts and the start latch (VC-577), and
  // every folded projection, for scheduled resume.
  const runtime = assembly.sessionRuntime;
  bindSessionRuntime?.({
    observeScheduledResume: lifecycle.observeScheduledResume,
    ...(runtime === null
      ? {}
      : {
          openNativeBindings: () => runtime.openNativeBindings(),
          pendingTurnStarts: () => runtime.pendingTurnStarts(),
          holdTurnStarts: () => runtime.holdTurnStarts(),
          releaseTurnStarts: () => runtime.releaseTurnStarts(),
        }),
  });
  const close = async (): Promise<void> => {
    try {
      await lifecycle.close();
      if (fullDrain) await automations.settled();
    } finally {
      product.dispose?.();
    }
  };
  return {
    runtime: assembly.sessionRuntime,
    piRuntimeHost: assembly.piRuntimeHost,
    piSessionsDirectory: assembly.piSessionsDirectory,
    pictures: assembly.pictures,
    transcriptArtifacts: assembly.transcriptArtifacts,
    shells,
    tokens,
    concurrency,
    observability,
    automations,
    handlers: handlersFor,
    owner: (edge = {}) => ({
      start: async () => {
        const ready = await lifecycle.ready();
        // Nothing schedules before runtime recovery.
        automations.start(recoveredSessionAutomationPorts(ready));
        try {
          await edge.bind?.(ready);
        } catch (error) {
          // A host whose doors never bound runs no scheduler.
          automations.stop();
          throw error;
        }
        agents.toolDoor(ready);
      },
      stopProducers,
      close: async () => {
        try {
          await edge.beforeClose?.();
        } finally {
          await close();
        }
      },
      ...(edge.closeSocket === undefined ? {} : { closeSocket: edge.closeSocket }),
      ...(edge.drainRequests === undefined ? {} : { drainRequests: edge.drainRequests }),
    }),
    ready: () => lifecycle.ready(),
    bootRecovery: () => lifecycle.bootRecovery(),
  };
}
