import type { ProfileRestoreStatus, ProfileRestorePort } from "@volli/shared";
import type { ProfileBackupsPort } from "../backup/automatic";
import type { ProfileBackupStatus } from "@volli/shared";
import type {
  HostWorkspaceCreateInput,
  HostWorkspaceCreateResult,
  HostWorkspaceList,
} from "@volli/shared";
/**
 * The host's one handler map: key → the whole command (VC-668; HP §
 * Command catalog, "One handler map").
 *
 * Every door is a projection of this object, and every projection runs the
 * door's policy before the handler: the map a root holds is sealed
 * ({@link HostHandlerMap}), and its only invocation path takes a policy
 * (`./handler-map`). The tRPC routers (IPC and WebSocket) call
 * `ctx.handlers[key]` on the router policy's view; the agent socket's
 * `AGENT_VERB_TABLE` binds every verb (a both-door key, a ticket write whose
 * command is a board key, VC-794, and each of its own verbs' keys, VC-923)
 * only as a projection of `handlers[key]` under its coordination policy
 * (`agent-dispatch/table.ts`), the four Session reads included (VC-894);
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
 * missing entry; an agent door's own verb (VC-923) is sealed empty and served
 * by that door, and so are the socket's Session reads, which the agent
 * command service serves (VC-894); each answers unavailable until it is
 * (`HandlerNotServedError`).
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
  autoTitleFromKickoff,
  DEFAULT_KICKOFF_MESSAGE,
  isOperationUnavailable,
  OperationUnavailableError,
  roleImpliedByTicket,
  type ActiveAddHost,
  type AddHostAnswer,
  type AddHostEvent,
  type AddHostFacts,
  type AddHostStartInput,
  type AddHostStepId,
  type AccountAccessToken,
  type AccountConnection,
  type AccountGithubSnapshot,
  type AccountSnapshot,
  type AgentResponse,
  type CloudLaunch,
  type BrowserAppShortcutEvent,
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
  type HostScopeRelayCall,
  type HostScopeRelaySubscribeCall,
  type HostLinkRelayCall,
  type HostLinkRelayEvent,
  type HostLinkRelaySubscribeCall,
  type HostSignInRunEvent,
  type HostSignInSendResult,
  type HostSignInStatus,
  type HostSignInUpdate,
  type HostLogsBatch,
  type HostLogsRead,
  type AgentCommandBindingId,
  type HostHandlerKey,
  type RuntimeVerbResult,
  type ServedAgentHandlerKey,
  type ServedHandlerKey,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
  type ModelPickerView,
  type ModelPurpose,
  type ModelSelection,
  type LatestSessionSignal,
  type RemoteHostDevices,
  type RemoteHostProjects,
  type RemoteHostsSnapshot,
  type RemoteWorkspaceInput,
  type RenameRemoteHostInput,
  type CreateRemoteProjectInput,
  type CreateRemoteProjectResult,
  type SessionListingPage,
  type ThisMacRunnerSnapshot,
  type CloudCheckoutChoice,
  type CloudCheckoutStatus,
  type Ticket,
  type WorktreeSetupAnswer,
  type WorktreeSetupStatusView,
  type WorktreeTrimSettings,
} from "@volli/shared";

import type { AgentVerbInput } from "../agent-dispatch/context";
import type { ToolVerbInput } from "../agent-tool-door";
import type { DetachedWorkPort } from "../detached-work";
import type { AccountPort } from "./account-port";
import type { BrowserShortcutsPort } from "./browser-shortcuts-port";
import type { RunnerAccountPort } from "./runner-account-port";
import type { CloudCheckoutPort } from "./cloud-checkout-port";
import type { BrowserPictureStore } from "../browser/picture-store";
import type { HostSignIns } from "../host-sign-ins";
import { withLogContext } from "../log/context";
import type { LogRing } from "../log/ring";
import { sealHostHandlers, type AdmissionObserver, type HostHandlerMap } from "./handler-map";
import type { RemoteHostsPort, RemoteHostUpdateWhen } from "./remote-hosts-port";
import type { RemoteSignInsPort } from "./remote-sign-ins-port";
import type { HostLinkRelayPort, HostScopeRelayPort } from "./host-link-relay-port";
import type { HostSessionPorts } from "../session-services";
import type { RuntimeAutomations } from "../session-runtime/automations";
import {
  boundedSessionListing,
  projectSessionListing,
  ticketSessionListing,
  type SessionListingSources,
} from "../session-control/listing-roster";
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
import type {
  SessionAttachInput,
  SessionModelOverride,
  SessionStartInput,
  Sessions,
} from "../session-runtime/sessions";
import {
  startSessionOperation,
  type StartSessionPorts,
  type StartSessionResult,
} from "../session-runtime/start-session";
import type { TicketSessionDelegation } from "../session-runtime/delegation-policy";
import { actorSessionTicketDisplay } from "../agent-dispatch/resolution";
import { getTicket } from "../db/tickets-repo";
import { createBoardHandlers, type BoardHandlerSignatures } from "../board/commands";
import { createBoardChangeFeed, type BoardChangeFeed } from "../board/change-feed";
import { listProjects, reorderProjects } from "../db/projects-repo";
import { removeProject, type ProjectLiveWork } from "../project-remove";
import {
  executeTicketMove,
  type TicketMoveCommandInput,
  type TicketMoveSeam,
} from "../ticket-move";
import type { BusyWorktreeSites } from "../worktree/activity";
import { getTrimSettings } from "../worktree/trim-settings";
import {
  retryWorktreeSetup,
  startWorktreeSetupAnyway,
  worktreeSetupStatus,
  type WorktreeSetupStatus,
} from "../worktree/setup-gate";
import type { WorktreePorts } from "../worktree/types";
import { worktreeDeps } from "../worktree-runtime";
import type { WorktreeReadInvalidation } from "../worktree-reads";

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
 * Every handler's signature, by key. A door's projection reads its
 * input and output types from here; the router package declares the slice it
 * projects structurally (it cannot import host-core, D2), and a composition
 * root's assignment of this map to that slice is the check that they agree.
 */
