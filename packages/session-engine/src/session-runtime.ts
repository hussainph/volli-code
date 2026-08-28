import { projectSession } from "@volli/shared";
import type {
  CommandReceipt,
  CompactionReason,
  ModelSelection,
  Session,
  SessionAttachment,
  SessionAttachmentContinuity,
  SessionCommand,
  SessionCommandIntent,
  SessionEvent,
  SessionEventProvenance,
  RuntimeObservation,
  SessionExecutionVenue,
  SessionInteractionCancelReason,
  SessionInteractionResolution,
  SessionNativeDetail,
  SessionNativeReference,
  SessionProjection,
  UnstampedCommandReceipt,
} from "@volli/shared";
import type { UIMessage } from "ai";
import type { SessionEngine, SubmitSessionCommandResult } from "./session-engine";
import type {
  BindingHandle,
  DeliveryReceipt,
  HarnessCommand,
  NativeAttachmentSpec,
  NativeHarnessAdapter,
  NativeMessageDelivery,
  NativeRuntimeIdentity,
  ObservationSink,
  Reconciliation,
} from "./native-adapter";
import { NativeAttachmentError } from "./native-adapter";
import type { TranslatedObservation, TranslatedObservationSink } from "./observation-translation";
import {
  RuntimeObservationTranslator,
  sessionMainBranchId,
  sessionRootThreadId,
} from "./observation-translation";
import type { SessionTranscriptArtifact, TranscriptArtifactStore } from "./transcript-artifacts";
import { transcriptReferenceFor } from "./transcript-tail";
import {
  applyTranscriptDelta,
  type TranscriptDelta,
  type TranscriptOverlay,
} from "./transcript-overlay";

export interface SessionLocation {
  directory: string;
  venue: SessionExecutionVenue;
}

export interface SessionLocationResolver {
  /** Where the Session runs as the record stands. A read — the directory may not exist yet. */
  resolve(session: Session): Promise<SessionLocation>;
  /**
   * The same location, materialized — what a binding is allowed to attach to.
   *
   * Separate from {@link resolve} because materializing is real work (for a
   * ticket that runs in its own checkout, git plus a durable event) and only an
   * attach needs it: every later command reuses the directory its binding
   * already holds. A host that cannot produce the directory throws rather than
   * substituting one, so the attach fails instead of binding somewhere else.
   */
  prepare(session: Session): Promise<SessionLocation>;
  /**
   * The directory a binding already holds, still there — put back if it is not.
   *
   * `prepare` runs once, at attach. Nothing has ever re-asked afterwards, so a
   * checkout deleted under an open attachment stayed bound: the adapter kept
   * being pointed at a path that no longer existed and every prompt died inside
   * the harness on whatever name it gives a missing directory. This is the
   * re-ask, and it is deliberately narrow — it must be cheap enough to run
   * before a turn, which `prepare` is not.
   *
   * Returns nothing on purpose. The answer is always the same directory, never
   * a substitute: a live binding cannot be re-pointed, and a rehydrated one
   * resumes from the immutable directory its attachment recorded. A host that
   * cannot put that directory back throws, naming it.
   */
  reaffirm(session: Session, directory: string): Promise<void>;
}

export interface SessionRuntimeClock {
  now(): number;
}

export interface SessionRuntimeIds {
  next(kind: "attachment" | "event" | "receipt" | "attention"): string;
}

export interface SessionRuntimePorts {
  engine: SessionEngine;
  /** The one structured executor this runtime attaches. */
  executor: NativeHarnessAdapter;
  artifacts: TranscriptArtifactStore;
  locations: SessionLocationResolver;
  clock: SessionRuntimeClock;
  ids: SessionRuntimeIds;
  /** Host diagnostics seam for a failing client stream; failures are isolated. */
  onSubscriberFailure?: (error: unknown) => void | Promise<void>;
}

export type SessionClientCommand =
  | {
      kind: "session.create";
      projectId: string;
      ticketId: string | null;
      title: string | null;
    }
  | { kind: "adapter.attach"; continuity: SessionAttachmentContinuity }
  | {
      kind: "message.submit";
      message: UIMessage;
      delivery?: NativeMessageDelivery;
      model?: { providerId: string; modelId: string } | null;
      agent?: string | null;
      variant?: string | null;
    }
  | { kind: "model.select"; selection: ModelSelection }
  | { kind: "executor.interrupt"; attachmentId?: string }
  | { kind: "executor.retry"; attachmentId?: string }
  | { kind: "context.compact"; attachmentId?: string; instructions?: string | null }
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
type SelectModelCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "model.select" }>;
};
type InterruptCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "executor.interrupt" }>;
};
type RetryCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "executor.retry" }>;
};
type CompactCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "context.compact" }>;
};
type DeliveryResultKind =
  | "executor.start.requested"
  | "executor.stop.requested"
  | "executor.interrupted"
  | "executor.retried"
  | "context.compacted"
  | "message.submitted"
  | "model.selected"
  | "interaction.resolved";
type AttachFailureAttentionKind = "configuration_invalid" | "adapter_unrecoverable";
/**
 * The Attention kinds a successful attach retires.
 *
 * A record rather than a set, and keyed by the union rather than by string, so
 * that adding a way for an attach to fail fails to compile until this decides
 * whether success disproves it. It did not, once: `adapter_unrecoverable` was
 * added for Pi's recovery failures while the clear path still named
 * `configuration_invalid` alone, so a Session that failed to attach once
 * carried the Attention for good — nothing else clears an id minted by
 * {@link freshAttachAttentionId}.
 *
 * Both kinds are claims about whether this executor can run this Session here,
 * and an attach that just opened is the direct evidence against either.
 *
 * It reaches further than the ids {@link freshAttachAttentionId} mints, and
 * deliberately: a per-attachment `${attachmentId}:recovery` Attention is raised
 * under `adapter_unrecoverable` too, and once its attachment is released this
 * is the only thing that retires it — `adapter.release` does not, and the retry
 * that would needs the attachment it just closed. Narrowing the filter by
 * `attachmentId === null` would read as tidier and would strand that Attention
 * for the life of the Session.
 */
const ATTACH_FAILURE_ATTENTION_KINDS: Readonly<Record<AttachFailureAttentionKind, true>> = {
  configuration_invalid: true,
  adapter_unrecoverable: true,
};
interface FailAttachInput {
  request: AttachCommandRequest;
  submitted: SubmitSessionCommandResult;
  adapter: NativeHarnessAdapter;
  location: SessionLocation;
  code: string;
  detail: string;
  attachmentId?: string;
  attentionKind?: AttachFailureAttentionKind;
}
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
type DeliveredSessionRuntimeCommandResult = SessionRuntimeCommandResult & {
  receipt: CommandReceipt;
};

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
 * A message mid-word, on its way to a live subscriber and nowhere else.
 *
 * `throughSequence` is the latest durable sequence recorded when this was
 * emitted, and it is the consumer's staleness guard: drop any overlay whose
 * `throughSequence` is strictly below the last durable transcript sequence
 * already applied for that message. With that guard in place the order in
 * which one batch's durable frames and overlays are applied stops mattering —
 * a settle that lands beside a stale append sorts itself out either way.
 */
export interface SessionStreamOverlay {
  kind: "overlay";
  sessionId: string;
  throughSequence: number;
  messageId: string;
  delta: TranscriptDelta;
}

/** A visible, live-only reason the Session is briefly waiting on a summary. */
export interface SessionStreamCompactionProgress {
  kind: "compaction";
  sessionId: string;
  /** The durable history the progress marker was emitted beside. */
  throughSequence: number;
  state: "started" | "finished";
  reason: CompactionReason;
}

export type SessionStreamTransient = SessionStreamOverlay | SessionStreamCompactionProgress;

/**
 * What a subscriber receives.
 *
 * The durable arm is the **bare** {@link SessionStreamFrame}, not a wrapped
 * one: every existing consumer validates a frame by its `sequence`, so leaving
 * it bare keeps them working untouched and simply ignoring live state until a
 * surface opts in.
 */
export type SessionStreamEmission = SessionStreamFrame | SessionStreamTransient;

/** The durable arm carries no `kind` of its own, which is the whole test. */
export function isSessionStreamOverlay(
  emission: SessionStreamEmission,
): emission is SessionStreamOverlay {
  return "kind" in emission && emission.kind === "overlay";
}

export function isSessionStreamCompactionProgress(
  emission: SessionStreamEmission,
): emission is SessionStreamCompactionProgress {
  return "kind" in emission && emission.kind === "compaction";
}

/** Durable frames are the only arm that carries an event sequence of its own. */
export function isSessionStreamFrame(
  emission: SessionStreamEmission,
): emission is SessionStreamFrame {
  return !("kind" in emission);
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
    listener: (emission: SessionStreamEmission) => void | Promise<void>,
    onFailure?: (error: unknown) => void,
  ): Promise<() => void>;
  cancelInteraction(request: CancelInteractionRequest): Promise<void>;
  reconcile(input: { sessionId: string; attachmentId: string }): Promise<void>;
  close(): Promise<void>;
}

/** One native binding this process holds open: the Session it serves, and where it works. */
export interface OpenNativeBinding {
  sessionId: string;
  directory: string;
  /**
   * The attachment this binding belongs to, so a host that has to END it can
   * name it. `adapter.release` is routed by attachment id, and a caller holding
   * only the Session would have to re-read the projection to find one — the
   * exact replay this listing exists to let callers avoid.
   */
  attachmentId: string;
  /**
   * Epoch milliseconds of the newest live token or tool-progress observation.
   *
   * Process-local by design: durable Session events intentionally do not carry
   * streamed tokens, and a watchdog must not treat its own bookkeeping as
   * runtime progress.
   */
  lastProgressAt: number;
}

