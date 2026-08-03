import { projectSession } from "@volli/shared";
import type {
  CommandReceipt,
  Session,
  SessionAttachment,
  SessionAttachmentContinuity,
  SessionCapabilitySnapshot,
  SessionCommand,
  SessionEvent,
  SessionEventProvenance,
  SessionExecutionVenue,
  SessionInteractionCancelReason,
  SessionInteractionResolution,
  SessionNativeDetail,
  SessionNativeReference,
  SessionProjection,
  TranscriptReference,
  UnstampedCommandReceipt,
} from "@volli/shared";
import type { UIMessage } from "ai";
import type { SessionEngine, SubmitSessionCommandResult } from "./session-engine";
import type {
  BindingHandle,
  DeliveryReceipt,
  HarnessObservation,
  NativeAdapterRegistry,
  NativeAttachmentSpec,
  NativeCapabilityReport,
  NativeHarnessAdapter,
  NativeMessageDelivery,
  NativeProbeResult,
  ObservationSink,
  Reconciliation,
} from "./native-adapter";
import type { SessionTranscriptArtifact, TranscriptArtifactStore } from "./transcript-artifacts";

export interface SessionLocation {
  directory: string;
  venue: SessionExecutionVenue;
}

export interface SessionLocationResolver {
  resolve(session: Session): Promise<SessionLocation>;
}

export interface SessionRuntimeClock {
  now(): number;
}

export interface SessionRuntimeIds {
  next(kind: "attachment" | "capabilities" | "event" | "receipt" | "attention"): string;
}

export interface SessionRuntimePorts {
  engine: SessionEngine;
  adapters: NativeAdapterRegistry;
  artifacts: TranscriptArtifactStore;
  locations: SessionLocationResolver;
  clock: SessionRuntimeClock;
  ids: SessionRuntimeIds;
  /** Host diagnostics seam for a failing client stream; failures are isolated. */
  onSubscriberFailure?: (error: unknown) => void | Promise<void>;
  /** Bounded host probe deadline; tests may inject a shorter value. */
  probeTimeoutMs?: number;
}

export type SessionClientCommand =
  | {
      kind: "session.create";
      projectId: string;
      ticketId: string | null;
      title: string | null;
    }
  | {
      kind: "adapter.attach";
      adapterId: string;
      profileId: string;
      continuity: SessionAttachmentContinuity;
    }
  | {
      kind: "message.submit";
      message: UIMessage;
      delivery?: NativeMessageDelivery;
      model?: { providerId: string; modelId: string } | null;
      agent?: string | null;
      variant?: string | null;
    }
  | { kind: "executor.interrupt"; attachmentId?: string }
  | {
      kind: "interaction.resolve";
      interactionId: string;
      resolution: SessionInteractionResolution;
    }
  | { kind: "adapter.release"; attachmentId: string };

export type SessionRuntimeCommandRequest =
  | { commandId: string; command: Extract<SessionClientCommand, { kind: "session.create" }> }
  | {
      commandId: string;
      sessionId: string;
      command: Exclude<SessionClientCommand, { kind: "session.create" }>;
    };

type ExistingSessionCommandRequest = Extract<SessionRuntimeCommandRequest, { sessionId: string }>;
type AttachCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "adapter.attach" }>;
};
type MessageCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "message.submit" }>;
};
type InterruptCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "executor.interrupt" }>;
};
type ResolveInteractionCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "interaction.resolve" }>;
};
type ReleaseCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "adapter.release" }>;
};

export interface SessionRuntimeCommandResult {
  sessionId: string;
  command: SessionCommand;
  receipt: CommandReceipt | null;
  throughSequence: number;
}

export interface CancelInteractionRequest {
  sessionId: string;
  interactionId: string;
  /** Required: an interaction that stops waiting always states why it stopped. */
  reason: SessionInteractionCancelReason;
}

export interface SessionStreamFrame {
  sessionId: string;
  sequence: number;
  event: SessionEvent;
  transcript: SessionTranscriptArtifact | null;
}

/**
 * A Session's durable state on its own.
 *
 * The frames beside it in {@link SessionRuntimeSnapshot} are a transcript
 * replay: one per event since the Session began, each transcript event costing
 * an artifact read. A surface that is already subscribed to the stream has
 * every one of those frames and needs only this, so it is a separate answer
 * rather than a field a caller is trusted to ignore.
 */
export interface SessionRuntimeProjectionSnapshot {
  projection: SessionProjection;
  throughSequence: number;
}

export interface SessionRuntimeSnapshot extends SessionRuntimeProjectionSnapshot {
  frames: readonly SessionStreamFrame[];
  transcript: readonly SessionTranscriptArtifact[];
}

export interface SessionRuntime {
  command(request: SessionRuntimeCommandRequest): Promise<SessionRuntimeCommandResult>;
  snapshot(input: { sessionId: string }): Promise<SessionRuntimeSnapshot>;
  /** Durable Session state without the transcript replay a fresh surface needs. */
  projection(input: { sessionId: string }): Promise<SessionRuntimeProjectionSnapshot>;
  subscribe(
    input: { sessionId: string; afterSequence: number },
    listener: (frame: SessionStreamFrame) => void | Promise<void>,
  ): Promise<() => void>;
  cancelInteraction(request: CancelInteractionRequest): Promise<void>;
  refreshCapabilities(input: {
    sessionId: string;
    attachmentId: string;
  }): Promise<SessionCapabilitySnapshot>;
  reconcile(input: { sessionId: string; attachmentId: string }): Promise<void>;
  close(): Promise<void>;
}

export class SessionRuntimeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRuntimeNotFoundError";
  }
}

export class SessionRuntimeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRuntimeConflictError";
  }
}

interface BindingRecord {
  adapter: NativeHarnessAdapter;
  handle: BindingHandle;
  spec: NativeAttachmentSpec;
  attachment: SessionAttachment;
  venue: SessionExecutionVenue;
  cursor: SessionNativeDetail | null;
  reconcileInFlight: Promise<void> | null;
}

type AdapterIdentity = Pick<NativeHarnessAdapter, "manifest">;

interface InFlightCommand {
  signature: string;
  promise: Promise<SessionRuntimeCommandResult>;
}

interface Subscriber {
  sessionId: string;
  cursor: number;
  events: Map<number, SessionEvent>;
  listener: (frame: SessionStreamFrame) => void | Promise<void>;
  draining: Promise<void>;
  active: boolean;
}

/**
 * Some SDKs synchronously report startup observations from `attach()`. Buffer
 * them until `attachment.opened` is durable, then serialize every later emit
 * behind that replay so provider order cannot overtake the ledger boundary.
 */
class BufferedObservationSink implements ObservationSink {
  readonly #pending: HarnessObservation[] = [];
  #tail: Promise<void> = Promise.resolve();
  #state: "buffering" | "active" | "discarded" = "buffering";

  constructor(private readonly target: ObservationSink) {}

