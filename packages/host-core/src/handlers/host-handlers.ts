/**
 * The host's one handler map: catalog key → the whole command (VC-668; HP §
 * Command catalog, "One handler map").
 *
 * Every door is a projection of this object, and every projection runs the
 * door's policy before the handler: the map a root holds is sealed
 * ({@link HostHandlerMap}), and its only invocation path takes a policy
 * (`./handler-map`). The tRPC routers (IPC and WebSocket) call
 * `ctx.handlers[key]` on the router policy's view; the agent socket's
 * `AGENT_VERB_TABLE` binds a both-door key only as a projection of
 * `handlers[key]` under its coordination policy (`agent-dispatch/table.ts`);
 * a legacy per-channel IPC handler that still serves a catalog command
 * invokes the same entry under the desktop window's policy until its area
 * moves. So "both doors reach the same function, admitted" is a fact of the
 * type, not a convention each composition root wires port by port.
 *
 * Each composition root builds this once ({@link createHostHandlers}) from
 * the host's services and hands the one object to every door. The behaviour a
 * root used to write around a low-level call (reconciling preferences on a
 * refresh, the availability check before a default, the Role a ticket implies,
 * resuming an Automation's delivery after attach, an armed arrival after a
 * deliberate move) lives here, once.
 *
 * Total by construction: {@link HostHandlers} maps every
 * {@link HostHandlerKey}, so a catalog key with no handler does not compile,
 * and neither does a handler with no catalog key. What a host lacks this
 * launch is a handler's answer ({@link OperationUnavailableError}), never a
 * missing entry.
 */
import type Database from "better-sqlite3";
import type {
  SessionClientCommand,
  SessionHistoryPage,
  SessionRuntime,
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
  SessionRuntimeProjectionSnapshot,
  SessionRuntimeSnapshot,
  SessionStartResult,
  SessionStreamEmission,
} from "@volli/session-engine";
import {
  isOperationUnavailable,
  OperationUnavailableError,
  roleImpliedByTicket,
  type AddHostAnswer,
  type AddHostEvent,
  type AddHostFacts,
  type AddHostStartInput,
  type AddHostStepId,
  type AgentResponse,
  type CodeModePolicy,
  type CompactionPolicy,
  type ExperimentId,
  type ExperimentSnapshot,
  type HandlerCall,
  type HiddenModelRef,
  type HostAuthCallbackDeliverInput,
  type HostAuthCallbackDeliverResult,
  type HostHandler,
  type HostSetApiKeyInput,
  type HostSetGitCredentialInput,
  type HostSignInAnswerInput,
  type HostSignInFlow,
  type HostSignInStartInput,
  type HostLinkRelayCall,
  type HostLinkRelayEvent,
  type HostLinkRelaySubscribeCall,
  type HostSignInRunEvent,
  type HostSignInSendResult,
  type HostSignInStatus,
  type HostSignInUpdate,
  type HostLogsBatch,
  type HostLogsRead,
  type HostHandlerKey,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
  type ModelPickerView,
  type ModelPurpose,
  type ModelSelection,
  type LatestSessionSignal,
  type RemoteHostDevices,
  type RemoteHostsSnapshot,
  type RenameRemoteHostInput,
  type SessionReadVerb,
  type Ticket,
  type WorktreeTrimSettings,
} from "@volli/shared";

import type { DetachedWorkPort } from "../detached-work";
import type { HostSignIns } from "../host-sign-ins";
import { withLogContext } from "../log/context";
import type { LogRing } from "../log/ring";
import { sealHostHandlers, type AdmissionObserver, type HostHandlerMap } from "./handler-map";
import type { RemoteHostsPort, RemoteHostUpdateWhen } from "./remote-hosts-port";
import type { RemoteSignInsPort } from "./remote-sign-ins-port";
import type { HostLinkRelayPort } from "./host-link-relay-port";
import type { HostSessionPorts } from "../session-services";
import type { RuntimeAutomations } from "../session-runtime/automations";
import {
  assertDefaultModelAvailable,
  readCodeModePolicy,
  readCompactionPolicy,
  readHiddenModels,
  readModelAccessDefaults,
  readModelPickerView,
  reconcileModelAccessPreferences,
  writeCodeModePolicy,
  writeCompactionPolicy,
  writeHiddenModels,
  writeModelAccessDefault,
  writeModelPickerView,
} from "../session-runtime/model-access-preferences";
import type { PiRuntimeHost } from "../session-runtime/pi-adapter";
import type { SessionAttachInput, SessionStartInput, Sessions } from "../session-runtime/sessions";
import { createBoardHandlers, type BoardHandlerSignatures } from "../board/commands";
import { createBoardChangeFeed, type BoardChangeFeed } from "../board/change-feed";
import { reorderProjects } from "../db/projects-repo";
import {
  executeTicketMove,
  type TicketMoveCommandInput,
  type TicketMoveSeam,
} from "../ticket-move";
import type { BusyWorktreeSites } from "../worktree/activity";
import { getTrimSettings } from "../worktree/trim-settings";
import type { WorktreePorts } from "../worktree/types";
import { worktreeDeps } from "../worktree-runtime";

