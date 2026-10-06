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
  type SessionReadVerb,
} from "@volli/shared";

import type {
  SessionAttachInput,
  SessionCreateInput,
  SessionCreateResult,
  SessionRouterContext,
  SessionRouterHandlers,
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
const SESSION_READS = "Session reads are unavailable on this transport";

/** The handler map over legacy ports: each handler calls the port its key once read. */
export function sessionHandlersFrom(ports: Omit<LegacySessionPorts, keyof SessionRouterContext>) {
  const runtime = <Method extends keyof SessionRuntime>(method: Method) => {
    const bound = ports.runtime[method];
    if (bound === undefined) throw new OperationUnavailableError(RUNTIME);
    return (bound as (...args: never[]) => unknown).bind(ports.runtime) as SessionRuntime[Method];
  };
  const handlers: SessionRouterHandlers = {
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
  };
  return handlers;
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
