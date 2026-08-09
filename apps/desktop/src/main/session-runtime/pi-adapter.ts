/**
 * The Pi-backed Agent Runtime wearing the Session Engine's native-adapter face.
 *
 * This is a desktop-private facade, not a second executor port. `@volli/agent-runtime`
 * already speaks product vocabulary; what it does not speak is the durable
 * Session's own seam — attachments, delivery receipts, transcript observations
 * — so everything here is translation and nothing here is policy. There is one
 * manifest id and one profile because there is one executor: no registry, no
 * catalog, no profile spread to grow into.
 *
 * Three things the two contracts genuinely disagree about, and how they join:
 *
 * 1. **Identity.** `NativeAttachmentSpec` carries a Session and a directory,
 *    and the runtime needs a Role, a project, possibly a Ticket, a root Thread
 *    and a Runtime Brief. None of those are derivable from a directory, and
 *    reading SQLite here would drag Electron-adjacent state into a module the
 *    tests run in plain Node — so identity arrives through
 *    {@link PiAdapterOptions.resolveRuntimeContext}, which main implements over
 *    the same composition the `volli ticket brief` CLI verb uses. A ticketless
 *    Session is a Role, not a missing Ticket: it resolves a project Brief and
 *    attaches. What still fails the attach is a Session with no recorded model
 *    or no Brief to give, rather than starting an agent that would be told
 *    nothing about why it exists.
 *
 * 2. **Message identity.** Pi names a settled message only once it has settled
 *    (`entryId`), while its deltas name only the turn they belong to — but the
 *    Session Engine retires an overlay entry by the *durable* message's own id
 *    (`session-runtime.ts`, `#clearOverlayMessage`), so the transient and the
 *    durable halves have to agree on one id before the first delta is emitted.
 *    So the facade mints that id — attachment, turn, and the message's position
 *    within the turn — and carries Pi's `entryId` where it is actually needed:
 *    on the observation's own identity, which is what dedupes a replay, and on
 *    the reconcile cursor, which is what Session 4 resumes from.
 *
 * 3. **Interrupt.** Aborting the runtime signal is how an attachment *ends* —
 *    Pi's abort listener latches the attachment cancelled and every later
 *    submit is rejected as closed. An interrupted turn is not an ended Session,
 *    and the Session Engine keeps the binding live across one, so
 *    `executor.interrupt` goes to the handle's own `interrupt()` and the
 *    AbortController stays what `release` pulls.
 */

import {
  createPiAgentRuntime,
  type AgentRuntime,
  type AttentionObservation,
  type DeliveryOutcome,
  type ModelSelectionOutcome,
  type PiRuntimeHostOptions,
  type RuntimeAttachmentHandle,
  type RuntimeActivityObservation,
  type RuntimeObservation,
  type RuntimeRecoveryRef,
  type SettledAssistantMessage,
  type SessionRuntimeSpec,
  type TranscriptDeltaObservation,
} from "@volli/agent-runtime";
import type {
  BindingHandle,
  DeliveryReceipt,
  HarnessCommand,
  HarnessObservation,
  NativeAttachmentSpec,
  NativeHarnessAdapter,
  NativeHarnessManifest,
  NativeProbeContext,
  NativeProbeResult,
  ObservationSink,
  Reconciliation,
  ReleaseReason,
  TranscriptDelta,
} from "@volli/session-engine";
import { NativeAttachmentError } from "@volli/session-engine";
import {
  ACTIVITY_METADATA_KEY,
  errorMessage,
  type ModelSelection,
  type SessionNativeDetail,
  type SessionNativeReference,
} from "@volli/shared";
import type { UIMessage } from "ai";

/** The one adapter id. Pi is the structured product's single target executor. */
export const PI_ADAPTER_ID = "pi";

const PI_PROFILE_ID = "native";

/** The one product tool identity for every runtime activity. */
const ACTIVITY_TOOL_NAME = "volli.activity";

/** Pi's npm home and pinned release; both are recorded in `packages/agent-runtime/UPSTREAM.md`. */
const PI_RUNTIME_PACKAGE = "@earendil-works/pi-agent-core";
const PI_RUNTIME_VERSION = "0.84.1";

/**
 * A model literal with exactly one reader left: the probe's declared catalog.
 *
 * It is no longer the model a Ticket Session runs on, and nothing below reads
 * it to decide what to run. The picker is Pi's own now — it reads Model Access
 * ({@link PiRuntimeHost.inspectModelAccess}), the choice it makes is recorded
 * as a durable per-Session selection, and `attach` carries that selection in
 * through {@link PiTicketContext.model}, which main resolves from the Session's
 * projection and refuses to attach without. So what survives here is the single
 * entry `probe` declares in its capability catalog, which the Session Engine
 * records and no product surface consults: a residual pending removal rather
 * than a policy. `openai-codex` is the provider this machine holds OAuth for;
 * Luna is its lightweight coding model at the full 272k context.
 */
