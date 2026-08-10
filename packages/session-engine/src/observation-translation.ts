/**
 * Turning one {@link RuntimeObservation} into the Session facts it stands for.
 *
 * The executor says what happened; this decides what is written down. That
 * split is why the code lives here rather than beside the runtime that produces
 * the observation: a durable id, a transcript address and the rule about which
 * halves of a message are transient are all Session concerns, and an executor
 * that minted them would be deciding the shape of history it is merely
 * reporting into.
 *
 * There are two translations, and merging them is a mistake this file exists to
 * prevent. {@link RuntimeObservationTranslator.translate} is the live path, and
 * it carries streaming state — an in-flight message, the overlays open in the
 * current turn. {@link RuntimeObservationTranslator.replay} is the cold path,
 * used when reconciling an executor's own history, and it touches none of that
 * state: `reconcile` is public and is not gated on the binding being idle, so a
 * replayed `turn.started` running through the live path would reset the message
 * counter mid-turn, re-mint an id a live message already holds, and publish a
 * `reset` over text the user is watching arrive.
 *
 * **Durable ids here are frozen.** They are re-derived from live data on every
 * relaunch — a rehydrating attachment reconciles from a null cursor and replays
 * all of history — and deduped by exact string match on a primary key. A changed
 * derivation does not fail; it inserts a second copy of every historical fact.
 * The namespace they are minted under belongs to whoever's events they are,
 * which is why it arrives from the adapter rather than being written here.
 */

import type {
  AttentionObservation,
  RuntimeActivityObservation,
  RuntimeObservation,
  SessionInteraction,
  SessionInteractionResolution,
  SessionNativeDetail,
  SettledAssistantMessage,
  TranscriptDeltaObservation,
} from "@volli/shared";
import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import type { UIMessage } from "ai";
import type { TranscriptDelta } from "./transcript-overlay";

/**
 * The root Thread and main Branch every fact in one Session is filed under, and
 * the one place either convention is written.
 *
 * The root Thread id is not only a transcript address: the executor records it
 * in its own recovery metadata and **throws** on recovery when the value it
 * finds does not match the one it was handed. Two derivations of this string
 * would not corrupt a digest — they would fail every existing Session's attach.
 */
export function sessionRootThreadId(sessionId: string): string {
  return `thread:${sessionId}:root`;
}

export function sessionMainBranchId(sessionId: string): string {
  return `branch:${sessionId}:main`;
}

interface TranslatedObservationBase {
  /** Stable native event identity; repeats must retain the same id and content. */
  id: string;
  occurredAt: number;
  cursor?: SessionNativeDetail | null;
}

/**
 * The envelope for a fact that is never made durable, and deliberately not
 * {@link TranslatedObservationBase}.
 *
 * The base carries `cursor`, and the runtime advances the reconcile cursor for
 * any observation that has one. A transient delta that moved it would make a
 * later reconcile ask the provider for events *after* content this Session
 * never wrote down — so the arm has no cursor to advance, and the runtime's
 * handling of it returns before the advance.
 */
interface TransientObservationBase {
  id: string;
  occurredAt: number;
}

