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

export interface SessionStreamFrame {
  sessionId: string;
  sequence: number;
  event: SessionEvent;
  transcript: SessionTranscriptArtifact | null;
}

export interface SessionRuntimeSnapshot {
  projection: SessionProjection;
  throughSequence: number;
  frames: readonly SessionStreamFrame[];
  transcript: readonly SessionTranscriptArtifact[];
}

export interface SessionRuntime {
  command(request: SessionRuntimeCommandRequest): Promise<SessionRuntimeCommandResult>;
  snapshot(input: { sessionId: string }): Promise<SessionRuntimeSnapshot>;
  subscribe(
    input: { sessionId: string; afterSequence: number },
    listener: (frame: SessionStreamFrame) => void | Promise<void>,
  ): Promise<() => void>;
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
    for (const observation of this.#pending.splice(0)) void this.#enqueue(observation);
    return this.#tail;
  }

  discard(): void {
    this.#state = "discarded";
    this.#pending.length = 0;
  }

  #enqueue(observation: HarnessObservation): Promise<void> {
    this.#tail = this.#tail.then(() => this.target.emit(observation));
    return this.#tail;
  }
}

class DefaultSessionRuntime implements SessionRuntime {
  readonly #bindings = new Map<string, BindingRecord>();
  readonly #rehydratingBindings = new Map<string, Promise<BindingRecord>>();
  readonly #inFlight = new Map<string, InFlightCommand>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();
  readonly #capabilityRevisions = new Map<string, number>();
  readonly #capabilityWrites = new Map<string, Promise<SessionCapabilitySnapshot>>();
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
    const existed = await this.#commandExists(request.sessionId, request.commandId);

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