/** A subscription's sink: the stream a door turns into its own envelope. */
export interface HandlerSink<Emission> {
  emit(emission: Emission): void | Promise<void>;
  fail(error: unknown): void;
}

/** A subscription entry: it opens, feeds the sink, and answers the unsubscribe. */
export type HostSubscriptionHandler<Input, Emission> = (
  input: Input,
  call: HandlerCall,
  sink: HandlerSink<Emission>,
) => Promise<() => void>;

/** A person's create door: they choose a Ticket or none, and the Role follows (VC-9). */
export type SessionCreateHandlerInput = Omit<SessionStartInput, "role" | "parentSessionId">;

/**
 * Every handler's signature, by catalog key. A door's projection reads its
 * input and output types from here; the router package declares the slice it
 * projects structurally (it cannot import host-core, D2), and a composition
 * root's assignment of this map to that slice is the check that they agree.
 */
export interface HostHandlerSignatures extends BoardHandlerSignatures {
  readonly "sessions.create": HostHandler<SessionCreateHandlerInput, { sessionId: string }>;
  readonly "sessions.attach": HostHandler<SessionAttachInput, SessionStartResult>;
  readonly "settings.experiments": HostHandler<void, ExperimentSnapshot>;
  readonly "settings.setExperiment": HostHandler<
    { id: ExperimentId; enabled: boolean },
    ExperimentSnapshot
  >;
  readonly "modelAccess.inspect": HostHandler<{ refresh?: boolean }, ModelAccessSnapshot>;
  readonly "modelAccess.defaults": HostHandler<void, ModelAccessDefaults>;
  readonly "modelAccess.setDefault": HostHandler<
    { purpose: ModelPurpose; selection: ModelSelection | null },
    ModelAccessDefaults
  >;
  readonly "modelAccess.hiddenModels": HostHandler<void, readonly HiddenModelRef[]>;
  readonly "modelAccess.setHiddenModels": HostHandler<readonly HiddenModelRef[], void>;
  readonly "modelAccess.compactionPolicy": HostHandler<void, CompactionPolicy>;
  readonly "modelAccess.setCompactionPolicy": HostHandler<CompactionPolicy, CompactionPolicy>;
  readonly "modelAccess.codeModePolicy": HostHandler<void, CodeModePolicy>;
  readonly "modelAccess.setCodeModePolicy": HostHandler<CodeModePolicy, CodeModePolicy>;
  readonly "modelAccess.pickerView": HostHandler<void, ModelPickerView>;
  readonly "modelAccess.setPickerView": HostHandler<ModelPickerView, ModelPickerView>;
  readonly "session.snapshot": HostHandler<{ sessionId: string }, SessionRuntimeSnapshot>;
  /** One page of older transcript, strictly below `before` (VC-315). The engine owns the bound. */
  readonly "session.history": HostHandler<
    { sessionId: string; before: number },
    SessionHistoryPage
  >;
  readonly "session.projection": HostHandler<
    { sessionId: string },
    SessionRuntimeProjectionSnapshot
  >;
  /**
   * `signal` lets a bounded door (the WebSocket's replay bounds, VC-663)
   * cancel a replay it refused before the subscribe call returns.
   */
  readonly "session.subscribe": HostSubscriptionHandler<
    { sessionId: string; afterSequence: number; signal?: AbortSignal },
    SessionStreamEmission
  >;
  readonly "session.subscribeQueue": HostSubscriptionHandler<
    { sessionId: string; afterSequence: number; signal?: AbortSignal },
    SessionStreamEmission
  >;
  readonly "session.command": HostHandler<
    SessionRuntimeCommandRequest,
    SessionRuntimeCommandResult
  >;
  /**
   * `expectedRevision`, when given, is the queue revision the Client acted on;
   * the Sessions module refuses a stale one with a typed queue-revision conflict.
   */
  readonly "session.cancelQueued": HostHandler<
    { commandId: string; sessionId: string; messageId: string; expectedRevision?: number },
    SessionRuntimeCommandResult
  >;
  readonly "session.editQueued": HostHandler<
    {
      commandId: string;
      sessionId: string;
      messageId: string;
      message: Extract<SessionClientCommand, { kind: "message.submit" }>["message"];
      expectedRevision?: number;
    },
    SessionRuntimeCommandResult
  >;
  readonly "session.cancelInteraction": HostHandler<
    { sessionId: string; interactionId: string },
    void
  >;
  readonly "session.reconcile": HostHandler<{ sessionId: string; attachmentId: string }, void>;
  /**
   * The socket's Session reads, for a caller bound to one Workspace (VC-663,
   * D4): the socket verb's own handler, its roster forced to `workspaceId`
   * (`AgentCommandService.executeInWorkspace`). Socket-delegated keys
   * (`SOCKET_DELEGATED_HANDLER_KEYS`): the socket serves these verbs itself.
   */
  readonly "session.list": HostHandler<SessionReadHandlerInput, AgentResponse>;
  readonly "session.show": HostHandler<SessionReadHandlerInput, AgentResponse>;
  readonly "session.peek": HostHandler<SessionReadHandlerInput, AgentResponse>;
  readonly "session.answer": HostHandler<SessionReadHandlerInput, AgentResponse>;
  readonly "signIns.status": HostHandler<void, HostSignInStatus>;
  readonly "signIns.setApiKey": HostHandler<HostSetApiKeyInput, HostSignInStatus>;
  readonly "signIns.signOut": HostHandler<{ providerId: string }, HostSignInStatus>;
  readonly "signIns.start": HostHandler<HostSignInStartInput, HostSignInFlow>;
  readonly "signIns.subscribe": HostSubscriptionHandler<HostSignInFlow, HostSignInUpdate>;
  readonly "signIns.answer": HostHandler<HostSignInAnswerInput, void>;
  readonly "signIns.cancel": HostHandler<HostSignInFlow, void>;
  readonly "signIns.setGitCredential": HostHandler<HostSetGitCredentialInput, HostSignInStatus>;
  readonly "signIns.clearGitCredential": HostHandler<{ host: string }, HostSignInStatus>;
  readonly "auth.callback.deliver": HostHandler<
    HostAuthCallbackDeliverInput,
    HostAuthCallbackDeliverResult
  >;
  /** The host's recent log, redacted and bounded (VC-699): a page after a cursor. */
  readonly "logs.tail": HostHandler<HostLogsRead, HostLogsBatch>;
  /** The host's log as it is written, after a cursor's backlog. */
  readonly "logs.follow": HostSubscriptionHandler<HostLogsRead, HostLogsBatch>;
  /**
   * The desktop-only tier (`DESKTOP_ENTRIES`, VC-608): the same map, under
   * placement-derived policy (both host-placed: device-as-user).
   */
  readonly "project.reorder": HostHandler<{ orderedIds: readonly string[] }, null>;
  readonly "worktree.trimSettings": HostHandler<void, WorktreeTrimSettings>;
  /**
   * Remote hosts this desktop added over SSH (VC-700 PR 2), all host-placed:
   * {@link HostHandlerOptions.remoteHosts}'s, or unavailable.
   */
  readonly "hosts.snapshot": HostHandler<void, RemoteHostsSnapshot>;
  /** The current snapshot first, then every change. */
  readonly "hosts.subscribe": HostSubscriptionHandler<void, RemoteHostsSnapshot>;
  readonly "hosts.retry": HostHandler<{ hostId: string }, null>;
  readonly "hosts.updateHost": HostHandler<{ hostId: string; when: RemoteHostUpdateWhen }, null>;
  readonly "hosts.cancelScheduledUpdate": HostHandler<{ hostId: string }, null>;
  readonly "hosts.signIn": HostHandler<{ hostId: string; providerId: string }, null>;
  readonly "hosts.forget": HostHandler<{ hostId: string }, null>;
  readonly "hostAdd.start": HostHandler<AddHostStartInput, { flowId: string }>;
  /** The flow's current view first, then every change and log line. */
  readonly "hostAdd.subscribe": HostSubscriptionHandler<{ flowId: string }, AddHostEvent>;
  readonly "hostAdd.answer": HostHandler<
    { flowId: string; questionId: string; answer: AddHostAnswer },
    null
  >;
  /** Write-only: the password is never echoed, and an error that carries it is scrubbed. */
  readonly "hostAdd.sudoPassword": HostHandler<
    { flowId: string; questionId: string; password: string },
    null
  >;
  readonly "hostAdd.retry": HostHandler<{ flowId: string; from?: AddHostStepId }, null>;
  readonly "hostAdd.cancel": HostHandler<{ flowId: string }, null>;
  /** Sign-ins on a remote host, from this desktop (VC-702 PR 2): its port, or unavailable. */
  readonly "hostSignIns.status": HostHandler<{ hostId: string }, HostSignInStatus>;
  readonly "hostSignIns.macKeys": HostHandler<void, readonly string[]>;
  readonly "hostSignIns.sendFromThisMac": HostHandler<
    { hostId: string; providerId: string; confirmed: true },
    HostSignInSendResult
  >;
  readonly "hostSignIns.setApiKey": HostHandler<
    { hostId: string; providerId: string; key: string },
    HostSignInStatus
  >;
  readonly "hostSignIns.setGitCredential": HostHandler<
    { hostId: string } & HostSetGitCredentialInput,
    HostSignInStatus
  >;
  readonly "hostSignIns.run": HostSubscriptionHandler<
    { hostId: string; providerId: string; runId?: string | undefined },
    HostSignInRunEvent
  >;
  readonly "hostSignIns.answer": HostHandler<
    {
      hostId: string;
      providerId: string;
      promptId: string;
      value: string;
      runId?: string | undefined;
    },
    null
  >;
  readonly "hostSignIns.cancel": HostHandler<
    { hostId: string; providerId: string; runId?: string | undefined },
    null
  >;
  /** Managing a host (VC-700 PR 3): this Mac's label, and the host's devices over SSH. */
  readonly "hosts.rename": HostHandler<RenameRemoteHostInput, null>;
  readonly "hosts.devices": HostHandler<{ hostId: string }, RemoteHostDevices>;
  readonly "hostAdd.facts": HostHandler<{ flowId: string }, AddHostFacts>;
  /**
   * The Workspace link relay (VC-711): a remote project's public operations
   * over desktop main's Workspace link, {@link HostHandlerOptions.hostLinkRelay}'s
   * or unavailable.
   */
  readonly "hostLink.query": HostHandler<HostLinkRelayCall, unknown>;
  readonly "hostLink.mutate": HostHandler<HostLinkRelayCall, unknown>;
  readonly "hostLink.subscribe": HostSubscriptionHandler<
    HostLinkRelaySubscribeCall,
    HostLinkRelayEvent
  >;
}