  emit(observation: HarnessObservation): Promise<void> {
    if (this.#state === "discarded") return Promise.resolve();
    if (this.#state === "buffering") {
      this.#pending.push(observation);
      return Promise.resolve();
    }
    return this.#enqueue(observation);
  }

  activate(): Promise<void> {
    this.#state = "active";
    const emissions = this.#pending.splice(0).map((observation) => this.#enqueue(observation));
    return Promise.all(emissions).then(() => undefined);
  }

  discard(): void {
    this.#state = "discarded";
    this.#pending.length = 0;
  }

  #enqueue(observation: HarnessObservation): Promise<void> {
    const emission = this.#tail.then(() => this.target.emit(observation));
    // Preserve the caller-visible rejection while allowing later observations
    // to continue behind a failed durable write.
    this.#tail = emission.catch(() => undefined);
    return emission;
  }
}

/**
 * One Session's history, folded once.
 *
 * `projection` is always exactly `projectSession(session, events, foldedAt)` —
 * the fold stays a pure total function over the whole log, and this only keeps
 * its result and the events it consumed so the next read folds the same log
 * plus whatever arrived after `throughSequence`.
 */
interface ProjectedHistory {
  projection: SessionProjection;
  events: readonly SessionEvent[];
  throughSequence: number;
  /**
   * When this fold stops being true on its own, or null if it never does.
   *
   * `now` is the single non-durable input to `projectSession`: a capability
   * snapshot leaves the projection the moment it expires, with no event to
   * announce it. This is the earliest such moment among the snapshots the fold
   * kept, and reaching it invalidates the entry as surely as a new event does.
   */
  staleAt: number | null;
}

const ADAPTER_PROBE_TIMEOUT_MS = 15_000;
const EVENT_PAGE_SIZE = 500;
/**
 * How many Sessions keep a folded history. A Session's events are held for as
 * long as its entry lives, so this is the bound on that memory; the desktop
 * reads one or two Sessions at a time and an evicted entry costs one re-read.
 */
const PROJECTION_CACHE_LIMIT = 8;

class DefaultSessionRuntime implements SessionRuntime {
  readonly #bindings = new Map<string, BindingRecord>();
  readonly #rehydratingBindings = new Map<string, Promise<BindingRecord>>();
  readonly #inFlight = new Map<string, InFlightCommand>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();
  readonly #capabilityRevisions = new Map<string, number>();
  readonly #capabilityWrites = new Map<string, Promise<SessionCapabilitySnapshot>>();
  /** Insertion-ordered, so the first key is the least recently read Session. */
  readonly #histories = new Map<string, ProjectedHistory>();
  readonly #probeControllers = new Set<AbortController>();
  #closed = false;

  constructor(private readonly ports: SessionRuntimePorts) {}

