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
 *    and the runtime needs a project, a ticket, a root Thread and a Runtime
 *    Brief. None of those are derivable from a directory, and reading SQLite
 *    here would drag Electron-adjacent state into a module the tests run in
 *    plain Node — so identity arrives through {@link PiAdapterOptions.resolveTicketContext},
 *    which main implements over the same composition the `volli ticket brief`
 *    CLI verb uses. A Session with no ticket has no brief to give, and the
 *    attach fails saying exactly that rather than starting an agent that would
 *    be told nothing about why it exists.
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
  type PiRuntimeHostOptions,
  type RuntimeAttachmentHandle,
  type RuntimeObservation,
  type SettledAssistantMessage,
  type TicketRuntimeSpec,
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
import { errorMessage, type ModelSelection, type SessionNativeReference } from "@volli/shared";
import type { UIMessage } from "ai";

/** The one adapter id. Pi is the structured product's single target executor. */
export const PI_ADAPTER_ID = "pi";

const PI_PROFILE_ID = "native";

/** Pi's npm home and pinned release; both are recorded in `packages/agent-runtime/UPSTREAM.md`. */
const PI_RUNTIME_PACKAGE = "@earendil-works/pi-agent-core";
const PI_RUNTIME_VERSION = "0.84.1";

/**
 * The model this slice runs on, pinned rather than selected.
 *
 * The composer's model picker is still fed by the Runtime Catalog's OpenCode
 * probe, so a submitted `command.model` names a provider Pi has never heard of.
 * Ignoring it and pinning here is the honest reading: one executor, one model,
 * until the picker is Pi's. `openai-codex` is the provider this machine holds
 * OAuth for; Luna is its lightweight coding model at the full 272k context.
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

/** The coding tools this slice loads. Process execution has no containment boundary yet. */
const PI_TOOLS = { tools: ["read", "edit", "write"] } as const;

/**
 * The root Thread id for a Session, and the one place the convention is written.
 *
 * Every transcript observation this Session ever carries — from this adapter or
 * OpenCode's — addresses the same root Thread and main Branch, derived from the
 * Session id. Main's ticket-context resolver mints the same value so the id Pi
 * records in its sidecar metadata is the id the transcript is filed under.
 */
export function piRootThreadId(sessionId: string): string {
  return `thread:${sessionId}:root`;
}

function piMainBranchId(sessionId: string): string {
  return `branch:${sessionId}:main`;
}

/** Everything about a Ticket Session that a directory cannot tell the runtime. */
export interface PiTicketContext {
  projectId: string;
  ticketId: string;
  rootThreadId: string;
  /** The generated Runtime Brief; the runtime prepends it to the first user message. */
  brief: string;
}

export interface PiAdapterOptions {
  /**
   * Directory that owns every attachment's Pi recovery sidecar. Main resolves
   * it from Electron's `userData`; this module stays Electron-free so its tests
   * run in plain Node.
   */
  sessionDataDir: string;
  /** Resolves durable Session identity to the Ticket it runs for; `null` when it runs for none. */
  resolveTicketContext: (sessionId: string) => Promise<PiTicketContext | null>;
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
} as const satisfies Record<
  AttentionObservation["reason"],
  Extract<HarnessObservation, { kind: "attention.raised" }>["attention"]["kind"]
>;

/** The rejection codes a caller can act on, per runtime rejection reason. */
const REJECTION_CODES = {
  "busy-unsupported": "PI_BUSY",
  closed: "PI_ATTACHMENT_CLOSED",
} as const;

/** One in-flight assistant message: the id its deltas address and the parts it has opened. */
interface StreamingMessage {
  id: string;
  /** Projected key order, so a `part.upsert` can state where the key lands. */
  keys: TranscriptDeltaObservation["channel"][];
}

export function createPiNativeAdapter(options: PiAdapterOptions): NativeHarnessAdapter {
  const now = options.now ?? Date.now;
  const create = options.createRuntime ?? createPiAgentRuntime;
  const runtime = create({
    sessionDataDir: options.sessionDataDir,
    ...(options.models === undefined ? {} : { models: options.models }),
  });

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
              detail: "Pi runs under Auto authority inside the worktree and asks for nothing",
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
      const context = await options.resolveTicketContext(spec.sessionId);
      if (context === null) {
        // Thrown, not emitted: the runtime discards this attach's sink when the
        // attach rejects, so the error message is the only channel that
        // survives — and it becomes the `attach_failed` receipt's detail, which
        // is where a user looks.
        throw new Error(
          "Pi runs Ticket Sessions only, and this Session has no ticket to brief it with.",
        );
      }
      const binding = new PiBinding({ spec, sink, context, now });
      binding.bind(await runtime.startTicketSession(binding.ticketSpec()));
      return binding;
    },
  };
}

interface PiBindingOptions {
  spec: NativeAttachmentSpec;
  sink: ObservationSink;
  context: PiTicketContext;
  now: () => number;
}

