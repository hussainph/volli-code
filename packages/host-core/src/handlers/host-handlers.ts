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
  OperationUnavailableError,
  roleImpliedByTicket,
  type AgentResponse,
  type CodeModePolicy,
  type CompactionPolicy,
  type ExperimentId,
  type ExperimentSnapshot,
  type HandlerCall,
  type HiddenModelRef,
  type HostHandler,
  type HostHandlerKey,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
  type ModelPickerView,
  type ModelPurpose,
  type ModelSelection,
  type SessionReadVerb,
  type Ticket,
} from "@volli/shared";

import type { DetachedWorkPort } from "../detached-work";
import { sealHostHandlers, type AdmissionObserver, type HostHandlerMap } from "./handler-map";
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
import { executeTicketMove, type TicketMoveCommandInput } from "../ticket-move";
import type { BusyWorktreeSites } from "../worktree/activity";
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
export interface HostHandlerSignatures {
  readonly "ticket.move": HostHandler<TicketMoveCommandInput, Ticket[]>;
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
  readonly "session.history": HostHandler<{ sessionId: string; before: number }, SessionHistoryPage>;
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
  readonly "session.command": HostHandler<
    SessionRuntimeCommandRequest,
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
}

/** Messages a client may show; unchanged from the router's own (VC-564). */
const SESSIONS_UNAVAILABLE = "Sessions are unavailable on this transport";
const RUNTIME_UNAVAILABLE = "The Session runtime is unavailable on this host";
const EXPERIMENTS_UNAVAILABLE = "Experimental settings are unavailable on this transport";
const MODEL_ACCESS_UNAVAILABLE = "Model Access is unavailable on this transport";
const PREFERENCES_UNAVAILABLE = "Model Access preferences are unavailable on this transport";
const BOARD_UNAVAILABLE = "The board is unavailable: the database did not open";
const SESSION_READS_UNAVAILABLE = "Session reads are unavailable on this transport";

function present<Service>(service: Service | null, message: string): Service {
  if (service === null) throw new OperationUnavailableError(message);
  return service;
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

  return {
    "ticket.move": (input, call) => {
      const database = board();
      return executeTicketMove(
        {
          worktree: options.worktree ?? worktreeDeps(database, ports, { dataDir: options.dataDir }),
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
      );
    },
    "sessions.create": (input) =>
      sessions().create({ ...input, role: roleImpliedByTicket(input.ticketId) }),
    // Every Retry rides this. A ready attachment is the recovery point for an
    // Automation's durable first-message intent; the runner's fixed Session
    // command id reconciles rather than duplicates after a crash.
    "sessions.attach": async (input) => {
      const attached = await sessions().attach(input);
      if (attached.state === "ready" && automations.kind === "live") {
        const execution = automations.execution;
        if (execution.kind === "ready") {
          await execution.runner.resumeDeliveryForSession(input.sessionId);
        }
      }
      return attached;
    },
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
    "session.command": (request) => runtime().command(request),
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
  };
}