    const abort = new AbortController();
    let probe: NativeProbeResult;
    try {
      probe = await adapter.probe(
        { profileId: request.command.profileId, directory: location.directory },
        abort.signal,
      );
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
    const projection = await this.#requireSession(request.sessionId);
    const events = await this.ports.engine.listEvents({ sessionId: request.sessionId });
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
    if (submitted.receipt) {
      await this.#reconcileBinding(binding);
      const replayed = await this.ports.engine.submit({
        commandId: request.commandId,
        sessionId: request.sessionId,
        intent: submitted.command.intent as Extract<
          SessionCommand["intent"],
          { kind: "message.submit" }
        >,
        provenance: userProvenance(location.venue),
      });
      return this.#result(
        request.sessionId,
        replayed.command,
        replayed.receipt ?? submitted.receipt,
      );
    }
    if (existed) {
      await this.#reconcileBinding(binding);
      const replayed = await this.ports.engine.submit({
        commandId: request.commandId,
        sessionId: request.sessionId,
        intent: submitted.command.intent as Extract<
          SessionCommand["intent"],
          { kind: "message.submit" }
        >,
        provenance: userProvenance(location.venue),
      });
      if (replayed.receipt)
        return this.#result(request.sessionId, replayed.command, replayed.receipt);
    }

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
    if (submitted.receipt) {
      await this.#reconcileBinding(binding);
      const replayed = await this.ports.engine.submit({
        commandId: request.commandId,
        sessionId: request.sessionId,
        intent: submitted.command.intent as Extract<
          SessionCommand["intent"],
          {
            kind: "executor.interrupt";
          }
        >,
        provenance: userProvenance(location.venue),
      });
      return this.#result(
        request.sessionId,
        replayed.command,
        replayed.receipt ?? submitted.receipt,
      );
    }
    if (existed) {
      await this.#reconcileBinding(binding);
      const after = await this.ports.engine.submit({
        commandId: request.commandId,
        sessionId: request.sessionId,
        intent: { kind: "executor.interrupt", attachmentId },
        provenance: userProvenance(location.venue),
      });
      if (after.receipt) return this.#result(request.sessionId, after.command, after.receipt);
    }
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
    if (submitted.receipt) {
      await this.#reconcileBinding(binding);
      const replayed = await this.ports.engine.submit({
        commandId: request.commandId,
        sessionId: request.sessionId,
        intent: submitted.command.intent as Extract<
          SessionCommand["intent"],
          {
            kind: "interaction.resolve";
          }
        >,
        provenance: userProvenance(location.venue),
      });
      return this.#result(
        request.sessionId,
        replayed.command,
        replayed.receipt ?? submitted.receipt,
      );
    }
    if (existed) {
      await this.#reconcileBinding(binding);
      const after = await this.ports.engine.submit({
        commandId: request.commandId,
        sessionId: request.sessionId,
        intent: submitted.command.intent as Extract<
          SessionCommand["intent"],
          { kind: "interaction.resolve" }
        >,
        provenance: userProvenance(location.venue),
      });
      if (after.receipt) return this.#result(request.sessionId, after.command, after.receipt);
    }
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
    if (submitted.receipt) {
      await this.#reconcileBinding(binding);
      const replayed = await this.ports.engine.submit({
        commandId: request.commandId,
        sessionId: request.sessionId,
        intent: submitted.command.intent as Extract<
          SessionCommand["intent"],
          {
            kind: "executor.stop";
          }
        >,
        provenance: userProvenance(location.venue),
      });
      return this.#result(
        request.sessionId,
        replayed.command,
        replayed.receipt ?? submitted.receipt,
      );
    }
    if (existed) {
      await this.#reconcileBinding(binding);
      const after = await this.ports.engine.submit({
        commandId: request.commandId,
        sessionId: request.sessionId,
        intent: { kind: "executor.stop", attachmentId: request.command.attachmentId },
        provenance: userProvenance(location.venue),
      });
      if (after.receipt) return this.#result(request.sessionId, after.command, after.receipt);
    }
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

  async snapshot(input: { sessionId: string }): Promise<SessionRuntimeSnapshot> {
    this.#assertOpen();
    const projection = await this.#requireSession(input.sessionId);
    const events = await this.ports.engine.listEvents({ sessionId: input.sessionId });
    const frames: SessionStreamFrame[] = [];
    const transcript: SessionTranscriptArtifact[] = [];
    for (const event of events) {
      const frame = await this.#frame(event);
      frames.push(frame);
      if (frame.transcript) transcript.push(frame.transcript);
    }
    return {
      projection,
      throughSequence: events.at(-1)?.sequence ?? 0,
      frames,
      transcript,
    };
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
      const replay = await this.ports.engine.listEvents({
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
    const abort = new AbortController();
    const probe = await binding.adapter.probe(
      { profileId: binding.spec.profileId, directory: binding.spec.directory },
      abort.signal,
    );
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
    for (const subscribers of this.#subscribers.values()) {
      for (const subscriber of subscribers) subscriber.active = false;
    }
    this.#subscribers.clear();
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
      catalog: report.catalog,
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
      continuity: attachment.continuity,
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
    for (const receipt of reconciliation.receipts) {
      const projection = await this.#requireSession(binding.spec.sessionId);
      const command = projection.commands.find(({ id }) => id === receipt.commandId);
      if (!command) continue;
      if (
        receipt.status === "unknown" &&
        projection.receipts.some(
          (existing) =>
            existing.commandId === receipt.commandId && existing.status !== "unreconciled",
        )
      ) {
        continue;
      }
      const resultKind = resultKindFor(command);
      await this.#recordDelivery(
        binding.spec.sessionId,
        binding.spec.attachmentId,
        binding.adapter,
        binding.venue,
        receipt,
        resultKind,
      );
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
            id: nativeReceiptId(receipt.commandId, receipt.status),
            commandId: receipt.commandId,
            status: "accepted",
            acceptedAt: receipt.acceptedAt,
            result: { kind: resultKind, sessionId },
          }
        : receipt.status === "rejected"
          ? {
              id: nativeReceiptId(receipt.commandId, receipt.status),
              commandId: receipt.commandId,
              status: "rejected",
              code: receipt.code,
              detail: receipt.detail,
            }
          : {
              id: nativeReceiptId(receipt.commandId, receipt.status),
              commandId: receipt.commandId,
              status: "unreconciled",
              detail: receipt.detail,
            };
    const event = await this.ports.engine.observe({
      id: nativeReceiptEventId(receipt.commandId, receipt.status),
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
      .catch(() => this.#removeSubscriber(subscriber));
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
    const events = await this.ports.engine.listEvents({ sessionId });
    /* v8 ignore next -- every returned command has at least its command.recorded event. */
    return { sessionId, command, receipt, throughSequence: events.at(-1)?.sequence ?? 0 };
  }

  async #requireSession(sessionId: string): Promise<SessionProjection> {
    const projection = await this.ports.engine.getSession({ sessionId });
    if (!projection) throw new SessionRuntimeNotFoundError(`Session ${sessionId} was not found`);
    return projection;
  }

  #requireAdapter(adapterId: string): NativeHarnessAdapter {
    const adapter = this.ports.adapters.get(adapterId);
    if (!adapter)
      throw new SessionRuntimeNotFoundError(`Native adapter ${adapterId} was not found`);
    return adapter;
  }

  async #commandExists(sessionId: string, commandId: string): Promise<boolean> {
    return (await this.ports.engine.listEvents({ sessionId })).some(
      (event) =>
        event.payload.kind === "command.recorded" && event.payload.command.id === commandId,
    );
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

function nativeReceiptId(commandId: string, status: DeliveryReceipt["status"]): string {
  return `native-receipt:${commandId}:${status}`;
}

function nativeReceiptEventId(commandId: string, status: DeliveryReceipt["status"]): string {
  return `native-receipt-event:${commandId}:${status}`;
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