export interface HostHandlerSignatures extends BoardHandlerSignatures, AgentHandlerSignatures {
  readonly "workspaces.list": HostHandler<void, HostWorkspaceList>;
  readonly "workspaces.create": HostHandler<HostWorkspaceCreateInput, HostWorkspaceCreateResult>;
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
  readonly "session.picture": HostHandler<
    { sessionId: string; pictureId: string; offset?: number },
    { data: string | null; mimeType: string | null; nextOffset: number | null }
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
   * The socket's Session reads (VC-663, D4; VC-894): one entry per read,
   * which the agent command service serves into the map
   * (`SERVED_CATALOG_HANDLER_KEYS`, `agent-dispatch/verbs.ts`), and which
   * every door reaches as a projection: the socket with the request it
   * resolved, a router with a Workspace the roster is forced to
   * ({@link SessionReadHandlerInput}). The answer is the socket's envelope.
   */
  readonly "session.list": HostHandler<SessionReadHandlerInput, AgentResponse>;
  readonly "session.show": HostHandler<SessionReadHandlerInput, AgentResponse>;
  readonly "session.peek": HostHandler<SessionReadHandlerInput, AgentResponse>;
  readonly "session.answer": HostHandler<SessionReadHandlerInput, AgentResponse>;
  /**
   * A Workspace's Session listing rows (VC-713): the rows the desktop's own
   * listing serves, bounded for one frame ({@link boundedSessionListing}).
   */
  readonly "session.listing": HostHandler<{ projectId: string }, SessionListingPage>;
  readonly "session.listingForTicket": HostHandler<{ ticketId: string }, SessionListingPage>;
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
   * placement-derived policy: the person only, on no network door.
   */
  readonly "shells.moveToBackground": HostHandler<
    { sessionId: string; toolCallId: string },
    { shellId: string }
  >;
  readonly "project.reorder": HostHandler<{ orderedIds: readonly string[] }, null>;
  /** Stops a project's live work, then detaches it (VC-796, VC-822): `../project-remove`. */
  readonly "project.remove": HostHandler<{ projectId: string }, null>;
  readonly "backups.status": HostHandler<void, ProfileBackupStatus>;
  readonly "backups.run": HostHandler<{ expectedRevision: string }, ProfileBackupStatus>;
  readonly "backups.reveal": HostHandler<void, null>;
  readonly "backups.restoreStatus": HostHandler<void, ProfileRestoreStatus>;
  readonly "backups.restoreChoose": HostHandler<{ fileName?: string }, ProfileRestoreStatus>;
  readonly "backups.restoreDirectory": HostHandler<void, string | null>;
  readonly "backups.restoreStart": HostHandler<
    { expectedRevision: string; projectPaths: Record<string, string> },
    ProfileRestoreStatus
  >;
  readonly "backups.restoreCancel": HostHandler<{ expectedRevision: string }, ProfileRestoreStatus>;
  readonly "backups.restoreRestart": HostHandler<{ expectedRevision: string }, null>;

