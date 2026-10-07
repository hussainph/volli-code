/**
 * TEST-ONLY: a Session router context from the per-behaviour ports the router
 * took before VC-668, so the router's own tests keep stating only the
 * behaviour each case needs.
 *
 * Production builds the handler map in host-core (`createHostHandlers`),
 * whose own tests prove what each handler does; this adapter only stands in
 * for it at the router's unit layer. A port left out answers unavailable, as
 * the host's handler does when its service is absent.
 */
import type { SessionRuntime } from "@volli/session-engine";
import {
  OperationUnavailableError,
  type AgentResponse,
  type CodeModePolicy,
  type CompactionPolicy,
  type ExperimentId,
  type ExperimentSnapshot,
  type HiddenModelRef,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
  type ModelPickerView,
  type ModelPurpose,
  type ModelSelection,
  type SessionListingPage,
  type SessionReadVerb,
  type HostLogsBatch,
  type HostLogsQuery,
} from "@volli/shared";

import type { DesktopRouterHandlers } from "./desktop-router";
import type {
  SessionAttachInput,
  SessionCreateInput,
  SessionCreateResult,
  SessionRouterContext,
  SessionRouterHandlers,
  SignInRouterHandlers,
} from "./index";
import type { SessionStartResult } from "@volli/session-engine";

/** The ports a Session router test may state, as the context once took them. */
export interface LegacySessionPorts extends Omit<SessionRouterContext, "handlers"> {
  runtime: Partial<SessionRuntime>;
  inspectModelAccess?: (input: { refresh?: boolean }) => Promise<ModelAccessSnapshot>;
  readModelAccessDefaults?: () => ModelAccessDefaults;
  writeModelAccessDefault?: (
    purpose: ModelPurpose,
    selection: ModelSelection | null,
  ) => ModelAccessDefaults | Promise<ModelAccessDefaults>;
  readHiddenModels?: () => readonly HiddenModelRef[];
  writeHiddenModels?: (hidden: readonly HiddenModelRef[]) => void | Promise<void>;
  readCompactionPolicy?: () => CompactionPolicy;
  writeCompactionPolicy?: (
    policy: CompactionPolicy,
  ) => CompactionPolicy | Promise<CompactionPolicy>;
  readCodeModePolicy?: () => CodeModePolicy;
  writeCodeModePolicy?: (policy: CodeModePolicy) => CodeModePolicy | Promise<CodeModePolicy>;
  readModelPickerView?: () => ModelPickerView;
  writeModelPickerView?: (view: ModelPickerView) => ModelPickerView | Promise<ModelPickerView>;
  readExperiments?: () => ExperimentSnapshot;
  writeExperiment?: (
    id: ExperimentId,
    enabled: boolean,
  ) => ExperimentSnapshot | Promise<ExperimentSnapshot>;
  createSession?: (input: SessionCreateInput) => Promise<SessionCreateResult>;
  attachSession?: (input: SessionAttachInput) => Promise<SessionStartResult>;
  /** The socket's Session reads, Workspace-scoped (VC-663, D4): host-core's `executeInWorkspace`. */
  readSessionVerb?: (
    verb: SessionReadVerb,
    workspaceId: string,
    args: Record<string, unknown>,
  ) => Promise<AgentResponse>;
  /** The Session listing (VC-713): a project's rows, or one ticket's. */
  listSessions?: (
    input: { projectId: string } | { ticketId: string },
  ) => SessionListingPage | Promise<SessionListingPage>;
  /** Sign-ins on a host (VC-702), handler by handler; an absent one answers unavailable. */
  signIns?: Partial<SignInRouterHandlers>;
  /** The host's recent log (VC-699): host-core's ring. */
  readLogs?: (query: HostLogsQuery) => HostLogsBatch;
  followLogs?: (
    query: HostLogsQuery,
    listener: (batch: HostLogsBatch) => void,
    fail: (error: unknown) => void,
  ) => () => void;
  /** The desktop-only tier (VC-608), for the desktop's bridge: the host map's own bodies. */
  desktop?: Partial<DesktopRouterHandlers>;
}

function need<Port>(port: Port | undefined, message: string): Port {
  if (port === undefined) throw new OperationUnavailableError(message);
  return port;
}

const SESSIONS = "Sessions are unavailable on this transport";
const EXPERIMENTS = "Experimental settings are unavailable on this transport";
const MODEL_ACCESS = "Model Access is unavailable on this transport";
const PREFERENCES = "Model Access preferences are unavailable on this transport";
const RUNTIME = "The Session runtime is unavailable on this host";
const LOGS = "This host keeps no log to read";
const SESSION_READS = "Session reads are unavailable on this transport";
const SIGN_INS = "Sign-ins are unavailable on this host";
const LISTING = "The Session listing is unavailable on this host";