/** The host-owned runtime plus the live local bindings only its process can know about. */
export interface HostedSessionRuntime extends SessionRuntime {
  /**
   * Every native binding this process currently holds open.
   *
   * Deliberately NOT an answer to "is an agent working here". A binding opens on
   * attach and is removed only by an explicit release, by the executor closing
   * itself, or by app shutdown — so an idle chat, and a chat whose tab was shut
   * hours ago, both still have one. A caller that needs the stronger question
   * asks the Session: `turnActive` on its projection is the one place an open
   * turn is decided, and this names the Session so it can be asked.
   *
   * It used to return bare directories, which left every caller no choice but to
   * read "attached" as "busy" — and that is how opening an empty chat made its
   * ticket permanently unarchivable, with no reachable way to close anything.
   *
   * It is also the only way a host can find the bindings rooted in a directory
   * it is about to delete. A binding survives its tab, so nothing else knows
   * that a Session is still pointed at a checkout that is going away; naming the
   * attachment here is what lets the host release it before the directory goes.
   */
  openNativeBindings(): readonly OpenNativeBinding[];
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
  /** Latest token/tool observation this live binding received, never a durable fact. */
  lastProgressAt: number;
  reconcileInFlight: Promise<void> | null;
  /**
   * The same translator the attachment's sink holds, for the replay path.
   *
   * A reference, not the owner: this record is deleted the moment an attachment
   * closes or fails, and the translator has to outlive that so observations
   * still draining behind the close keep minting ids from where they left off.
   * The sink owns it; reconciliation borrows it so both passes over one fact
   * derive the same id.
   */
  translator: RuntimeObservationTranslator;
  /**
   * The live observation pipeline, so whoever ends this binding can stop it.
   *
   * An executor is asked to stop and then reports that it stopped, and the two
   * are not one event — the Session Engine writes `attachment.closed` itself
   * once the release resolves. Between those, anything the executor is still
   * mid-way through saying would be recorded against an attachment that is
   * already closed, which the ledger refuses rather than tolerates.
   */
  sink: BufferedObservationSink;
}

type AdapterIdentity = Pick<NativeHarnessAdapter, "id" | "adapterVersion">;

interface InFlightCommand {
  signature: string;
  promise: Promise<SessionRuntimeCommandResult>;
}

interface Subscriber {
  sessionId: string;
  cursor: number;
  events: Map<number, SessionEvent>;
  listener: (emission: SessionStreamEmission) => void | Promise<void>;
  /**
   * Told when this subscription dies mid-stream, so the transport above it can
   * end loudly. Without it a drain failure removed the subscriber and nothing
   * else: the rpc queue it fed stayed open, the renderer kept a healthy-looking
   * stream that would never speak again, and the Session held its Stop button
   * forever. The failure must reach the consumer, whose reconnect then heals
   * from the ledger.
   */
  onFailure?: (error: unknown) => void;
  draining: Promise<void>;
  active: boolean;
}

/**
 * One Session's in-flight transient transcript.
 *
 * `throughSequence` travels with it because an overlay emission has to state
 * the durable sequence it was emitted beside, and that number is what makes a
 * subscriber able to drop a baseline a settle has already overtaken.
 */
interface SessionOverlayState {
  messages: TranscriptOverlay;
  throughSequence: number;
}

/**
 * One attachment's whole observation pipeline: what an executor says, on its
 * way to being what this Session recorded.
 *
 * Some SDKs synchronously report startup observations from `attach()`. Buffer
 * them until `attachment.opened` is durable, then serialize every later emit
 * behind that replay so provider order cannot overtake the ledger boundary.
 *
 * Translation lives inside rather than behind this, because {@link discard} has
 * to be able to stop the pipeline and one observation is not one fact. A single
 * runtime observation fans out — a settled streamed message withdraws its
 * transient claim before it writes the durable one — so a gate only at the
 * mouth would let a fan-out admitted a moment before the stop finish writing
 * its tail on the far side of it. That tail does not merely land late: the
 * Session Engine refuses every observation on an attachment it has already
 * closed, so it throws back out through the executor's own observer. Holding
 * the translator here is also what keeps it alive past the binding record,
 * which is dropped the moment an attachment closes.
 */
class BufferedObservationSink implements ObservationSink {
  readonly #pending: RuntimeObservation[] = [];
  #tail: Promise<void> = Promise.resolve();
  #state: "buffering" | "active" | "discarded" = "buffering";

  constructor(
    private readonly translator: RuntimeObservationTranslator,
    private readonly record: TranslatedObservationSink,
  ) {}

  emit(observation: RuntimeObservation): Promise<void> {
    if (this.stopped) return Promise.resolve();
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

  /**
   * Stop the pipeline: nothing from this binding reaches the ledger again.
   *
   * Every stage is gated, because each one can already be past the previous:
   * an observation still buffered, one queued behind the serializing tail, a
   * fan-out mid-flight, and — through {@link stopped} — a single fact already
   * inside the recorder are four different places a fact can be waiting.
   */
  discard(): void {
    this.#state = "discarded";
    this.#pending.length = 0;
  }

  /** For the one durable write that can start before a stop and finish after it. */
  get stopped(): boolean {
    return this.#state === "discarded";
  }

  #enqueue(observation: RuntimeObservation): Promise<void> {
    const emission = this.#tail.then(() => this.#translate(observation));
    // Preserve the caller-visible rejection while allowing later observations
    // to continue behind a failed durable write.
    this.#tail = emission.catch(() => undefined);
    return emission;
  }

  #translate(observation: RuntimeObservation): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.translator.translate(observation, (fact) =>
      this.stopped ? Promise.resolve() : this.record(fact),
    );
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
}

const EVENT_PAGE_SIZE = 500;
/**
 * How many Sessions keep a folded history. A Session's events are held for as
 * long as its entry lives, so this is the bound on that memory; the desktop
 * reads one or two Sessions at a time and an evicted entry costs one re-read.
 */
const PROJECTION_CACHE_LIMIT = 8;
/**
 * How many Sessions keep a transient overlay, bounded the same way and for the
 * same reason as the fold cache above: the explicit drop points (attachment
 * closure, release, close) cover every orderly end, and this covers the rest,
 * so no single rule's absence leaves the map growing. An evicted overlay costs
 * the tail of one in-flight message — the emitter's next reset or settle
 * rebuilds it.
 */
const OVERLAY_CACHE_LIMIT = 8;

class DefaultSessionRuntime implements SessionRuntime {
  readonly #bindings = new Map<string, BindingRecord>();
  readonly #rehydratingBindings = new Map<string, Promise<BindingRecord>>();
  readonly #inFlight = new Map<string, InFlightCommand>();
  readonly #sessionAdmissionTails = new Map<string, Promise<void>>();
  readonly #messageAdmissions = new Map<string, () => void>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();
  /** Insertion-ordered, so the first key is the least recently read Session. */
  readonly #histories = new Map<string, ProjectedHistory>();
  /** Insertion-ordered too, so the first key is the least recently folded Session. */
  readonly #overlays = new Map<string, SessionOverlayState>();
  /** One active context rewrite per Session; both the runtime and the stream enforce it. */
  readonly #compactionProgress = new Map<string, SessionStreamCompactionProgress>();
  #closed = false;

  constructor(private readonly ports: SessionRuntimePorts) {}