export const PI_MODEL: ModelSelection = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-luna",
  reasoningLevel: "medium",
};

const PI_MANIFEST: NativeHarnessManifest = {
  id: PI_ADAPTER_ID,
  displayName: "Pi",
  adapterVersion: "0.0.1",
  profiles: [{ id: PI_PROFILE_ID, label: "Native", transport: "native" }],
};

/** The explicitly contained coding tools this slice loads. */
const PI_TOOLS = { tools: ["read", "edit", "write", "execute"] } as const;

/**
 * The root Thread id for a Session, and the one place the convention is written.
 *
 * Every transcript observation this Session ever carries — from this adapter or
 * OpenCode's — addresses the same root Thread and main Branch, derived from the
 * Session id. Main's runtime-context resolver mints the same value so the id Pi
 * records in its sidecar metadata is the id the transcript is filed under.
 */
export function piRootThreadId(sessionId: string): string {
  return `thread:${sessionId}:root`;
}

function piMainBranchId(sessionId: string): string {
  return `branch:${sessionId}:main`;
}

/** Everything about a Session that a directory cannot tell the runtime. */
interface PiRuntimeContextFields {
  projectId: string;
  rootThreadId: string;
  /** The generated Runtime Brief; the runtime prepends it to the first user message. */
  brief: string;
  /** Durable product policy selected before this attachment starts. */
  model: ModelSelection;
}

/**
 * The Role a Session attaches under, resolved with the identity it implies.
 *
 * Mirrors the runtime's own identity union rather than carrying an optional
 * Ticket: "ticketless" is what a project Session *is*, and a resolver that
 * returned a Ticket Session with a null Ticket would not typecheck here.
 */
export type PiRuntimeContext =
  | (PiRuntimeContextFields & { role: "ticket"; ticketId: string })
  | (PiRuntimeContextFields & { role: "project"; ticketId: null });

export interface PiAdapterOptions {
  /**
   * Directory that owns every attachment's Pi recovery sidecar. Main resolves
   * it from Electron's `userData`; this module stays Electron-free so its tests
   * run in plain Node.
   */
  sessionDataDir: string;
  /** Resolves durable Session identity to the Role it runs under; `null` when it cannot. */
  resolveRuntimeContext: (sessionId: string) => Promise<PiRuntimeContext | null>;
  /** Injectable Pi model collection, for deterministic tests and host-owned credentials. */
  models?: PiRuntimeHostOptions["models"];
  /** Injectable runtime factory. Defaults to the real Pi-backed runtime. */
  createRuntime?: (options: PiRuntimeHostOptions) => AgentRuntime;
  now?: () => number;
}

/** Product attention vocabulary, per runtime reason. */
const ATTENTION_KINDS = {
  auth: "auth_required",
  configuration: "configuration_invalid",
  context: "context_limit_reached",
  "runtime-failure": "adapter_unrecoverable",
  "partial-turn": "partial_turn_interrupted",
} as const satisfies Record<
  AttentionObservation["reason"],
  Extract<HarnessObservation, { kind: "attention.raised" }>["attention"]["kind"]
>;

/** The rejection codes a caller can act on, per runtime rejection reason. */
const REJECTION_CODES = {
  "busy-unsupported": "PI_BUSY",
  closed: "PI_ATTACHMENT_CLOSED",
  "replace-unsupported": "PI_REPLACE_UNSUPPORTED",
  "retry-unavailable": "PI_RETRY_UNAVAILABLE",
} as const satisfies Record<Extract<DeliveryOutcome, { kind: "rejected" }>["reason"], string>;

const MODEL_SELECTION_REJECTION_CODES = {
  "busy-unsupported": "PI_BUSY",
  closed: "PI_ATTACHMENT_CLOSED",
  "model-unavailable": "PI_MODEL_UNAVAILABLE",
  "reasoning-unsupported": "PI_REASONING_UNSUPPORTED",
} as const satisfies Record<Extract<ModelSelectionOutcome, { kind: "rejected" }>["reason"], string>;

/** One in-flight assistant message: the id its deltas address and the parts it has opened. */
interface StreamingMessage {
  id: string;
  /** Projected key order, so a `part.upsert` can state where the key lands. */
  keys: TranscriptDeltaObservation["channel"][];
}

/** A transient activity awaiting its own durable activity message. */
interface StreamingActivity {
  turnId: string;
  messageId: string;
}