/** What one runtime observation becomes: a Session fact, or a view of one. */
export type TranslatedObservation =
  | (TranslatedObservationBase & {
      /**
       * The native binding ended after it was already attached.
       *
       * Only `completed`, because that is all a translation can honestly say: a
       * runtime reports that its attachment closed and not how the work inside
       * it went. The durable event kind carries the other two outcomes — a
       * failure arrives as {@link TranslatedObservation} `attachment.failed`,
       * and an interruption is recorded by whoever asked for it.
       */
      kind: "attachment.closed";
      outcome: "completed";
    })
  | (TranslatedObservationBase & {
      /** Native failure after attachment; it closes the durable binding as failed. */
      kind: "attachment.failed";
      detail: string | null;
    })
  | (TranslatedObservationBase & {
      /** The durable record: a message as it stands at a settle point. */
      kind: "transcript.message";
      threadId: string;
      branchId: string;
      attemptId: string;
      turnId: string | null;
      message: UIMessage;
    })
  | (TransientObservationBase & {
      /**
       * A message mid-word. View state, not a Session fact: it is folded into an
       * in-memory overlay and published to live subscribers, and nothing about
       * it is written down. The durable record of the same message arrives as
       * `transcript.message` when it settles.
       */
      kind: "transcript.delta";
      threadId: string;
      branchId: string;
      attemptId: string;
      turnId: string | null;
      messageId: string;
      delta: TranscriptDelta;
    })
  | (TranslatedObservationBase & { kind: "turn.started"; turnId: string })
  | (TranslatedObservationBase & { kind: "turn.completed"; turnId: string })
  | (TranslatedObservationBase & { kind: "turn.interrupted"; turnId: string })
  /**
   * The Session's authority refused a call. The executor reports it rather than
   * minting it: only the runtime sees the call, and only the Session Engine owns
   * the attachment the fact belongs to.
   */
  | (TranslatedObservationBase & {
      kind: "authority.denied";
      turnId: string | null;
      tool: string;
      cause: string;
      reason: string;
    })
  | (TranslatedObservationBase & {
      kind: "interaction.opened";
      interaction: Omit<SessionInteraction, "attachmentId">;
    })
  | (TranslatedObservationBase & {
      kind: "interaction.resolved";
      interactionId: string;
      resolution: SessionInteractionResolution;
    })
  | (TranslatedObservationBase & {
      kind: "attention.raised";
      attention: {
        id: string;
        kind:
          | "auth_required"
          | "configuration_invalid"
          | "context_limit_reached"
          | "partial_turn_interrupted"
          | "adapter_unrecoverable";
        detail: string | null;
        diagnostic: SessionNativeDetail | null;
      };
    })
  | (TranslatedObservationBase & { kind: "attention.cleared"; attentionId: string });

/** Resolves only once the fact's durable half has committed. */
export type TranslatedObservationSink = (observation: TranslatedObservation) => Promise<void>;

/** Product attention vocabulary, per runtime reason. */
const ATTENTION_KINDS = {
  auth: "auth_required",
  configuration: "configuration_invalid",
  context: "context_limit_reached",
  "runtime-failure": "adapter_unrecoverable",
  "partial-turn": "partial_turn_interrupted",
} as const satisfies Record<
  AttentionObservation["reason"],
  Extract<TranslatedObservation, { kind: "attention.raised" }>["attention"]["kind"]
>;

/** The one product tool identity for every runtime activity. */
const ACTIVITY_TOOL_NAME = "volli.activity";

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

export interface ObservationTranslationSpec {
  /**
   * The leading segment of every durable id this mints — the `pi:` in
   * `pi:turn:…`. Frozen per executor, and supplied by it: the ids belong to
   * whoever's events they are.
   */
  namespace: string;
  sessionId: string;
  attachmentId: string;
  /** Only ever read for a fact the executor did not timestamp itself. */
  now: () => number;
}

/**
 * One attachment's translation, and the state it needs to do it.
 *
 * The lifetime is one attach, which is what makes the counters correct. It is
 * held by the observation sink handed to the executor rather than by the
 * Session's binding record: the binding record is dropped the moment an
 * attachment closes or fails, while an executor may still be draining
 * observations behind that. A translator that died with the binding record
 * would restart `#sequence` at zero for anything still arriving, re-mint an id
 * an earlier fact already holds, and the ledger would reject the repeat as a
 * conflict. Held here, a late observation translates against live counters and
 * is recorded like any other.
 */