  openNativeBindings(): readonly OpenNativeBinding[] {
    return [...this.#bindings.values()].map(({ spec, lastProgressAt }) => ({
      sessionId: spec.sessionId,
      directory: spec.directory,
      attachmentId: spec.attachmentId,
      lastProgressAt,
    }));
  }

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

    // Every command that touches what the executor will next be sent, so none
    // of them can be deciding it at the same time. `context.compact` is here
    // for a sharper reason than the two beside it: it REPLACES the executor's
    // message array rather than extending it, and a message admitted while its
    // summary was still running would be a turn the returning compaction
    // overwrote — the message and its reply gone from the model's context
    // while both remain in the ledger and on screen. Unlike a message, a
    // compaction holds this tail for its whole run, because it is not finished
    // when it starts and there is no earlier moment that is safe.
    const serializesAdmission =
      "sessionId" in request &&
      (request.command.kind === "message.submit" ||
        request.command.kind === "model.select" ||
        request.command.kind === "context.compact");
    const previous =
      "sessionId" in request ? this.#sessionAdmissionTails.get(request.sessionId) : null;
    const admission =
      "sessionId" in request && request.command.kind === "message.submit"
        ? Promise.withResolvers<void>()
        : null;
    const run = () => {
      if (admission !== null && "sessionId" in request) {
        this.#messageAdmissions.set(request.sessionId, admission.resolve);
      }
      return this.#command(request).finally(() => {
        if (admission !== null && "sessionId" in request) {
          this.#releaseMessageAdmission(request.sessionId, admission.resolve);
        }
      });
    };
    const operation = previous ? previous.then(run) : run();
    const promise = operation.finally(async () => {
      this.#inFlight.delete(request.commandId);
      await this.#releaseBindingsAfterClose();
    });
    this.#inFlight.set(request.commandId, { signature, promise });
    if (serializesAdmission && "sessionId" in request) {
      const sessionId = request.sessionId;
      const tail =
        admission?.promise ??
        promise.then(
          () => undefined,
          () => undefined,
        );
      this.#sessionAdmissionTails.set(sessionId, tail);
      void tail.finally(() => {
        if (this.#sessionAdmissionTails.get(sessionId) === tail) {
          this.#sessionAdmissionTails.delete(sessionId);
        }
      });
    }
    return promise;
  }

  #releaseMessageAdmission(sessionId: string, release: () => void): void {
    if (this.#messageAdmissions.get(sessionId) !== release) return;
    this.#messageAdmissions.delete(sessionId);
    release();
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
        return this.#attach(request as AttachCommandRequest, projection, location, existed);
      case "message.submit":
        return this.#submitMessage(request as MessageCommandRequest, projection, location, existed);
      case "model.select":
        return this.#selectModel(
          request as SelectModelCommandRequest,
          projection,
          location,
          existed,
        );
      case "executor.interrupt":
        return this.#interrupt(request as InterruptCommandRequest, projection, location, existed);
      case "executor.retry":
        return this.#retry(request as RetryCommandRequest, projection, location, existed);
      case "context.compact":
        return this.#compact(request as CompactCommandRequest, projection, location, existed);
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

  async #selectModel(
    request: SelectModelCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const submitted = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      intent: { kind: "model.select", selection: request.command.selection },
      provenance: userProvenance(location.venue),
    });
    await this.#publishSubmit(submitted, existed);
    if (submitted.receipt && submitted.receipt.status !== "unreconciled") {
      return this.#result(request.sessionId, submitted.command, submitted.receipt);
    }

    const attachmentId = submitted.command.route?.attachmentId;
    if (!attachmentId) {
      throw new SessionRuntimeConflictError(
        `Model selection ${request.commandId} has neither a receipt nor a live attachment route`,
      );
    }
    const needsRehydration = !this.#bindings.has(attachmentId);
    if (!existed && needsRehydration) {
      const unavailable = await this.#rejectUnavailableLocation(
        request.sessionId,
        submitted.command,
        projection,
        location,
      );
      if (unavailable) return this.#result(request.sessionId, submitted.command, unavailable);
    }
    const binding = await this.#bindingForCommand(
      submitted.command,
      projection,
      location,
      !existed && needsRehydration,
    );
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) return recovered;
    if (existed) await this.ports.locations.reaffirm(projection.session, binding.spec.directory);

    const receipt = await binding.handle.dispatch({
      kind: "model.select",
      commandId: request.commandId,
      sessionId: request.sessionId,
      attachmentId,
      selection: request.command.selection,
    });
    if (receipt.status === "accepted") {
      const completed = await this.ports.engine.completeModelSelection({
        sessionId: request.sessionId,
        commandId: request.commandId,
        attachmentId,
        occurredAt: receipt.acceptedAt,
        provenance: adapterProvenance(binding.adapter, binding.venue),
      });
      await this.#publish([completed.event, completed.receiptEvent]);
      return this.#result(request.sessionId, submitted.command, completed.receipt);
    }
    const durable = await this.#recordDelivery(
      request.sessionId,
      attachmentId,
      binding.adapter,
      binding.venue,
      receipt,
      "model.selected",
    );
    return this.#result(request.sessionId, submitted.command, durable);
  }

  async #attach(
    request: AttachCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const adapter = this.ports.executor;
    const submitted = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      // The route is this runtime's own executor, never a client-supplied id.
      // The Session Engine holds the route and the attachment to the same
      // adapter id, so anything else would be a conflict thrown mid-attach.
      intent: {
        kind: "executor.start",
        adapterId: adapter.id,
        continuity: request.command.continuity,
      },
      provenance: userProvenance(location.venue),
    });
    await this.#publishSubmit(submitted, existed);
    if (submitted.receipt && submitted.receipt.status !== "unreconciled")
      return this.#result(request.sessionId, submitted.command, submitted.receipt);

    if (existed) return this.#recoverReplayedAttach(request, submitted, adapter, location);

    // The directory has to be real before it is bound: an adapter handed one
    // that is not there fails per prompt, deep inside the harness, wearing
    // whatever name that harness gives a missing path.
    let site: SessionLocation;
    try {
      site = await this.ports.locations.prepare(projection.session);
    } catch (error) {
      return this.#failAttach({
        request,
        submitted,
        adapter,
        location,
        code: "location_unavailable",
        detail: errorMessage(error),
      });
    }

    const attachmentId = this.#id("attachment");
    const spec: NativeAttachmentSpec = {
      sessionId: request.sessionId,
      attachmentId,
      directory: site.directory,
      continuity: request.command.continuity,
      native: null,
    };
    const { translator, sink } = this.#pipeline(adapter, spec, location.venue);
    let handle: BindingHandle;
    try {
      handle = await adapter.attach(spec, sink);
    } catch (error) {
      sink.discard();
      const nativeFailure =
        error instanceof NativeAttachmentError
          ? { code: error.code, attentionKind: error.attentionKind }
          : null;
      return this.#failAttach({
        request,
        submitted,
        adapter,
        location,
        code: nativeFailure?.code ?? "attach_failed",
        detail: errorMessage(error),
        attachmentId,
        attentionKind: nativeFailure?.attentionKind,
      });
    }

    try {
      const attachment: SessionAttachment = {
        id: attachmentId,
        sessionId: request.sessionId,
        adapterId: adapter.id,
        venue: location.venue,
        continuity: request.command.continuity,
        // The directory that was PREPARED, never the one that was resolved. On a
        // worktree ticket with no stamp yet the two differ, and `resolve` names
        // the main checkout — writing that down would hand every later resume
        // the fallback this attach exists to refuse (#38), because
        // `#rehydrateBinding` trusts the persisted directory over a fresh read.
        native: wrapNativeBinding(site.directory, adapter.runtime, handle.native),
        // The policy this attachment opened under, read off the handle exactly
        // as `native` is and written down once, here (VC-44). This is the only
        // place an Authority Snapshot becomes durable, which is what lets a
        // later `authority.denied` — which carries this `attachmentId` — name
        // the rule pack that produced it. An adapter that does not answer runs
        // no policy, and records none.
        authority: handle.authority ?? null,
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
      const clearedAttachFailures = await Promise.all(
        projection.attention.active
          // `hasOwn`, not `in`: the kind arrives from durable history, and `in`
          // would answer true for `toString` and every other prototype key.
          .filter(({ kind }) => Object.hasOwn(ATTACH_FAILURE_ATTENTION_KINDS, kind))
          .map(({ id: attentionId }) =>
            this.ports.engine.observe({
              id: this.#id("event"),
              sessionId: request.sessionId,
              occurredAt: this.ports.clock.now(),
              provenance: adapterProvenance(adapter, location.venue),
              kind: "attention.cleared",
              attentionId,
            }),
          ),
      );
      this.#bindings.set(attachmentId, {
        adapter,
        handle,
        spec: { ...spec, native: handle.native },
        attachment,
        venue: location.venue,
        cursor: null,
        lastProgressAt: this.ports.clock.now(),
        reconcileInFlight: null,
        translator,
        sink,
      });
      await this.#publish([opened, ...clearedAttachFailures]);
      await sink.activate();
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

  async #failAttach(input: FailAttachInput): Promise<SessionRuntimeCommandResult> {
    const attachmentId = input.attachmentId ?? this.#id("attachment");
    const failed = await this.ports.engine.observe({
      id: this.#id("event"),
      sessionId: input.request.sessionId,
      occurredAt: this.ports.clock.now(),
      provenance: adapterProvenance(input.adapter, input.location.venue),
      commandId: input.request.commandId,
      kind: "attachment.failed",
      attachment: {
        id: attachmentId,
        sessionId: input.request.sessionId,
        adapterId: input.adapter.id,
        venue: input.location.venue,
        continuity: input.request.command.continuity,
        native: null,
        // An attach that failed ran nothing, so it was governed by nothing. The
        // Snapshot is not merely unknown here — there was no attachment for one
        // to be pinned to, and writing the policy that *would* have applied
        // would put a claim in history that no call was ever judged against.
        authority: null,
      },
      failure: { code: input.code, detail: input.detail, diagnostic: null },
    });
    const attention =
      input.attentionKind === undefined
        ? null
        : await this.ports.engine.observe({
            id: this.#id("event"),
            sessionId: input.request.sessionId,
            occurredAt: this.ports.clock.now(),
            provenance: adapterProvenance(input.adapter, input.location.venue),
            kind: "attention.raised",
            attention: {
              id: freshAttachAttentionId(
                input.request.sessionId,
                input.adapter.id,
                input.attentionKind,
              ),
              // The attachment attempt is already a closed fact. This Attention
              // belongs to the Session until a fresh attach succeeds, rather
              // than pretending a failed binding can receive recovery work.
              attachmentId: null,
              kind: input.attentionKind,
              detail: input.detail,
              diagnostic: null,
            },
          });
    await this.#publish(attention === null ? [failed] : [failed, attention]);
    const receipt = await this.#recordDelivery(
      input.request.sessionId,
      null,
      input.adapter,
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
      threadId: sessionRootThreadId(request.sessionId),
      branchId: sessionMainBranchId(request.sessionId),
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

    // A fresh command has definitely not reached the adapter yet. Validate the
    // immutable binding directory before binding/reconciliation can throw past
    // the durable intent, and turn a local preflight failure into the terminal
    // receipt that intent is owed.
    if (!existed) {
      const unavailable = await this.#rejectUnavailableLocation(
        request.sessionId,
        submitted.command,
        projection,
        location,
      );
      if (unavailable) return this.#result(request.sessionId, submitted.command, unavailable);
    }

    const binding = await this.#bindingForCommand(
      submitted.command,
      projection,
      location,
      !existed,
    );
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) return recovered;

    // A replay reconciles before it attempts delivery: the earlier invocation
    // may already have reached the adapter. Only when reconciliation finds no
    // terminal receipt do we re-ask before dispatching. Fresh commands took the
    // rejection-producing preflight above; `resolve` stays the cheap read it is
    // documented to be.
    if (existed) await this.ports.locations.reaffirm(projection.session, binding.spec.directory);

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

  /**
   * An explicit Context Compaction — the third reason a context is summarized,
   * and the only one a person chose.
   *
   * The same shape of act as an interrupt: one operation addressed to the live
   * attachment, whose whole outcome is its receipt — so it takes the same road
   * ({@link #addressedOperation}) rather than a copy of it. Retry's extra
   * machinery is about the Attention a failed run leaves behind, and a
   * compaction leaves none: the executor's refusals, including "there is
   * nothing left to summarize", reach the user through this receipt.
   */
  async #compact(
    request: CompactCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const attachmentId = request.command.attachmentId ?? projection.liveExecutor?.id;
    if (!attachmentId) throw new SessionRuntimeConflictError("No live executor can be compacted");
    // Null, never absent: the instructions are part of the intent, so a
    // command id resent with different words is a different command rather
    // than one answered with the first one's receipt.
    const instructions = request.command.instructions ?? null;
    return this.#addressedOperation({
      request,
      projection,
      location,
      existed,
      attachmentId,
      intent: { kind: "context.compact", attachmentId, instructions },
      resultKind: "context.compacted",
      delivery: {
        kind: "context.compact",
        commandId: request.commandId,
        sessionId: request.sessionId,
        attachmentId,
        instructions,
      },
    });
  }

  async #interrupt(
    request: InterruptCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const attachmentId = request.command.attachmentId ?? projection.liveExecutor?.id;
    if (!attachmentId) throw new SessionRuntimeConflictError("No live executor can be interrupted");
    return this.#addressedOperation({
      request,
      projection,
      location,
      existed,
      attachmentId,
      intent: { kind: "executor.interrupt", attachmentId },
      resultKind: "executor.interrupted",
      delivery: {
        kind: "executor.interrupt",
        commandId: request.commandId,
        sessionId: request.sessionId,
        attachmentId,
      },
    });
  }

  /**
   * One operation addressed to one attachment, delivered the way every
   * adapter-bound command is delivered.
   *
   * What is in here is not any operation: it is the delivery discipline they
   * all owe. Record the intent before anything acts on it; answer a command
   * whose receipt is already terminal with that receipt; resume a cold binding
   * before addressing it and settle a location that will not come back; and
   * let a replay find the receipt its first attempt left rather than doing the
   * work twice — which for a compaction would mean a second summary call and a
   * second entry appended.
   *
   * Shared by {@link #interrupt} and {@link #compact} because the discipline is
   * one thing. Two copies of it would be one thing until the day they
   * disagreed, and the disagreement would be invisible from either call site.
   */
  async #addressedOperation(input: {
    request: ExistingSessionCommandRequest;
    projection: SessionProjection;
    location: SessionLocation;
    existed: boolean;
    attachmentId: string;
    intent: Extract<
      SessionCommandIntent,
      { kind: "executor.interrupt" } | { kind: "context.compact" }
    >;
    resultKind: DeliveryResultKind;
    delivery: HarnessCommand;
  }): Promise<SessionRuntimeCommandResult> {
    const { request, projection, location, existed, attachmentId } = input;
    const submitted = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      intent: input.intent,
      provenance: userProvenance(location.venue),
    });
    await this.#publishSubmit(submitted, existed);
    if (submitted.receipt && submitted.receipt.status !== "unreconciled")
      return this.#result(request.sessionId, submitted.command, submitted.receipt);
    // A live binding can always be addressed without consulting its old cwd.
    // A cold one must first be resumed, so give that location failure the same
    // durable outcome as every other post-intent delivery preflight.
    const needsRehydration = !this.#bindings.has(attachmentId);
    if (!existed && needsRehydration) {
      const unavailable = await this.#rejectUnavailableLocation(
        request.sessionId,
        submitted.command,
        projection,
        location,
      );
      if (unavailable) return this.#result(request.sessionId, submitted.command, unavailable);
    }
    const binding = await this.#bindingForCommand(
      submitted.command,
      projection,
      location,
      !existed && needsRehydration,
    );
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) return recovered;
    const receipt = await binding.handle.dispatch(input.delivery);
    const durable = await this.#recordDelivery(
      request.sessionId,
      attachmentId,
      binding.adapter,
      binding.venue,
      receipt,
      input.resultKind,
    );
    return this.#result(request.sessionId, submitted.command, durable);
  }

  async #retry(
    request: RetryCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
  ): Promise<SessionRuntimeCommandResult> {
    const attachmentId = request.command.attachmentId ?? projection.liveExecutor?.id;
    if (!attachmentId) throw new SessionRuntimeConflictError("No live executor can be retried");
    const submitted = await this.ports.engine.submit({
      commandId: request.commandId,
      sessionId: request.sessionId,
      intent: { kind: "executor.retry", attachmentId },
      provenance: userProvenance(location.venue),
    });
    await this.#publishSubmit(submitted, existed);
    if (submitted.receipt && submitted.receipt.status !== "unreconciled") {
      return this.#result(request.sessionId, submitted.command, submitted.receipt);
    }
    const needsRehydration = !this.#bindings.has(attachmentId);
    if (!existed && needsRehydration) {
      const unavailable = await this.#rejectUnavailableLocation(
        request.sessionId,
        submitted.command,
        projection,
        location,
      );
      if (unavailable) return this.#result(request.sessionId, submitted.command, unavailable);
    }
    const attachment = projection.attachments.find(({ id }) => id === attachmentId);
    /* v8 ignore next 3 -- SessionEngine only routes retry to an open attachment. */
    if (attachment === undefined) {
      throw new SessionRuntimeNotFoundError(`Attachment ${attachmentId} is not open`);
    }
    let binding: BindingRecord;
    try {
      binding = await this.#bindingForCommand(
        submitted.command,
        projection,
        location,
        !existed && needsRehydration,
      );
    } catch (error) {
      if (this.#closed) throw error;
      const detail = `Retry recovery failed: ${errorMessage(error)}`;
      const adapter = this.#adapterIdentityFor(attachment.adapterId);
      const recoveryAttentionId = `${attachmentId}:recovery`;
      if (!projection.attention.active.some(({ id }) => id === recoveryAttentionId)) {
        const attention = await this.ports.engine.observe({
          id: this.#id("event"),
          sessionId: request.sessionId,
          attachmentId,
          occurredAt: this.ports.clock.now(),
          provenance: adapterProvenance(adapter, location.venue),
          kind: "attention.raised",
          attention: {
            id: recoveryAttentionId,
            attachmentId,
            kind: "adapter_unrecoverable",
            detail,
            diagnostic: null,
          },
        });
        await this.#publish([attention]);
      }
      const receipt = await this.#recordDelivery(
        request.sessionId,
        attachmentId,
        adapter,
        location.venue,
        {
          commandId: request.commandId,
          status: "rejected",
          code: error instanceof NativeAttachmentError ? error.code : "retry_recovery_failed",
          detail,
          native: null,
        },
        "executor.retried",
      );
      return this.#result(request.sessionId, submitted.command, receipt);
    }
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) {
      await this.#clearRecoveryAttentionAfterAcceptedRetry({
        sessionId: request.sessionId,
        attachmentId,
        projection,
        adapter: binding.adapter,
        venue: binding.venue,
        receipt: recovered.receipt,
      });
      return recovered;
    }
    const receipt = await binding.handle.dispatch({
      kind: "executor.retry",
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
      "executor.retried",
    );
    await this.#clearRecoveryAttentionAfterAcceptedRetry({
      sessionId: request.sessionId,
      attachmentId,
      projection,
      adapter: binding.adapter,
      venue: binding.venue,
      receipt: durable,
    });
    return this.#result(request.sessionId, submitted.command, durable);
  }

  async #clearRecoveryAttentionAfterAcceptedRetry(input: {
    sessionId: string;
    attachmentId: string;
    projection: SessionProjection;
    adapter: AdapterIdentity;
    venue: SessionExecutionVenue;
    receipt: CommandReceipt;
  }): Promise<void> {
    if (input.receipt.status !== "accepted") return;
    const attentionId = `${input.attachmentId}:recovery`;
    if (!input.projection.attention.active.some(({ id }) => id === attentionId)) return;
    const cleared = await this.ports.engine.observe({
      id: this.#id("event"),
      sessionId: input.sessionId,
      attachmentId: input.attachmentId,
      occurredAt: this.ports.clock.now(),
      provenance: adapterProvenance(input.adapter, input.venue),
      kind: "attention.cleared",
      attentionId,
    });
    await this.#publish([cleared]);
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
      threadId: sessionRootThreadId(request.sessionId),
      branchId: sessionMainBranchId(request.sessionId),
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

    // An interaction can wait on a person indefinitely, so the turn's earlier
    // directory check is not evidence that the reply still has somewhere to go.
    if (!existed) {
      const unavailable = await this.#rejectUnavailableLocation(
        request.sessionId,
        submitted.command,
        projection,
        location,
      );
      if (unavailable) return this.#result(request.sessionId, submitted.command, unavailable);
    }
    const binding = await this.#bindingForAttachment(
      interaction.attachmentId,
      projection,
      location,
      !existed,
    );
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) return recovered;
    // Same replay rule as message delivery. A fresh interaction resolution was
    // checked before binding; an older ambiguous attempt reconciles first.
    if (existed) await this.ports.locations.reaffirm(projection.session, binding.spec.directory);
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
   * delivers. Cancelling records one durable fact and dispatches no command:
   * the harness was never told an answer, so Volli must not claim it heard one.
   * That is also why this is not a Session command — a command earns a delivery
   * receipt, and there is no delivery here to receipt.
   *
   * Whether a harness can be told to withdraw an ask was always the adapter's
   * question, and the structured executor now answers yes: it parks a promise
   * per open question, so writing the fact and saying nothing would leave a
   * model's tool call waiting on a gate nobody is left to open. The ask is
   * therefore withdrawn too — best-effort, after the fact is durable, because
   * an executor that cannot hear it still stops waiting when its attachment
   * ends, and the person's cancel must not hang on the harness answering. The
   * withdrawal carries no resolution, for the reason this verb exists at all:
   * every way to answer carries a disposition, and reaching for one to clear
   * the gate would print a choice nobody made. It is a courtesy paid to a live
   * executor, not a delivery — still no command, still no receipt.
   *
   * The attachment may be closed by now, and this is the one Session fact that
   * still lands when it is. Nothing can be delivered to a closed binding — but
   * nothing needs to be, because the point of the fact is that nothing was.
   *
   * Cancelling an interaction that is no longer open is a no-op, not a fault.
   * Unlike a command this carries no idempotency key, so a repeat is
   * indistinguishable from a first attempt and there is no receipt to replay —
   * which leaves the state it asked for as the only thing to answer against.
   * Two Stop clicks, or a click racing the harness's own answer, both arrive
   * here with the ask already gone, and both got what they wanted: the
   * interaction has stopped waiting. Failing the second would put a Session in
   * `lifecycle:"error"` over an outcome that already holds.
   */
  async #cancelInteraction(request: CancelInteractionRequest): Promise<void> {
    const projection = await this.#requireSession(request.sessionId);
    const interaction = projection.interactions.active.find(
      ({ id }) => id === request.interactionId,
    );
    if (!interaction) return;
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
    // Only an executor that is already speaking can be told to stop waiting:
    // `#bindingForAttachment` would attach one to say it, and cancelling a
    // question is the last intent that should ever start a harness. A closed
    // attachment therefore finds nothing here, which is the ordinary case and
    // not a fault. Whatever the withdrawal does is swallowed — including a
    // throw that lands before a promise exists to reject — because the fact
    // above is durable and the person's cancel already holds.
    const binding = this.#bindings.get(interaction.attachmentId);
    try {
      await binding?.handle.withdrawInteraction?.(interaction.id);
    } catch {
      // Nothing to record: an unheard withdrawal changes no Session fact.
    }
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
    // Do not recreate or validate a checkout merely to stop an already-live
    // binding. A relaunch has no handle to release, however, and must rehydrate;
    // that cold location check is owed a receipt if it cannot succeed.
    const needsRehydration = !this.#bindings.has(request.command.attachmentId);
    if (!existed && needsRehydration) {
      const unavailable = await this.#rejectUnavailableLocation(
        request.sessionId,
        submitted.command,
        projection,
        location,
      );
      if (unavailable) return this.#result(request.sessionId, submitted.command, unavailable);
    }
    const binding = await this.#bindingForAttachment(
      request.command.attachmentId,
      projection,
      location,
      !existed && needsRehydration,
    );
    const recovered = await this.#recoverAdapterDelivery({ request, submitted, binding, existed });
    if (recovered) return recovered;
    await binding.handle.release("requested");
    // The binding stops speaking before this Session records that it stopped.
    // What `release` resolving guarantees is narrow, and worth stating exactly:
    // an observation whose own `emit` already resolved is durable. One still
    // queued behind the serializing tail is not, and is dropped here rather
    // than filed against an attachment that is over — the ledger would refuse
    // it and throw back out through the executor's own observer. Dropping is
    // the Session's guarantee; draining first would only move the race.
    binding.sink.discard();
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
    this.#overlays.delete(request.sessionId);
    this.#compactionProgress.delete(request.sessionId);
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
  }): Promise<DeliveredSessionRuntimeCommandResult | null> {
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
    if (!receipt) return null;
    return {
      ...(await this.#result(input.request.sessionId, replayed.command, receipt)),
      receipt,
    };
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
    listener: (emission: SessionStreamEmission) => void | Promise<void>,
    onFailure?: (error: unknown) => void,
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
      ...(onFailure ? { onFailure } : {}),
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
      await this.#enqueueOverlayBaselines(subscriber);
      await this.#enqueueCompactionProgressBaseline(subscriber);
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

  async reconcile(input: { sessionId: string; attachmentId: string }): Promise<void> {
    this.#assertOpen();
    const projection = await this.#requireSession(input.sessionId);
    this.#assertOpen();
    const location = await this.ports.locations.resolve(projection.session);
    this.#assertOpen();
    const attachment = projection.attachments.find(({ id }) => id === input.attachmentId);
    if (attachment === undefined) {
      throw new SessionRuntimeNotFoundError(`Attachment ${input.attachmentId} is not open`);
    }
    const recoveryAttentionId = `${input.attachmentId}:recovery`;
    let binding: BindingRecord;
    try {
      binding = await this.#bindingForAttachment(input.attachmentId, projection, location);
    } catch (error) {
      // Only failure to reconstruct the binding is unrecoverable. A binding
      // that was reconstructed and then had a transient reconcile failure is
      // still a live executor and remains a normal retryable transport error.
      if (this.#closed) throw error;
      if (projection.attention.active.some(({ id }) => id === recoveryAttentionId)) throw error;
      const detail = `Recovery failed: ${errorMessage(error)}`;
      // Raising the Attention is best effort, and deliberately cannot displace
      // the failure it describes. An attachment that is already closed rejects
      // the observation, and letting that rejection propagate would replace
      // "the binding could not be reconstructed" with "it is already closed" —
      // the second is true and the first is the one worth reading. Nothing is
      // swallowed: `error` is still thrown, and it is the better diagnostic.
      try {
        const attention = await this.ports.engine.observe({
          id: this.#id("event"),
          sessionId: input.sessionId,
          attachmentId: input.attachmentId,
          occurredAt: this.ports.clock.now(),
          provenance: adapterProvenance(
            this.#adapterIdentityFor(attachment.adapterId),
            location.venue,
          ),
          kind: "attention.raised",
          attention: {
            id: recoveryAttentionId,
            attachmentId: input.attachmentId,
            kind: "adapter_unrecoverable",
            detail,
            diagnostic: null,
          },
        });
        await this.#publish([attention]);
      } catch {
        // Deliberately empty: `error` below is the diagnostic worth keeping.
      }
      throw error;
    }
    await this.#assertBindingOperationOpen();
    await this.#reconcileBinding(binding, true);
    await this.#assertBindingOperationOpen();
    if (projection.attention.active.some(({ id }) => id === recoveryAttentionId)) {
      const cleared = await this.ports.engine.observe({
        id: this.#id("event"),
        sessionId: input.sessionId,
        attachmentId: input.attachmentId,
        occurredAt: this.ports.clock.now(),
        provenance: adapterProvenance(
          this.#adapterIdentityFor(attachment.adapterId),
          location.venue,
        ),
        kind: "attention.cleared",
        attentionId: recoveryAttentionId,
      });
      await this.#publish([cleared]);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscribers of this.#subscribers.values()) {
      for (const subscriber of subscribers) subscriber.active = false;
    }
    this.#subscribers.clear();
    this.#histories.clear();
    this.#overlays.clear();
    this.#compactionProgress.clear();
    await this.#releaseBindingsAfterClose();
  }

  /**
   * Shutdown's release, held to the same order as the requested one: drain,
   * then stop. A release that threw stops the pipeline too — the runtime is
   * going away either way, and this is the last caller that could.
   */
  async #releaseBindingsAfterClose(): Promise<void> {
    if (!this.#closed) return;
    const bindings = [...this.#bindings.values()];
    this.#bindings.clear();
    await Promise.allSettled(
      bindings.map((binding) =>
        binding.handle.release("shutdown").finally(() => binding.sink.discard()),
      ),
    );
  }

  async #assertBindingOperationOpen(): Promise<void> {
    if (!this.#closed) return;
    await this.#releaseBindingsAfterClose();
    this.#assertOpen();
  }

  /** Update only the live binding that produced a real runtime observation. */
  #recordBindingProgress(spec: Pick<NativeAttachmentSpec, "sessionId" | "attachmentId">): void {
    const binding = this.#bindings.get(spec.attachmentId);
    /* v8 ignore next -- only this attachment-keyed sink calls here, and it is discarded before its binding leaves this private map. */
    if (binding?.spec.sessionId !== spec.sessionId) return;
    binding.lastProgressAt = this.ports.clock.now();
  }

  /**
   * One attachment's observation pipeline, and the translator it runs on.
   *
   * Both are returned because the binding record borrows the translator for the
   * replay path while the sink owns it — see {@link BindingRecord.translator}.
   */
  #pipeline(
    adapter: NativeHarnessAdapter,
    spec: NativeAttachmentSpec,
    venue: SessionExecutionVenue,
  ): { translator: RuntimeObservationTranslator; sink: BufferedObservationSink } {
    const translator = new RuntimeObservationTranslator({
      namespace: adapter.durableIdNamespace,
      sessionId: spec.sessionId,
      attachmentId: spec.attachmentId,
      now: () => this.ports.clock.now(),
    });
    const sink: BufferedObservationSink = new BufferedObservationSink(translator, (fact) =>
      this.#recordFact(adapter, spec, venue, fact, sink, "live"),
    );
    return { translator, sink };
  }

  async #recordFact(
    adapter: NativeHarnessAdapter,
    spec: NativeAttachmentSpec,
    venue: SessionExecutionVenue,
    observation: TranslatedObservation,
    /** The pipeline this fact came through, re-read for the one write that can outlast it. */
    sink: BufferedObservationSink,
    source: "live" | "replay" = "live",
  ): Promise<void> {
    // Replayed facts may be hours old. Only live tokens/tool observations reset
    // the watchdog's process-local clock; durable recovery is not progress.
    if (source === "live") this.#recordBindingProgress(spec);
    // A transient fact, and every durable step below is skipped on purpose: no
    // artifact write, no ledger event, and no observation-id dedupe — at ~31
    // emissions a second a delta carries no durable identity worth deduping.
    // It also returns here rather than falling through to the cursor advance at
    // the foot of this method: the arm has no cursor, and moving the reconcile
    // cursor for content that was never written down would make a later
    // reconcile ask the provider for events past it.
    if (observation.kind === "transcript.delta") {
      await this.#recordTranscriptDelta(spec.sessionId, observation);
      return;
    }
    if (observation.kind === "context.compaction-progress") {
      await this.#recordCompactionProgress(spec.sessionId, observation);
      return;
    }
    const base = {
      id: nativeObservationId(adapter.id, spec.sessionId, spec.attachmentId, observation.id),
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
        // The one await in this method between accepting a fact and recording
        // it, so the one place a release can land mid-fact. Artifacts are
        // content-addressed and nothing yet points at these bytes, so
        // abandoning them costs an inert file, where recording the event would
        // be a fact about an attachment the ledger has already closed.
        if (sink.stopped) return;
        event = await this.ports.engine.observe({
          ...base,
          kind: "transcript.referenced",
          turnId: observation.turnId,
          reference,
        });
        // The settled snapshot is durable, so the transient tail it supersedes
        // goes now — the durable message's own id is what a delta addresses, so
        // the two arms join here. Keyed off this observation being *processed*,
        // not off its frame being delivered: `observe` dedupes by id and returns
        // the original event for a repeat; that event's sequence is behind every
        // subscriber cursor, so its frame is never delivered again, and an entry
        // waiting on that delivery would wait forever.
        this.#clearOverlayMessage(spec.sessionId, observation.message.id);
        break;
      }
      case "turn.started":
      case "turn.completed":
      case "turn.interrupted":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          turnId: observation.turnId,
        });
        if (observation.kind === "turn.started") {
          const release = this.#messageAdmissions.get(spec.sessionId);
          if (release !== undefined) this.#releaseMessageAdmission(spec.sessionId, release);
        }
        break;
      case "context.compacted":
        // The durable outcome replaces the transient loading state for every
        // current subscriber and makes a late subscriber's baseline empty.
        this.#compactionProgress.delete(spec.sessionId);
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          reason: observation.reason,
          entryId: observation.entryId,
          tokensBefore: observation.tokensBefore,
          tokensAfter: observation.tokensAfter,
        });
        break;
      case "context.compaction_failed":
        this.#compactionProgress.delete(spec.sessionId);
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          reason: observation.reason,
          detail: observation.detail,
        });
        break;
      case "authority.denied":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          turnId: observation.turnId,
          tool: observation.tool,
          cause: observation.cause,
          reason: observation.reason,
        });
        break;
      case "usage.recorded":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          turnId: observation.turnId,
          usage: observation.usage,
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
      // The executor's own withdrawal, which is a different fact from the one
      // `#cancelInteraction` writes even though both land as the same kind. That
      // one carries user provenance because a person closed the question; this
      // one carries the executor's, because the question stopped being asked
      // without anybody deciding anything. Neither may carry a resolution.
      case "interaction.cancelled":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          interactionId: observation.interactionId,
          reason: observation.reason,
        });
        break;
      case "attention.cleared":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          attentionId: observation.attentionId,
        });
        break;
      // `rate_limited` and `quota_exhausted` are Attention kinds no executor can
      // reach, so this arm no longer carries the `retryAt`/`resetAt` shapes they
      // need. Reaching them means widening the runtime's attention `reason`,
      // which the recovery sidecar re-validates against every marker already on
      // disk — a schema migration, and its own piece of work.
      case "attention.raised":
        event = await this.ports.engine.observe({
          ...base,
          kind: observation.kind,
          attention: {
            id: observation.attention.id,
            attachmentId: spec.attachmentId,
            kind: observation.attention.kind,
            detail: observation.attention.detail,
            diagnostic: observation.attention.diagnostic,
          },
        });
        break;
    }
    const binding = this.#bindings.get(spec.attachmentId);
    if (binding && observation.cursor !== undefined) binding.cursor = observation.cursor;
    await this.#publish([event]);
    if (observation.kind === "attachment.closed" || observation.kind === "attachment.failed") {
      // The executor closed itself, so the stop is the same one `#release`
      // performs and belongs at the same point: after the closing fact is
      // durable, before anything behind it in the pipeline can be recorded
      // against the attachment it just closed.
      binding?.sink.discard();
      this.#bindings.delete(spec.attachmentId);
      // Nothing is left to finish what the overlay holds, and its content was
      // never durable. Dropping it beside the binding keeps the two ends
      // together.
      this.#overlays.delete(spec.sessionId);
      this.#compactionProgress.delete(spec.sessionId);
    }
  }

  /**
   * Folds one transient delta and hands it to this Session's live subscribers.
   *
   * The emission is published even when the fold ignored the delta: a
   * subscriber runs the same self-healing rule over the same entries, so an
   * ignored delta is ignored identically on both ends, and filtering here would
   * only make the two folds different code.
   */
  async #recordTranscriptDelta(
    sessionId: string,
    observation: Extract<TranslatedObservation, { kind: "transcript.delta" }>,
  ): Promise<void> {
    const overlay = await this.#overlay(sessionId);
    overlay.messages = applyTranscriptDelta(
      overlay.messages,
      observation.messageId,
      observation.delta,
    );
    await this.#publishOverlay({
      kind: "overlay",
      sessionId,
      throughSequence: overlay.throughSequence,
      messageId: observation.messageId,
      delta: observation.delta,
    });
  }

  /**
   * The progress marker is deliberately not a Session Event: a restart stops
   * the operation that emitted it, so retaining it would turn a past wait into
   * a permanent spinner. Its durable sequence lets a renderer reject a marker
   * that was already overtaken by that compaction's terminal event.
   */
  async #recordCompactionProgress(
    sessionId: string,
    observation: Extract<TranslatedObservation, { kind: "context.compaction-progress" }>,
  ): Promise<void> {
    const progress: SessionStreamCompactionProgress = {
      kind: "compaction",
      sessionId,
      throughSequence: (await this.#history(sessionId)).throughSequence,
      state: observation.state,
      reason: observation.reason,
    };
    if (progress.state === "started") this.#compactionProgress.set(sessionId, progress);
    else this.#compactionProgress.delete(sessionId);
    await this.#publishCompactionProgress(progress);
  }

  /**
   * The Session's overlay, created on its first delta.
   *
   * The record is installed *before* the sequence it starts from is read, so a
   * durable publish landing during that read raises the same record rather than
   * a discarded one; `#recordDurableSequence` only ever moves the number
   * forward, so whichever of the two arrives second is the one that wins. A
   * record that starts from a stale sequence would emit overlays the
   * subscriber's staleness guard drops, which is why this is worth one ledger
   * read per streaming attachment.
   *
   * Installing it early is also what exposes it to deletion mid-read, so *both*
   * exits have to honour a deletion, not just the failing one. A closed or
   * failed attachment, a release command and `close()` each drop the entry,
   * and every one of them can land while this read is in flight;
   * `#keepOverlay` writes the record back unconditionally, so returning through
   * it would undo whichever of them just ran. What survives is transient state
   * for a Session with no binding left to finish it — published to subscribers
   * as though something were still streaming, rebuilt as a baseline for every
   * later subscriber, and, when the deleter was `close()`, held past the end of
   * the runtime that owns it. The failure path resolves this by deleting; here
   * the record may still be the live one, so the answer is to look before
   * re-inserting.
   */
  async #overlay(sessionId: string): Promise<SessionOverlayState> {
    const existing = this.#overlays.get(sessionId);
    if (existing) return this.#keepOverlay(sessionId, existing);
    const created: SessionOverlayState = { messages: new Map(), throughSequence: 0 };
    this.#overlays.set(sessionId, created);
    try {
      this.#recordDurableSequence(sessionId, (await this.#history(sessionId)).throughSequence);
    } catch (error) {
      // A half-made record would report sequence 0 forever. Drop it so the next
      // delta starts the seed again, and let the emitter hear the failure.
      this.#overlays.delete(sessionId);
      throw error;
    }
    // Not the record installed above means it was deleted during the read (and
    // possibly replaced since). The caller still gets somewhere to fold this one
    // delta, but it stays out of the map and dies with this call — the deletion
    // is the newer fact about the Session, and this call has no standing to
    // reverse it.
    if (this.#overlays.get(sessionId) !== created) return created;
    return this.#keepOverlay(sessionId, created);
  }

  #keepOverlay(sessionId: string, overlay: SessionOverlayState): SessionOverlayState {
    this.#overlays.delete(sessionId);
    this.#overlays.set(sessionId, overlay);
    for (const oldest of this.#overlays.keys()) {
      if (this.#overlays.size <= OVERLAY_CACHE_LIMIT) break;
      this.#overlays.delete(oldest);
    }
    return overlay;
  }

  #clearOverlayMessage(sessionId: string, messageId: string): void {
    const overlay = this.#overlays.get(sessionId);
    if (!overlay) return;
    overlay.messages = applyTranscriptDelta(overlay.messages, messageId, { op: "message.remove" });
  }

  #recordDurableSequence(sessionId: string, sequence: number): void {
    const overlay = this.#overlays.get(sessionId);
    if (!overlay) return;
    if (sequence > overlay.throughSequence) overlay.throughSequence = sequence;
  }

  async #bindingForCommand(
    command: SessionCommand,
    projection: SessionProjection,
    location: SessionLocation,
    locationReaffirmed = false,
  ): Promise<BindingRecord> {
    const attachmentId = command.route?.attachmentId;
    /* v8 ignore next 3 -- SessionEngine returns a durable no_live_executor receipt before an un-routed command can reach delivery. */
    if (!attachmentId) {
      throw new SessionRuntimeConflictError(`Command ${command.id} has no attachment route`);
    }
    return this.#bindingForAttachment(attachmentId, projection, location, locationReaffirmed);
  }

  async #bindingForAttachment(
    attachmentId: string,
    projection: SessionProjection,
    location: SessionLocation,
    locationReaffirmed = false,
  ): Promise<BindingRecord> {
    const existing = this.#bindings.get(attachmentId);
    if (existing) return existing;
    const rehydrating = this.#rehydratingBindings.get(attachmentId);
    if (rehydrating) return rehydrating;
    const promise = this.#rehydrateBinding(attachmentId, projection, location, locationReaffirmed);
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
    locationReaffirmed: boolean,
  ): Promise<BindingRecord> {
    const attachment = projection.attachments.find(({ id }) => id === attachmentId);
    // `!attachment` is defence in depth and no longer reachable: `reconcile`
    // pre-guards on the same condition, the delivery paths are routed by the
    // engine, which refuses an unknown attachment before delivery, and the
    // replayed attach takes its id from an event in the same fold. Retiring the
    // capability probe removed the last caller that arrived here unchecked.
    if (!attachment || attachment.status !== "open") {
      throw new SessionRuntimeNotFoundError(`Attachment ${attachmentId} is not open`);
    }
    const binding = unwrapNativeBinding(attachment.native);
    const adapter = this.#requireExecutorFor(attachment.adapterId);
    // The other half of the same guarantee, for the attach that never runs
    // `prepare`: a binding rebuilt from history — a replayed attach command, or
    // the first command after a relaunch — takes its directory from the durable
    // attachment and hands it straight to the adapter. That directory was real
    // when it was written down and may not be now, and re-affirming it here
    // covers every caller of `#bindingForAttachment` at once.
    const directory = binding.directory ?? location.directory;
    // Delivery commands perform their own rejection-producing preflight after
    // persisting intent. Do not repeat that check here: a second failure would
    // escape after persistence and recreate the receipt-less command hole. All
    // other cold-binding callers still receive the rehydration guarantee here.
    if (!locationReaffirmed) await this.ports.locations.reaffirm(projection.session, directory);
    const spec: NativeAttachmentSpec = {
      sessionId: projection.session.id,
      attachmentId,
      directory,
      // A persisted binding is always a resume operation. A malformed empty
      // provider id fails honestly in the adapter; it must never create fresh.
      continuity: "native_resume",
      native: binding.native,
      // The Snapshot this attachment opened under, replayed rather than
      // re-resolved (VC-44). `#openAttachment` reads the handle's Snapshot and
      // writes it onto `attachment.opened`; this is the same fact travelling the
      // other way, so an attachment rebuilt after a relaunch is governed by the
      // policy history says governed it. Without this the durable record and the
      // live gate drift apart the first time anyone edits policy, and the record
      // is the half that would be wrong.
      pinnedAuthority: attachment.authority,
    };
    const { translator, sink } = this.#pipeline(adapter, spec, attachment.venue);
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
      lastProgressAt: this.ports.clock.now(),
      reconcileInFlight: null,
      translator,
      sink,
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
      for (const fact of binding.translator.replay(observation)) {
        await this.#recordFact(
          binding.adapter,
          binding.spec,
          binding.venue,
          fact,
          binding.sink,
          "replay",
        );
      }
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
      if (command.intent.kind === "model.select" && receipt.status === "accepted") {
        const completed = await this.ports.engine.completeModelSelection({
          sessionId: binding.spec.sessionId,
          commandId: command.id,
          attachmentId: binding.spec.attachmentId,
          occurredAt: receipt.acceptedAt,
          provenance: adapterProvenance(binding.adapter, binding.venue),
        });
        await this.#publish([completed.event, completed.receiptEvent]);
        terminalReceiptCommands.add(receipt.commandId);
        continue;
      }
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
    resultKind: DeliveryResultKind,
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
          id: adapter.id,
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

  /**
   * Re-validate the immutable directory a routed command is about to use.
   *
   * This runs after intent is durable and before any adapter call. A failure is
   * therefore an ordinary local rejection, not a thrown transport error and not
   * an attachment failure: the open binding remains retryable once its directory
   * can be restored.
   */
  async #rejectUnavailableLocation(
    sessionId: string,
    command: SessionCommand,
    projection: SessionProjection,
    location: SessionLocation,
  ): Promise<CommandReceipt | null> {
    const attachmentId = command.route?.attachmentId;
    /* v8 ignore next 3 -- routed adapter commands are enforced by SessionEngine. */
    if (!attachmentId) {
      throw new SessionRuntimeConflictError(`Command ${command.id} has no attachment route`);
    }
    const attachment = projection.attachments.find(({ id }) => id === attachmentId);
    /* v8 ignore next 3 -- SessionEngine only routes commands to an open attachment. */
    if (!attachment || attachment.status !== "open") {
      throw new SessionRuntimeNotFoundError(`Attachment ${attachmentId} is not open`);
    }
    const binding = unwrapNativeBinding(attachment.native);
    try {
      await this.ports.locations.reaffirm(
        projection.session,
        binding.directory ?? location.directory,
      );
      return null;
    } catch (error) {
      const adapter = this.#adapterIdentityFor(attachment.adapterId);
      return this.#recordDelivery(
        sessionId,
        attachmentId,
        adapter,
        attachment.venue,
        {
          commandId: command.id,
          status: "rejected",
          code: "location_unavailable",
          detail: errorMessage(error),
          native: null,
        },
        resultKindFor(command),
      );
    }
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
      // Recorded here, where an event is known to be durable: this is what the
      // Session's overlay emissions report as their `throughSequence`.
      this.#recordDurableSequence(event.sessionId, event.sequence);
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
          const event =
            subscriber.events.get(subscriber.cursor + 1) ?? (await this.#nextAfterGap(subscriber));
          if (!event) {
            /* v8 ignore next 7 -- per-Session MAX(sequence)+1 contiguity says the
               ledger always closes a hole; if that bet is ever lost, fail the
               subscription loudly so the consumer's reconnect heals from the
               ledger instead of holding a Stop button forever. */
            if (subscriber.events.size > 0) {
              throw new Error(
                `Session stream hole at sequence ${subscriber.cursor + 1} the ledger could not close`,
              );
            }
            break;
          }
          subscriber.events.delete(event.sequence);
          const frame = await this.#frame(event);
          if (!subscriber.active) break;
          await subscriber.listener(frame);
          subscriber.cursor = event.sequence;
        }
      })
      .catch((error: unknown) => this.#failSubscriber(subscriber, error));
    await subscriber.draining;
  }

  /**
   * The event after a hole the publish path left, read back from the ledger.
   *
   * The drain above delivers strictly contiguously, which reads as an ordering
   * guarantee but is really a bet: that every durable event reaches a subscriber
   * through {@link #publish}. The runtime is not the ledger's only writer — a
   * Session retitle, a terminal's own command bookkeeping, and the agent CLI all
   * submit straight to the Engine — and each of those appends sequences no
   * subscriber is ever handed. One of them lands mid-turn and the hole is
   * permanent: `cursor + 1` never arrives, so every event after it sits in
   * `events` unread, the Session's own `turn.completed` among them, and it holds
   * a Stop button nothing will ever clear.
   *
   * The ledger is canonical, and already the authority {@link #history} re-reads
   * for exactly this reason, so the hole is closed from it rather than by asking
   * every writer to remember to publish.
   *
   * A non-empty buffer is the whole test for "there is a hole", and it is exact
   * rather than a heuristic: {@link #enqueue} admits only sequences above the
   * cursor, this is reached only when `cursor + 1` is absent, so anything still
   * buffered is strictly beyond the hole. A healthy stream drains its buffer
   * empty every time and therefore never reads the ledger at all.
   *
   * Returning the event rather than a flag is what bounds the loop: a hole the
   * ledger cannot close — which the per-Session `MAX(sequence) + 1` contiguity
   * says cannot happen — stops the drain here instead of spinning on it.
   */
  async #nextAfterGap(subscriber: Subscriber): Promise<SessionEvent | undefined> {
    if (subscriber.events.size === 0) return undefined;
    const events = await this.#listEventsPaged({
      sessionId: subscriber.sessionId,
      afterSequence: subscriber.cursor,
    });
    // Every one of these is above the cursor by construction, and re-setting one
    // the buffer already holds replaces an immutable event with itself.
    for (const event of events) subscriber.events.set(event.sequence, event);
    return subscriber.events.get(subscriber.cursor + 1);
  }

  async #publishOverlay(emission: SessionStreamOverlay): Promise<void> {
    await this.#publishTransient(emission);
  }

  async #publishCompactionProgress(emission: SessionStreamCompactionProgress): Promise<void> {
    await this.#publishTransient(emission);
  }

  async #publishTransient(emission: SessionStreamTransient): Promise<void> {
    const subscribers = this.#subscribers.get(emission.sessionId);
    if (!subscribers) return;
    await Promise.all(
      [...subscribers].map((subscriber) => this.#appendTransient(subscriber, emission)),
    );
  }

  /**
   * A fresh subscriber's view of what is in flight: one `reset` per overlay
   * message, after the durable replay it belongs behind.
   *
   * The overlay read and the appends below are one synchronous step. Any await
   * between them lets a concurrent settle clear an entry and a baseline
   * resurrect it — and the tick-level race that even this cannot close is
   * covered by the sequence each baseline carries, which a settle that already
   * landed leaves strictly above it.
   *
   * That sequence is read off the overlay and never off the subscriber that
   * asked for these baselines. A subscription cursor is client input —
   * `subscribe` checks it is a non-negative integer and nothing else, and the
   * RPC edge widens it further to whatever `Last-Event-ID` a reconnect carried —
   * while `throughSequence` is Session-wide state stamped on the emissions
   * *every* subscriber receives. Recording a cursor as durable progress would
   * therefore let one caller resuming from a number above this Session's head
   * raise it for all of them, permanently: `#recordDurableSequence` only moves
   * forward. The consumer's whole defence against a pre-settle overlay arriving
   * after its settle is `throughSequence < settledAt`, so an inflated number
   * silently retires that guard and the late overlay replaces a durable message
   * with an older partial one. Nothing here needs to record anything anyway:
   * `#overlay` seeds the number from the folded history and `#publish` advances
   * it on every durable event. Should it still trail what this subscriber was
   * just replayed, that errs the only safe way — a baseline below a sequence
   * the consumer has already folded is dropped, costing one transient message
   * that the emitter's next delta rebuilds, where an inflated one costs durable
   * content.
   */
  #enqueueOverlayBaselines(subscriber: Subscriber): Promise<void> {
    const overlay = this.#overlays.get(subscriber.sessionId);
    if (!overlay) return Promise.resolve();
    const baselines = [...overlay.messages].map(([messageId, message]) =>
      this.#appendTransient(subscriber, {
        kind: "overlay",
        sessionId: subscriber.sessionId,
        throughSequence: overlay.throughSequence,
        messageId,
        delta: { op: "reset", message },
      }),
    );
    return Promise.all(baselines).then(() => undefined);
  }

  /** A reconnect sees an already-running compaction once, as its live baseline. */
  #enqueueCompactionProgressBaseline(subscriber: Subscriber): Promise<void> {
    const progress = this.#compactionProgress.get(subscriber.sessionId);
    return progress ? this.#appendTransient(subscriber, progress) : Promise.resolve();
  }

  /**
   * Hands one transient emission to a subscriber.
   *
   * The append is synchronous, at exactly the point `#enqueue` appends to the
   * same chain. Awaiting `draining` first and appending after would let a
   * durable publish that arrived in between interleave ahead of an overlay that
   * preceded it.
   *
   * How far the resulting promise reaches back is the listener's choice, not
   * this method's. A listener that awaits its own delivery holds the chain, and
   * `#publishTransient` awaits every subscriber's, so the adapter's emit is paced
   * by the slowest of them — the same backpressure durable frames already get.
   * A listener that hands the emission to a buffer of its own resolves at once
   * and lets none of that through: the session-rpc subscription is exactly such
   * a listener, and what bounds it is its own queue's capacity, which is its to
   * size and to report on overflowing. Both shapes are allowed on purpose —
   * what this seam owes is order and one delivery per emission, and a listener
   * that chooses to buffer answers for the buffer.
   */
  #appendTransient(subscriber: Subscriber, emission: SessionStreamTransient): Promise<void> {
    subscriber.draining = subscriber.draining
      .then(async () => {
        if (!subscriber.active) return;
        await subscriber.listener(emission);
      })
      .catch((error: unknown) => this.#failSubscriber(subscriber, error));
    return subscriber.draining;
  }

  async #failSubscriber(subscriber: Subscriber, error: unknown): Promise<void> {
    try {
      await this.ports.onSubscriberFailure?.(error);
    } finally {
      try {
        // The subscription itself is told, not just the host: removal alone
        // left the transport's queue open and silent, which downstream read as
        // a healthy stream that simply had nothing to say.
        subscriber.onFailure?.(error);
      } finally {
        this.#removeSubscriber(subscriber);
      }
    }
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
   * The entry is served unchanged only when the ledger returned no event past
   * the cursor. Otherwise the log it holds is extended and re-folded from the
   * top, so `projection` is never a partial fold and `projectSession` is never
   * asked to resume from one.
   *
   * That makes the invalidation rule the ledger's own contract, and the fold
   * has exactly two durable inputs, each covered by one clause of it:
   *
   * The events are append-only and sequence-ordered — `SessionLedgerTransaction`
   * offers `appendEvent` and no way to rewrite or remove one — so nothing below
   * the cursor can change under a live entry, and everything above it is read
   * every time, including facts appended by another writer.
   *
   * The base Session the fold starts from is insert-only: the same interface
   * offers `insertSession` and no verb that updates or removes a row, so the
   * copy an entry holds cannot go stale and a Session that was found once
   * cannot later be missing. That is why the cached path re-reads events and
   * not the row, and it is the whole of the invariant — every field of a
   * Session that does change (its title) changes by an event, and this fold is
   * what applies them. Weakening `SessionLedgerTransaction` to allow a Session
   * row to be written twice would have to re-verify here.
   *
   * History rewritten out of band, beneath that contract, would not be seen;
   * `close()` drops every entry, and a runtime that outlives such a rewrite
   * must be rebuilt.
   *
   * Two concurrent reads may both fold and the slower one may install the older
   * result. That entry is still exactly the fold of the events it holds — only
   * its cursor is behind — so the next read picks the difference back up.
   */
  async #history(sessionId: string): Promise<ProjectedHistory> {
    const cached = this.#histories.get(sessionId);
    if (!cached) {
      // The base row, not `getSession`'s projection: that would fold the whole
      // log to produce a value whose only used field is the row, and then be
      // thrown away for the fold below.
      const known = await this.ports.engine.getBaseSession({ sessionId });
      if (!known) throw new SessionRuntimeNotFoundError(`Session ${sessionId} was not found`);
      const events = await this.#listEventsPaged({ sessionId });
      return this.#keepHistory(sessionId, foldHistory(known, events));
    }
    const appended = await this.#listEventsPaged({
      sessionId,
      afterSequence: cached.throughSequence,
    });
    if (appended.length === 0) return this.#keepHistory(sessionId, cached);
    return this.#keepHistory(
      sessionId,
      foldHistory(cached.projection.session, [...cached.events, ...appended]),
    );
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

  /** How a durable attachment's adapter is stamped on a fact, whoever wrote it. */
  #adapterIdentityFor(adapterId: string): AdapterIdentity {
    return adapterId === this.ports.executor.id ? this.ports.executor : adapterIdentity(adapterId);
  }

  /**
   * The executor an attachment recorded, or a refusal.
   *
   * A durable attachment names the adapter that opened it, and history outlives
   * the executor that wrote it: a Session bound under a runtime this build no
   * longer ships cannot be rehydrated by the one it does. Refusing is what turns
   * that into an honest recovery failure rather than a live binding pointed at
   * someone else's native identity.
   */
  #requireExecutorFor(adapterId: string): NativeHarnessAdapter {
    if (adapterId !== this.ports.executor.id) {
      throw new SessionRuntimeNotFoundError(`Native adapter ${adapterId} was not found`);
    }
    return this.ports.executor;
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