function piRecoveryRef(spec: NativeAttachmentSpec): RuntimeRecoveryRef | undefined {
  if (spec.continuity !== "native_resume") return undefined;
  const detail = spec.native?.detail;
  if (
    spec.native === null ||
    detail === null ||
    Array.isArray(detail) ||
    typeof detail !== "object"
  ) {
    throw new Error("Pi recovery metadata is missing or invalid.");
  }
  const record = detail as { readonly [key: string]: SessionNativeDetail };
  if (
    record["runtime"] !== "pi" ||
    typeof record["sessionId"] !== "string" ||
    typeof record["sessionFilePath"] !== "string" ||
    spec.native.id !== record["sessionId"]
  ) {
    throw new Error("Pi recovery metadata does not match the persisted attachment.");
  }
  return {
    runtime: "pi",
    sessionId: record["sessionId"],
    sessionFilePath: record["sessionFilePath"],
  };
}

function recoveryEntryId(cursor: SessionNativeDetail | null): string | null {
  if (cursor === null || Array.isArray(cursor) || typeof cursor !== "object") return null;
  const entryId = (cursor as { readonly [key: string]: SessionNativeDetail })["entryId"];
  if (typeof entryId !== "string") {
    throw new Error("Pi recovery cursor is missing its sidecar entry id.");
  }
  return entryId;
}

function recoveryCursor(entryId: string | undefined): { cursor?: SessionNativeDetail } {
  return entryId === undefined ? {} : { cursor: { entryId } };
}

export interface PiRuntimeHost {
  readonly adapter: NativeHarnessAdapter;
  inspectModelAccess: AgentRuntime["inspectModelAccess"];
}

/** Main-owned singular runtime host; the native adapter remains private migration scaffolding. */
export function createPiRuntimeHost(options: PiAdapterOptions): PiRuntimeHost {
  const now = options.now ?? Date.now;
  const create = options.createRuntime ?? createPiAgentRuntime;
  const runtime = create({
    sessionDataDir: options.sessionDataDir,
    ...(options.models === undefined ? {} : { models: options.models }),
  });

  return {
    adapter: piNativeAdapter(options, runtime, now),
    inspectModelAccess: (input) => runtime.inspectModelAccess(input),
  };
}

/** @deprecated Main should own {@link createPiRuntimeHost}; retained for isolated adapter tests. */
export function createPiNativeAdapter(options: PiAdapterOptions): NativeHarnessAdapter {
  return createPiRuntimeHost(options).adapter;
}

function piNativeAdapter(
  options: PiAdapterOptions,
  runtime: AgentRuntime,
  now: () => number,
): NativeHarnessAdapter {
  return {
    manifest: PI_MANIFEST,

    /**
     * Static, because there is nothing to interrogate: Pi is a library this
     * process already holds, not a binary on a PATH that may be missing, stale
     * or untrusted. Credentials are not probed either — a provider that refuses
     * says so on the turn that needs it, as an attention the Session can act on,
     * rather than as an attach this adapter guessed would fail.
     */
    async probe(context: NativeProbeContext): Promise<NativeProbeResult> {
      if (context.profileId !== PI_PROFILE_ID) {
        return {
          status: "unavailable",
          runtime: null,
          reason: `Unknown Pi profile ${context.profileId}`,
        };
      }
      return {
        status: "available",
        runtime: {
          path: PI_RUNTIME_PACKAGE,
          version: PI_RUNTIME_VERSION,
          fingerprint: `npm:${PI_RUNTIME_PACKAGE}@${PI_RUNTIME_VERSION}`,
        },
        capabilities: {
          features: [
            { id: "message.submit", state: "available", evidence: "declared", detail: null },
            { id: "executor.interrupt", state: "available", evidence: "declared", detail: null },
            {
              id: "interaction.permission",
              state: "unavailable",
              evidence: "declared",
              // One probe answers for every Role, so this cannot name a
              // worktree: a project Session's workspace is the Main checkout.
              detail:
                "Pi runs under Auto authority inside the Session workspace and asks for nothing",
            },
            {
              id: "interaction.question",
              state: "unavailable",
              evidence: "declared",
              detail: "Pi asks no questions in this migration slice",
            },
          ],
          catalog: [
            {
              kind: "model",
              id: `${PI_MODEL.providerId}/${PI_MODEL.modelId}`,
              label: `${PI_MODEL.providerId}/${PI_MODEL.modelId}`,
              state: "available",
              evidence: "declared",
              detail: null,
            },
          ],
        },
      };
    },

    async attach(spec: NativeAttachmentSpec, sink: ObservationSink): Promise<BindingHandle> {
      if (spec.profileId !== PI_PROFILE_ID) throw new Error(`Unknown Pi profile ${spec.profileId}`);
      let recovery: RuntimeRecoveryRef | undefined;
      try {
        recovery = piRecoveryRef(spec);
      } catch (error) {
        throw new NativeAttachmentError(
          errorMessage(error),
          "PI_RECOVERY_FAILED",
          "adapter_unrecoverable",
        );
      }
      const context = await options.resolveRuntimeContext(spec.sessionId);
      if (context === null) {
        // Thrown, not emitted: the runtime discards this attach's sink when the
        // attach rejects, so the error message is the only channel that
        // survives — and it becomes the `attach_failed` receipt's detail, which
        // is where a user looks.
        throw new NativeAttachmentError(
          "Pi requires a Session with a selected model and Runtime Brief.",
          "PI_CONFIGURATION_INVALID",
          "configuration_invalid",
        );
      }
      const binding = new PiBinding({ spec, sink, context, recovery, now });
      try {
        binding.bind(await runtime.startSession(binding.runtimeSpec()));
      } catch (error) {
        throw new NativeAttachmentError(
          errorMessage(error),
          recovery === undefined ? "PI_CONFIGURATION_INVALID" : "PI_RECOVERY_FAILED",
          recovery === undefined ? "configuration_invalid" : "adapter_unrecoverable",
        );
      }
      return binding;
    },
  };
}