class PiBinding implements BindingHandle {
  readonly #spec: NativeAttachmentSpec;
  readonly #sink: ObservationSink;
  readonly #context: PiTicketContext;
  readonly #now: () => number;
  readonly #abort = new AbortController();
  readonly #threadId: string;
  readonly #branchId: string;
  #handle: RuntimeAttachmentHandle | null = null;
  #native: SessionNativeReference = { id: null, detail: null };
  #released = false;
  #streaming: StreamingMessage | null = null;
  /** Assistant messages already opened in the current turn; the message id's last segment. */
  #messageSequence = 0;
  /** Transient and synthetic observations carry no native identity, so a counter is the whole of it. */
  #sequence = 0;

  constructor(options: PiBindingOptions) {
    this.#spec = options.spec;
    this.#sink = options.sink;
    this.#context = options.context;
    this.#now = options.now;
    this.#threadId = options.context.rootThreadId;
    this.#branchId = piMainBranchId(options.spec.sessionId);
  }

  get native(): SessionNativeReference {
    return this.#native;
  }

  ticketSpec(): TicketRuntimeSpec {
    return {
      identity: {
        sessionId: this.#spec.sessionId,
        rootThreadId: this.#context.rootThreadId,
        attachmentId: this.#spec.attachmentId,
        projectId: this.#context.projectId,
        ticketId: this.#context.ticketId,
      },
      role: "ticket",
      // The directory the Session Engine PREPARED, which for a worktree ticket
      // is the isolated checkout — never the main one.
      worktreePath: this.#spec.directory,
      venue: "local",
      model: PI_MODEL,
      authority: { mode: "auto" },
      brief: { text: this.#context.brief },
      tools: { tools: [...PI_TOOLS.tools] },
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
      case "executor.interrupt":
        try {
          await handle.interrupt();
          return this.#accepted(command.commandId);
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

  /**
   * Nothing to replay. Pi's history lives in a JSONL sidecar this slice writes
   * and never reads back, so the honest reconciliation is the empty one that
   * leaves the caller's cursor exactly where it was; Session 4 owns reopening.
   */
  async reconcile(cursor: Parameters<BindingHandle["reconcile"]>[0]): Promise<Reconciliation> {
    return { cursor, observations: [], receipts: [] };
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
    // `command.model`, `agent` and `variant` are deliberately dropped: the
    // composer's picker is still OpenCode-fed this slice, so whatever it names
    // is not a provider Pi can reach. The pinned model is the honest answer.
    const text = messageText(command.message);
    if (text.trim().length === 0) {
      return this.#rejected(
        command.commandId,
        "PI_EMPTY_MESSAGE",
        "There was no text in this message to send.",
      );
    }
    try {
      const outcome = await handle.submitUserMessage(text);
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
      this.#messageSequence = 0;
      this.#streaming = null;
      await this.#emit({
        id: `pi:turn:${observation.turnId}:started`,
        kind: "turn.started",
        occurredAt: this.#now(),
        turnId: observation.turnId,
      });
      return;
    }
    // An interrupted turn is a closed turn. What made it stop is already said —
    // by the attention Pi raises for a real failure, or by nothing at all when
    // the user asked for it — and inventing a second story here would only give
    // the two surfaces something to disagree about.
    await this.#withdrawStreaming();
    await this.#emit({
      id: `pi:turn:${observation.turnId}:completed`,
      kind: "turn.completed",
      occurredAt: this.#now(),
      turnId: observation.turnId,
    });
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
    const messageId = this.#streaming?.id ?? this.#openMessage(observation.turnId);
    this.#streaming = null;
    const parts = settledParts(observation.message);
    if (parts.length === 0) {
      // Nothing durable to settle into — a tool-only assistant turn. The
      // transient claim still has to be withdrawn explicitly or it outlives the
      // message it stood for.
      await this.#emitDelta(messageId, { op: "message.remove" });
      return;
    }
    await this.#emit({
      id: `pi:message:${observation.message.entryId}`,
      kind: "transcript.message",
      occurredAt: this.#now(),
      // The only observation that moves the reconcile cursor, and Pi's entry id
      // is exactly what a later resume deduplicates against.
      cursor: { entryId: observation.message.entryId },
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
    });
  }

  #translateAttention(observation: AttentionObservation): Promise<void> {
    // Keyed by reason so a clear cancels the raise it belongs to; the runtime
    // names no id of its own, and the reason is the whole of what it can name.
    const attentionId = `pi:attention:${this.#spec.attachmentId}:${observation.reason}`;
    if (observation.state === "cleared") {
      return this.#emit({
        id: `${attentionId}:cleared:${++this.#sequence}`,
        kind: "attention.cleared",
        occurredAt: this.#now(),
        attentionId,
      });
    }
    return this.#emit({
      id: `${attentionId}:raised:${++this.#sequence}`,
      kind: "attention.raised",
      occurredAt: this.#now(),
      attention: {
        id: attentionId,
        kind: ATTENTION_KINDS[observation.reason],
        detail: observation.message,
        diagnostic: null,
      },
    });
  }

  /** Retire an in-flight message nothing is going to finish. */
  async #withdrawStreaming(): Promise<void> {
    const streaming = this.#streaming;
    if (streaming === null) return;
    this.#streaming = null;
    await this.#emitDelta(streaming.id, { op: "message.remove" });
  }

  #openMessage(turnId: string): string {
    const index = this.#messageSequence;
    this.#messageSequence += 1;
    return `pi:${this.#spec.attachmentId}:${turnId}:${index}`;
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