  readonly "worktree.trimSettings": HostHandler<void, WorktreeTrimSettings>;
  /** Where the ticket's working copy's environment setup stands (VC-584). */
  readonly "worktree.setupStatus": HostHandler<{ ticketId: string }, WorktreeSetupStatusView>;
  /** A person's answer to a failed environment setup (VC-584). */
  readonly "worktree.answerSetup": HostHandler<
    { ticketId: string; answer: WorktreeSetupAnswer },
    WorktreeSetupStatusView
  >;
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
  /** The add flows main still owns (VC-720): bounded, secret-free, newest first. */
  readonly "hostAdd.active": HostHandler<void, readonly ActiveAddHost[]>;
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
  /** A host's projects (VC-710): listed and created over SSH, opened and closed on this Mac. */
  readonly "hosts.projects": HostHandler<{ hostId: string }, RemoteHostProjects>;
  readonly "hosts.createProject": HostHandler<CreateRemoteProjectInput, CreateRemoteProjectResult>;
  readonly "hosts.openWorkspace": HostHandler<RemoteWorkspaceInput, null>;
  readonly "hosts.closeWorkspace": HostHandler<RemoteWorkspaceInput, null>;
  /** HOST-scoped operations before any Workspace, through desktop main's port. */
  readonly "hostScope.query": HostHandler<HostScopeRelayCall, unknown>;
  readonly "hostScope.mutate": HostHandler<HostScopeRelayCall, unknown>;
  readonly "hostScope.subscribe": HostSubscriptionHandler<
    HostScopeRelaySubscribeCall,
    HostLinkRelayEvent
  >;
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
  /**
   * App shortcuts out of a focused Browser page (VC-301): desktop main's
   * Browser Tab host, {@link HostHandlerOptions.browserShortcuts}'s, or
   * unavailable.
   */
  readonly "browserShortcuts.subscribe": HostSubscriptionHandler<void, BrowserAppShortcutEvent>;
  readonly "browserShortcuts.focusPage": HostHandler<{ tabId: string }, null>;
  /**
   * The Volli Cloud account on this Mac (VC-884): desktop main's account
   * service, {@link HostHandlerOptions.account}'s, or unavailable.
   */
  readonly "account.snapshot": HostHandler<void, AccountSnapshot>;
  /** The current snapshot first, then every change. */
  readonly "account.subscribe": HostSubscriptionHandler<void, AccountSnapshot>;
  readonly "account.signIn": HostHandler<
    { connection: AccountConnection; inviteCode?: string; acceptedAgreementVersion?: string },
    null
  >;
  readonly "account.cancelSignIn": HostHandler<void, null>;
  readonly "account.signOut": HostHandler<void, null>;
  readonly "account.requestDeletion": HostHandler<void, null>;
  readonly "account.cancelDeletion": HostHandler<void, null>;
  /** VC-889: the window's Convex client's token, the launch's store, and the restart. */
  readonly "account.accessToken": HostHandler<{ force: boolean }, AccountAccessToken>;
  readonly "cloud.launch": HostHandler<void, CloudLaunch>;
  readonly "cloud.relaunch": HostHandler<void, null>;
  readonly "cloud.reportUnsavedWrites": HostHandler<{ count: number }, null>;
  readonly "cloud.saveSnapshot": HostHandler<{ text: string }, null>;
  readonly "cloud.readSnapshot": HostHandler<void, { text: string | null }>;
  /** The account's GitHub connection and the App's installations (VC-897), through {@link AccountPort.github}. */
  readonly "account.githubSubscribe": HostSubscriptionHandler<void, AccountGithubSnapshot>;
  readonly "account.githubConnect": HostHandler<void, null>;
  readonly "account.githubInstall": HostHandler<void, null>;
  readonly "account.githubCancel": HostHandler<void, null>;
  readonly "account.githubDisconnect": HostHandler<void, null>;
  /**
   * This Mac as one of the person's runners (VC-895): desktop main's Mac
   * runner, {@link HostHandlerOptions.runners}'s, or unavailable.
   */
  readonly "runners.thisMac": HostHandler<void, ThisMacRunnerSnapshot>;
  /** The current snapshot first, then every change. */
  readonly "runners.subscribeThisMac": HostSubscriptionHandler<void, ThisMacRunnerSnapshot>;
  readonly "runners.addThisMac": HostHandler<void, null>;
  readonly "runners.removeThisMac": HostHandler<void, null>;
  /**
   * A Volli Cloud project's folder on this Mac (VC-895 N2-3): desktop main's
   * {@link HostHandlerOptions.checkouts}, or unavailable. Never a path.
   */
  readonly "checkouts.status": HostHandler<{ projectId: string }, CloudCheckoutStatus>;
  readonly "checkouts.chooseFolder": HostHandler<{ projectId: string }, CloudCheckoutChoice>;
}

/** The agent keys the socket serves: its own verbs, less the start both agent doors share. */
export type SocketServedKey = Extract<ServedAgentHandlerKey, AgentCommandBindingId>;

/** The agent keys the tool door serves: the Agent Tool Surface's own verbs, less the start. */
export type ToolServedKey = Exclude<ServedAgentHandlerKey, AgentCommandBindingId>;