export function createSessionRuntime(ports: SessionRuntimePorts): HostedSessionRuntime {
  return new DefaultSessionRuntime(ports);
}

function foldHistory(session: Session, events: readonly SessionEvent[]): ProjectedHistory {
  return {
    projection: projectSession(session, events),
    events,
    throughSequence: events.at(-1)?.sequence ?? 0,
  };
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
      id: adapter.id,
      detail: { adapterVersion: adapter.adapterVersion },
    },
    venue,
  };
}

/** Names an adapter this runtime does not host — a historical attachment's own id. */
function adapterIdentity(adapterId: string): AdapterIdentity {
  return { id: adapterId, adapterVersion: "unavailable" };
}

function wrapNativeBinding(
  directory: string,
  runtime: NativeRuntimeIdentity,
  native: SessionNativeReference,
): SessionNativeReference {
  return {
    id: native.id,
    detail: {
      kind: "volli.native-binding.v1",
      directory,
      runtime: {
        path: runtime.path,
        version: runtime.version,
        fingerprint: runtime.fingerprint,
      },
      locator: native.detail,
    },
  };
}

/**
 * Reads a persisted binding envelope, at the version every build has written.
 *
 * Tolerant of a `profileId` the writer no longer emits: rows written before
 * profiles were deleted still carry one, they still rehydrate on every app
 * start, and refusing them would strand every Session that has ever attached.
 * The envelope is not versioned past v1 for the same reason — nothing about
 * what a reader needs from it changed.
 */
