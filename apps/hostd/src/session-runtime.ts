/** Headless ports over the same assembly, facade, recovery and drain desktop uses. */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  piHostCredentials,
  piOwnedModelAccess,
  piSignIn,
  type PiModelAccess,
  type CodeModeSandboxAssets,
} from "@volli/agent-runtime";
import { displayTicketId, VOLLI_SOCKET_ENV, type SessionExecutionVenue } from "@volli/shared";
import type { HostCorePorts, LiveHostCore } from "@volli/host-core";
import type { RetentionReclaimSeams } from "@volli/host-core/maintenance";
import { getProjectById, getTicket } from "@volli/host-core/db";
import type { BoardChangeFeed } from "@volli/host-core/board";
import { createHostHandlers, type SessionReadPort } from "@volli/host-core/handlers";
import type { LogRing } from "@volli/host-core/log";
import { SecretService } from "@volli/host-core/secrets";
import { AgentObservability, hostMcpDispatch, hostCodeMode } from "@volli/host-core/integrations";
import {
  createSessionTokenRegistry,
  createSessionConcurrencyEnvReader,
} from "@volli/host-core/sessions";
import {
  BackgroundShellHost,
  readCodeModePolicy,
  createAttachmentIdentities,
  createRuntimeAssembly,
  createRuntimeContextResolver,
  createRuntimeAutomations,
  createTicketSessionDelegationStore,
  createRuntimeSessionFacade,
  recoveredSessionCommandPorts,
  recoveredSessionAutomationPorts,
  recoveredRuntimeSessionServices,
  createSessionRuntimeLifecycle,
  fileGitCredentialStore,
  GIT_CREDENTIALS_FILE,
  HostSignIns,
} from "@volli/host-core/session-runtime";
import {
  agentSitesWithin,
  releaseAgentSites,
  liveShellWorktreeSites,
  type BusyWorktreeSites,
  type AgentSiteRuntime,
} from "@volli/host-core/worktree";
import type { HeadlessSecrets } from "./secrets";
import { ownsLegacyHostdVenue } from "./venue";
import { sessionGitEnv } from "./agent-git-env";
import { createHostWorkspaces } from "./host-workspaces";

export interface HeadlessRuntimeOptions {
  binDir: string;
  venue: SessionExecutionVenue;
  codeModeSandbox?: CodeModeSandboxAssets;
  /** A scripted provider replaces only the wire in host-container and integration proofs. */
  modelAccess?: PiModelAccess;
  /**
   * Volli's git credential helper (VC-702), as git's `credential.helper`
   * value: a `!`-command that answers from this host's push-credential
   * store. Set, every Session command's environment installs it as
   * command-scope git configuration; absent or null (the `cloud` flag off),
   * Sessions push exactly as before.
   */
  gitCredentialHelper?: string | null;
  /** The box's platform (`process.platform`): on a Mac, Session git never reaches the keychain. */
  platform?: string;
  /** Host-scope project creation, composed only behind cloud. */
  projectsRoot?: string | null;
  userInstall?: boolean;
}

function headlessHomeDir(env: Readonly<Record<string, string | undefined>>): string {
  return env["HOME"] || homedir();
}

/**
 * The host's model access, built when host-core's runtime services are first
 * read. A service account's Pi auth lives where its own environment says
 * (`PI_CODING_AGENT_DIR`, else `$HOME/.pi/agent`), never the machine user's.
 */
export function headlessModelAccess(
  env: Readonly<Record<string, string | undefined>>,
  options: Pick<HeadlessRuntimeOptions, "modelAccess">,
): PiModelAccess {
  return (
    options.modelAccess ??
    piOwnedModelAccess({
      agentDir: env["PI_CODING_AGENT_DIR"] || join(headlessHomeDir(env), ".pi", "agent"),
    })
  );
}

/** A worktree question asked before boot recovery finished. */
function notReady(): Error {
  return new Error("The headless Session runtime is not ready.");
}