export class RuntimeObservationTranslator {
  readonly #namespace: string;
  readonly #attachmentId: string;
  readonly #threadId: string;
  readonly #branchId: string;
  readonly #now: () => number;
  #streaming: StreamingMessage | null = null;
  #activityOverlays = new Map<string, StreamingActivity>();
  /** Turns that closed before every transient activity removal reached the Session. */
  #closedActivityTurns = new Set<string>();
  /** Assistant overlays already opened in the current turn; the id's last segment. */
  #messageSequence = 0;
  /**
   * Transient and synthetic observations carry no native identity, so a counter
   * is the whole of it.
   *
   * **A fresh translator restarts this at zero, and three durable id families
   * are minted from it** — `…:authority:<attachment>:<n>`,
   * `…:attachment:<attachment>:failed:<n>`, and the `live:<n>` fallback an
   * attention event takes when the executor offers no `recoveryCursor`. Two
   * translators over one attachment therefore re-mint one id for two different
   * facts, and the ledger's response to that is not a duplicate but a throw:
   * `was already recorded with different evidence`, raised back through the
   * executor's own observer. For a refusal that is the exact ordering
   * {@link RuntimeObservationTranslator.#translateAuthority} exists to prevent —
   * the model told, the ledger silent.
   *
   * What contains it, and what does not:
   *
   * - **Within one process, nothing restarts the counter.** A translator's
   *   lifetime is one attach; the binding record is only ever dropped once the
   *   attachment is closed or failed, and `#bindingForAttachment` rehydrates
   *   only on a miss. So one open attachment has exactly one translator.
   * - **Across a relaunch it is not contained for the structured executor.**
   *   The boot sweep (`boot-recovery.ts`) retires stale open attachments, but
   *   deliberately skips the structured adapter so it can rehydrate from its own
   *   sidecar — which is the adapter that mints these ids. A rehydrated
   *   attachment translates on a counter that starts again at zero.
   * - **Two of the three families cannot collide anyway.** `attachment.failed`
   *   closes the attachment, so no rehydrate can follow the run that wrote one;
   *   and the runtime stamps every attention marker with its sidecar entry id,
   *   so the `live:<n>` fallback has no producer today.
   *
   * That leaves refusals, whose numbering depends on how many transient deltas
   * preceded them in each run. Do not narrow the containment above without
   * replacing it: the fix is a per-attachment id that survives a relaunch —
   * durable high-water mark or executor-supplied identity — not a longer counter.
   */
  #sequence = 0;

  constructor(spec: ObservationTranslationSpec) {
    this.#namespace = spec.namespace;
    this.#attachmentId = spec.attachmentId;
    this.#threadId = sessionRootThreadId(spec.sessionId);
    this.#branchId = sessionMainBranchId(spec.sessionId);
    this.#now = spec.now;
  }