  command(request: SessionRuntimeCommandRequest): Promise<SessionRuntimeCommandResult> {
    this.#assertOpen();
    const signature = stableJson(request);
    const existing = this.#inFlight.get(request.commandId);
    if (existing) {
      if (existing.signature !== signature) {
        return Promise.reject(
          new SessionRuntimeConflictError(
            `Command ${request.commandId} is already in flight with different intent`,
          ),
        );
      }
      return existing.promise;
    }

    const promise = this.#command(request).finally(async () => {
      this.#inFlight.delete(request.commandId);
      await this.#releaseBindingsAfterClose();
    });
    this.#inFlight.set(request.commandId, { signature, promise });
    return promise;
  }

  async #command(request: SessionRuntimeCommandRequest): Promise<SessionRuntimeCommandResult> {
    if (!("sessionId" in request)) {
      const result = await this.ports.engine.createSession({
        commandId: request.commandId,
        projectId: request.command.projectId,
        ticketId: request.command.ticketId,
        title: request.command.title,
        provenance: userProvenance(null),
      });
      await this.#publish([result.commandEvent, result.event, result.receiptEvent]);
      return {
        sessionId: result.session.id,
        command: result.command,
        receipt: result.receipt,
        throughSequence: result.receiptEvent.sequence,
      };
    }

    const projection = await this.#requireSession(request.sessionId);
    const location = await this.ports.locations.resolve(projection.session);
    const existed = this.#commandExists(projection, request.commandId);

    switch (request.command.kind) {
      case "adapter.attach":
        return this.#attach(request as AttachCommandRequest, location, existed);
      case "message.submit":
        return this.#submitMessage(request as MessageCommandRequest, projection, location, existed);
      case "executor.interrupt":
        return this.#interrupt(request as InterruptCommandRequest, projection, location, existed);
      case "interaction.resolve":
        return this.#resolveInteraction(
          request as ResolveInteractionCommandRequest,
          projection,
          location,
          existed,
        );
      case "adapter.release":
        return this.#release(request as ReleaseCommandRequest, projection, location, existed);
    }
  }

  async #attach(
    request: AttachCommandRequest,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const submitted = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      intent: {
        kind: "executor.start",
        adapterId: request.command.adapterId,
        continuity: request.command.continuity,
      },
      provenance: userProvenance(location.venue),
    });
    await this.#publishSubmit(submitted, existed);
    if (submitted.receipt && submitted.receipt.status !== "unreconciled")
      return this.#result(request.sessionId, submitted.command, submitted.receipt);

    const adapter = this.ports.adapters.get(request.command.adapterId);
    if (!adapter) {
      return this.#failAttach({
        request,
        submitted,
        adapter: null,
        location,
        code: "adapter_missing",
        detail: `Native adapter ${request.command.adapterId} was not found`,
      });
    }
    if (existed) return this.#recoverReplayedAttach(request, submitted, adapter, location);

    const profile = adapter.manifest.profiles.find(({ id }) => id === request.command.profileId);
    if (!profile || profile.transport !== "native") {
      return this.#failAttach({
        request,
        submitted,
        adapter,
        location,
        code: "profile_unavailable",
        detail: `Native profile ${request.command.profileId} is unavailable`,
      });
    }

    let probe: NativeProbeResult;
    try {
      probe = await this.#probe(adapter, {
        profileId: request.command.profileId,
        directory: location.directory,
      });
    } catch (error) {
      return this.#failAttach({
        request,
        submitted,
        adapter,
        location,
        code: "probe_failed",
        detail: errorMessage(error),
      });
    }
    if (probe.status !== "available") {
      return this.#failAttach({
        request,
        submitted,
        adapter,
        location,
        code: `adapter_${probe.status}`,
        detail: probe.reason,
      });
    }

    const attachmentId = this.#id("attachment");
    const spec: NativeAttachmentSpec = {
      sessionId: request.sessionId,
      attachmentId,
      profileId: request.command.profileId,
      directory: location.directory,
      continuity: request.command.continuity,
      native: null,
    };
    const sink = new BufferedObservationSink(this.#sink(adapter, spec, location.venue));
    let handle: BindingHandle;
    try {
      handle = await adapter.attach(spec, sink);
    } catch (error) {
      sink.discard();
      return this.#failAttach({
        request,
        submitted,
        adapter,
        location,
        code: "attach_failed",
        detail: errorMessage(error),
        attachmentId,
      });
    }

    try {
      const attachment: SessionAttachment = {
        id: attachmentId,
        sessionId: request.sessionId,
        adapterId: adapter.manifest.id,
        venue: location.venue,
        continuity: request.command.continuity,
        native: wrapNativeBinding(
          request.command.profileId,
          location.directory,
          probe,
          handle.native,
        ),
      };
      const opened = await this.ports.engine.observe({
        id: this.#id("event"),
        sessionId: request.sessionId,
        occurredAt: this.ports.clock.now(),
        provenance: adapterProvenance(adapter, location.venue),
        commandId: request.commandId,
        kind: "attachment.opened",
        attachment,
      });
      this.#bindings.set(attachmentId, {
        adapter,
        handle,
        spec: { ...spec, native: handle.native },
        attachment,
        venue: location.venue,
        cursor: null,
        reconcileInFlight: null,
      });
      await this.#publish([opened]);
      await sink.activate();
      await this.#recordCapabilities(
        request.sessionId,
        attachmentId,
        request.command.profileId,
        adapter,
        probe.capabilities,
        location.venue,
      );
      const receipt = await this.#recordDelivery(
        request.sessionId,
        attachmentId,
        adapter,
        location.venue,
        {
          commandId: request.commandId,
          status: "accepted",
          acceptedAt: this.ports.clock.now(),
          native: handle.native,
        },
        "executor.start.requested",
      );
      return this.#result(request.sessionId, submitted.command, receipt);
    } catch (error) {
      if (!this.#bindings.has(attachmentId)) {
        sink.discard();
        await handle.release("adapter_failure").catch(() => undefined);
      }
      throw error;
    }
  }

  async #recoverReplayedAttach(
    request: AttachCommandRequest,
    submitted: SubmitSessionCommandResult,
    adapter: NativeHarnessAdapter,
    location: SessionLocation,
  ): Promise<SessionRuntimeCommandResult> {
    // One read of the folded history: the projection and the events below are
    // the same fold, so a recovery decision can never be made against a
    // projection from one moment and a log from another.
    const { projection, events } = await this.#history(request.sessionId);
    const outcome = events.find(
      (event) =>
        event.commandId === request.commandId &&
        (event.payload.kind === "attachment.opened" || event.payload.kind === "attachment.failed"),
    );
    if (outcome?.payload.kind === "attachment.opened") {
      try {
        const binding = await this.#bindingForAttachment(
          outcome.payload.attachment.id,
          projection,
          location,
        );
        await this.#reconcileBinding(binding);
      } catch (error) {
        const receipt = await this.#recordDelivery(
          request.sessionId,
          outcome.payload.attachment.id,
          adapter,
          location.venue,
          {
            commandId: request.commandId,
            status: "unknown",
            detail: `Attachment recovery failed: ${errorMessage(error)}`,
            native: null,
          },
          "executor.start.requested",
        );
        return this.#result(request.sessionId, submitted.command, receipt);
      }
    }

    const replayed = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      intent: submitted.command.intent as Extract<
        SessionCommand["intent"],
        { kind: "executor.start" }
      >,
      provenance: userProvenance(location.venue),
    });
    if (replayed.receipt)
      return this.#result(request.sessionId, replayed.command, replayed.receipt);

    const receipt = await this.#recordDelivery(
      request.sessionId,
      outcome?.payload.kind === "attachment.opened" ? outcome.payload.attachment.id : null,
      adapter,
      location.venue,
      {
        commandId: request.commandId,
        status: "unknown",
        detail: outcome
          ? "Attachment outcome is recorded but its delivery receipt is unreconciled"
          : "Attach command has no durable attachment outcome; explicit recovery is required",
        native: null,
      },
      "executor.start.requested",
    );
    return this.#result(request.sessionId, submitted.command, receipt);
  }

  async #failAttach(input: {
    request: Extract<SessionRuntimeCommandRequest, { sessionId: string }> & {
      command: Extract<SessionClientCommand, { kind: "adapter.attach" }>;
    };
    submitted: SubmitSessionCommandResult;
    adapter: NativeHarnessAdapter | null;
    location: SessionLocation;
    code: string;
    detail: string;
    attachmentId?: string;
  }): Promise<SessionRuntimeCommandResult> {
    const attachmentId = input.attachmentId ?? this.#id("attachment");
    const failed = await this.ports.engine.observe({
      id: this.#id("event"),
      sessionId: input.request.sessionId,
      occurredAt: this.ports.clock.now(),
      provenance: adapterProvenance(
        input.adapter ?? adapterIdentity(input.request.command.adapterId),
        input.location.venue,
      ),
      commandId: input.request.commandId,
      kind: "attachment.failed",
      attachment: {
        id: attachmentId,
        sessionId: input.request.sessionId,
        adapterId: input.adapter?.manifest.id ?? input.request.command.adapterId,
        venue: input.location.venue,
        continuity: input.request.command.continuity,
        native: null,
      },
      failure: { code: input.code, detail: input.detail, diagnostic: null },
    });
    await this.#publish([failed]);
    const receipt = await this.#recordDelivery(
      input.request.sessionId,
      null,
      input.adapter ?? adapterIdentity(input.request.command.adapterId),
      input.location.venue,
      {
        commandId: input.request.commandId,
        status: "rejected",
        code: input.code,
        detail: input.detail,
        native: null,
      },
      "executor.start.requested",
    );
    return this.#result(input.request.sessionId, input.submitted.command, receipt);
  }

  async #submitMessage(
    request: MessageCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const artifact = await this.ports.artifacts.write({
      version: 1,
      threadId: `thread:${request.sessionId}:root`,
      branchId: `branch:${request.sessionId}:main`,
      attemptId: `attempt:${request.commandId}`,
      turnId: `turn:${request.commandId}`,
      message: request.command.message,
    });
    const submitted = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      intent: { kind: "message.submit", reference: artifact },
      provenance: userProvenance(location.venue),
    });
    await this.#publishSubmit(submitted, existed);
    if (submitted.receipt && submitted.receipt.status !== "unreconciled")
      return this.#result(request.sessionId, submitted.command, submitted.receipt);

    const binding = await this.#bindingForCommand(submitted.command, projection, location);
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) return recovered;

    const receipt = await binding.handle.dispatch({
      kind: "message.submit",
      commandId: request.commandId,
      sessionId: request.sessionId,
      attachmentId: binding.spec.attachmentId,
      message: request.command.message,
      delivery: request.command.delivery ?? "queue",
      model: request.command.model ?? null,
      agent: request.command.agent ?? null,
      variant: request.command.variant ?? null,
    });
    const durable = await this.#recordDelivery(
      request.sessionId,
      binding.spec.attachmentId,
      binding.adapter,
      binding.venue,
      receipt,
      "message.submitted",
    );
    return this.#result(request.sessionId, submitted.command, durable);
  }

  async #interrupt(
    request: InterruptCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const attachmentId = request.command.attachmentId ?? projection.liveExecutor?.id;
    if (!attachmentId) throw new SessionRuntimeConflictError("No live executor can be interrupted");
    const submitted = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      intent: { kind: "executor.interrupt", attachmentId },
      provenance: userProvenance(location.venue),
    });
    await this.#publishSubmit(submitted, existed);
    if (submitted.receipt && submitted.receipt.status !== "unreconciled")
      return this.#result(request.sessionId, submitted.command, submitted.receipt);
    const binding = await this.#bindingForCommand(submitted.command, projection, location);
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) return recovered;
    const receipt = await binding.handle.dispatch({
      kind: "executor.interrupt",
      commandId: request.commandId,
      sessionId: request.sessionId,
      attachmentId,
    });
    const durable = await this.#recordDelivery(
      request.sessionId,
      attachmentId,
      binding.adapter,
      binding.venue,
      receipt,
      "executor.interrupted",
    );
    return this.#result(request.sessionId, submitted.command, durable);
  }

  async #resolveInteraction(
    request: ResolveInteractionCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const interaction = projection.interactions.active.find(
      ({ id }) => id === request.command.interactionId,
    );
    if (!interaction) {
      throw new SessionRuntimeNotFoundError(
        `Interaction ${request.command.interactionId} is not open`,
      );
    }
    const resolutionArtifact = await this.ports.artifacts.write({
      version: 1,
      threadId: `thread:${request.sessionId}:root`,
      branchId: `branch:${request.sessionId}:main`,
      attemptId: `attempt:${request.commandId}`,
      turnId: null,
      message: {
        id: request.commandId,
        role: "user",
        metadata: { kind: "interaction-resolution", interactionId: interaction.id },
        parts: [
          {
            type: "data-interaction-resolution",
            data: request.command.resolution,
          },
        ],
      },
    });
    const submitted = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      intent: {
        kind: "interaction.resolve",
        attachmentId: interaction.attachmentId,
        interactionId: interaction.id,
        resolution: request.command.resolution,
        reference: resolutionArtifact,
      },
      provenance: userProvenance(location.venue),
    });
    await this.#publishSubmit(submitted, existed);
    if (submitted.receipt && submitted.receipt.status !== "unreconciled")
      return this.#result(request.sessionId, submitted.command, submitted.receipt);
    const binding = await this.#bindingForAttachment(
      interaction.attachmentId,
      projection,
      location,
    );
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) return recovered;
    const receipt = await binding.handle.dispatch({
      kind: "interaction.resolve",
      commandId: request.commandId,
      sessionId: request.sessionId,
      attachmentId: interaction.attachmentId,
      interaction,
      resolution: request.command.resolution,
    });
    const durable = await this.#recordDelivery(
      request.sessionId,
      interaction.attachmentId,
      binding.adapter,
      binding.venue,
      receipt,
      "interaction.resolved",
    );
    return this.#result(request.sessionId, submitted.command, durable);
  }

  /**
   * The third interaction verb, beside `#resolveInteraction` and the answer it
   * delivers. Cancelling records one durable fact and dispatches nothing: the
   * harness was never told an answer, so Volli must not claim it heard one.
   * That is also why this is not a Session command — a command earns a delivery
   * receipt, and there is no delivery here to receipt.
   */
  async #cancelInteraction(request: CancelInteractionRequest): Promise<void> {
    const projection = await this.#requireSession(request.sessionId);
    const interaction = projection.interactions.active.find(
      ({ id }) => id === request.interactionId,
    );
    if (!interaction) {
      throw new SessionRuntimeNotFoundError(`Interaction ${request.interactionId} is not open`);
    }
    const location = await this.ports.locations.resolve(projection.session);
    const event = await this.ports.engine.observe({
      id: this.#id("event"),
      sessionId: request.sessionId,
      attachmentId: interaction.attachmentId,
      occurredAt: this.ports.clock.now(),
      provenance: userProvenance(location.venue),
      kind: "interaction.cancelled",
      interactionId: interaction.id,
      reason: request.reason,
    });
    await this.#publish([event]);
  }

  async #release(
    request: ReleaseCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const submitted = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      intent: { kind: "executor.stop", attachmentId: request.command.attachmentId },
      provenance: userProvenance(location.venue),
    });
    await this.#publishSubmit(submitted, existed);
    if (submitted.receipt && submitted.receipt.status !== "unreconciled")
      return this.#result(request.sessionId, submitted.command, submitted.receipt);
    const binding = await this.#bindingForAttachment(
      request.command.attachmentId,
      projection,
      location,
    );
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) return recovered;
    await binding.handle.release("requested");
    const closed = await this.ports.engine.observe({
      id: this.#id("event"),
      sessionId: request.sessionId,
      attachmentId: request.command.attachmentId,
      commandId: request.commandId,
      occurredAt: this.ports.clock.now(),
      provenance: adapterProvenance(binding.adapter, binding.venue),
      kind: "attachment.closed",
      outcome: "completed",
    });
    await this.#publish([closed]);
    this.#bindings.delete(request.command.attachmentId);
    const receipt = await this.#recordDelivery(
      request.sessionId,
      request.command.attachmentId,
      binding.adapter,
      binding.venue,
      {
        commandId: request.commandId,
        status: "accepted",
        acceptedAt: this.ports.clock.now(),
        native: binding.handle.native,
      },
      "executor.stop.requested",
    );
    return this.#result(request.sessionId, submitted.command, receipt);
  }

  async #recoverAdapterDelivery(input: {
    request: ExistingSessionCommandRequest;
    submitted: SubmitSessionCommandResult;
    binding: BindingRecord;
    existed: boolean;
  }): Promise<SessionRuntimeCommandResult | null> {
    const priorReceipt = input.submitted.receipt;
    if (!priorReceipt && !input.existed) return null;
    await this.#reconcileBinding(input.binding);
    const replayed = await this.ports.engine.submit({
      commandId: input.request.commandId,
      sessionId: input.request.sessionId,
      intent: input.submitted.command.intent as Exclude<
        SessionCommand["intent"],
        { kind: "session.create" }
      >,
      provenance: userProvenance(input.binding.venue),
    });
    const receipt = replayed.receipt ?? priorReceipt;
    return receipt ? this.#result(input.request.sessionId, replayed.command, receipt) : null;
  }

  async snapshot(input: { sessionId: string }): Promise<SessionRuntimeSnapshot> {
    this.#assertOpen();
    const history = await this.#history(input.sessionId);
    const frames: SessionStreamFrame[] = [];
    const transcript: SessionTranscriptArtifact[] = [];
    for (const event of history.events) {
      const frame = await this.#frame(event);
      frames.push(frame);
      if (frame.transcript) transcript.push(frame.transcript);
    }
    return {
      projection: history.projection,
      throughSequence: history.throughSequence,
      frames,
      transcript,
    };
  }

  async projection(input: { sessionId: string }): Promise<SessionRuntimeProjectionSnapshot> {
    this.#assertOpen();
    const history = await this.#history(input.sessionId);
    return { projection: history.projection, throughSequence: history.throughSequence };
  }

  async subscribe(
    input: { sessionId: string; afterSequence: number },
    listener: (frame: SessionStreamFrame) => void | Promise<void>,
  ): Promise<() => void> {
    this.#assertOpen();
    if (!Number.isInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new Error("Session subscription cursor must be a non-negative integer");
    }
    const subscriber: Subscriber = {
      sessionId: input.sessionId,
      cursor: input.afterSequence,
      events: new Map(),
      listener,
      draining: Promise.resolve(),
      active: true,
    };
    let subscribers = this.#subscribers.get(input.sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.#subscribers.set(input.sessionId, subscribers);
    }
    subscribers.add(subscriber);
    try {
      const replay = await this.#listEventsPaged({
        sessionId: input.sessionId,
        afterSequence: input.afterSequence,
      });
      await this.#enqueue(subscriber, replay);
    } catch (error) {
      subscribers.delete(subscriber);
      throw error;
    }
    return () => {
      subscriber.active = false;
      subscribers?.delete(subscriber);
      if (subscribers?.size === 0) this.#subscribers.delete(input.sessionId);
    };
  }

  async cancelInteraction(request: CancelInteractionRequest): Promise<void> {
    this.#assertOpen();
    await this.#cancelInteraction(request);
  }

  async refreshCapabilities(input: {
    sessionId: string;
    attachmentId: string;
  }): Promise<SessionCapabilitySnapshot> {
    this.#assertOpen();
    const projection = await this.#requireSession(input.sessionId);
    this.#assertOpen();
    const location = await this.ports.locations.resolve(projection.session);
    this.#assertOpen();
    const binding = await this.#bindingForAttachment(input.attachmentId, projection, location);
    await this.#assertBindingOperationOpen();
    const probe = await this.#probe(binding.adapter, {
      profileId: binding.spec.profileId,
      directory: binding.spec.directory,
    });
    await this.#assertBindingOperationOpen();
    if (probe.status !== "available") {
      throw new SessionRuntimeConflictError(probe.reason);
    }
    return this.#recordCapabilities(
      input.sessionId,
      input.attachmentId,
      binding.spec.profileId,
      binding.adapter,
      probe.capabilities,
      binding.venue,
    );
  }

  async reconcile(input: { sessionId: string; attachmentId: string }): Promise<void> {
    this.#assertOpen();
    const projection = await this.#requireSession(input.sessionId);
    this.#assertOpen();
    const location = await this.ports.locations.resolve(projection.session);
    this.#assertOpen();
    const binding = await this.#bindingForAttachment(input.attachmentId, projection, location);
    await this.#assertBindingOperationOpen();
    await this.#reconcileBinding(binding, true);
    await this.#assertBindingOperationOpen();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#probeControllers)
      controller.abort(new Error("Session runtime closed"));
    this.#probeControllers.clear();
    for (const subscribers of this.#subscribers.values()) {
      for (const subscriber of subscribers) subscriber.active = false;
    }
    this.#subscribers.clear();
    this.#histories.clear();
    await this.#releaseBindingsAfterClose();
  }

  async #releaseBindingsAfterClose(): Promise<void> {
    if (!this.#closed) return;
    const bindings = [...this.#bindings.values()];
    this.#bindings.clear();
    await Promise.allSettled(bindings.map(({ handle }) => handle.release("shutdown")));
  }

  async #assertBindingOperationOpen(): Promise<void> {
    if (!this.#closed) return;
    await this.#releaseBindingsAfterClose();
    this.#assertOpen();
  }

  async #probe(
    adapter: NativeHarnessAdapter,
    context: { profileId: string; directory: string },
  ): Promise<NativeProbeResult> {
    const controller = new AbortController();
    const timeoutMs = this.ports.probeTimeoutMs ?? ADAPTER_PROBE_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("Native adapter probe timeout must be a positive integer");
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([controller.signal, deadline]);
    this.#probeControllers.add(controller);
    let onAbort!: () => void;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([adapter.probe(context, signal), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#probeControllers.delete(controller);
    }
  }

  async #recordCapabilities(
    sessionId: string,
    attachmentId: string,
    profileId: string,
    adapter: AdapterIdentity,
    report: NativeCapabilityReport,
    venue: SessionExecutionVenue,
  ): Promise<SessionCapabilitySnapshot> {
    const scope = `${sessionId}\u0000${attachmentId}\u0000${adapter.manifest.id}\u0000${profileId}`;
    const previous = this.#capabilityWrites.get(scope) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() =>
        this.#recordCapabilitiesNow(
          sessionId,
          attachmentId,
          profileId,
          adapter,
          report,
          venue,
          scope,
        ),
      );
    this.#capabilityWrites.set(scope, write);
    try {
      return await write;
    } finally {
      if (this.#capabilityWrites.get(scope) === write) this.#capabilityWrites.delete(scope);
    }
  }

  async #recordCapabilitiesNow(
    sessionId: string,
    attachmentId: string,
    profileId: string,
    adapter: AdapterIdentity,
    report: NativeCapabilityReport,
    venue: SessionExecutionVenue,
    scope: string,
  ): Promise<SessionCapabilitySnapshot> {
    let previousRevision = this.#capabilityRevisions.get(scope);
    if (previousRevision === undefined) {
      const projection = await this.#requireSession(sessionId);
      previousRevision =
        projection.capabilities.find(
          (snapshot) =>
            snapshot.attachmentId === attachmentId &&
            snapshot.adapterId === adapter.manifest.id &&
            snapshot.profileId === profileId,
        )?.revision ?? 0;
    }
    const revision = previousRevision + 1;
    const observedAt = this.ports.clock.now();
    const snapshot: SessionCapabilitySnapshot = {
      id: this.#id("capabilities"),
      adapterId: adapter.manifest.id,
      attachmentId,
      profileId,
      revision,
      observedAt,
      expiresAt: observedAt + 60_000,
      features: report.features,
      // Exhaustive provider inventory belongs behind the Runtime Catalog
      // Module, not in every immutable Session event and renderer snapshot.
      // Keep only entries this attachment can actually offer now.
      catalog: report.catalog.filter((item) => item.state !== "unavailable"),
    };
    const event = await this.ports.engine.observe({
      id: this.#id("event"),
      sessionId,
      attachmentId,
      occurredAt: observedAt,
      provenance: adapterProvenance(adapter, venue),
      kind: "capabilities.updated",
      snapshot,
    });
    this.#capabilityRevisions.set(scope, revision);
    await this.#publish([event]);
    return snapshot;
  }

  #sink(
    adapter: NativeHarnessAdapter,
    spec: NativeAttachmentSpec,
    venue: SessionExecutionVenue,
  ): ObservationSink {
    return {
      emit: (observation) => this.#recordObservation(adapter, spec, venue, observation),
    };
  }

  async #recordObservation(
    adapter: NativeHarnessAdapter,
    spec: NativeAttachmentSpec,
    venue: SessionExecutionVenue,
    observation: HarnessObservation,
  ): Promise<void> {
    const base = {
      id: nativeObservationId(
        adapter.manifest.id,
        spec.sessionId,
        spec.attachmentId,
        observation.id,
      ),
      sessionId: spec.sessionId,
      attachmentId: spec.attachmentId,
      occurredAt: observation.occurredAt,
      provenance: adapterProvenance(adapter, venue),
    } as const;
    let event: SessionEvent;
    switch (observation.kind) {
      case "attachment.closed":
      case "attachment.failed":
        event = await this.ports.engine.observe({
          ...base,
          kind: "attachment.closed",
          outcome: observation.kind === "attachment.failed" ? "failed" : observation.outcome,
        });
        break;
      case "transcript.message": {
        const reference = await this.ports.artifacts.write({
          version: 1,
          threadId: observation.threadId,
          branchId: observation.branchId,
          attemptId: observation.attemptId,
          turnId: observation.turnId,
          message: observation.message,
        });
        event = await this.ports.engine.observe({
          ...base,
          kind: "transcript.referenced",
          turnId: observation.turnId,
          reference,
        });
        break;
      }
      case "turn.started":
      case "turn.completed":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          turnId: observation.turnId,
        });
        break;
      case "interaction.opened":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          interaction: { ...observation.interaction, attachmentId: spec.attachmentId },
        });
        break;
      case "interaction.resolved":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          interactionId: observation.interactionId,
          resolution: observation.resolution,
        });
        break;
      case "attention.cleared":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          attentionId: observation.attentionId,
        });
        break;
      case "attention.raised": {
        const common = {
          id: observation.attention.id,
          attachmentId: spec.attachmentId,
          detail: observation.attention.detail,
          diagnostic: observation.attention.diagnostic,
        };
        const attention =
          observation.attention.kind === "rate_limited"
            ? {
                ...common,
                kind: observation.attention.kind,
                retryAt: observation.attention.retryAt ?? null,
              }
            : observation.attention.kind === "quota_exhausted"
              ? {
                  ...common,
                  kind: observation.attention.kind,
                  resetAt: observation.attention.resetAt ?? null,
                }
              : { ...common, kind: observation.attention.kind };
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          attention,
        });
        break;
      }
    }
    const binding = this.#bindings.get(spec.attachmentId);
    if (binding && observation.cursor !== undefined) binding.cursor = observation.cursor;
    await this.#publish([event]);
    if (observation.kind === "attachment.closed" || observation.kind === "attachment.failed") {
      this.#bindings.delete(spec.attachmentId);
    }
  }

  async #bindingForCommand(
    command: SessionCommand,
    projection: SessionProjection,
    location: SessionLocation,
  ): Promise<BindingRecord> {
    const attachmentId = command.route?.attachmentId;
    /* v8 ignore next 3 -- SessionEngine returns a durable no_live_executor receipt before an un-routed command can reach delivery. */
    if (!attachmentId) {
      throw new SessionRuntimeConflictError(`Command ${command.id} has no attachment route`);
    }
    return this.#bindingForAttachment(attachmentId, projection, location);
  }

  async #bindingForAttachment(
    attachmentId: string,
    projection: SessionProjection,
    location: SessionLocation,
  ): Promise<BindingRecord> {
    const existing = this.#bindings.get(attachmentId);
    if (existing) return existing;
    const rehydrating = this.#rehydratingBindings.get(attachmentId);
    if (rehydrating) return rehydrating;
    const promise = this.#rehydrateBinding(attachmentId, projection, location);
    this.#rehydratingBindings.set(attachmentId, promise);
    try {
      return await promise;
    } finally {
      /* v8 ignore next -- no other path can replace this private, attachment-keyed promise. */
      if (this.#rehydratingBindings.get(attachmentId) === promise) {
        this.#rehydratingBindings.delete(attachmentId);
      }
    }
  }

  async #rehydrateBinding(
    attachmentId: string,
    projection: SessionProjection,
    location: SessionLocation,
  ): Promise<BindingRecord> {
    const attachment = projection.attachments.find(({ id }) => id === attachmentId);
    if (!attachment || attachment.status !== "open") {
      throw new SessionRuntimeNotFoundError(`Attachment ${attachmentId} is not open`);
    }
    const binding = unwrapNativeBinding(attachment.native);
    const adapter = this.#requireAdapter(attachment.adapterId);
    const spec: NativeAttachmentSpec = {
      sessionId: projection.session.id,
      attachmentId,
      profileId: binding.profileId,
      directory: binding.directory ?? location.directory,
      // A persisted binding is always a resume operation. A malformed empty
      // provider id fails honestly in the adapter; it must never create fresh.
      continuity: "native_resume",
      native: binding.native,
    };
    const sink = new BufferedObservationSink(this.#sink(adapter, spec, attachment.venue));
    let handle: BindingHandle;
    try {
      handle = await adapter.attach(spec, sink);
    } catch (error) {
      sink.discard();
      throw error;
    }
    const record: BindingRecord = {
      adapter,
      handle,
      spec,
      attachment,
      venue: attachment.venue,
      cursor: null,
      reconcileInFlight: null,
    };
    this.#bindings.set(attachmentId, record);
    await sink.activate();
    return record;
  }

  async #reconcileBinding(binding: BindingRecord, requireOpen = false): Promise<void> {
    if (binding.reconcileInFlight) return binding.reconcileInFlight;
    const reconciliation = this.#performReconciliation(binding, requireOpen);
    binding.reconcileInFlight = reconciliation;
    try {
      await reconciliation;
    } finally {
      binding.reconcileInFlight = null;
    }
  }

  async #performReconciliation(binding: BindingRecord, requireOpen: boolean): Promise<void> {
    const reconciliation = await binding.handle.reconcile(binding.cursor);
    if (requireOpen) await this.#assertBindingOperationOpen();
    await this.#recordReconciliation(binding, reconciliation);
  }

  async #recordReconciliation(
    binding: BindingRecord,
    reconciliation: Reconciliation,
  ): Promise<void> {
    for (const observation of reconciliation.observations) {
      await this.#recordObservation(binding.adapter, binding.spec, binding.venue, observation);
    }
    const projection = await this.#requireSession(binding.spec.sessionId);
    const commands = new Map(projection.commands.map((command) => [command.id, command]));
    const terminalReceiptCommands = new Set(
      projection.receipts
        .filter((receipt) => receipt.status !== "unreconciled")
        .map((receipt) => receipt.commandId),
    );
    for (const receipt of reconciliation.receipts) {
      const command = commands.get(receipt.commandId);
      if (!command) continue;
      if (receipt.status === "unknown" && terminalReceiptCommands.has(receipt.commandId)) continue;
      const resultKind = resultKindFor(command);
      const durable = await this.#recordDelivery(
        binding.spec.sessionId,
        binding.spec.attachmentId,
        binding.adapter,
        binding.venue,
        receipt,
        resultKind,
      );
      if (durable.status !== "unreconciled") terminalReceiptCommands.add(receipt.commandId);
    }
    binding.cursor = reconciliation.cursor;
    await binding.handle.acknowledgeReconciliation?.(reconciliation.cursor);
  }

  async #recordDelivery(
    sessionId: string,
    attachmentId: string | null,
    adapter: AdapterIdentity,
    venue: SessionExecutionVenue,
    receipt: DeliveryReceipt,
    resultKind:
      | "executor.start.requested"
      | "executor.stop.requested"
      | "executor.interrupted"
      | "message.submitted"
      | "interaction.resolved",
  ): Promise<CommandReceipt> {
    const unstamped: UnstampedCommandReceipt =
      receipt.status === "accepted"
        ? {
            id: nativeReceiptId(receipt.commandId, receipt),
            commandId: receipt.commandId,
            status: "accepted",
            acceptedAt: receipt.acceptedAt,
            result: { kind: resultKind, sessionId },
          }
        : receipt.status === "rejected"
          ? {
              id: nativeReceiptId(receipt.commandId, receipt),
              commandId: receipt.commandId,
              status: "rejected",
              code: receipt.code,
              detail: receipt.detail,
            }
          : {
              id: nativeReceiptId(receipt.commandId, receipt),
              commandId: receipt.commandId,
              status: "unreconciled",
              detail: receipt.detail,
            };
    const event = await this.ports.engine.observe({
      id: nativeReceiptEventId(receipt.commandId, receipt),
      sessionId,
      attachmentId,
      occurredAt: receipt.status === "accepted" ? receipt.acceptedAt : this.ports.clock.now(),
      provenance: {
        ...adapterProvenance(adapter, venue),
        source: {
          kind: "adapter",
          id: adapter.manifest.id,
          detail: receipt.native?.detail ?? null,
        },
      },
      kind: "command.receipt",
      receipt: unstamped,
    });
    await this.#publish([event]);
    /* v8 ignore next 3 -- a typed SessionEngine may still be supplied by an external host. */
    if (event.payload.kind !== "command.receipt.recorded") {
      throw new Error("Session Engine returned a non-receipt event for a delivery receipt");
    }
    return event.payload.receipt;
  }

  async #publishSubmit(result: SubmitSessionCommandResult, replayed: boolean): Promise<void> {
    if (!replayed)
      await this.#publish([
        result.commandEvent,
        ...(result.receiptEvent ? [result.receiptEvent] : []),
      ]);
  }

  async #publish(events: readonly SessionEvent[]): Promise<void> {
    const bySession = new Map<string, SessionEvent[]>();
    for (const event of events) {
      const items = bySession.get(event.sessionId) ?? [];
      items.push(event);
      bySession.set(event.sessionId, items);
    }
    for (const [sessionId, sessionEvents] of bySession) {
      const subscribers = this.#subscribers.get(sessionId);
      if (!subscribers) continue;
      await Promise.all(
        [...subscribers].map((subscriber) => this.#enqueue(subscriber, sessionEvents)),
      );
    }
  }

  async #enqueue(subscriber: Subscriber, events: readonly SessionEvent[]): Promise<void> {
    if (!subscriber.active) return;
    for (const event of events) {
      if (event.sequence > subscriber.cursor) subscriber.events.set(event.sequence, event);
    }
    subscriber.draining = subscriber.draining
      .then(async () => {
        while (subscriber.active) {
          const event = subscriber.events.get(subscriber.cursor + 1);
          if (!event) break;
          subscriber.events.delete(event.sequence);
          const frame = await this.#frame(event);
          if (!subscriber.active) break;
          await subscriber.listener(frame);
          subscriber.cursor = event.sequence;
        }
      })
      .catch(async (error) => {
        try {
          await this.ports.onSubscriberFailure?.(error);
        } finally {
          this.#removeSubscriber(subscriber);
        }
      });
    await subscriber.draining;
  }

  #removeSubscriber(subscriber: Subscriber): void {
    subscriber.active = false;
    subscriber.events.clear();
    const subscribers = this.#subscribers.get(subscriber.sessionId);
    subscribers?.delete(subscriber);
    if (subscribers?.size === 0) this.#subscribers.delete(subscriber.sessionId);
  }

  async #frame(event: SessionEvent): Promise<SessionStreamFrame> {
    const reference = transcriptReferenceFor(event);
    const transcript = reference ? await this.ports.artifacts.read(reference) : null;
    return { sessionId: event.sessionId, sequence: event.sequence, event, transcript };
  }

  async #result(
    sessionId: string,
    command: SessionCommand,
    receipt: CommandReceipt | null,
  ): Promise<SessionRuntimeCommandResult> {
    return { sessionId, command, receipt, throughSequence: await this.#latestSequence(sessionId) };
  }

  async #latestSequence(sessionId: string): Promise<number> {
    let afterSequence = 0;
    for (;;) {
      const page = await this.ports.engine.listEvents({
        sessionId,
        afterSequence,
        limit: EVENT_PAGE_SIZE,
      });
      const latest = page.at(-1);
      /* v8 ignore next -- #result is only called after its command event commits. */
      if (!latest) throw new Error(`Session ${sessionId} has no committed command event`);
      afterSequence = latest.sequence;
      if (page.length < EVENT_PAGE_SIZE) return afterSequence;
    }
  }

  async #listEventsPaged(input: {
    sessionId: string;
    afterSequence?: number;
  }): Promise<readonly SessionEvent[]> {
    let afterSequence = input.afterSequence ?? 0;
    const events: SessionEvent[] = [];
    for (;;) {
      const page = await this.ports.engine.listEvents({
        sessionId: input.sessionId,
        afterSequence,
        limit: EVENT_PAGE_SIZE,
      });
      events.push(...page);
      const latest = page.at(-1);
      if (!latest || page.length < EVENT_PAGE_SIZE) return events;
      afterSequence = latest.sequence;
    }
  }

  async #requireSession(sessionId: string): Promise<SessionProjection> {
    return (await this.#history(sessionId)).projection;
  }

  /**
   * A Session's folded history, kept between reads.
   *
   * Every read asked the ledger for the whole log and folded it again, which is
   * linear in Session length per read and quadratic across a streaming turn.
   * This keeps the fold's *result* and the events behind it, and asks the
   * ledger only for what arrived after `throughSequence`.
   *
   * The entry is served unchanged only when both of its inputs are unchanged:
   * the ledger returned no event past the cursor, and the clock has not reached
   * `staleAt`. Otherwise the log it holds is extended and re-folded from the
   * top, so `projection` is never a partial fold and `projectSession` is never
   * asked to resume from one.
   *
   * That makes the invalidation rule the ledger's own contract: a Session's
   * events are append-only and sequence-ordered (`SessionLedgerTransaction`
   * offers `appendEvent` and no way to rewrite or remove one), so nothing below
   * the cursor can change under a live entry, and everything above it is read
   * every time — including facts appended by another writer. History rewritten
   * out of band, beneath that contract, would not be seen; `close()` drops
   * every entry, and a runtime that outlives such a rewrite must be rebuilt.
   *
   * Two concurrent reads may both fold and the slower one may install the older
   * result. That entry is still exactly the fold of the events it holds — only
   * its cursor is behind — so the next read picks the difference back up.
   */
  async #history(sessionId: string): Promise<ProjectedHistory> {
    const now = this.ports.clock.now();
    const cached = this.#histories.get(sessionId);
    if (!cached) {
      const known = await this.ports.engine.getSession({ sessionId });
      if (!known) throw new SessionRuntimeNotFoundError(`Session ${sessionId} was not found`);
      const events = await this.#listEventsPaged({ sessionId });
      return this.#keepHistory(sessionId, foldHistory(known.session, events, now));
    }
    const appended = await this.#listEventsPaged({
      sessionId,
      afterSequence: cached.throughSequence,
    });
    if (appended.length === 0 && (cached.staleAt === null || now < cached.staleAt)) {
      return this.#keepHistory(sessionId, cached);
    }
    const events = appended.length === 0 ? cached.events : [...cached.events, ...appended];
    return this.#keepHistory(sessionId, foldHistory(cached.projection.session, events, now));
  }

  #keepHistory(sessionId: string, history: ProjectedHistory): ProjectedHistory {
    this.#histories.delete(sessionId);
    this.#histories.set(sessionId, history);
    for (const oldest of this.#histories.keys()) {
      if (this.#histories.size <= PROJECTION_CACHE_LIMIT) break;
      this.#histories.delete(oldest);
    }
    return history;
  }

  #requireAdapter(adapterId: string): NativeHarnessAdapter {
    const adapter = this.ports.adapters.get(adapterId);
    if (!adapter)
      throw new SessionRuntimeNotFoundError(`Native adapter ${adapterId} was not found`);
    return adapter;
  }

  #commandExists(projection: SessionProjection, commandId: string): boolean {
    return projection.commands.some((command) => command.id === commandId);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Session runtime is closed");
  }

  #id(kind: Parameters<SessionRuntimeIds["next"]>[0]): string {
    return `runtime-${kind}:${this.ports.ids.next(kind)}`;
  }
}

