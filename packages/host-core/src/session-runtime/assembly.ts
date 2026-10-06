/**
 * Pi attachment assembly, shared by hosts (VC-622, desktop lift slice 1).
 *
 * Construction is synchronous and inert: no Session/ledger read happens until
 * an attachment or a Session start calls a port. The caller can install its quit
 * hold before yielding. Browser/shell capabilities are supplied at construction,
 * never late-bound through a mutable backend reference.
 *
 * The facade/tool-door cycle is deliberately a pair of deferred ports for this
 * slice. Session commands and boot recovery move behind this assembly next.
 */
import { join } from "node:path";
import type { PiModelAccess, CodeModeSandboxAssets } from "@volli/agent-runtime";
import { piExecutionEnv, refusingCredentialReads } from "@volli/agent-runtime";
import type { SessionEngine } from "@volli/session-engine";
import {
  shortSessionId,
  type McpToolDefinition,
  type ObservabilitySink,
  type SessionEvent,
  type SessionToolId,
  type SessionExecutionVenue,
} from "@volli/shared";
import type { DbHandle, HostCorePorts } from "../index";
import { getProjectById } from "../db/projects-repo";
import { blobsRoot } from "../blob-store";
import { prepareTurnAttachments } from "../turn-attachments";
import type { AgentToolDoor } from "../agent-tool-door";
import { McpSessionHost, serversForFrozenMcpTools } from "../mcp/session-host";
import type { McpSettingsService } from "../mcp/settings";
import type { HostMcpDispatch } from "../mcp/dispatch-policy";
import type { HostCodeMode } from "../codemode/dev-config";
import type { HostDecisions } from "../decision/host-decisions";
import type { WebAccessSettings } from "../web/settings";
import { webPortsFor } from "../web/ports";
import type { SecretService } from "../secrets/service";
import type { BackgroundShellHost } from "../shell/background-shell-host";
import { createAgentShellPort } from "../shell/agent-port";
import { browserAgentPort } from "../browser/agent-port";
import type { BrowserBackend } from "../browser/backend";
import type { AttachmentIdentities } from "./attachment-identity";
import type { TicketSessionDelegationStore } from "./delegation-store";
import type { SessionToolSurfacePorts } from "./sessions";
import { readCompactionPolicy } from "./model-access-preferences";
import { createPiRuntimeHost, type PiAdapterOptions } from "./pi-adapter";
import {
  createHostSessionRuntime,
  createFileTranscriptArtifactStore,
  sessionTranscriptsRoot,
} from "./index";
import { resolveHostToolSurface } from "./host-capabilities";
import { wireSessionRuntime } from "../session-services";

export interface RuntimeAssemblyOptions {
  dbHandle: DbHandle;
  /** Receive the host's one engine; never construct another writer. */
  sessionEngine: SessionEngine | null;
  dataDir: string;
  binDir: string;
  venue: SessionExecutionVenue;
  hostPorts: Pick<HostCorePorts, "events" | "connectivity">;
  modelAccess: PiModelAccess | null;
  decisions: HostDecisions | null;
  webAccess: WebAccessSettings | null;
  mcpSettings: McpSettingsService | null;
  mcpDispatch: HostMcpDispatch;
  codeMode: HostCodeMode;
  codeModeSandbox?: CodeModeSandboxAssets;
  observability: ObservabilitySink | null;
  delegation: TicketSessionDelegationStore | null;
  secrets: SecretService;
  attachmentIdentities: AttachmentIdentities;
  /** An absent port records no shell tools at birth. */
  shells?: BackgroundShellHost;
  /** An absent port records no browser tools at birth. */
  browser?: {
    backend: BrowserBackend;
    cursorFor: NonNullable<Parameters<typeof browserAgentPort>[0]["cursorFor"]>;
  };
  /** This host has a person-answering surface for Session interactions. */
  askUser: boolean;
  requestSecret: boolean;
  beforeExecution(): Promise<unknown>;
  concurrencyEnvFor(sessionId: string): Promise<Record<string, string>>;
  resolveRuntimeContext: PiAdapterOptions["resolveRuntimeContext"];
  callVerb: AgentToolDoor;
}

/** The Cache Prefix's durable tool half, or null for a pre-VC-164 Session. */
export function recordedToolSurface(
  events: readonly SessionEvent[],
): readonly SessionToolId[] | null {
  for (const event of events) {
    if (
      event.payload.kind === "session.input.recorded" &&
      event.payload.input.kind === "tool-surface"
    ) {
      return event.payload.input.tools;
    }
  }
  return null;
}