interface PiBindingOptions {
  spec: NativeAttachmentSpec;
  sink: ObservationSink;
  context: PiRuntimeContext;
  recovery: RuntimeRecoveryRef | undefined;
  now: () => number;
}

class PiBinding implements BindingHandle {
  readonly #spec: NativeAttachmentSpec;
  readonly #sink: ObservationSink;
  readonly #context: PiRuntimeContext;
  readonly #recovery: RuntimeRecoveryRef | undefined;
  readonly #now: () => number;
  readonly #abort = new AbortController();
  readonly #threadId: string;
  readonly #branchId: string;
  #handle: RuntimeAttachmentHandle | null = null;
  #native: SessionNativeReference = { id: null, detail: null };
  #released = false;
  #streaming: StreamingMessage | null = null;
  #activityOverlays = new Map<string, StreamingActivity>();
  /** Turns that closed before every transient activity removal reached the Session. */
  #closedActivityTurns = new Set<string>();
  /** Assistant overlays already opened in the current turn; the id's last segment. */
  #messageSequence = 0;
  /** Transient and synthetic observations carry no native identity, so a counter is the whole of it. */
  #sequence = 0;

  constructor(options: PiBindingOptions) {
    this.#spec = options.spec;
    this.#sink = options.sink;
    this.#context = options.context;
    this.#recovery = options.recovery;
    this.#now = options.now;
    this.#threadId = options.context.rootThreadId;
    this.#branchId = piMainBranchId(options.spec.sessionId);
  }

  get native(): SessionNativeReference {
    return this.#native;
  }