export function createSessionRuntime(ports: SessionRuntimePorts): SessionRuntime {
  return new DefaultSessionRuntime(ports);
}

function foldHistory(
  session: Session,
  events: readonly SessionEvent[],
  now: number,
): ProjectedHistory {
  const projection = projectSession(session, events, now);
  return {
    projection,
    events,
    throughSequence: events.at(-1)?.sequence ?? 0,
    staleAt: earliestCapabilityExpiry(projection.capabilities),
  };
}

function earliestCapabilityExpiry(
  capabilities: readonly SessionCapabilitySnapshot[],
): number | null {
  let earliest: number | null = null;
  for (const snapshot of capabilities) {
    if (snapshot.expiresAt === null) continue;
    if (earliest === null || snapshot.expiresAt < earliest) earliest = snapshot.expiresAt;
  }
  return earliest;
}

function userProvenance(venue: SessionExecutionVenue | null): SessionEventProvenance {
  return { source: { kind: "user", id: "session-client", detail: null }, venue };
}

function adapterProvenance(
  adapter: AdapterIdentity,
  venue: SessionExecutionVenue,
): SessionEventProvenance {
  return {
    source: {
      kind: "adapter",
      id: adapter.manifest.id,
      detail: { adapterVersion: adapter.manifest.adapterVersion },
    },
    venue,
  };
}