  /**
   * The live path: what an attachment is saying as it says it.
   *
   * One observation fans out to several facts — a delta opens a message before
   * it grows it, a turn ending retires whatever it left unfinished — so this
   * emits rather than returns. Each emission is awaited, and the state around it
   * is deliberately updated on the far side of a rejected write: an overlay
   * whose removal never reached the Session stays tracked, so the next
   * lifecycle edge can retire it.
   */
  translate(observation: RuntimeObservation, emit: TranslatedObservationSink): Promise<void> {
    switch (observation.kind) {
      case "attachment":
        return this.#translateAttachment(observation, emit);
      case "turn":
        return this.#translateTurn(observation, emit);
      case "delta":
        return this.#translateDelta(observation, emit);
      case "message-settled":
        return this.#translateSettled(observation, emit);
      case "activity":
        return this.#translateActivity(observation, emit);
      case "authority":
        return this.#translateAuthority(observation, emit);
      case "attention":
        return emit(this.#attentionObservation(observation));
      case "interaction":
        return emit(this.#interactionObservation(observation));
    }
  }

  /**
   * The cold path: an executor's own history, re-offered after a restart.
   *
   * Durable facts only, and none of the *streaming* state is read or written —
   * see this module's header for what merging the two paths would break. The id
   * counter is the one deliberate exception, and the distinction is worth
   * keeping straight: it is not streaming state, it is a last-resort identity
   * for facts that carry none of their own, and both paths have always shared
   * one.
   *
   * What makes a fact seen live and again on replay land under the same id is
   * its `recoveryCursor`, never the counter — the counter is only reached when
   * a fact has no cursor, and a fact with no cursor is one the executor's
   * history cannot offer back. Sharing it is therefore about *collision*, not
   * agreement: a replay-side counter starting at zero would hand `live:1` to a
   * second, different fact, and the ledger dedupes by exact string match.
   *
   * `started` and `progress` activity is dropped here on purpose. It is the only
   * thing stopping a replay from opening transient overlays for tool calls that
   * finished days ago.
   */
  replay(observation: RuntimeObservation): TranslatedObservation[] {
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
      case "interaction":
        return [this.#interactionObservation(observation)];
      case "attachment":
      case "delta":
        return [];
      // A refusal never lands in an executor's own recovery history: it is
      // committed through the live observer only, because the durable fact
      // belongs to the Session's ledger rather than to the executor's replay
      // log. Reconcile therefore never actually offers one — the case exists so
      // this switch stays exhaustive against the type it is honestly wider than.
      case "authority":
        return [];
    }
  }

  /**
   * A refusal reaches the Session before it reaches the model.
   *
   * `observer` resolves only at the consumer boundary, so a refusal that
   * reached the sink and then dropped would leave the model told and the ledger
   * silent — the one ordering this must never produce.
   */
  async #translateAuthority(
    observation: Extract<RuntimeObservation, { kind: "authority" }>,
    emit: TranslatedObservationSink,
  ): Promise<void> {
    await emit({
      id: `${this.#namespace}:authority:${this.#attachmentId}:${++this.#sequence}`,
      kind: "authority.denied",
      occurredAt: observation.occurredAt ?? this.#now(),
      turnId: observation.turnId,
      tool: observation.tool,
      cause: observation.cause,
      reason: observation.reason,
    });
  }

  async #translateAttachment(
    observation: Extract<RuntimeObservation, { kind: "attachment" }>,
    emit: TranslatedObservationSink,
  ): Promise<void> {
    if (observation.state === "failed") {
      await emit({
        id: `${this.#namespace}:attachment:${this.#attachmentId}:failed:${++this.#sequence}`,
        kind: "attachment.failed",
        occurredAt: this.#now(),
        detail: observation.failure?.message ?? null,
      });
      return;
    }
    // `started` and `recovered` say nothing the Session does not already know:
    // the Engine writes its own `attachment.opened`, and a recovery it asked for
    // is not news.
    if (observation.state === "closed") {
      await emit({
        id: `${this.#namespace}:attachment:${this.#attachmentId}:closed`,
        kind: "attachment.closed",
        occurredAt: this.#now(),
        outcome: "completed",
      });
    }
  }