  runtimeSpec(): SessionRuntimeSpec {
    const context = this.#context;
    const identity = {
      sessionId: this.#spec.sessionId,
      rootThreadId: context.rootThreadId,
      attachmentId: this.#spec.attachmentId,
      projectId: context.projectId,
    };
    return {
      identity:
        context.role === "ticket"
          ? { ...identity, role: "ticket", ticketId: context.ticketId }
          : { ...identity, role: "project", ticketId: null },
      // The directory the Session Engine PREPARED: for a worktree ticket the
      // isolated checkout — never the main one — and for a ticketless Session
      // the project root, which is the only place it was ever going to run.
      workspacePath: this.#spec.directory,
      venue: "local",
      model: this.#context.model,
      authority: { mode: "auto" },
      brief: { text: this.#context.brief },
      tools: { tools: [...PI_TOOLS.tools] },
      ...(this.#recovery === undefined ? {} : { recovery: this.#recovery }),
      signal: this.#abort.signal,
      observer: (observation) => this.#translate(observation),
    };
  }

  /**
   * Adopt the live attachment, and with it the recovery reference.
   *
   * The reference is the whole of what crosses back out of Pi: a runtime tag, a
   * Pi Session id, and the sidecar path Session 4 reopens. No credential, no
   * transport detail, nothing a later reader could mistake for Session truth.
   */
  bind(handle: RuntimeAttachmentHandle): void {
    this.#handle = handle;
    const recovery = handle.recovery;
    if (recovery === undefined) return;
    this.#native = {
      id: recovery.sessionId,
      detail: {
        runtime: recovery.runtime,
        sessionId: recovery.sessionId,
        sessionFilePath: recovery.sessionFilePath,
      },
    };
  }

  async dispatch(command: HarnessCommand): Promise<DeliveryReceipt> {
    const handle = this.#handle;
    if (handle === null || this.#released) {
      return this.#rejected(
        command.commandId,
        "PI_ATTACHMENT_CLOSED",
        "This attachment is closed.",
      );
    }
    switch (command.kind) {
      case "message.submit":
        return this.#submit(handle, command);
      case "model.select":
        try {
          const outcome = await handle.selectModel(command.selection);
          return outcome.kind === "selected"
            ? this.#accepted(command.commandId)
            : this.#rejected(
                command.commandId,
                MODEL_SELECTION_REJECTION_CODES[outcome.reason],
                outcome.message,
              );
        } catch {
          return this.#rejected(
            command.commandId,
            "PI_MODEL_SELECTION_FAILED",
            "The model policy could not be applied. Retry.",
          );
        }
      case "executor.interrupt":
        try {
          await handle.interrupt();
          return this.#accepted(command.commandId);
        } catch (error) {
          return this.#unknown(command.commandId, error);
        }
      case "executor.retry":
        try {
          const outcome = await handle.retry(command.commandId);
          return outcome.kind === "delivered"
            ? this.#accepted(command.commandId)
            : this.#rejected(command.commandId, REJECTION_CODES[outcome.reason], outcome.message);
        } catch (error) {
          return this.#unknown(command.commandId, error);
        }
      case "interaction.resolve":
        return this.#rejected(
          command.commandId,
          "PI_INTERACTION_UNSUPPORTED",
          "Pi raises no interactions in this migration slice, so there is none to resolve.",
        );
    }
  }

  async reconcile(cursor: Parameters<BindingHandle["reconcile"]>[0]): Promise<Reconciliation> {
    const handle = this.#handle;
    if (handle === null || this.#released) {
      return { cursor, observations: [], receipts: [] };
    }
    const entryId = recoveryEntryId(cursor);
    const replay = await handle.reconcile(entryId);
    return {
      cursor: replay.cursor === null ? cursor : { entryId: replay.cursor },
      observations: replay.observations.flatMap((observation) =>
        this.#durableObservations(observation),
      ),
      receipts: (replay.receipts ?? []).map(({ commandId, acceptedAt }) => ({
        commandId,
        status: "accepted",
        acceptedAt,
        native: this.#native,
      })),
    };
  }

  /**
   * End the live attachment, never the Session.
   *
   * The sink closes first: the Session Engine writes `attachment.closed` itself
   * once this resolves, and Pi's own close observation would otherwise say the
   * same thing a second time in the other direction.
   */
  async release(_reason: ReleaseReason): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    this.#abort.abort();
    await this.#handle?.close();
  }

  async #submit(
    handle: RuntimeAttachmentHandle,
    command: Extract<HarnessCommand, { kind: "message.submit" }>,
  ): Promise<DeliveryReceipt> {
    // `command.model`, `agent` and `variant` go nowhere, and nothing is lost
    // by that. They are contract scaffolding no Volli surface fills — the chat
    // client's `message.submit` carries a message and a delivery, so the
    // runtime hands all three down as `null` — and a per-message override is
    // not this product's model semantics in the first place. A Session's model
    // is durable: chosen through `model.select`, and applied at attach from
    // the Session's own projected selection.
    const text = messageText(command.message);
    if (text.trim().length === 0) {
      return this.#rejected(
        command.commandId,
        "PI_EMPTY_MESSAGE",
        "There was no text in this message to send.",
      );
    }
    if (command.delivery === "replace") {
      return this.#rejected(
        command.commandId,
        "PI_REPLACE_UNSUPPORTED",
        "Pi does not support replacing the active turn.",
      );
    }
    try {
      const outcome = await handle.submitUserMessage(text, command.delivery, command.commandId);
      return outcome.kind === "delivered"
        ? this.#accepted(command.commandId)
        : this.#rejected(command.commandId, REJECTION_CODES[outcome.reason], outcome.message);
    } catch (error) {
      // The prompt reached Pi and something after it failed. "Unknown" is the
      // only truthful receipt: the turn may well have run.
      return this.#unknown(command.commandId, error);
    }
  }

  #accepted(commandId: string): DeliveryReceipt {
    return { commandId, status: "accepted", acceptedAt: this.#now(), native: this.#native };
  }

  #rejected(commandId: string, code: string, detail: string): DeliveryReceipt {
    return { commandId, status: "rejected", code, detail, native: this.#native };
  }

  #unknown(commandId: string, error: unknown): DeliveryReceipt {
    return { commandId, status: "unknown", detail: errorMessage(error), native: this.#native };
  }

  #translate(observation: RuntimeObservation): Promise<void> {
    // A released binding has no sink to speak into, and Pi's own close
    // observation lands here on the way out of `release`.
    if (this.#released) return Promise.resolve();
    switch (observation.kind) {
      case "attachment":
        return this.#translateAttachment(observation);
      case "turn":
        return this.#translateTurn(observation);
      case "delta":
        return this.#translateDelta(observation);
      case "message-settled":
        return this.#translateSettled(observation);
      case "activity":
        return this.#translateActivity(observation);
      case "attention":
        return this.#translateAttention(observation);
    }
  }

  async #translateAttachment(
    observation: Extract<RuntimeObservation, { kind: "attachment" }>,
  ): Promise<void> {
    // Nothing before the handle exists reaches the Session: `started` is the
    // Session Engine's own `attachment.opened` said twice, and a pre-handle
    // `failed` is the rejection `attach` is about to throw.
    if (this.#handle === null) return;
    if (observation.state === "failed") {
      await this.#emit({
        id: `pi:attachment:${this.#spec.attachmentId}:failed:${++this.#sequence}`,
        kind: "attachment.failed",
        occurredAt: this.#now(),
        detail: observation.failure?.message ?? null,
      });
      return;
    }
    if (observation.state === "closed") {
      await this.#emit({
        id: `pi:attachment:${this.#spec.attachmentId}:closed`,
        kind: "attachment.closed",
        occurredAt: this.#now(),
        outcome: "completed",
      });
    }
  }

  async #translateTurn(observation: Extract<RuntimeObservation, { kind: "turn" }>): Promise<void> {
    if (observation.state === "started") {
      await this.#retryClosedActivityWithdrawals();
      this.#messageSequence = 0;
      this.#streaming = null;
      await this.#emit(this.#turnObservation(observation));
      return;
    }
    // An interrupted turn is a closed turn. What made it stop is already said —
    // by the attention Pi raises for a real failure, or by nothing at all when
    // the user asked for it — and inventing a second story here would only give
    // the two surfaces something to disagree about.
    this.#closedActivityTurns.add(observation.turnId);
    await this.#withdrawStreaming();
    await this.#retryClosedActivityWithdrawals();
    await this.#emit(this.#turnObservation(observation));
  }

  /**
   * Grow the in-flight message, opening it on its first delta.
   *
   * Reasoning is carried as the overlay's own reasoning part rather than
   * dropped: it is text-bearing, it folds and appends exactly like assistant
   * text, and the transcript already knows how to draw it. Nothing new is
   * invented for it here — the richer reasoning vocabulary is Session 3's.
   */
  async #translateDelta(observation: TranscriptDeltaObservation): Promise<void> {
    let streaming = this.#streaming;
    if (streaming === null) {
      streaming = { id: this.#openMessage(observation.turnId), keys: [] };
      this.#streaming = streaming;
      await this.#emitDelta(streaming.id, {
        op: "reset",
        message: { id: streaming.id, role: "assistant", parts: [] },
      });
    }
    const key = observation.channel;
    if (streaming.keys.includes(key)) {
      await this.#emitDelta(streaming.id, { op: "part.append", key, text: observation.text });
      return;
    }
    streaming.keys.push(key);
    await this.#emitDelta(streaming.id, {
      op: "part.upsert",
      key,
      index: streaming.keys.length - 1,
      part: streamingPart(key, observation.text),
    });
  }

  async #translateSettled(
    observation: Extract<RuntimeObservation, { kind: "message-settled" }>,
  ): Promise<void> {
    const streamingId = this.#streaming?.id;
    this.#streaming = null;
    const settled = this.#settledObservation(observation);
    if (settled === null) {
      // Nothing durable to settle into — a tool-only assistant turn. The
      // transient claim still has to be withdrawn explicitly or it outlives the
      // message it stood for.
      if (streamingId !== undefined) {
        await this.#emitDelta(streamingId, { op: "message.remove" });
      }
      return;
    }
    if (streamingId !== undefined && streamingId !== settled.message.id) {
      await this.#emitDelta(streamingId, { op: "message.remove" });
    }
    await this.#emit(settled);
  }

  /**
   * Activity is a standalone assistant message while it runs, then settles to
   * that same id. The shared descriptor is the only native-specific context
   * the renderer needs; the SDK tool name stays product-owned.
   */
  async #translateActivity(observation: RuntimeActivityObservation): Promise<void> {
    const messageId = this.#activityMessageId(observation.turnId, observation.activityId);
    if (observation.state === "started" || observation.state === "progress") {
      if (!this.#activityOverlays.has(messageId)) {
        await this.#emitDelta(messageId, {
          op: "reset",
          message: { id: messageId, role: "assistant", parts: [] },
        });
        this.#activityOverlays.set(messageId, { turnId: observation.turnId, messageId });
      }
      await this.#emitDelta(messageId, {
        op: "part.upsert",
        key: activityPartKey(observation.activityId),
        index: 0,
        part: activityPart(observation),
      });
      return;
    }

    await this.#emit(this.#activityObservation(observation));
    this.#activityOverlays.delete(messageId);
  }

  #translateAttention(observation: AttentionObservation): Promise<void> {
    return this.#emit(this.#attentionObservation(observation));
  }

  #durableObservations(observation: RuntimeObservation): HarnessObservation[] {
    switch (observation.kind) {
      case "turn":
        return [this.#turnObservation(observation)];
      case "message-settled": {
        const settled = this.#settledObservation(observation);
        return settled === null ? [] : [settled];
      }
      case "activity":
        return observation.state === "started" || observation.state === "progress"
          ? []
          : [this.#activityObservation(observation)];
      case "attention":
        return [this.#attentionObservation(observation)];
      case "attachment":
      case "delta":
        return [];
    }
  }

  #turnObservation(
    observation: Extract<RuntimeObservation, { kind: "turn" }>,
  ): Extract<HarnessObservation, { kind: "turn.started" | "turn.completed" | "turn.interrupted" }> {
    return {
      id: `pi:turn:${observation.turnId}:${observation.state}`,
      kind:
        observation.state === "started"
          ? "turn.started"
          : observation.state === "interrupted"
            ? "turn.interrupted"
            : "turn.completed",
      occurredAt: observation.occurredAt ?? this.#now(),
      ...recoveryCursor(observation.recoveryCursor),
      turnId: observation.turnId,
    };
  }

  #settledObservation(
    observation: Extract<RuntimeObservation, { kind: "message-settled" }>,
  ): Extract<HarnessObservation, { kind: "transcript.message" }> | null {
    const parts = settledParts(observation.message);
    if (parts.length === 0) return null;
    const messageId = `pi:${this.#spec.attachmentId}:entry:${observation.message.entryId}`;
    return {
      id: `pi:message:${observation.message.entryId}`,
      kind: "transcript.message",
      occurredAt: observation.occurredAt ?? this.#now(),
      ...recoveryCursor(observation.recoveryCursor),
      threadId: this.#threadId,
      branchId: this.#branchId,
      attemptId: `attempt:${messageId}`,
      turnId: observation.turnId,
      message: {
        id: messageId,
        role: "assistant",
        parts,
        ...messageMetadata(observation.message),
      },
    };
  }

  #activityObservation(
    observation: RuntimeActivityObservation,
  ): Extract<HarnessObservation, { kind: "transcript.message" }> {
    const messageId = this.#activityMessageId(observation.turnId, observation.activityId);
    return {
      id: `pi:activity:${this.#spec.attachmentId}:${observation.turnId}:${observation.activityId}:${observation.state}`,
      kind: "transcript.message",
      occurredAt: observation.occurredAt ?? this.#now(),
      ...recoveryCursor(observation.recoveryCursor),
      threadId: this.#threadId,
      branchId: this.#branchId,
      attemptId: `attempt:${messageId}`,
      turnId: observation.turnId,
      message: {
        id: messageId,
        role: "assistant",
        parts: [activityPart(observation)],
      },
    };
  }

  #attentionObservation(
    observation: AttentionObservation,
  ): Extract<HarnessObservation, { kind: "attention.raised" | "attention.cleared" }> {
    const attentionId = `pi:attention:${this.#spec.attachmentId}:${observation.reason}`;
    const eventIdentity = observation.recoveryCursor ?? `live:${++this.#sequence}`;
    if (observation.state === "cleared") {
      return {
        id: `${attentionId}:cleared:${eventIdentity}`,
        kind: "attention.cleared",
        occurredAt: observation.occurredAt ?? this.#now(),
        ...recoveryCursor(observation.recoveryCursor),
        attentionId,
      };
    }
    return {
      id: `${attentionId}:raised:${eventIdentity}`,
      kind: "attention.raised",
      occurredAt: observation.occurredAt ?? this.#now(),
      ...recoveryCursor(observation.recoveryCursor),
      attention: {
        id: attentionId,
        kind: ATTENTION_KINDS[observation.reason],
        detail: observation.message,
        diagnostic: null,
      },
    };
  }

  /** Retire an in-flight message nothing is going to finish. */
  async #withdrawStreaming(): Promise<void> {
    const streaming = this.#streaming;
    if (streaming === null) return;
    this.#streaming = null;
    await this.#emitDelta(streaming.id, { op: "message.remove" });
  }

  /**
   * Retry only overlays from a turn Pi has closed. A rejected sink write leaves
   * the row tracked, so the next lifecycle edge can retire it without deleting
   * state before the Session observed the removal.
   */
  async #retryClosedActivityWithdrawals(): Promise<void> {
    const active = [...this.#activityOverlays.values()].filter((activity) =>
      this.#closedActivityTurns.has(activity.turnId),
    );
    for (const activity of active) {
      await this.#emitDelta(activity.messageId, { op: "message.remove" });
      this.#activityOverlays.delete(activity.messageId);
    }
    for (const turnId of this.#closedActivityTurns) {
      if (![...this.#activityOverlays.values()].some((activity) => activity.turnId === turnId)) {
        this.#closedActivityTurns.delete(turnId);
      }
    }
  }

  #openMessage(turnId: string): string {
    const index = this.#messageSequence;
    this.#messageSequence += 1;
    return `pi:${this.#spec.attachmentId}:${turnId}:${index}`;
  }

  #activityMessageId(turnId: string, activityId: string): string {
    return `pi:${this.#spec.attachmentId}:${turnId}:activity:${activityId}`;
  }

  #emitDelta(messageId: string, delta: TranscriptDelta): Promise<void> {
    return this.#emit({
      id: `pi:delta:${this.#spec.attachmentId}:${++this.#sequence}`,
      kind: "transcript.delta",
      occurredAt: this.#now(),
      threadId: this.#threadId,
      branchId: this.#branchId,
      attemptId: `attempt:${messageId}`,
      turnId: null,
      messageId,
      delta,
    });
  }

  #emit(observation: HarnessObservation): Promise<void> {
    if (this.#released) return Promise.resolve();
    return this.#sink.emit(observation);
  }
}