function unwrapNativeBinding(reference: SessionNativeReference | null): {
  directory: string | null;
  native: SessionNativeReference;
} {
  if (!reference || !reference.detail || Array.isArray(reference.detail)) {
    throw new SessionRuntimeConflictError("Attachment has no native binding metadata");
  }
  const detail = reference.detail as { readonly [key: string]: SessionNativeDetail };
  if (typeof detail !== "object" || detail.kind !== "volli.native-binding.v1") {
    throw new SessionRuntimeConflictError("Attachment has invalid native binding metadata");
  }
  return {
    directory: typeof detail.directory === "string" ? detail.directory : null,
    native: { id: reference.id, detail: detail.locator ?? null },
  };
}

function resultKindFor(command: SessionCommand): DeliveryResultKind {
  switch (command.intent.kind) {
    case "executor.start":
      return "executor.start.requested";
    case "executor.stop":
      return "executor.stop.requested";
    case "executor.interrupt":
      return "executor.interrupted";
    case "executor.retry":
      return "executor.retried";
    case "context.compact":
      return "context.compacted";
    case "message.submit":
      return "message.submitted";
    case "model.select":
      return "model.selected";
    case "interaction.resolve":
      return "interaction.resolved";
    /* v8 ignore next 2 -- only adapter-bound intents enter reconciliation. */
    default:
      throw new SessionRuntimeConflictError(`Command ${command.id} is not adapter-bound`);
  }
}

/**
 * The durable id of an attach-failure Attention, deduped by exact string match.
 *
 * `"native"` is a frozen durable value, not a live parameter: it was the profile
 * id of every structured attach before profiles were deleted. The id is the
 * dedupe identity for a repeated failure, so a Session failing to attach twice
 * under two derivations would raise two Attentions for one condition, and a row
 * an older build left on disk would not be recognised as the same one.
 *
 * A successful attach does now clear both kinds — see
 * {@link ATTACH_FAILURE_ATTENTION_KINDS} — but it clears by the id it reads
 * back from the projection, which is exactly why that path never needed the
 * derivation and is no argument for changing it.
 */
const FROZEN_ATTACH_ATTENTION_PROFILE_SEGMENT = "native";

function freshAttachAttentionId(
  sessionId: string,
  adapterId: string,
  kind: AttachFailureAttentionKind,
): string {
  return ["attach", sessionId, adapterId, FROZEN_ATTACH_ATTENTION_PROFILE_SEGMENT, kind]
    .map(encodeURIComponent)
    .join(":");
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

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
