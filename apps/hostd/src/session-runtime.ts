/** Headless ports over the same assembly, facade, recovery and drain desktop uses. */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  piOwnedModelAccess,
  type PiModelAccess,
  type CodeModeSandboxAssets,
} from "@volli/agent-runtime";
import {
  displayTicketId,
  VOLLI_SOCKET_ENV,
  type SessionExecutionVenue,
  type TicketMovedNotice,
} from "@volli/shared";
import type { HostCore, HostCorePorts } from "@volli/host-core";
import { getProjectById } from "@volli/host-core/db/projects-repo";
import { getTicket } from "@volli/host-core/db/tickets-repo";
import { SecretService } from "@volli/host-core/secrets/service";
import { AgentObservability } from "@volli/host-core/observability/settings";
import { createSessionTokenRegistry } from "@volli/host-core/session-tokens";
import { createSessionConcurrencyEnvReader } from "@volli/host-core/session-concurrency";
import { BackgroundShellHost } from "@volli/host-core/shell/background-shell-host";
import { desktopMcpDispatch } from "@volli/host-core/mcp/dispatch-policy";
import { desktopCodeMode } from "@volli/host-core/codemode/dev-config";
import { readCodeModePolicy } from "@volli/host-core/session-runtime/model-access-preferences";
import { createAttachmentIdentities } from "@volli/host-core/session-runtime/attachment-identity";
import { createRuntimeAssembly } from "@volli/host-core/session-runtime/assembly";
import { createRuntimeContextResolver } from "@volli/host-core/session-runtime/context";
import { createRuntimeAutomations } from "@volli/host-core/session-runtime/automations";
import { createTicketSessionDelegationStore } from "@volli/host-core/session-runtime/delegation-store";
import {
  createRuntimeSessionFacade,
  recoveredSessionCommandPorts,
  recoveredSessionAutomationPorts,
  recoveredRuntimeSessionServices,
} from "@volli/host-core/session-runtime/facade";
import { createSessionRuntimeLifecycle } from "@volli/host-core/session-runtime/lifecycle";
import { agentSitesWithin } from "@volli/host-core/worktree/agent-sites";
import type { BusyWorktreeSites, BusyWorktreeSite } from "@volli/host-core/worktree/activity";
import type { HeadlessSecrets } from "./secrets";

export interface HeadlessRuntimeOptions {
  binDir: string;
  venue: SessionExecutionVenue;
  codeModeSandbox?: CodeModeSandboxAssets;
  /** A scripted provider replaces only the wire in host-container and integration proofs. */
  modelAccess?: PiModelAccess;
}

/** Synchronous ownership first; ready() is the only public ledger-consuming door. */
export function createHeadlessSessionRuntime(input: {
  host: HostCore;
  version: string;
  ports: HostCorePorts;
  secrets: HeadlessSecrets;
  env: Readonly<Record<string, string | undefined>>;
  /** The agent socket this host serves; every Session command is pointed at it. */
  socketPath: string;
  options: HeadlessRuntimeOptions;
}) {
  const { host, ports, env, options } = input;
  if (!host.database.ok || host.sessionEngine === null)
    throw new Error("The Session database is unavailable.");
  const db = host.database.db;
  const sessionEngine = host.sessionEngine;
  const homeDir = env["HOME"] || homedir();
  const modelAccess =
    options.modelAccess ??
    piOwnedModelAccess({
      agentDir: env["PI_CODING_AGENT_DIR"] || join(homeDir, ".pi", "agent"),
    });
  const decisions = host.runtimeServices.createDecisions(modelAccess, options.venue);
  const mcpSettings = host.runtimeServices.createMcp().settings;
  const mcpDispatch = desktopMcpDispatch({
    env,
    packaged: true,
    log: (message) => ports.log.warn(message),
  });
  const codeMode = desktopCodeMode({
    env,
    packaged: true,
    policy: () => readCodeModePolicy(db),
    sandboxAvailable: options.codeModeSandbox !== undefined,
    log: (message) => ports.log.warn(message),
  });
  const secrets = new SecretService(input.secrets.store);
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
    ledger: host.maintenance.createSpawnLedger(),
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
    webAccess: host.runtimeServices.createWebAccess(),
    mcpSettings,
    mcpDispatch,
    codeMode,
    ...(options.codeModeSandbox === undefined ? {} : { codeModeSandbox: options.codeModeSandbox }),
    observability,
    delegation,
    secrets,
    attachmentIdentities: identities,
    shells,
    // No client can answer person questions or secret cards. Neither belongs at birth.
    askUser: false,
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
    concurrencyEnvFor: async (sessionId) => ({
      ...(await concurrency({ excludeSessionId: sessionId, environment: env })),
      [VOLLI_SOCKET_ENV]: input.socketPath,
    }),
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
    host,
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
    host,
    ports,
    runtime: assembly.sessionRuntime,
    // The headless resource drain joins shell termination before SQLite closes.
    rpc: () => ({ close: () => shells.close() }),
    observability,
    delegation,
    delegationsFor: agents.recoveryDelegationsFor,
    services: () => facade,
    stopProducers: () => automations.stop(),
    installQuitHold: () => {},
  });
  observability.start();
  return {
    close: lifecycle.close,
    openNativeBindings: () => assembly.sessionRuntime?.openNativeBindings() ?? [],
    observeScheduledResume: lifecycle.observeScheduledResume,
    async ready() {
      const ready = await lifecycle.ready();
      const services = recoveredRuntimeSessionServices(ready);
      if (services.sessions === null || services.runtime === null)
        throw new Error("The headless Session runtime is unavailable.");
      automations.start(recoveredSessionAutomationPorts(ready));
      agents.toolDoor(ready);
      const busyWorktreeSites: BusyWorktreeSites = async (target) => {
        // No terminals are composed on this host. When a terminal port lands,
        // its live cwds must join this supplier rather than bypassing the guard.
        const sites: BusyWorktreeSite[] = shells
          .liveCwds()
          .map((directory) => ({ directory, surface: "terminal" }));
        for (const binding of agentSitesWithin(services.runtime!, target)) {
          // An unreadable Session refuses automatic trim; no fail-open deletion.
          if (
            (await services.runtime!.projection({ sessionId: binding.sessionId })).projection
              .turnActive
          ) {
            sites.push({ directory: binding.directory, surface: "agent" });
          }
        }
        return sites;
      };
      return {
        ...recoveredSessionCommandPorts(ready),
        venue: options.venue,
        verifySessionToken: tokens.verify,
        busyWorktreeSites,
        automationsAvailable: automations.runner !== null,
        onDeliberateMove: (notice: TicketMovedNotice) =>
          automations.pendingArmedRuns?.noteDeliberateMove(notice),
      };
    },
  };
}
export type HeadlessSessionRuntime = ReturnType<typeof createHeadlessSessionRuntime>;