/** Each sign-in handler the test stated, or one that answers unavailable. */
function signInHandlersFrom(stated: Partial<SignInRouterHandlers> = {}): SignInRouterHandlers {
  const unavailable = (): never => {
    throw new OperationUnavailableError(SIGN_INS);
  };
  return {
    "signIns.status": stated["signIns.status"] ?? unavailable,
    "signIns.setApiKey": stated["signIns.setApiKey"] ?? unavailable,
    "signIns.signOut": stated["signIns.signOut"] ?? unavailable,
    "signIns.start": stated["signIns.start"] ?? unavailable,
    "signIns.subscribe": stated["signIns.subscribe"] ?? (async () => unavailable()),
    "signIns.answer": stated["signIns.answer"] ?? unavailable,
    "signIns.cancel": stated["signIns.cancel"] ?? unavailable,
    "signIns.setGitCredential": stated["signIns.setGitCredential"] ?? unavailable,
    "signIns.clearGitCredential": stated["signIns.clearGitCredential"] ?? unavailable,
    "auth.callback.deliver": stated["auth.callback.deliver"] ?? unavailable,
  };
}
const BOARD = "The board is unavailable: the database did not open";
const REMOTE_HOSTS = "Remote hosts are unavailable on this host";

/** The handler map over legacy ports: each handler calls the port its key once read. */
export function sessionHandlersFrom(
  ports: Omit<LegacySessionPorts, keyof SessionRouterContext>,
): SessionRouterHandlers & DesktopRouterHandlers {
  const runtime = <Method extends keyof SessionRuntime>(method: Method) => {
    const bound = ports.runtime[method];
    if (bound === undefined) throw new OperationUnavailableError(RUNTIME);
    return (bound as (...args: never[]) => unknown).bind(ports.runtime) as SessionRuntime[Method];
  };
  const handlers: SessionRouterHandlers = {
    ...signInHandlersFrom(ports.signIns),
    "sessions.create": (input) => need(ports.createSession, SESSIONS)(input),
    "sessions.attach": (input) => need(ports.attachSession, SESSIONS)(input),
    "settings.experiments": () => need(ports.readExperiments, EXPERIMENTS)(),
    "settings.setExperiment": ({ id, enabled }) =>
      need(ports.writeExperiment, EXPERIMENTS)(id, enabled),
    "modelAccess.inspect": (input) => need(ports.inspectModelAccess, MODEL_ACCESS)(input),
    "modelAccess.defaults": () => need(ports.readModelAccessDefaults, PREFERENCES)(),
    "modelAccess.setDefault": ({ purpose, selection }) =>
      need(ports.writeModelAccessDefault, PREFERENCES)(purpose, selection),
    "modelAccess.hiddenModels": () => need(ports.readHiddenModels, PREFERENCES)(),
    "modelAccess.setHiddenModels": async (hidden) => {
      await need(ports.writeHiddenModels, PREFERENCES)(hidden);
    },
    "modelAccess.compactionPolicy": () => need(ports.readCompactionPolicy, PREFERENCES)(),
    "modelAccess.setCompactionPolicy": (policy) =>
      need(ports.writeCompactionPolicy, PREFERENCES)(policy),
    "modelAccess.codeModePolicy": () => need(ports.readCodeModePolicy, PREFERENCES)(),
    "modelAccess.setCodeModePolicy": (policy) =>
      need(ports.writeCodeModePolicy, PREFERENCES)(policy),
    "modelAccess.pickerView": () => need(ports.readModelPickerView, PREFERENCES)(),
    "modelAccess.setPickerView": (view) => need(ports.writeModelPickerView, PREFERENCES)(view),
    "session.snapshot": (input) => runtime("snapshot")(input),
    "session.history": (input) => runtime("history")(input),
    "session.projection": (input) => runtime("projection")(input),
    "session.subscribe": (input, _call, sink) =>
      runtime("subscribe")(
        input,
        (emission) => sink.emit(emission),
        (error) => sink.fail(error),
      ),
    "session.subscribeQueue": (input, _call, sink) =>
      runtime("subscribe")(
        input,
        (emission) => sink.emit(emission),
        (error) => sink.fail(error),
      ),
    "session.command": (request) => runtime("command")(request),
    "logs.tail": (query) => need(ports.readLogs, LOGS)(query),
    "logs.follow": async (query, _call, sink) =>
      need(ports.followLogs, LOGS)(
        query,
        (batch) => void sink.emit(batch),
        (error) => sink.fail(error),
      ),
    "session.cancelQueued": ({ commandId, sessionId, messageId, expectedRevision }) =>
      runtime("command")({
        commandId,
        sessionId,
        command: {
          kind: "message.cancel",
          messageId,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        },
      }),
    "session.editQueued": ({ commandId, sessionId, messageId, message, expectedRevision }) =>
      runtime("command")({
        commandId,
        sessionId,
        command: {
          kind: "message.edit",
          messageId,
          message,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        },
      }),
    "session.cancelInteraction": (input) =>
      runtime("cancelInteraction")({ ...input, reason: "abandoned", origin: { kind: "user" } }),
    "session.reconcile": (input) => runtime("reconcile")(input),
    "session.list": ({ workspaceId, args }) =>
      need(ports.readSessionVerb, SESSION_READS)("session.list", workspaceId, args),
    "session.show": ({ workspaceId, args }) =>
      need(ports.readSessionVerb, SESSION_READS)("session.show", workspaceId, args),
    "session.peek": ({ workspaceId, args }) =>
      need(ports.readSessionVerb, SESSION_READS)("session.peek", workspaceId, args),
    "session.answer": ({ workspaceId, args }) =>
      need(ports.readSessionVerb, SESSION_READS)("session.answer", workspaceId, args),
    "session.listing": async (input) => need(ports.listSessions, LISTING)(input),
    "session.listingForTicket": async (input) => need(ports.listSessions, LISTING)(input),
  };
  /** A remote hosts key: the case's own handler, or unavailable, as on hostd. */
  const remote = <Key extends keyof DesktopRouterHandlers>(key: Key): DesktopRouterHandlers[Key] =>
    ((...args: unknown[]) =>
      (need(ports.desktop?.[key], REMOTE_HOSTS) as (...args: unknown[]) => unknown)(
        ...args,
      )) as DesktopRouterHandlers[Key];
  const desktop: DesktopRouterHandlers = {
    "project.reorder": (input, call) =>
      need(ports.desktop?.["project.reorder"], BOARD)(input, call),
    "worktree.trimSettings": (input, call) =>
      need(ports.desktop?.["worktree.trimSettings"], BOARD)(input, call),
    "hosts.snapshot": remote("hosts.snapshot"),
    "hosts.subscribe": remote("hosts.subscribe"),
    "hosts.retry": remote("hosts.retry"),
    "hosts.updateHost": remote("hosts.updateHost"),
    "hosts.cancelScheduledUpdate": remote("hosts.cancelScheduledUpdate"),
    "hosts.signIn": remote("hosts.signIn"),
    "hosts.forget": remote("hosts.forget"),
    "hostAdd.start": remote("hostAdd.start"),
    "hostAdd.subscribe": remote("hostAdd.subscribe"),
    "hostAdd.answer": remote("hostAdd.answer"),
    "hostAdd.sudoPassword": remote("hostAdd.sudoPassword"),
    "hostAdd.retry": remote("hostAdd.retry"),
    "hostAdd.cancel": remote("hostAdd.cancel"),
    "hostSignIns.status": remote("hostSignIns.status"),
    "hostSignIns.macKeys": remote("hostSignIns.macKeys"),
    "hostSignIns.sendFromThisMac": remote("hostSignIns.sendFromThisMac"),
    "hostSignIns.setApiKey": remote("hostSignIns.setApiKey"),
    "hostSignIns.setGitCredential": remote("hostSignIns.setGitCredential"),
    "hostSignIns.run": remote("hostSignIns.run"),
    "hostSignIns.answer": remote("hostSignIns.answer"),
    "hostSignIns.cancel": remote("hostSignIns.cancel"),
    "hosts.rename": remote("hosts.rename"),
    "hosts.devices": remote("hosts.devices"),
    "hostAdd.facts": remote("hostAdd.facts"),
  };
  return { ...handlers, ...desktop };
}

/** A Session router context from legacy ports. */
export function sessionContext(ports: LegacySessionPorts): SessionRouterContext {
  const {
    caller,
    resourceWorkspace,
    sessionMayAct,
    diagnostics,
    transport,
    performanceObserver,
    ...legacy
  } = ports;
  return {
    caller,
    ...(resourceWorkspace === undefined ? {} : { resourceWorkspace }),
    ...(sessionMayAct === undefined ? {} : { sessionMayAct }),
    diagnostics,
    ...(transport === undefined ? {} : { transport }),
    ...(performanceObserver === undefined ? {} : { performanceObserver }),
    handlers: sessionHandlersFrom(legacy),
  };
}