/** What a Session read's handler is asked: its Workspace, and the socket verb's args. */
export interface SessionReadHandlerInput {
  readonly workspaceId: string;
  readonly args: Record<string, unknown>;
}

/** Runs one of the socket's Session reads forced to one Workspace: the agent command service's. */
export type SessionReadPort = (
  verb: SessionReadVerb,
  workspaceId: string,
  args: Record<string, unknown>,
) => Promise<AgentResponse>;

/** The one map: every {@link HostHandlerKey}, and nothing else. */
export type HostHandlers = { readonly [Key in HostHandlerKey]: HostHandlerSignatures[Key] };

type AssertNever<Type extends never> = Type;
/**
 * A catalog key with no signature, or a signature with no catalog key, fails
 * `pnpm typecheck` here and names the key: CI's check that every catalog
 * command has exactly one handler.
 */
export type HostHandlerCoverage = AssertNever<
  | Exclude<HostHandlerKey, keyof HostHandlerSignatures>
  | Exclude<keyof HostHandlerSignatures, HostHandlerKey>
>;

/** A handler's input, for a door that maps its own envelope onto it. */
export type HostHandlerInput<Key extends HostHandlerKey> = Parameters<HostHandlers[Key]>[0];

/** A handler's answer, settled. */
export type HostHandlerOutput<Key extends HostHandlerKey> = Awaited<ReturnType<HostHandlers[Key]>>;