type TranscriptPart = UIMessage["parts"][number];
type DynamicToolPart = Extract<TranscriptPart, { type: "dynamic-tool" }>;
type ToolMetadata = NonNullable<DynamicToolPart["toolMetadata"]>;

function activityPartKey(activityId: string): string {
  return `activity:${activityId}`;
}

function activityPart(observation: RuntimeActivityObservation): DynamicToolPart {
  const base = {
    type: "dynamic-tool" as const,
    toolName: ACTIVITY_TOOL_NAME,
    toolCallId: observation.activityId,
    toolMetadata: { [ACTIVITY_METADATA_KEY]: observation.descriptor } as ToolMetadata,
  };
  switch (observation.state) {
    case "started":
      return { ...base, state: "input-available", input: observation.input };
    case "progress":
      return {
        ...base,
        state: "output-available",
        input: observation.input,
        output: observation.output,
        preliminary: true,
      };
    case "completed":
      return {
        ...base,
        state: "output-available",
        input: observation.input,
        output: observation.output,
      };
    case "failed":
      return {
        ...base,
        state: "output-error",
        input: observation.input,
        errorText: observation.error ?? "Activity failed.",
      };
  }
}

function streamingPart(
  channel: TranscriptDeltaObservation["channel"],
  text: string,
): TranscriptPart {
  return channel === "reasoning"
    ? { type: "reasoning", text, state: "streaming" }
    : { type: "text", text, state: "streaming" };
}