function adapterIdentity(adapterId: string): AdapterIdentity {
  return {
    manifest: {
      id: adapterId,
      displayName: adapterId,
      adapterVersion: "unavailable",
      profiles: [],
    },
  };
}

function wrapNativeBinding(
  profileId: string,
  directory: string,
  probe: Extract<NativeProbeResult, { status: "available" }>,
  native: SessionNativeReference,
): SessionNativeReference {
  return {
    id: native.id,
    detail: {
      kind: "volli.native-binding.v1",
      profileId,
      directory,
      runtime: {
        path: probe.runtime.path,
        version: probe.runtime.version,
        fingerprint: probe.runtime.fingerprint,
      },
      locator: native.detail,
    },
  };
}

function unwrapNativeBinding(reference: SessionNativeReference | null): {
  profileId: string;
  directory: string | null;
  native: SessionNativeReference;
} {
  if (!reference || !reference.detail || Array.isArray(reference.detail)) {
    throw new SessionRuntimeConflictError("Attachment has no native binding metadata");
  }
  const detail = reference.detail as { readonly [key: string]: SessionNativeDetail };
  if (
    typeof detail !== "object" ||
    detail.kind !== "volli.native-binding.v1" ||
    typeof detail.profileId !== "string"
  ) {
    throw new SessionRuntimeConflictError("Attachment has invalid native binding metadata");
  }
  return {
    profileId: detail.profileId,
    directory: typeof detail.directory === "string" ? detail.directory : null,
    native: { id: reference.id, detail: detail.locator ?? null },
  };
}