/** Host-level experimental flags (desktop's `ExperimentalSettings`). */
export interface HostExperiments {
  snapshot(): ExperimentSnapshot;
  set(id: ExperimentId, enabled: boolean): ExperimentSnapshot | Promise<ExperimentSnapshot>;
}

/** The services a host builds its handlers from. Absent ones answer unavailable. */
export interface HostHandlerOptions {
  /** The host's database, or null when it did not open. */
  readonly db: Database.Database | null;
  /** The host's data directory: where a worktree's attachment bytes live. */
  readonly dataDir: string;
  /** The recovered Session runtime, or null when this launch has none. */
  readonly runtime: SessionRuntime | null;
  /** The recovered Sessions facade, or null when this launch has none. */
  readonly sessions: Pick<Sessions, "create" | "attach"> | null;
  /** Model Access, or null when the Pi runtime did not come up. */
  readonly modelAccess: Pick<PiRuntimeHost, "inspectModelAccess"> | null;
  /** Experimental flags, or null on a host that keeps none. */
  readonly experiments: HostExperiments | null;
  /** Where an armed arrival and a resumed delivery go. */
  readonly automations: RuntimeAutomations;
  /** The same busy-worktree guard every destructive worktree path reads. */
  readonly busyWorktreeSites: BusyWorktreeSites;
  /** Interrupts a ticket's live agent attachments after a committed backward move. */
  readonly interruptTicketSessions?: (ticketId: string) => string[] | Promise<string[]>;
  /** Where a Done move's detached trim enrols, so shutdown drains it (VC-627). */
  readonly detachedWork?: DetachedWorkPort;
  readonly now?: () => number;
  /** Test seam: the worktree bundle a Done trim runs through. Defaults to the host's. */
  readonly worktree?: WorktreePorts;
  /** Sees every policy verdict at the map, before the handler it admits. */
  readonly onAdmission?: AdmissionObserver;
  /**
   * The socket's Session reads, Workspace-scoped (VC-663, D4), or null where
   * the host serves them over no network door (the desktop): they answer
   * unavailable. A root whose agent command service is built after this map
   * passes a forwarder.
   */
  readonly sessionReads?: SessionReadPort | null;
  /** The host's in-memory recent log (VC-699), or null where this host keeps none. */
  readonly logs?: LogRing | null;
  /**
   * Sign-ins on a host (VC-702), or null where no network door serves them
   * (the desktop, whose window signs in over its own IPC): they answer
   * unavailable.
   */
  readonly signIns?: HostSignIns | null;
  /**
   * The host's board change feeds (VC-565): every board command stamps its
   * rows here, and the root's event bus feeds it every other writer's
   * `data-changed` (`BoardChangeFeed.noteDataChanged`). One per host: a
   * root passes the feed its bus feeds; absent (tests), a private one.
   */
  readonly boardFeed?: BoardChangeFeed;
  /** The Session ledger's latest outcome per ticket, or null on a host without one. */
  readonly ticketSignals?: ((projectId: string) => Promise<readonly LatestSessionSignal[]>) | null;
  /** Where Pi keeps saved tool output, which an archive or delete releases (VC-469). */
  readonly piSessionsDirectory?: string;
  /**
   * The remote hosts this desktop added over SSH, and their add flows
   * (VC-700 PR 2): desktop main's registry. Absent or null (hostd, a desktop
   * that did not build one): every `hosts.*` and `hostAdd.*` entry answers
   * unavailable. A port that cannot act now throws `OperationUnavailableError`
   * itself (`./remote-hosts-port`).
   */
  readonly remoteHosts?: RemoteHostsPort | null;
  /**
   * Sign-ins on a remote host, from this desktop (VC-702 PR 2), or null on a
   * host that adds none (hostd): `hostSignIns.*` answer unavailable.
   */
  readonly remoteSignIns?: RemoteSignInsPort | null;
  /**
   * The Workspace link relay (VC-711): desktop main's remote Workspace links,
   * or null on a host that holds none (hostd): `hostLink.*` answer unavailable.
   */
  readonly hostLinkRelay?: HostLinkRelayPort | null;
}