function settledParts(message: SettledAssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  // Reasoning first: it is what the model did before it spoke, and the
  // transcript reads it that way.
  if (message.reasoning !== undefined && message.reasoning.length > 0) {
    parts.push({ type: "reasoning", text: message.reasoning, state: "done" });
  }
  if (message.text.length > 0) parts.push({ type: "text", text: message.text, state: "done" });
  return parts;
}

/**
 * The model and cost a settled message was produced under, in the shape
 * OpenCode's adapter already writes so a consumer reads one shape from both.
 */
function messageMetadata(message: SettledAssistantMessage): { metadata?: unknown } {
  const usage = message.usage;
  const tokens =
    usage === undefined || (usage.inputTokens === undefined && usage.outputTokens === undefined)
      ? null
      : {
          input: usage.inputTokens ?? null,
          output: usage.outputTokens ?? null,
          reasoning: null,
          cacheRead: null,
          cacheWrite: null,
        };
  const cost = usage?.costUsd ?? null;
  if (message.model === undefined && cost === null && tokens === null) return {};
  return {
    metadata: {
      providerId: message.model?.providerId ?? null,
      modelId: message.model?.modelId ?? null,
      cost,
      tokens,
    },
  };
}

/** Pi takes one string; a `UIMessage` may carry several text parts. */
function messageText(message: UIMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
}