/** Exact sanitized MCP definitions frozen beside the dynamic tool names. */
export function recordedMcpTools(events: readonly SessionEvent[]): readonly McpToolDefinition[] {
  for (const event of events) {
    if (
      event.payload.kind === "session.input.recorded" &&
      event.payload.input.kind === "tool-surface"
    ) {
      return event.payload.input.mcpTools ?? [];
    }
  }
  return [];
}

export function createRuntimeAssembly(options: RuntimeAssemblyOptions) {
  const {
    dbHandle,
    sessionEngine,
    dataDir,
    binDir,
    venue,
    modelAccess: piModelAccess,
    decisions: hostDecisions,
    webAccess,
    mcpSettings,
    mcpDispatch,
    codeMode,
    observability: agentObservability,
    delegation: sessionDelegation,
    secrets,
    attachmentIdentities,
    shells,
    browser,
  } = options;
  const sessionToolSurface: SessionToolSurfacePorts | null =
    webAccess !== null && sessionEngine !== null && sessionDelegation !== null
      ? {
          resolve: (role, grants, within, mcpTools = [], codeModeBirth, classify = false) => {
            // Membership only. `webAccess.resolve()` may momentarily read a key
            // to prove the capability works, but only sanitized names and order
            // survive this closure; the provider closures are discarded here.
            const web = webPortsFor(webAccess.resolve());
            return resolveHostToolSurface({
              role,
              grants,
              mcpTools,
              classify,
              web,
              ...(within === undefined ? {} : { within }),
              ...(codeModeBirth === undefined ? {} : { codeModeBirth }),
              capabilities: {
                askUser: options.askUser,
                requestSecret: options.requestSecret,
                browser: browser !== undefined,
                shells: shells !== undefined,
              },
            });
          },
          // A root Session freezes today's selection, marked eligible for
          // parallel reads only where the developer allowlist names the exact
          // tool (VC-454).
          resolveMcp: (projectId) =>
            mcpDispatch.forNewSession(mcpSettings?.selectedTools(projectId) ?? []),
          resolveClassify: (projectId) =>
            hostDecisions?.offersClassify(projectId) ?? Promise.resolve(false),
          // A parent's own frozen record, read to bound its child (VC-9).
          recorded: async (sessionId) =>
            recordedToolSurface(await sessionEngine.listEvents({ sessionId })),
          recordedMcp: async (sessionId) =>
            recordedMcpTools(await sessionEngine.listEvents({ sessionId })),
          // Code Mode's one decision per birth (VC-471), from the Session's
          // own model; `resolve` and `record` are both handed this answer.
          codeModeAt: (model, mcpTools) => codeMode.birth(model, mcpTools),
          record: async (sessionId, tools, mcpTools = [], { codeMode: codeModeBirth } = {}) => {
            // Code Mode's routes and limits are frozen beside the names they
            // route, at the same birth, from the decision `resolve` was given.
            // A child's names are already bounded by its parent's record
            // (VC-9); its routes follow its own model's mode.
            const codeModeSurface =
              codeModeBirth === undefined
                ? undefined
                : codeMode.surfaceFor(codeModeBirth, tools, mcpTools);
            await sessionEngine.getOrRecordSessionInput({
              sessionId,
              input: {
                kind: "tool-surface",
                tools,
                // At birth, freeze the wire spelling too. The old mcp_* names
                // remain available only to Sessions whose record predates this marker.
                mcpManagementNames: "server",
                ...(mcpTools.length === 0 ? {} : { mcpTools }),
                ...(codeModeSurface === undefined ? {} : { codeMode: codeModeSurface }),
              },
              provenance: {
                source: { kind: "system", id: "pi-runtime", detail: null },
                venue,
              },
            });
          },
        }
      : null;
  const piSessionsDirectory = join(dataDir, "pi-sessions");
  const piRuntimeHost =
    dbHandle.ok &&
    piModelAccess !== null &&
    sessionToolSurface !== null &&
    sessionDelegation !== null
      ? createPiRuntimeHost({
          sessionDataDir: piSessionsDirectory,
          models: piModelAccess.models,
          credentials: piModelAccess.credentials,
          catalogReady: piModelAccess.catalogReady,
          catalogs: piModelAccess.catalogs,
          // Frozen parallel-read marks take effect only while the developer
          // opt-in is set (VC-454); unset, every Session is sequential again.
          parallelMcpReads: mcpDispatch.parallelMcpReads,
          // Code Mode's sandbox (VC-471), located once at boot above.
          ...(options.codeModeSandbox === undefined
            ? {}
            : { codeModeSandbox: options.codeModeSandbox }),
          // A stable reference for the life of the process: flipping the
          // Settings switch swaps what is behind this owner rather than
          // replacing it, so a Session started before the flip is observed
          // after it. Absent when the database never opened, which leaves the
          // runtime on its own no-op default.
          ...(agentObservability === null ? {} : { observability: agentObservability }),
          // A closed lid or a missing Wi-Fi is waited out rather than charged
          // to a turn's retry budget, and a request open across a sleep is
          // re-sent instead of hanging on a dead socket (VC-443).
          connectivity: options.hostPorts.connectivity,
          // A turn's attachments (VC-50): materialize them into the Session's
          // tree so the agent can open any of them by path, and read images
          // back as base64 so the model can actually see them. Injected here
          // because the adapter deliberately knows nothing about the database
          // or the Blob store.
          prepareTurnAttachments: (message, owner) =>
            prepareTurnAttachments(dbHandle.db, blobsRoot(dataDir), message, owner),
          // Read per compaction rather than captured here, for the same reason:
          // a Session outlives the Settings change that retunes it, and the
          // next compaction should run under the policy configured now.
          compactionPolicy: () => readCompactionPolicy(dbHandle.db),
          // Makes `volli` and every detected toolchain resolve inside a
          // structured Session's shell tool whether or not the background
          // install's `~/.local/bin/volli` link is reachable yet — the same
          // recovery a spawned PTY gets from `agentSessionEnv`/
          // `ticketSessionEnv` prepending this same directory
          // (`harness-runtime.ts`).
          executionEnvFactory: async (workspacePath, identity) => {
            await options.beforeExecution();
            // The Session's own name rides beside the PATH recovery:
            // `VOLLI_SESSION`/`VOLLI_TICKET` in a structured Session's shell,
            // exactly as `agentSessionEnv` exports them into a spawned PTY —
            // what lets `volli session done`/`blocked` resolve their context
            // and makes socket writes attribute to the Session (VC-51). The
            // identity is resolved through the one per-attachment store the
            // shell port resolves through too (VC-270), so both doors export
            // the same token — see `attachment-identity.ts`.
            return refusingCredentialReads(
              await piExecutionEnv(workspacePath, {
                pathPrefixes: [binDir],
                identity: attachmentIdentities.resolve(identity),
                // This Session's concurrency budget (VC-339), computed at attach
                // from the Sessions working now — under the identity above, which
                // is what keeps a machine fact from ever posing as who is running.
                environment: await options.concurrencyEnvFor(identity.sessionId),
                secretEnvironment: (signal) => secrets.environmentAsync(identity.sessionId, signal),
                // The execution environment is owned by this attachment and its
                // cleanup runs on every close path. Revoke there so a copied
                // token cannot outlive the structured attachment that held it.
                onCleanup: () => attachmentIdentities.release(identity.attachmentId),
              }),
              workspacePath,
            );
          },
          // The Session's background shells (VC-270): the one host, scoped to
          // the Session, spawning through the same environment record and the
          // same attachment identity the execute tool gets.
          ...(shells === undefined
            ? {}
            : {
                resolveShellPort: (scope) =>
                  createAgentShellPort({
                    host: shells,
                    scope: { projectId: scope.projectId, ticketId: scope.ticketId },
                    session: { sessionId: scope.sessionId, attachmentId: scope.attachmentId },
                    workspacePath: scope.workspacePath,
                    identity: attachmentIdentities.resolve({
                      sessionId: scope.sessionId,
                      attachmentId: scope.attachmentId,
                      ticketId: scope.ticketId,
                    }),
                    pathPrefixes: [binDir],
                    // Asked for at each start rather than captured at attach: a
                    // background shell IS the long-running heavy thing on the
                    // machine, so it self-limits by the budget that is true when it
                    // starts (VC-339).
                    concurrencyEnv: () => options.concurrencyEnvFor(scope.sessionId),
                    secretEnvironment: (signal) =>
                      secrets.environmentAsync(scope.sessionId, signal),
                  }),
              }),
          // The Session's decision port (VC-478), bound to the Session and its
          // project at attach. Membership is the frozen record's; this only
          // answers it. Absent when the database never opened.
          ...(hostDecisions === null
            ? {}
            : {
                resolveClassifyPort: (scope: { sessionId: string; projectId: string }) =>
                  hostDecisions.classifyPort(scope),
              }),
          resolveSecretPort: ({ sessionId, projectId, wait, allowInjection }) =>
            secrets.port(
              {
                sessionId,
                sessionLabel: `Session ${shortSessionId(sessionId)}`,
                projectId,
                projectLabel: dbHandle.ok
                  ? (getProjectById(dbHandle.db, projectId)?.name ?? "Project")
                  : "Project",
              },
              wait,
              allowInjection,
            ),
          resolveMcpPort:
            mcpSettings === null
              ? undefined
              : (scope) => {
                  const host = new McpSessionHost({
                    workspacePath: scope.workspacePath,
                    // Snapshot only the configuration the frozen surface needs.
                    // Current enablement selects new Sessions; a missing record
                    // refuses attachment instead of advertising an unusable tool.
                    servers: serversForFrozenMcpTools(
                      mcpSettings.list(scope.projectId),
                      scope.mcpTools,
                    ),
                    // Credentials are resolved per connection and tokens per
                    // request, so this attachment sees a sign-in or a stored
                    // value a person adds while it runs (VC-470).
                    open: mcpSettings.opener(),
                    credentialsRevision: (serverId) => mcpSettings.credentials.revision(serverId),
                    accessRevision: (serverId) => mcpSettings.credentials.accessRevision(serverId),
                    // Signed in against the stored row, but only while it still
                    // names the endpoint this Session's question names.
                    signIn: (server, signal) =>
                      mcpSettings.signIn({
                        projectId: scope.projectId,
                        serverId: server.id,
                        signal,
                        ...(server.transport.type === "streamable-http"
                          ? { expectedUrl: server.transport.url }
                          : {}),
                      }),
                  });
                  // Behind the one per-server budget (VC-454): over-budget
                  // calls queue, and closing the attachment withdraws this
                  // Session's queued and in-flight calls and nobody else's.
                  // The raw call goes behind the budget and the person-routing
                  // (VC-470) wraps it from outside, so a sign-in a person is
                  // finishing in the browser never holds a budget slot.
                  const bound = mcpDispatch.bind({
                    port: host.rawPort,
                    close: () => host.close(),
                  });
                  return { call: host.routed(bound.call).call, dispose: bound.dispose };
                },
          // What this profile can honestly bind now, read once per attachment.
          // The durable Session record decides whether either port belongs in
          // the tool array; this live answer supplies closures only. Missing a
          // recorded capability rejects recovery, while newly enabled ports are
          // ignored. This is the only attach path that reads the stored key,
          // and it hands it straight to the provider constructor.
          resolveWebPorts: webAccess === null ? undefined : () => webPortsFor(webAccess.resolve()),
          // The Session's Browser capability, composed at attach over the one
          // host: the registry decides which tabs the scope may see, and the
          // CDP wire is each tab's app-private debugger — never a debug port.
          ...(browser === undefined
            ? {}
            : {
                resolveBrowserPort: (scope) =>
                  browserAgentPort({
                    backend: browser.backend,
                    scope: { projectId: scope.projectId, ticketId: scope.ticketId },
                    session: { sessionId: scope.sessionId, attachmentId: scope.attachmentId },
                    cursorFor: browser.cursorFor,
                  }),
              }),
          // The verb half of the Agent Tool Surface (VC-162). Unlike the web
          // ports this decides no membership — the Session's frozen record does
          // — it supplies the one closure every bundled verb is answered
          // through. The typed deferred port cuts the facade/host inference
          // cycle while the caller stages the door after its Sessions facade.
          callVerb: (caller, request, signal, budgetAsk) => {
            // Forwarded, not just read: `session_send` races it, and the
            // signal firing is the only notice a call still in flight gets
            // that its turn was interrupted. `budgetAsk` rides along
            // for the one question a verb may raise mid-call — a spent
            // delegation allowance asking the person driving for one more
            // (VC-204) — answered through the binding that lent it.
            return options.callVerb(caller, request, signal, budgetAsk);
          },
          // The runtime needs the Role a Session runs under and the Ticket it
          // implies, which a directory cannot say. The generated Brief is
          // recorded once before the first runtime construction; every later
          // attach reuses those exact bytes.
          resolveRuntimeContext: options.resolveRuntimeContext,
        })
      : null;
  // One store for the launch: the runtime writes and replays through it, and
  // `session peek` reads a chat Session's transcript tail through it straight
  // off the ledger, without a runtime in the middle (VC-79).
  const transcriptDirectory = sessionTranscriptsRoot(dataDir);
  const transcriptArtifacts = createFileTranscriptArtifactStore(transcriptDirectory);
  const sessionRuntime =
    dbHandle.ok && sessionEngine !== null && piRuntimeHost !== null
      ? createHostSessionRuntime({
          venue,
          db: dbHandle.db,
          events: options.hostPorts.events,
          dataDir,
          transcriptDirectory,
          executor: piRuntimeHost.adapter,
          sessionEngine,
          artifacts: transcriptArtifacts,
          ...(agentObservability === null ? {} : { observability: agentObservability }),
        })
      : null;
  if (sessionEngine !== null && sessionRuntime !== null) {
    wireSessionRuntime(sessionEngine, {
      openNativeBindings: () => sessionRuntime.openNativeBindings(),
    });
  }
  return {
    sessionToolSurface,
    piRuntimeHost,
    sessionRuntime,
    piSessionsDirectory,
    transcriptDirectory,
    transcriptArtifacts,
  };
}