/**
 * What the map's start is asked (VC-923): one Ticket Session's start, whichever
 * agent door asked. Each door resolves the Ticket, validates its own envelope
 * and mints the operation id under its own rule (random on the socket, the
 * caller plus its tool call id on the tool surface); the actor is the call's.
 */
export interface SessionStartCommandInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly ticketId: string;
  readonly message?: string;
  readonly title?: string;
  readonly modelOverride?: SessionModelOverride;
  /** A claimed Ticket caller's frozen ancestry: the tool door's, after its claim. */
  readonly delegation?: TicketSessionDelegation;
}

/**
 * The agent doors' entries (VC-923). Each socket verb that is neither a
 * catalog command nor a board write, and each tool verb, is its own key.
 *
 * - A socket verb is answered by its handler with the socket's wire answer.
 *   The input is the request as the door resolved it ({@link AgentVerbInput}).
 * - A tool verb is answered by its handler with the result the model reads.
 *   The input is the bound caller, the call, and the attachment's
 *   capabilities for it ({@link ToolVerbInput}).
 * - `session.start`, on both doors, is one command: the map builds it from
 *   its own services, as it builds a catalog command.
 *
 * The call is who the door authenticated. The two doors serve their own
 * verbs' entries (`./handler-map`); the map is sealed without them.
 */
export type AgentHandlerSignatures = {
  readonly [Key in SocketServedKey]: HostHandler<AgentVerbInput, AgentResponse>;
} & {
  readonly [Key in ToolServedKey]: HostHandler<ToolVerbInput, RuntimeVerbResult>;
} & {
  readonly "session.start": HostHandler<SessionStartCommandInput, StartSessionResult>;
};

/**
 * What a router asks a Session read (VC-663, D4): the Workspace its roster is
 * forced to, and the socket verb's args. The project is the Workspace's,
 * never taken from the args, so a handle in any other Workspace resolves
 * exactly as an absent one does.
 */
export interface SessionReadWorkspaceInput {
  readonly workspaceId: string;
  readonly args: Record<string, unknown>;
}

/**
 * What a Session read's entry is asked: a router's Workspace-scoped call, or
 * the request the agent socket resolved ({@link AgentVerbInput}), as the
 * socket's own verbs are asked. Told apart by `request`, which only the
 * socket's carries.
 */
export type SessionReadHandlerInput = SessionReadWorkspaceInput | AgentVerbInput;

/** The one map: every {@link HostHandlerKey}, and nothing else. */
export type HostHandlers = { readonly [Key in HostHandlerKey]: HostHandlerSignatures[Key] };

/**
 * What {@link createHostHandlers} seals: every entry but the served ones (the
 * agent doors' own, and the socket's Session reads), which a door's service
 * serves.
 */