  async #translateTurn(
    observation: Extract<RuntimeObservation, { kind: "turn" }>,
    emit: TranslatedObservationSink,
  ): Promise<void> {
    if (observation.state === "started") {
      await this.#retryClosedActivityWithdrawals(emit);
      this.#messageSequence = 0;
      this.#streaming = null;
      await emit(this.#turnObservation(observation));
      return;
    }
    // An interrupted turn is a closed turn. What made it stop is already said —
    // by the attention the executor raises for a real failure, or by nothing at
    // all when the user asked for it — and inventing a second story here would
    // only give the two surfaces something to disagree about.
    this.#closedActivityTurns.add(observation.turnId);
    await this.#withdrawStreaming(emit);
    await this.#retryClosedActivityWithdrawals(emit);
    await emit(this.#turnObservation(observation));
  }

  /**
   * Grow the in-flight message, opening it on its first delta.
   *
   * Reasoning is carried as the overlay's own reasoning part rather than
   * dropped: it is text-bearing, it folds and appends exactly like assistant
   * text, and the transcript already knows how to draw it.
   */
  async #translateDelta(
    observation: TranscriptDeltaObservation,
    emit: TranslatedObservationSink,
  ): Promise<void> {
    let streaming = this.#streaming;
    if (streaming === null) {
      streaming = { id: this.#openMessage(observation.turnId), keys: [] };
      this.#streaming = streaming;
      await this.#emitDelta(emit, streaming.id, {
        op: "reset",
        message: { id: streaming.id, role: "assistant", parts: [] },
      });
    }
    const key = observation.channel;
    if (streaming.keys.includes(key)) {
      await this.#emitDelta(emit, streaming.id, {
        op: "part.append",
        key,
        text: observation.text,
      });
      return;
    }
    streaming.keys.push(key);
    await this.#emitDelta(emit, streaming.id, {
      op: "part.upsert",
      key,
      index: streaming.keys.length - 1,
      part: streamingPart(key, observation.text),
    });
  }

  async #translateSettled(
    observation: Extract<RuntimeObservation, { kind: "message-settled" }>,
    emit: TranslatedObservationSink,
  ): Promise<void> {
    const streamingId = this.#streaming?.id;
    this.#streaming = null;
    const settled = this.#settledObservation(observation);
    if (settled === null) {
      // Nothing durable to settle into — a tool-only assistant turn. The
      // transient claim still has to be withdrawn explicitly or it outlives the
      // message it stood for.
      if (streamingId !== undefined) {
        await this.#emitDelta(emit, streamingId, { op: "message.remove" });
      }
      return;
    }
    if (streamingId !== undefined && streamingId !== settled.message.id) {
      await this.#emitDelta(emit, streamingId, { op: "message.remove" });
    }
    await emit(settled);
  }

  /**
   * Activity is a standalone assistant message while it runs, then settles to
   * that same id. The shared descriptor is the only executor-specific context
   * the renderer needs; the tool name stays product-owned.
   */
  async #translateActivity(
    observation: RuntimeActivityObservation,
    emit: TranslatedObservationSink,
  ): Promise<void> {
    const messageId = this.#activityMessageId(observation.turnId, observation.activityId);
    if (observation.state === "started" || observation.state === "progress") {
      if (!this.#activityOverlays.has(messageId)) {
        await this.#emitDelta(emit, messageId, {
          op: "reset",
          message: { id: messageId, role: "assistant", parts: [] },
        });
        this.#activityOverlays.set(messageId, { turnId: observation.turnId, messageId });
      }
      await this.#emitDelta(emit, messageId, {
        op: "part.upsert",
        key: activityPartKey(observation.activityId),
        index: 0,
        part: activityPart(observation),
      });
      return;
    }

    await emit(this.#activityObservation(observation));
    this.#activityOverlays.delete(messageId);
  }

  #turnObservation(
    observation: Extract<RuntimeObservation, { kind: "turn" }>,
  ): Extract<
    TranslatedObservation,
    { kind: "turn.started" | "turn.completed" | "turn.interrupted" }
  > {
    return {
      id: `${this.#namespace}:turn:${observation.turnId}:${observation.state}`,
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
  ): Extract<TranslatedObservation, { kind: "transcript.message" }> | null {
    const parts = settledParts(observation.message);
    if (parts.length === 0) return null;
    const messageId = `${this.#namespace}:${this.#attachmentId}:entry:${observation.message.entryId}`;
    return {
      id: `${this.#namespace}:message:${observation.message.entryId}`,
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
  ): Extract<TranslatedObservation, { kind: "transcript.message" }> {
    const messageId = this.#activityMessageId(observation.turnId, observation.activityId);
    return {
      id: `${this.#namespace}:activity:${this.#attachmentId}:${observation.turnId}:${observation.activityId}:${observation.state}`,
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
  ): Extract<TranslatedObservation, { kind: "attention.raised" | "attention.cleared" }> {
    // The Attention's own durable id, and frozen independently of the event id
    // it prefixes: `attention.cleared` names it, and the projection pairs a
    // raise with its clearance by exact match on it. One reason is one standing
    // claim, however many times it is raised.
    const attentionId = `${this.#namespace}:attention:${this.#attachmentId}:${observation.reason}`;
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

  #interactionObservation(
    observation: Extract<RuntimeObservation, { kind: "interaction" }>,
  ): Extract<TranslatedObservation, { kind: "interaction.opened" | "interaction.resolved" }> {
    // An interaction is asked once and answered once, so its own id plus the
    // side of that pair is the whole identity — no counter, and stable across a
    // replay of the same fact.
    if (observation.state === "resolved") {
      return {
        id: `${this.#namespace}:interaction:${this.#attachmentId}:${observation.interactionId}:resolved`,
        kind: "interaction.resolved",
        occurredAt: observation.occurredAt ?? this.#now(),
        interactionId: observation.interactionId,
        resolution: observation.resolution,
      };
    }
    return {
      id: `${this.#namespace}:interaction:${this.#attachmentId}:${observation.interaction.id}:opened`,
      kind: "interaction.opened",
      occurredAt: observation.occurredAt ?? this.#now(),
      interaction: observation.interaction,
    };
  }

  /** Retire an in-flight message nothing is going to finish. */
  async #withdrawStreaming(emit: TranslatedObservationSink): Promise<void> {
    const streaming = this.#streaming;
    if (streaming === null) return;
    this.#streaming = null;
    await this.#emitDelta(emit, streaming.id, { op: "message.remove" });
  }

  /**
   * Retry only overlays from a turn the executor has closed. A rejected sink
   * write leaves the row tracked, so the next lifecycle edge can retire it
   * without deleting state before the Session observed the removal.
   */
  async #retryClosedActivityWithdrawals(emit: TranslatedObservationSink): Promise<void> {
    const active = [...this.#activityOverlays.values()].filter((activity) =>
      this.#closedActivityTurns.has(activity.turnId),
    );
    for (const activity of active) {
      await this.#emitDelta(emit, activity.messageId, { op: "message.remove" });
      this.#activityOverlays.delete(activity.messageId);
    }
    // Reaching here means every overlay belonging to a closed turn was withdrawn
    // and dropped, so no closed turn has anything left to retire. A rejected
    // write throws out of the loop above instead, which is what leaves the turn
    // tracked for the next lifecycle edge to try again.
    this.#closedActivityTurns.clear();
  }

  /**
   * Name an assistant message before anyone knows what it will be called.
   *
   * A runtime names a settled message only once it has settled — Pi calls that
   * an `entryId` — while its deltas name only the turn they belong to. But an
   * overlay entry is retired by the *durable* message's own id
   * (`session-runtime.ts`, `#clearOverlayMessage`), so the transient and durable
   * halves have to agree on one id before the first delta goes out, and the
   * settled name does not exist yet.
   *
   * So the id is minted from what is already known: the attachment, the turn,
   * and the message's position within that turn. The runtime's own `entryId`
   * then goes where it is actually needed and nowhere else — on the observation
   * id, which is what dedupes a replay, and on the reconcile cursor, which is
   * what a resume starts from.
   */
  #openMessage(turnId: string): string {
    const index = this.#messageSequence;
    this.#messageSequence += 1;
    return `${this.#namespace}:${this.#attachmentId}:${turnId}:${index}`;
  }

  #activityMessageId(turnId: string, activityId: string): string {
    return `${this.#namespace}:${this.#attachmentId}:${turnId}:activity:${activityId}`;
  }

  #emitDelta(
    emit: TranslatedObservationSink,
    messageId: string,
    delta: TranscriptDelta,
  ): Promise<void> {
    return emit({
      id: `${this.#namespace}:delta:${this.#attachmentId}:${++this.#sequence}`,
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
}

function recoveryCursor(entryId: string | undefined): { cursor?: SessionNativeDetail } {
  return entryId === undefined ? {} : { cursor: { entryId } };
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
  // transcript reads it that way. `parts` is an array inside the artifact the
  // durable digest is taken over, so this order is part of that digest.
  if (message.reasoning !== undefined && message.reasoning.length > 0) {
    parts.push({ type: "reasoning", text: message.reasoning, state: "done" });
  }
  if (message.text.length > 0) parts.push({ type: "text", text: message.text, state: "done" });
  return parts;
}

/**
 * The model and cost a settled message was produced under — the shape a
 * transcript artifact's `metadata` carries.
 *
 * Every field is nullable and the key is omitted entirely when the runtime
 * reported nothing, so a reader never has to tell "free" from "not measured".
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