/** Messages a client may show; unchanged from the router's own (VC-564). */
const SESSIONS_UNAVAILABLE = "Sessions are unavailable on this transport";
const RUNTIME_UNAVAILABLE = "The Session runtime is unavailable on this host";
const EXPERIMENTS_UNAVAILABLE = "Experimental settings are unavailable on this transport";
const MODEL_ACCESS_UNAVAILABLE = "Model Access is unavailable on this transport";
const PREFERENCES_UNAVAILABLE = "Model Access preferences are unavailable on this transport";
const BOARD_UNAVAILABLE = "The board is unavailable: the database did not open";
const SESSION_READS_UNAVAILABLE = "Session reads are unavailable on this transport";
const SIGN_INS_UNAVAILABLE = "Sign-ins are unavailable on this host";
const REMOTE_HOSTS_UNAVAILABLE = "Remote hosts are unavailable on this host";
const REMOTE_SIGN_INS_UNAVAILABLE = "Remote host sign-ins are unavailable on this host";
const LOGS_UNAVAILABLE = "This host keeps no log to read";
const HOST_LINK_RELAY_UNAVAILABLE = "Remote projects are unavailable on this host";

/**
 * Runs a handler with the ids its input names joined to the operation's log
 * context (VC-699): every line the command writes, the Session runtime's and
 * the turn's included, names the Session, ticket and command it serves.
 */
function joined<Result>(
  ids: Readonly<Record<string, string | undefined>>,
  run: () => Result,
): Result {
  // An absent id stays absent: the logger leaves undefined fields out.
  return withLogContext(ids, run);
}

function present<Service>(service: Service | null, message: string): Service {
  if (service === null) throw new OperationUnavailableError(message);
  return service;
}

/** Runs a command for its effect: the bridge's answer is `null`. */
async function done(run: () => unknown): Promise<null> {
  await run();
  return null;
}

const REDACTED = "[redacted]";

/**
 * A failure that must not carry `secret`: an error whose message names it is
 * replaced by one that does not (its brand kept, its cause and stack dropped,
 * since either could carry the secret too). Every door records and shows an
 * error's message, so this is where a write-only input stays write-only.
 */
function withoutSecret(error: unknown, secret: string): unknown {
  if (secret === "" || !(error instanceof Error) || !error.message.includes(secret)) return error;
  const message = error.message.split(secret).join(REDACTED);
  return isOperationUnavailable(error)
    ? new OperationUnavailableError(message)
    : new Error(message);
}