export type SealedHostHandlers = Omit<HostHandlers, ServedHandlerKey>;

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
  readonly backups?: ProfileBackupsPort | null;
  readonly restore?: ProfileRestorePort | null;
  /** The same screenshot store Code Mode writes; absent means an explicit unavailable picture. */
  readonly pictures?: BrowserPictureStore;
  /** The recovered Session runtime, or null when this launch has none. */
  readonly runtime: SessionRuntime | null;
  /** The recovered Sessions facade, or null when this launch has none. */
  readonly sessions: Pick<Sessions, "create" | "attach" | "start"> | null;
  /**
   * Delivers a started Session's kickoff turn (`session.start`, VC-923).
   * Absent means a start lands with no kickoff, as on a socket with none.
   */
  readonly submitSessionMessage?: StartSessionPorts["submitSessionMessage"];
  /** Refines a started Session's heuristic title with a model call. Absent: heuristic only. */
  readonly refineAutoTitle?: StartSessionPorts["refineAutoTitle"];
  /** Model Access, or null when the Pi runtime did not come up. */
  readonly modelAccess: Pick<PiRuntimeHost, "inspectModelAccess"> | null;
  /** Experimental flags, or null on a host that keeps none. */
  readonly experiments: HostExperiments | null;
  /**
   * Whether working copies' environment recipes run (VC-584, the `cloud`
   * flag), read per call. Off or absent, the setup gate has nothing to show
   * and nothing to answer.
   */
  readonly environmentRecipes?: () => boolean;
  /** Where an armed arrival and a resumed delivery go. */
  readonly automations: RuntimeAutomations;
  /** The same busy-worktree guard every destructive worktree path reads. */
  readonly busyWorktreeSites: BusyWorktreeSites;
  /**
   * The host's worktree read service (VC-788), whose last-known answers a
   * scope switch's materialization and a Done or archive trim retire. Null
   * only on a host whose database did not open, where no board command runs.
   */
  readonly worktreeReads: WorktreeReadInvalidation | null;
  /** Interrupts a ticket's live agent attachments after a committed backward move. */
  readonly interruptTicketSessions?: (ticketId: string) => string[] | Promise<string[]>;
  /** Where a Done move's detached trim enrols, so shutdown drains it (VC-627). */
  readonly detachedWork?: DetachedWorkPort;
  readonly now?: () => number;
  /** Test seam: mints a created ticket's id. Defaults to `randomUUID`. */
  readonly newId?: () => string;
  /** Test seam: the worktree bundle a Done trim runs through. Defaults to the host's. */
  readonly worktree?: WorktreePorts;
  /** Sees every policy verdict at the map, before the handler it admits. */
  readonly onAdmission?: AdmissionObserver;
  /** The host's in-memory recent log (VC-699), or null where this host keeps none. */
  readonly logs?: LogRing | null;
  /**
   * What the Session listing reads (VC-713): the database, the Session
   * Engine's roster and the live attachments. Absent or null (a launch with no
   * Session Engine): `session.listing` answers unavailable.
   */
  readonly sessionListing?: SessionListingSources | null;
  /**
   * Sign-ins on a host (VC-702), or null where no network door serves them
   * (the desktop, whose window signs in over its own IPC): they answer
   * unavailable.
   */
  readonly signIns?: HostSignIns | null;
  /** Hostd-owned project creation; absent on the in-process desktop. */
  readonly workspaces?: {
    list(): HostWorkspaceList | Promise<HostWorkspaceList>;
    create(input: HostWorkspaceCreateInput): Promise<HostWorkspaceCreateResult>;
  };
  /**
   * The host's board change feeds (VC-565): every board command stamps its
   * rows here, and the root's event bus feeds it every other writer's
   * `data-changed` (`BoardChangeFeed.noteDataChanged`). One per host: a
   * root passes the feed its bus feeds; absent (tests), a private one.
   */
  readonly boardFeed?: BoardChangeFeed;
  /** The Session ledger's latest outcome per ticket, or null on a host without one. */
  readonly ticketSignals?: ((projectId: string) => Promise<readonly LatestSessionSignal[]>) | null;
  /** The host's foreground-shell registry. Absent on hosts without this UI operation. */
  readonly backgroundShells?: {
    moveForeground(sessionId: string, toolCallId: string): { shellId: string };
  } | null;
  /** Where Pi keeps saved tool output, which an archive or delete releases (VC-469). */
  readonly piSessionsDirectory?: string;
  /**
   * The live work this host holds for a project's Sessions, which removing
   * the project stops before it detaches it (VC-796, VC-822). Absent or null:
   * a host that cannot stop it, where `project.remove` answers unavailable
   * rather than hiding Sessions that are still working.
   */
  readonly projectLiveWork?: ProjectLiveWork | null;
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
  /** Desktop main's HOST links; absent or null on hostd: `hostScope.*` unavailable. */
  readonly hostScopeRelay?: HostScopeRelayPort | null;
  /**
   * App shortcuts out of desktop main's Browser pages (VC-301); absent or null
   * on hostd: `browserShortcuts.*` answer unavailable.
   */
  readonly browserShortcuts?: BrowserShortcutsPort | null;
  /**
   * Desktop main's Volli Cloud account service (VC-884); absent or null on
   * hostd: `account.*` answer unavailable.
   */
  readonly account?: AccountPort | null;
  /**
   * Desktop main's Mac runner (VC-895): this Mac's registration as one of
   * the person's runners; absent or null on hostd: `runners.*` answer
   * unavailable.
   */
  readonly runners?: RunnerAccountPort | null;
  /**
   * Desktop main's cloud project folders (VC-895 N2-3): the runner-local
   * registry and the folder picker; absent or null on hostd: `checkouts.*`
   * answer unavailable.
   */
  readonly checkouts?: CloudCheckoutPort | null;
}