function resultKindFor(
  command: SessionCommand,
):
  | "executor.start.requested"
  | "executor.stop.requested"
  | "executor.interrupted"
  | "message.submitted"
  | "interaction.resolved" {
  switch (command.intent.kind) {
    case "executor.start":
      return "executor.start.requested";
    case "executor.stop":
      return "executor.stop.requested";
    case "executor.interrupt":
      return "executor.interrupted";
    case "message.submit":
      return "message.submitted";
    case "interaction.resolve":
      return "interaction.resolved";
    /* v8 ignore next 2 -- only adapter-bound intents enter reconciliation. */
    default:
      throw new SessionRuntimeConflictError(`Command ${command.id} is not adapter-bound`);
  }
}

function nativeObservationId(
  adapterId: string,
  sessionId: string,
  attachmentId: string,
  observationId: string,
): string {
  return `native-event:${adapterId}:${sessionId}:${attachmentId}:${observationId}`;
}

function nativeReceiptId(commandId: string, receipt: DeliveryReceipt): string {
  return `native-receipt:${commandId}:${receiptIdentity(receipt)}`;
}

function nativeReceiptEventId(commandId: string, receipt: DeliveryReceipt): string {
  return `native-receipt-event:${commandId}:${receiptIdentity(receipt)}`;
}

function receiptIdentity(receipt: DeliveryReceipt): string {
  if (receipt.status === "accepted") return `accepted:${receipt.acceptedAt}`;
  if (receipt.status === "rejected") {
    return `rejected:${receipt.code}:${encodeURIComponent(receipt.detail ?? "")}`;
  }
  return `unreconciled:${encodeURIComponent(receipt.detail ?? "")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transcriptReferenceFor(event: SessionEvent): TranscriptReference | null {
  if (event.payload.kind === "transcript.referenced") return event.payload.reference;
  if (
    event.payload.kind === "command.recorded" &&
    (event.payload.command.intent.kind === "message.submit" ||
      event.payload.command.intent.kind === "interaction.resolve")
  ) {
    return event.payload.command.intent.reference;
  }
  return null;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