/**
 * Builds the host's handler map, sealed behind policy. Call it once per
 * composition root, with the recovered services, and hand the same object to
 * every door; each door invokes it through its own policy.
 */
export function createHostHandlers(
  ports: Pick<HostSessionPorts, "events" | "attention">,
  options: HostHandlerOptions,
): HostHandlerMap {
  return sealHostHandlers(hostHandlerEntries(ports, options), options.onAdmission);
}

function hostHandlerEntries(
  ports: Pick<HostSessionPorts, "events" | "attention">,
  options: HostHandlerOptions,
): HostHandlers {
  // JS callers must fail closed too: a Done trim without activity evidence
  // could remove a directory a live process is standing in.
  if (typeof options.busyWorktreeSites !== "function") {
    throw new Error("The busy-worktree supplier is required.");
  }
  const { db, automations } = options;
  const now = options.now ?? Date.now;
  const runtime = () => present(options.runtime, RUNTIME_UNAVAILABLE);
  const sessions = () => present(options.sessions, SESSIONS_UNAVAILABLE);
  const experiments = () => present(options.experiments, EXPERIMENTS_UNAVAILABLE);
  const modelAccess = () => present(options.modelAccess, MODEL_ACCESS_UNAVAILABLE);
  const preferences = () => present(db, PREFERENCES_UNAVAILABLE);
  const board = () => present(db, BOARD_UNAVAILABLE);
  const sessionReads = () => present(options.sessionReads ?? null, SESSION_READS_UNAVAILABLE);
  const signIns = () => present(options.signIns ?? null, SIGN_INS_UNAVAILABLE);
  const remoteHosts = () => present(options.remoteHosts ?? null, REMOTE_HOSTS_UNAVAILABLE);
  const remoteSignIns = () => present(options.remoteSignIns ?? null, REMOTE_SIGN_INS_UNAVAILABLE);
  const logs = () => present(options.logs ?? null, LOGS_UNAVAILABLE);
  const hostLinkRelay = () => present(options.hostLinkRelay ?? null, HOST_LINK_RELAY_UNAVAILABLE);

  const worktree = (database: Database.Database) =>
    options.worktree ?? worktreeDeps(database, ports, { dataDir: options.dataDir });

  /** The deliberate move (VC-629), whichever door: its write and every effect after it. */
  const moveTicket = (
    input: TicketMoveCommandInput,
    call: HandlerCall,
    seam?: TicketMoveSeam,
  ): Ticket[] | Promise<Ticket[]> => {
    const database = board();
    // Joined to the move's ticket and project (VC-699): every line it writes carries both.
    return joined(
      { ticketId: (input as { ticketId?: string }).ticketId, projectId: input.projectId },
      () =>
        executeTicketMove(
          {
            worktree: worktree(database),
            now,
            busySites: options.busyWorktreeSites,
            interruptTicketSessions: options.interruptTicketSessions,
            // An explicit move is the Deliberate-move door: it reaches the one
            // host-owned pending arrival, whichever door the person used.
            onDeliberateMove: (notice) => {
              if (automations.kind !== "live") return;
              const execution = automations.execution;
              if (execution.kind !== "idle") execution.pendingArmedRuns.noteDeliberateMove(notice);
            },
            notify: (request) => ports.attention.deliver(request),
            // The desktop window holds the committed board in its reply, so
            // only the detached trim's worktree change is pushed back to it.
            onMutation: (change) => {
              if (call.origin === "desktop-window" && change.kind !== "worktree") return;
              ports.events.publish("data-changed", change);
            },
            detachedWork: options.detachedWork,
          },
          input,
          { now: now(), actor: call.actor },
          seam,
        ),
    );
  };

  return {
    ...createBoardHandlers({
      db,
      now,
      events: ports.events,
      feed: options.boardFeed ?? createBoardChangeFeed(),
      worktree,
      busyWorktreeSites: options.busyWorktreeSites,
      detachedWork: options.detachedWork,
      ticketSignals: options.ticketSignals ?? null,
      piSessionsDirectory: options.piSessionsDirectory,
      move: (input, call, seam) => moveTicket(input, call, seam),
    }),
    "sessions.create": (input) =>
      sessions().create({ ...input, role: roleImpliedByTicket(input.ticketId) }),
    // Every Retry rides this. A ready attachment is the recovery point for an
    // Automation's durable first-message intent; the runner's fixed Session
    // command id reconciles rather than duplicates after a crash.
    "sessions.attach": (input) =>
      joined({ sessionId: input.sessionId }, async () => {
        const attached = await sessions().attach(input);
        if (attached.state === "ready" && automations.kind === "live") {
          const execution = automations.execution;
          if (execution.kind === "ready") {
            await execution.runner.resumeDeliveryForSession(input.sessionId);
          }
        }
        return attached;
      }),
    "settings.experiments": () => experiments().snapshot(),
    "settings.setExperiment": ({ id, enabled }) => experiments().set(id, enabled),
    "modelAccess.inspect": async (input) => {
      const access = await modelAccess().inspectModelAccess(input);
      if (input.refresh === true && db !== null) {
        reconcileModelAccessPreferences(db, access, now());
      }
      return access;
    },
    "modelAccess.defaults": () => readModelAccessDefaults(preferences()),
    "modelAccess.setDefault": async ({ purpose, selection }) => {
      const database = preferences();
      const access = present(options.modelAccess, PREFERENCES_UNAVAILABLE);
      // Clearing an explicit choice needs no availability check: it resolves
      // to the global default, which had one when it was saved.
      if (selection !== null) {
        assertDefaultModelAvailable(await access.inspectModelAccess({}), selection, purpose);
      }
      return writeModelAccessDefault(database, purpose, selection, now());
    },
    "modelAccess.hiddenModels": () => readHiddenModels(preferences()),
    "modelAccess.setHiddenModels": (hidden) => {
      writeHiddenModels(preferences(), hidden, now());
    },
    "modelAccess.compactionPolicy": () => readCompactionPolicy(preferences()),
    "modelAccess.setCompactionPolicy": (policy) =>
      writeCompactionPolicy(preferences(), policy, now()),
    // Read again at each Session's birth, never pushed: a write reaches the
    // next Session created and no Session already running.
    "modelAccess.codeModePolicy": () => readCodeModePolicy(preferences()),
    "modelAccess.setCodeModePolicy": (policy) => writeCodeModePolicy(preferences(), policy, now()),
    "modelAccess.pickerView": () => readModelPickerView(preferences()),
    "modelAccess.setPickerView": (view) => writeModelPickerView(preferences(), view, now()),
    "session.snapshot": (input) => runtime().snapshot(input),
    "session.history": (input) => runtime().history(input),
    "session.projection": (input) => runtime().projection(input),
    "session.subscribe": (input, _call, sink) =>
      runtime().subscribe(
        input,
        (emission) => sink.emit(emission),
        (error) => sink.fail(error),
      ),
    "session.subscribeQueue": (input, _call, sink) =>
      runtime().subscribe(
        input,
        (emission) => sink.emit(emission),
        (error) => sink.fail(error),
      ),
    "session.command": (request) =>
      joined(
        { sessionId: (request as { sessionId?: string }).sessionId, commandId: request.commandId },
        () => runtime().command(request),
      ),
    // An absent revision stays absent: the command's idempotency signature is
    // unchanged for a Client that does not send one.
    "session.cancelQueued": ({ commandId, sessionId, messageId, expectedRevision }) =>
      joined({ sessionId, commandId }, () =>
        runtime().command({
          commandId,
          sessionId,
          command: {
            kind: "message.cancel",
            messageId,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          },
        }),
      ),
    "session.editQueued": ({ commandId, sessionId, messageId, message, expectedRevision }) =>
      joined({ sessionId, commandId }, () =>
        runtime().command({
          commandId,
          sessionId,
          command: {
            kind: "message.edit",
            messageId,
            message,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          },
        }),
      ),
    // A person walked away from a pending interaction: the only reason a
    // person's door can honestly report is that they left it undecided.
    "session.cancelInteraction": (input) =>
      runtime().cancelInteraction({ ...input, reason: "abandoned", origin: { kind: "user" } }),
    "session.reconcile": (input) => runtime().reconcile(input),
    "session.list": ({ workspaceId, args }) => sessionReads()("session.list", workspaceId, args),
    "session.show": ({ workspaceId, args }) => sessionReads()("session.show", workspaceId, args),
    "session.peek": ({ workspaceId, args }) => sessionReads()("session.peek", workspaceId, args),
    "session.answer": ({ workspaceId, args }) =>
      sessionReads()("session.answer", workspaceId, args),
    "signIns.status": () => signIns().status(),
    "signIns.setApiKey": (input) => signIns().setApiKey(input),
    "signIns.signOut": (input) => signIns().signOut(input),
    "signIns.start": (input, call) => signIns().start(input, call),
    "signIns.subscribe": async (input, call, sink) => signIns().subscribe(input, call, sink),
    "signIns.answer": (input, call) => signIns().answer(input, call),
    "signIns.cancel": (input, call) => signIns().cancel(input, call),
    "signIns.setGitCredential": (input) => signIns().setGitCredential(input),
    "signIns.clearGitCredential": (input) => signIns().clearGitCredential(input),
    "auth.callback.deliver": (input, call) => signIns().deliverCallback(input, call),
    "logs.tail": (query) => logs().read(query),
    "logs.follow": async (query, _call, sink) =>
      logs().follow(query, (batch) => void sink.emit(batch)),
    // The desktop-only tier: the bodies `volli:project-reorder` and
    // `volli:worktree-trim-settings-get` had in `data-ipc.ts`, moved, not copied.
    "project.reorder": ({ orderedIds }) => {
      reorderProjects(board(), orderedIds, now());
      return null;
    },
    "worktree.trimSettings": () => getTrimSettings(board()),
    // Remote hosts (VC-700 PR 2): desktop main's registry, through its port.
    "hosts.snapshot": () => remoteHosts().snapshot(),
    "hosts.subscribe": async (_input, _call, sink) =>
      remoteHosts().subscribe((snapshot) => sink.emit(snapshot)),
    "hosts.retry": ({ hostId }) => done(() => remoteHosts().retry(hostId)),
    "hosts.updateHost": ({ hostId, when }) => done(() => remoteHosts().updateHost(hostId, when)),
    "hosts.cancelScheduledUpdate": ({ hostId }) =>
      done(() => remoteHosts().cancelScheduledUpdate(hostId)),
    "hosts.signIn": ({ hostId, providerId }) =>
      done(() => remoteHosts().signIn(hostId, providerId)),
    "hosts.forget": ({ hostId }) => done(() => remoteHosts().forget(hostId)),
    "hostAdd.start": async (input) => {
      const { flowId } = await remoteHosts().startAdd(input);
      return { flowId };
    },
    "hostAdd.subscribe": async ({ flowId }, _call, sink) =>
      remoteHosts().subscribeAdd(flowId, (event) => sink.emit(event)),
    "hostAdd.answer": ({ flowId, questionId, answer }) =>
      done(() => remoteHosts().answerAdd(flowId, questionId, answer)),
    "hostAdd.sudoPassword": async ({ flowId, questionId, password }) => {
      try {
        return await done(() => remoteHosts().sudoPassword(flowId, questionId, password));
      } catch (error) {
        throw withoutSecret(error, password);
      }
    },
    "hostAdd.retry": ({ flowId, from }) => done(() => remoteHosts().retryAdd(flowId, from)),
    "hostAdd.cancel": ({ flowId }) => done(() => remoteHosts().cancelAdd(flowId)),
    // Sign-ins on a remote host (VC-702 PR 2): desktop main's, through its port.
    // A value going in is never echoed by a failure (`withoutSecret`).
    "hostSignIns.status": ({ hostId }) => remoteSignIns().status(hostId),
    "hostSignIns.macKeys": () => remoteSignIns().macKeys(),
    "hostSignIns.sendFromThisMac": ({ hostId, providerId }) =>
      remoteSignIns().sendFromThisMac(hostId, providerId),
    "hostSignIns.setApiKey": async ({ hostId, providerId, key }) => {
      try {
        return await remoteSignIns().setApiKey(hostId, providerId, key);
      } catch (error) {
        throw withoutSecret(error, key);
      }
    },
    "hostSignIns.setGitCredential": async ({ hostId, ...credential }) => {
      try {
        return await remoteSignIns().setGitCredential(hostId, credential);
      } catch (error) {
        throw withoutSecret(error, credential.password);
      }
    },
    "hostSignIns.run": async ({ hostId, providerId, runId }, _call, sink) =>
      remoteSignIns().run(hostId, providerId, (event) => sink.emit(event), runId),
    "hostSignIns.answer": async ({ hostId, providerId, promptId, value, runId }) => {
      try {
        return await done(() => remoteSignIns().answer(hostId, providerId, promptId, value, runId));
      } catch (error) {
        throw withoutSecret(error, value);
      }
    },
    "hostSignIns.cancel": ({ hostId, providerId, runId }) =>
      done(() => remoteSignIns().cancel(hostId, providerId, runId)),
    "hosts.rename": ({ hostId, name }) => done(() => remoteHosts().rename(hostId, name)),
    "hosts.devices": ({ hostId }) => remoteHosts().devices(hostId),
    "hostAdd.facts": ({ flowId }) => remoteHosts().addFacts(flowId),
    // The Workspace link relay (VC-711): desktop main's, through its port.
    "hostLink.query": ({ workspaceId, path, input }) =>
      hostLinkRelay().query(workspaceId, path, input),
    "hostLink.mutate": ({ workspaceId, path, input }) =>
      hostLinkRelay().mutate(workspaceId, path, input),
    "hostLink.subscribe": async ({ workspaceId, path, input, lastEventId }, _call, sink) =>
      hostLinkRelay().subscribe(
        workspaceId,
        path,
        input,
        (event) => sink.emit(event),
        lastEventId === undefined ? {} : { lastEventId },
      ),
  };
}