/** Messages a client may show; unchanged from the router's own (VC-564). */
const SESSIONS_UNAVAILABLE = "Sessions are unavailable on this transport";
const RUNTIME_UNAVAILABLE = "The Session runtime is unavailable on this host";
const WORKTREE_READS_UNAVAILABLE = "Worktree reads are unavailable on this host";
const EXPERIMENTS_UNAVAILABLE = "Experimental settings are unavailable on this transport";
const MODEL_ACCESS_UNAVAILABLE = "Model Access is unavailable on this transport";
const PREFERENCES_UNAVAILABLE = "Model Access preferences are unavailable on this transport";
const BOARD_UNAVAILABLE = "The board is unavailable: the database did not open";
const SIGN_INS_UNAVAILABLE = "Sign-ins are unavailable on this host";
const REMOTE_HOSTS_UNAVAILABLE = "Remote hosts are unavailable on this host";
const REMOTE_SIGN_INS_UNAVAILABLE = "Remote host sign-ins are unavailable on this host";
const LOGS_UNAVAILABLE = "This host keeps no log to read";
const SESSION_LISTING_UNAVAILABLE = "The Session listing is unavailable on this host";
const HOST_SCOPE_RELAY_UNAVAILABLE = "Remote host operations are unavailable on this host";
const HOST_LINK_RELAY_UNAVAILABLE = "Remote projects are unavailable on this host";
const BROWSER_SHORTCUTS_UNAVAILABLE = "Browser Tab shortcuts are unavailable on this host";
const ACCOUNT_UNAVAILABLE = "Accounts are unavailable on this host";
const RUNNERS_UNAVAILABLE = "Runners are unavailable on this host";
const CHECKOUTS_UNAVAILABLE = "Project folders are unavailable on this host";
const PROJECT_REMOVAL_UNAVAILABLE = "Removing a project is unavailable on this host";

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

const ENVIRONMENT_RECIPES_OFF = "Environment setup is off on this host";

/** The ticket's working copy on this runner, or `null` when it has none; unknown tickets throw. */
function ticketWorktreePath(database: Database.Database, ticketId: string): string | null {
  const ticket = getTicket(database, ticketId);
  if (!ticket) throw new Error("Unknown ticket");
  return ticket.usesWorktree ? ticket.worktreePath : null;
}