/** Synchronous ownership first; ready() is the only public ledger-consuming door. */
export function createHeadlessSessionRuntime(input: {
  host: LiveHostCore;
  version: string;
  ports: HostCorePorts;
  /** The host's board change feeds (VC-565): its bus already feeds them. */
  boardFeed?: BoardChangeFeed;
  secrets: HeadlessSecrets;
  env: Readonly<Record<string, string | undefined>>;
  /** The agent socket this host serves; every Session command is pointed at it. */
  socketPath: string;
  options: HeadlessRuntimeOptions;
  /** The host's recent log (VC-699), when the process keeps one: what `host.logs` reads. */
  logs?: LogRing | null;
}) {
  const { host, ports, env, options } = input;
  const db = host.database.db;
  const sessionEngine = host.sessionEngine;
  const homeDir = headlessHomeDir(env);
  // One lazy module: its model access is `headlessModelAccess`, handed to host-core.
  const { modelAccess, decisions, mcp: mcpSettings, webAccess } = host.runtimeServices;
  const mcpDispatch = hostMcpDispatch({
    env,
    packaged: true,
    log: (message) => ports.log.warn(message),
  });
  const codeMode = hostCodeMode({
    env,
    packaged: true,
    policy: () => readCodeModePolicy(db),
    sandboxAvailable: options.codeModeSandbox !== undefined,
    log: (message) => ports.log.warn(message),
  });
  const secrets = new SecretService(input.secrets.store);
  const gitHelper = options.gitCredentialHelper ?? null;

  const delegation = createTicketSessionDelegationStore(db);
  const tokens = createSessionTokenRegistry();
  const identities = createAttachmentIdentities({
    mint: tokens.mint,
    revoke: tokens.revoke,
    ticketDisplayIdOf: (ticketId) => {
      const ticket = getTicket(db, ticketId);
      const project = ticket === undefined ? undefined : getProjectById(db, ticket.projectId);
      return ticket && project ? displayTicketId(project.ticketPrefix, ticket.ticketNumber) : null;
    },
  });
  const observability = new AgentObservability({ db, serviceVersion: input.version });
  const shells = new BackgroundShellHost({
    ledger: host.maintenance.spawnLedger,
    redactOutput: (text) => secrets.store.redact(text),
    redactNoticeOutput: (text) => secrets.store.redactPartial(text),
    onNotice: (notice) => lifecycle.relayShellNotice(notice),
    publishState: () => {},
    publishRemoved: () => {},
  });
  const concurrency = createSessionConcurrencyEnvReader({
    listAttachedSessions: () => sessionEngine.listAttachedSessions(),
  });
  const assembly: ReturnType<typeof createRuntimeAssembly> = createRuntimeAssembly({
    dbHandle: host.database,
    sessionEngine,
    dataDir: host.dataDir,
    binDir: options.binDir,
    venue: options.venue,
    hostPorts: ports,
    modelAccess,
    decisions,
    webAccess,
    mcpSettings,
    mcpDispatch,
    codeMode,
    ...(options.codeModeSandbox === undefined ? {} : { codeModeSandbox: options.codeModeSandbox }),
    observability,
    delegation,
    secrets,
    attachmentIdentities: identities,
    shells,
    // Remote chat answers questions through session.command → interaction.resolve.
    // VC-9 still withholds ask_user from children in the shared Role policy.
    askUser: true,
    // Secret cards need a secure field on the box's side; unavailable in v1.
    requestSecret: false,
    // systemd/launchd environment is operator-owned; no rc files are executed.
    beforeExecution: async () => {},
    // Every command a Session runs, through `execute` and background shells
    // alike, is handed this record (VC-563). Beside the concurrency budget it
    // names this host's socket: desktop bakes its socket into the generated
    // `volli` shim, while the artifact's `bin/volli` is one launcher shared
    // with operators and bakes nothing. Without it the agent's `volli` answers
    // APP_UNREACHABLE and `session done` cannot reach the host that runs it.
    // The Session's identity is still composed after this, never from here.
    // A Session's git (VC-700, VC-702): on a Mac the keychain helper is reset
    // first, and Volli's push-credential helper (behind `cloud`) is appended
    // after it, never over it.
    concurrencyEnvFor: async (sessionId) =>
      sessionGitEnv(
        {
          ...(await concurrency({ excludeSessionId: sessionId, environment: env })),
          [VOLLI_SOCKET_ENV]: input.socketPath,
        },
        options.platform ?? process.platform,
        gitHelper,
      ),
    resolveRuntimeContext: createRuntimeContextResolver({
      db,
      sessionEngine,
      venue: options.venue,
      mcpDispatch,
      // Boot reconciliation is itself an internal consumer; awaiting ready
      // here would make recovery wait on its own unfinished promise.
      waitForBirth: (sessionId) => facade.waitForBirth(sessionId),
      toolSurface: () => assembly.sessionToolSurface,
    }),
    callVerb: async (caller, request, signal, budgetAsk) => {
      const door = agents.toolDoor(await lifecycle.ready());
      if (door === null) throw new Error("The headless tool door is unavailable.");
      signal.throwIfAborted();
      return door(caller, request, signal, budgetAsk);
    },
  });
  const automations = createRuntimeAutomations({
    host: { database: host.database, dataDir: host.dataDir },
    events: ports.events,
    piRuntimeHost: assembly.piRuntimeHost,
    homeDir,
    log: ports.log,
  });
  const facade = createRuntimeSessionFacade({
    host,
    assembly,
    homeDir,
    venue: options.venue,
    events: ports.events,
    decisions,
    delegation,
  });
  const agents = facade.agents({
    host,
    delegation,
    automations,
    mcpSettings,
    events: ports.events,
    log: ports.log,
  });
  const lifecycle = createSessionRuntimeLifecycle({
    venue: options.venue,
    ownsLegacyVenue: ownsLegacyHostdVenue,
    host,
    ports,
    runtime: assembly.sessionRuntime,
    // The headless resource drain joins shell termination before SQLite closes.
    rpc: () => ({ close: () => shells.close() }),
    observability,
    delegation,
    delegationsFor: agents.recoveryDelegationsFor,
    services: () => facade,
    stopProducers: () => {
      automations.stop();
      agents.stop();
    },
    installQuitHold: () => {},
  });
  observability.start();
  /** Set once recovery has finished; until then every worktree question refuses. */
  let recovered: { busyWorktreeSites: BusyWorktreeSites; runtime: AgentSiteRuntime } | undefined;
  /**
   * The retention reclaim's seams (VC-113). Fail closed: before recovery
   * there is no answer to "is this worktree busy", so the question throws and
   * the automatic reclaim and trim skip rather than delete.
   */
  const reclaim: Required<RetentionReclaimSeams> = {
    busyWorktreeSites: async (target) => {
      if (recovered === undefined) throw notReady();
      return recovered.busyWorktreeSites(target);
    },
    releaseAgentSites: async (directory) => {
      if (recovered === undefined) throw notReady();
      return releaseAgentSites(recovered.runtime, directory, {
        newCommandId: randomUUID,
        onError: (sessionId, error) =>
          ports.log.error("could not release session from directory", {
            sessionId,
            directory,
            error,
          }),
      });
    },
  };
  let workspaces: ReturnType<typeof createHostWorkspaces> | undefined;
  return {
    close: async () => {
      try {
        await workspaces?.close();
      } finally {
        try {
          await lifecycle.close();
        } finally {
          await automations.settled();
        }
      }
    },
    /** The scheduler and armed Runs: the host lifecycle's synchronous first step. */
    stopProducers: () => {
      automations.stop();
      agents.stop();
    },
    /** Sessions holding a live attachment token, read on every orphan scan. */
    liveSessionIds: () => tokens.liveSessionIds(),
    reclaim,
    async ready() {
      const ready = await lifecycle.ready();
      const { sessions, runtime, piRuntimeHost } = recoveredRuntimeSessionServices(ready);
      if (sessions === null || runtime === null)
        throw new Error("The headless Session runtime is unavailable.");
      automations.start(recoveredSessionAutomationPorts(ready));
      agents.toolDoor(ready);
      const busyWorktreeSites: BusyWorktreeSites = async (target) => {
        // No terminals are composed on this host. When a terminal port lands,
        // its live cwds must join this supplier rather than bypassing the guard.
        const sites = liveShellWorktreeSites(shells);
        for (const binding of agentSitesWithin(runtime, target)) {
          // An unreadable Session refuses automatic trim; no fail-open deletion.
          if ((await runtime.projection({ sessionId: binding.sessionId })).projection.turnActive) {
            sites.push({ directory: binding.directory, surface: "agent" });
          }
        }
        return sites;
      };
      recovered = { busyWorktreeSites, runtime };
      // Sign-ins on this host (VC-702): keys and push credentials a Client
      // sends land in the host's own stores (Pi's auth storage; the
      // push-credential file under the data directory), and subscription
      // logins run here, over the same Pi collection the runtime reads.
      const signIns =
        modelAccess === null || piRuntimeHost === null
          ? null
          : new HostSignIns({
              pi: piSignIn(modelAccess.models, {
                // Sign in with ChatGPT names the installation to OpenAI: on
                // a host, its persisted host id, a UUID.
                deviceId: () => options.venue.id,
              }),
              inspect: () => piRuntimeHost.inspectModelAccess({}),
              keys: {
                models: piHostCredentials(modelAccess.credentials),
                git: fileGitCredentialStore(join(host.dataDir, GIT_CREDENTIALS_FILE)),
              },
            });
      workspaces ??=
        options.projectsRoot == null
          ? undefined
          : createHostWorkspaces({
              db,
              projectsRoot: options.projectsRoot,
              userInstall: options.userInstall ?? true,
              env: input.env,
              gitCredentialHelper: options.gitCredentialHelper ?? "",
              detachedWork: host.detachedWork,
              onCreated: (project) =>
                ports.events.publish("data-changed", { projectId: project.id }),
            });
      let sessionReads: SessionReadPort | undefined;
      return {
        ...recoveredSessionCommandPorts(ready),
        /**
         * Hands the map its Session reads (VC-663, D4): the agent command
         * service's Workspace-scoped `executeInWorkspace`, which is built
         * after this map, so the map forwards to it once served.
         */
        serveSessionReads(read: SessionReadPort): void {
          sessionReads = read;
        },
        venue: options.venue,
        verifySessionToken: tokens.verify,
        automationsAvailable: automations.kind === "live" && automations.execution.kind === "ready",
        // The host's one handler map (VC-668): every door this host serves
        // projects it. hostd keeps no experiments and composes no terminals,
        // so those handlers answer unavailable and a backward move interrupts
        // nothing a terminal holds.
        handlers: createHostHandlers(ports, {
          db,
          dataDir: host.dataDir,
          runtime,
          sessions,
          modelAccess: piRuntimeHost,
          experiments: null,
          automations,
          busyWorktreeSites,
          detachedWork: host.detachedWork,
          // Served before any door opens: hostd hands it over before it
          // settles the socket or starts the listener.
          sessionReads: (verb, workspaceId, args) => sessionReads!(verb, workspaceId, args),
          signIns,
          workspaces,
          logs: input.logs ?? null,
          // The listing rows (VC-713): the same rows the desktop's own
          // listing builds, live-ness from this process's executor bindings.
          sessionListing: {
            db,
            listSessions: (query) => sessionEngine.listSessions(query),
            liveAttachmentIds: () =>
              new Set(runtime.openNativeBindings().map((binding) => binding.attachmentId)),
          },
          ...(input.boardFeed === undefined ? {} : { boardFeed: input.boardFeed }),
          ticketSignals: (projectId) => sessionEngine.listLatestTicketSignals({ projectId }),
        }),
      };
    },
  };
}
export type HeadlessSessionRuntime = ReturnType<typeof createHeadlessSessionRuntime>;