/** A setup status as a window reads it: the run's ids and machine facts stay on the runner. */
function setupStatusView(status: WorktreeSetupStatus): WorktreeSetupStatusView {
  if (status.kind === "none" || status.kind === "pending" || status.kind === "running") {
    return { kind: status.kind };
  }
  const { source, summary, exitCode, endedAt, tail } = status.run;
  return { kind: status.kind, run: { source, summary, exitCode, endedAt, tail } };
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
 * The start's own unavailable (VC-923): this launch has no Sessions facade.
 * Each agent door words it in its own vocabulary, which it can do only for
 * this cause; any other unavailable (no database) keeps its own message.
 */
export class SessionRuntimeUnavailableError extends OperationUnavailableError {
  constructor() {
    super(SESSIONS_UNAVAILABLE);
    this.name = "SessionRuntimeUnavailableError";
  }
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
): SealedHostHandlers {
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
  const worktreeReads = () => present(options.worktreeReads, WORKTREE_READS_UNAVAILABLE);
  const signIns = () => present(options.signIns ?? null, SIGN_INS_UNAVAILABLE);
  const remoteHosts = () => present(options.remoteHosts ?? null, REMOTE_HOSTS_UNAVAILABLE);
  const remoteSignIns = () => present(options.remoteSignIns ?? null, REMOTE_SIGN_INS_UNAVAILABLE);
  const logs = () => present(options.logs ?? null, LOGS_UNAVAILABLE);
  const listing = () => present(options.sessionListing ?? null, SESSION_LISTING_UNAVAILABLE);
  const hostScopeRelay = () =>
    present(options.hostScopeRelay ?? null, HOST_SCOPE_RELAY_UNAVAILABLE);
  const hostLinkRelay = () => present(options.hostLinkRelay ?? null, HOST_LINK_RELAY_UNAVAILABLE);
  const browserShortcuts = () =>
    present(options.browserShortcuts ?? null, BROWSER_SHORTCUTS_UNAVAILABLE);
  const account = () => present(options.account ?? null, ACCOUNT_UNAVAILABLE);
  const runners = () => present(options.runners ?? null, RUNNERS_UNAVAILABLE);
  const checkouts = () => present(options.checkouts ?? null, CHECKOUTS_UNAVAILABLE);
  const feed = options.boardFeed ?? createBoardChangeFeed();

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
            worktreeReads: worktreeReads(),
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
      ...(options.newId === undefined ? {} : { newId: options.newId }),
      events: ports.events,
      feed,
      worktree,
      worktreeReads,
      busyWorktreeSites: options.busyWorktreeSites,
      detachedWork: options.detachedWork,
      ticketSignals: options.ticketSignals ?? null,
      piSessionsDirectory: options.piSessionsDirectory,
      move: (input, call, seam) => moveTicket(input, call, seam),
    }),
    "sessions.create": (input) =>
      sessions().create({ ...input, role: roleImpliedByTicket(input.ticketId) }),
    // One Ticket Session's start, whichever agent door asked (VC-923): the
    // person's operator CLI and the named tool resolve their own Ticket and
    // envelope, and both reach this. The facade, the kickoff, the auto-title
    // refinement, the mutation and the start notice are its, once.
    "session.start": (input, call) => {
      if (options.sessions === null) throw new SessionRuntimeUnavailableError();
      const facade = options.sessions;
      const database = board();
      const projects = listProjects(database);
      const ticket = getTicket(database, input.ticketId);
      const project = projects.find(({ id }) => id === input.projectId);
      if (ticket === undefined || project === undefined || ticket.projectId !== project.id) {
        throw new Error(`No ticket ${input.ticketId} in project ${input.projectId}.`);
      }
      return joined({ ticketId: ticket.id, projectId: project.id }, () =>
        startSessionOperation(
          {
            db: database,
            projects,
            sessions: facade,
            submitSessionMessage: options.submitSessionMessage,
            refineAutoTitle: options.refineAutoTitle,
            onMutation: (change) => ports.events.publish("data-changed", change),
            onSessionStarted: (notice) => ports.events.publish("session-started", notice),
            actorTicketDisplay: (ticketId) =>
              actorSessionTicketDisplay(database, projects, ticketId),
            now,
          },
          {
            operationId: input.operationId,
            project,
            ticket,
            message: input.message,
            title: input.title,
            modelOverride: input.modelOverride,
            delegation: input.delegation,
            actor: call.actor,
          },
          { defaultKickoff: DEFAULT_KICKOFF_MESSAGE, autoTitle: autoTitleFromKickoff },
        ),
      );
    },
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
    "session.picture": ({ sessionId, pictureId, offset }) =>
      options.pictures?.readActivityImage(sessionId, pictureId, offset) ?? {
        data: null,
        mimeType: null,
        nextOffset: null,
      },
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
    "session.listing": async ({ projectId }) =>
      boundedSessionListing(await projectSessionListing(listing(), projectId)),
    "session.listingForTicket": async ({ ticketId }) =>
      boundedSessionListing(await ticketSessionListing(listing(), ticketId)),
    "workspaces.list": () =>
      present(
        options.workspaces ?? null,
        "Project management is not available on this host",
      ).list(),
    "workspaces.create": (input) =>
      present(
        options.workspaces ?? null,
        "Project management is not available on this host",
      ).create(input),
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
    "shells.moveToBackground": ({ sessionId, toolCallId }) =>
      joined({ sessionId, toolCallId }, () =>
        present(
          options.backgroundShells ?? null,
          "Moving commands to the background is unavailable on this host",
        ).moveForeground(sessionId, toolCallId),
      ),
    "project.reorder": ({ orderedIds }) => {
      reorderProjects(board(), orderedIds, now());
      return null;
    },
    // Every window hears it, the asking one included, so a second window
    // drops the project. Untapped: the removed Workspace's feed has ended,
    // and no other Workspace changed.
    "project.remove": ({ projectId }) =>
      joined({ projectId }, async () => {
        await removeProject(
          {
            db: board(),
            live: present(options.projectLiveWork ?? null, PROJECT_REMOVAL_UNAVAILABLE),
            disposeFeed: (id) => feed.dispose(id),
            announce: () => feed.untapped(() => ports.events.publish("data-changed", {})),
            now,
          },
          projectId,
        );
        return null;
      }),
    "backups.restoreStatus": () =>
      present(options.restore ?? null, "Local restore is unavailable.").status(),
    "backups.restoreChoose": ({ fileName }) =>
      present(options.restore ?? null, "Local restore is unavailable.").choose(fileName),
    "backups.restoreDirectory": () =>
      present(options.restore ?? null, "Local restore is unavailable.").directory(),
    "backups.restoreStart": ({ expectedRevision, projectPaths }) =>
      present(options.restore ?? null, "Local restore is unavailable.").start(
        expectedRevision,
        projectPaths,
      ),
    "backups.restoreCancel": ({ expectedRevision }) =>
      present(options.restore ?? null, "Local restore is unavailable.").cancel(expectedRevision),
    "backups.restoreRestart": ({ expectedRevision }) =>
      done(() =>
        present(options.restore ?? null, "Local restore is unavailable.").restart(expectedRevision),
      ),
    "backups.status": () =>
      present(options.backups ?? null, "Local backups are unavailable.").status(),
    "backups.run": ({ expectedRevision }) =>
      present(options.backups ?? null, "Local backups are unavailable.").run(expectedRevision),
    "backups.reveal": () =>
      done(() => present(options.backups ?? null, "Local backups are unavailable.").reveal()),
    "worktree.trimSettings": () => getTrimSettings(board()),
    // The working copy's setup gate (VC-584). A ticket with no working copy
    // on this runner has nothing to stand on: `none`. With recipes off there
    // is no gate: nothing to show, and nothing to answer.
    "worktree.setupStatus": ({ ticketId }) => {
      if (options.environmentRecipes?.() !== true) return { kind: "none" };
      const database = board();
      const path = ticketWorktreePath(database, ticketId);
      return path === null
        ? { kind: "none" }
        : setupStatusView(worktreeSetupStatus(worktree(database), path, ticketId, now()));
    },
    "worktree.answerSetup": ({ ticketId, answer }) => {
      if (options.environmentRecipes?.() !== true) {
        throw new OperationUnavailableError(ENVIRONMENT_RECIPES_OFF);
      }
      const database = board();
      const path = ticketWorktreePath(database, ticketId);
      if (path === null) return { kind: "none" };
      const deps = worktree(database);
      return setupStatusView(
        answer === "retry"
          ? retryWorktreeSetup(deps, path, ticketId, now())
          : startWorktreeSetupAnyway(deps, path, ticketId, now()),
      );
    },
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
    // The add flows main still owns (VC-720): a reopened window's discovery read.
    "hostAdd.active": () => remoteHosts().activeAdds(),
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
    "hosts.projects": ({ hostId }) => remoteHosts().projects(hostId),
    // The sudo password (VC-710) is write-only, as the add flow's: scrubbed from any error.
    "hosts.createProject": async (input) => {
      try {
        return await remoteHosts().createProject(input);
      } catch (error) {
        throw withoutSecret(error, input.sudoPassword ?? "");
      }
    },
    "hosts.openWorkspace": ({ hostId, workspaceId }) =>
      done(() => remoteHosts().openWorkspace(hostId, workspaceId)),
    "hosts.closeWorkspace": ({ hostId, workspaceId }) =>
      done(() => remoteHosts().closeWorkspace(hostId, workspaceId)),
    // HOST relay (VC-722): before any project, through desktop main's port.
    "hostScope.query": ({ hostId, path, input }) => hostScopeRelay().query(hostId, path, input),
    "hostScope.mutate": ({ hostId, path, input }) => hostScopeRelay().mutate(hostId, path, input),
    "hostScope.subscribe": async ({ hostId, path, input, lastEventId }, _call, sink) =>
      hostScopeRelay().subscribe(hostId, path, input, lastEventId, (event) => sink.emit(event)),
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
    // Browser page shortcuts (VC-301): desktop main's Browser Tab host, through its port.
    "browserShortcuts.subscribe": async (_input, _call, sink) =>
      browserShortcuts().subscribe((event) => void sink.emit(event)),
    "browserShortcuts.focusPage": ({ tabId }) => done(() => browserShortcuts().focusPage(tabId)),
    // The Volli Cloud account (VC-884): desktop main's account service, through its port.
    "account.snapshot": () => account().snapshot(),
    "account.subscribe": async (_input, _call, sink) =>
      account().subscribe((snapshot) => void sink.emit(snapshot)),
    "account.signIn": ({ connection, inviteCode, acceptedAgreementVersion }) =>
      done(() =>
        acceptedAgreementVersion !== undefined
          ? account().signIn(connection, inviteCode, acceptedAgreementVersion)
          : inviteCode === undefined
            ? account().signIn(connection)
            : account().signIn(connection, inviteCode),
      ),
    "account.cancelSignIn": () => done(() => account().cancelSignIn()),
    "account.signOut": () => done(() => account().signOut()),
    "account.requestDeletion": () => done(() => account().requestDeletion()),
    "account.cancelDeletion": () => done(() => account().cancelDeletion()),
    "account.accessToken": ({ force }) => account().accessToken(force),
    "cloud.launch": () => account().launch(),
    "cloud.relaunch": () => done(() => account().relaunch()),
    "cloud.reportUnsavedWrites": ({ count }) => done(() => account().reportUnsavedWrites(count)),
    "cloud.saveSnapshot": ({ text }) => done(() => account().saveSnapshot(text)),
    "cloud.readSnapshot": async () => ({ text: await account().readSnapshot() }),
    "account.githubSubscribe": async (_input, _call, sink) =>
      account().github.subscribe((snapshot) => void sink.emit(snapshot)),
    "account.githubConnect": () => done(() => account().github.connect()),
    "account.githubInstall": () => done(() => account().github.install()),
    "account.githubCancel": () => done(() => account().github.cancel()),
    "account.githubDisconnect": () => done(() => account().github.disconnect()),
    // This Mac as a runner (VC-895): desktop main's Mac runner, through its port.
    "runners.thisMac": () => runners().thisMac(),
    "runners.subscribeThisMac": async (_input, _call, sink) =>
      runners().subscribeThisMac((snapshot) => void sink.emit(snapshot)),
    "runners.addThisMac": () => done(() => runners().addThisMac()),
    "runners.removeThisMac": () => done(() => runners().removeThisMac()),
    // A cloud project's folder on this Mac (VC-895 N2-3): desktop main, through its port.
    "checkouts.status": ({ projectId }) => checkouts().status(projectId),
    "checkouts.chooseFolder": ({ projectId }) => checkouts().chooseFolder(projectId),
  };
}
