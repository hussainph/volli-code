/**
 * The chat plane's decisions, without a plane.
 *
 * Everything here is a rule the surface has to get right and a renderer cannot
 * help it get right: what stops a person typing and what to offer them about it,
 * how a decision and the redirection behind it are ordered, and which rows a
 * streamed token is allowed to repaint.
 */
import type {
  ModelAccessModel,
  ModelAccessProvider,
  ModelAccessState,
  ModelSelection,
  RendererSessionInteraction,
  SessionAttention,
  SessionAttentionProjection,
  SessionInteraction,
  SessionInteractionResolution,
} from "@volli/shared";
import { REASONING_LEVELS } from "@volli/shared";
import type { UIMessage } from "ai";

import { composerAnswer, type InteractionSubmission } from "@renderer/chat/interaction";
import type { ComposerIntent, QueuedMessage } from "@renderer/chat/session-model";
import type { HeldMessage } from "@renderer/stores/chat-drafts";

export function composerModelSelection(input: {
  providerId: string;
  modelId: string;
  reasoningLevel: string;
}): ModelSelection | null {
  const reasoningLevel = REASONING_LEVELS.find((level) => level === input.reasoningLevel);
  return reasoningLevel === undefined
    ? null
    : { providerId: input.providerId, modelId: input.modelId, reasoningLevel };
}

/** This Session's durable model, weighed against what the profile can run. */
export interface SessionModelStanding {
  /** Named rather than the model, because signing in is per provider. */
  providerLabel: string;
  state: ModelAccessState;
}

/**
 * What the catalog says about the model this Session is pinned to.
 *
 * A Session records its model policy at birth, from the app default, and
 * nothing re-reads that decision afterwards — so a Session can be pointed at a
 * provider nobody is signed in to and look completely ordinary until its first
 * message dies at the provider's API. This is that fact, available before the
 * message rather than after it.
 *
 * A selection the catalog has never heard of counts as unavailable: the model
 * is gone, and the Session is pinned to it either way.
 */
export function sessionModelStanding(
  selection: { providerId: string; modelId: string } | null,
  models: readonly ModelAccessModel[],
  providers: readonly ModelAccessProvider[],
): SessionModelStanding | null {
  if (selection === null) return null;
  const providerLabel =
    providers.find((provider) => provider.id === selection.providerId)?.label ??
    selection.providerId;
  const model = models.find(
    (candidate) =>
      candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
  );
  return { providerLabel, state: model?.state ?? "unavailable" };
}

/* -------------------------------------------------------------- answering */

/**
 * A decision, and the redirection that could not ride it.
 *
 * Two acts, in this order and never merged. The resolution is what the harness's
 * reply endpoint takes; a refusal is defined by being empty, so words the reader
 * typed instead of choosing travel afterwards as an ordinary message — and only
 * once the decision itself has *landed*.
 */
export async function answerInteraction(
  interactionId: string,
  submission: InteractionSubmission,
  acts: {
    resolve(interactionId: string, resolution: SessionInteractionResolution): Promise<boolean>;
    deliver(message: string): void;
    resolving(interactionId: string, active: boolean): void;
  },
): Promise<boolean> {
  acts.resolving(interactionId, true);
  try {
    const resolved = await acts.resolve(interactionId, submission.resolution);
    if (resolved && submission.message !== null) acts.deliver(submission.message);
    return resolved;
  } finally {
    acts.resolving(interactionId, false);
  }
}

/**
 * The other way a card ends: nobody is going to decide it.
 *
 * The second act waits on the first only for order — stopping the turn does not
 * answer the question, and an interaction leaves the projection only when it is
 * resolved or cancelled. It holds the same in-flight latch a decision does, so a
 * second click lands on a disabled Stop rather than on a second withdrawal.
 */
export async function withdrawInteraction(
  interactionId: string,
  acts: {
    interrupt(): Promise<boolean>;
    cancel(interactionId: string): Promise<boolean>;
    resolving(interactionId: string, active: boolean): void;
  },
): Promise<void> {
  acts.resolving(interactionId, true);
  try {
    await acts.interrupt();
    await acts.cancel(interactionId);
  } finally {
    acts.resolving(interactionId, false);
  }
}

/**
 * Which cards have a decision in flight — by id, because several can be open at
 * once and each one's controls answer for itself alone.
 */
export function resolvingWith(
  current: ReadonlySet<string>,
  interactionId: string,
  active: boolean,
): ReadonlySet<string> {
  const next = new Set(current);
  if (active) next.add(interactionId);
  else next.delete(interactionId);
  return next;
}

/**
 * Where a message goes right now: to the harness, or into the Session's queue.
 *
 * One rule for every message this surface sends, wherever it was typed. The
 * queue is not only the composer's affordance for holding a message behind a
 * live turn — it is also what keeps words written before the executor is up, and
 * a card's redirection is written exactly then as often as anything else.
 */
export type MessageRoute = "send" | "hold";

/* ---------------------------------------------------------------- copying */

/**
 * The raw prose a feed row presents, in the order the reader sees it.
 *
 * A turn can contain several messages and a message can contain several text
 * parts. The feed separates each part with its normal prose beat, so the copied
 * form uses a blank line rather than welding those boundaries together. Tool and
 * reasoning parts intentionally stay out: they have their own inline controls
 * and are not message text.
 */
export function messageCopyText(messages: readonly UIMessage[]): string | null {
  const text: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text" && part.text.length > 0) text.push(part.text);
    }
  }
  return text.length > 0 ? text.join("\n\n") : null;
}

export function messageRoute(intent: ComposerIntent, deliverable: boolean): MessageRoute {
  return intent !== "queue" && deliverable ? "send" : "hold";
}

/**
 * What one press of the composer turns out to have been.
 *
 * Two things, and only the first of them is new: a message is what every press
 * has always been, and an answer is what a press becomes while a question is
 * standing open above the box that can take its words
 * ({@link composerAnswer}, which owns the rule and the reasons).
 *
 * It is a decision rather than a mode, and that distinction is the whole
 * design: the composer is not put into an answering state that a reader has to
 * leave, and no press is ever refused for being the wrong kind. What the words
 * are is read off the request that is open at the moment they are sent, and
 * where they are not an answer they are a message — which is exactly what the
 * surface did before, and remains the road for everything a question cannot
 * take: a permission waiting on a verdict, a walk through several questions, a
 * model that asked for one of its own listed answers.
 */
export type ComposerPress =
  | { kind: "answer"; interactionId: string; submission: InteractionSubmission }
  | { kind: "message" };

export function composerPress(
  pending: RendererSessionInteraction | null,
  text: string,
): ComposerPress {
  if (pending === null) return { kind: "message" };
  const submission = composerAnswer(pending, text);
  return submission === null
    ? { kind: "message" }
    : { kind: "answer", interactionId: pending.id, submission };
}

export type HeldDispatchOutcome = "delivered" | "recorded" | "refused" | "held";

export interface HeldDispatchActs {
  /** Makes the only renderer-independent copy durable before delivery begins. */
  persist(): Promise<boolean>;
  deliver(): Promise<HeldDispatchOutcome>;
  /** Persists the final ownership state before the dispatch is allowed to settle. */
  finish(outcome: HeldDispatchOutcome): Promise<void>;
}

/**
 * Owns the persist-before-delivery rule for fresh composer typing. The plane
 * supplies storage and Session adapters; this module keeps their ordering from
 * becoming a view lifecycle detail.
 */
export async function dispatchHeldMessage(acts: HeldDispatchActs): Promise<HeldDispatchOutcome> {
  if (!(await acts.persist())) {
    await acts.finish("refused");
    return "refused";
  }
  let outcome: HeldDispatchOutcome;
  try {
    outcome = await acts.deliver();
  } catch {
    await acts.finish("refused");
    return "refused";
  }
  await acts.finish(outcome);
  return outcome;
}

export interface QueuedMutationActs {
  queueBacked: boolean;
  claim(): boolean;
  consumeClaim(): boolean;
  releaseClaim(): void;
  dropHeld(): void;
}

/** Refuses Edit/Delete while resident delivery owns the same queue identity. */
export function coordinateQueuedMutation(acts: QueuedMutationActs): boolean {
  if (acts.queueBacked) {
    if (!acts.claim()) return false;
    if (!acts.consumeClaim()) {
      acts.releaseClaim();
      return false;
    }
  }
  acts.dropHeld();
  return true;
}

export interface QueuedSteerActs {
  /** One synchronous reading of both resident sources and current liveness. */
  read(): {
    held: readonly HeldMessage[];
    queue: readonly QueuedMessage[];
    steerable: boolean;
  };
  /**
   * Claims the resident queue, persists the visible order, revalidates
   * liveness, and only then consumes the target. Every non-started result has
   * restored its source state and waited for that persistence attempt.
   */
  start(visible: readonly QueuedMessage[], targetId: string): Promise<QueuedSteerStart>;
  submit(message: QueuedMessage, delivery: "steer"): Promise<QueuedSteerDelivery>;
  /** Waits for held cleanup or refusal persistence before settling. */
  finish(id: string, outcome: QueuedSteerDelivery): Promise<void>;
}

export type QueuedSteerDelivery = "delivered" | "recorded" | "refused";
export type QueuedSteerOutcome = QueuedSteerDelivery | "held" | "stale";
export type QueuedSteerStart =
  | "started"
  | Exclude<QueuedSteerOutcome, QueuedSteerDelivery>
  | "refused";

/** The held state an aborted steer must restore without corrupting its source. */
export function steerRollbackState(
  queueBacked: boolean,
  heldState: HeldMessage["state"] | undefined,
): HeldMessage["state"] {
  return queueBacked ? "queued" : (heldState ?? "unsent");
}

/** True only while the exact turn targeted before an async durability wait remains active. */
export function steerTurnIsCurrent(
  targetedTurnEpoch: number | undefined,
  current: { turnEpoch: number; working: boolean; deliverable: boolean } | undefined,
): boolean {
  return (
    targetedTurnEpoch !== undefined &&
    current !== undefined &&
    current.turnEpoch === targetedTurnEpoch &&
    current.working &&
    current.deliverable
  );
}

export interface QueuedSteerStartActs {
  queueBacked: boolean;
  claim(): boolean;
  persist(): Promise<boolean>;
  current(): { turnEpoch: number; working: boolean; deliverable: boolean } | undefined;
  consumeClaim(): boolean;
  restore(): Promise<void>;
  releaseClaim(): void;
}

/**
 * Owns the async gap between a queue click and its durable held copy. A queue
 * claim freezes resident release until this either consumes the selected row or
 * restores its source state; held-only retries take the same path without one.
 */
export async function coordinateQueuedSteerStart(
  targetedTurnEpoch: number | undefined,
  acts: QueuedSteerStartActs,
): Promise<QueuedSteerStart> {
  let claimActive = false;
  if (acts.queueBacked) {
    if (!acts.claim()) return "stale";
    claimActive = true;
  }

  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    await acts.restore();
  };

  try {
    if (!(await acts.persist())) {
      await restore();
      return "refused";
    }
    if (!steerTurnIsCurrent(targetedTurnEpoch, acts.current())) {
      await restore();
      return "held";
    }
    if (acts.queueBacked && !acts.consumeClaim()) {
      await restore();
      return "stale";
    }
    claimActive = false;
    return "started";
  } catch (error) {
    await restore();
    throw error;
  } finally {
    if (claimActive) acts.releaseClaim();
  }
}

/**
 * Moves one existing strip row into the active turn without changing its id.
 *
 * A queue-only row gains its durable held copy before dequeue. An unsent
 * held-only row already has one. A held `queued` row whose release queue entry
 * vanished is stale: the resident client may already own it, so steering it
 * again would risk a duplicate turn.
 */
export async function steerQueuedMessage(
  id: string,
  inFlight: Set<string>,
  acts: QueuedSteerActs,
): Promise<QueuedSteerOutcome> {
  if (inFlight.has(id)) return "stale";
  const snapshot = acts.read();
  const held = snapshot.held.find((entry) => entry.id === id);
  const queued = snapshot.queue.find((entry) => entry.id === id);
  if (held?.state === "sending" || (held?.state === "queued" && queued === undefined)) {
    return "stale";
  }
  const message: QueuedMessage | undefined =
    held === undefined
      ? queued
      : {
          id: held.id,
          text: held.text,
          ...(held.resources === undefined ? {} : { resources: held.resources }),
        };
  if (message === undefined) return "stale";
  // A click cannot improve a queue while the Session cannot steer. In
  // particular, never manufacture a release-queue copy for a held-only row:
  // the resident client observes enqueue synchronously and can drain that copy
  // before this transition marks the held source as queued.
  if (!snapshot.steerable) return "held";

  inFlight.add(id);
  try {
    const started = await acts.start(heldStrip(snapshot.held, snapshot.queue), id);
    if (started !== "started") return started;
    const outcome = await acts.submit(message, "steer");
    await acts.finish(id, outcome);
    return outcome;
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Every message this Session is holding for you, in one strip.
 *
 * Two lists say it, for two different spans. The release queue is what the
 * resident client drains and it lives as long as the window does; the persisted
 * held list is what survives one, and it is also where a message nothing took
 * goes rather than being welded onto whatever was typed after it. A message
 * that is in both — the ordinary queued one — is one row, because the id is the
 * same message in two records and not two messages.
 *
 * `sending` is excluded on purpose: the transcript is already drawing that
 * message, and a copy of it under the composer reads as one that failed to
 * leave.
 */
export function heldStrip(
  held: readonly HeldMessage[],
  queue: readonly QueuedMessage[],
  durableMessageIds: ReadonlySet<string> = new Set(),
  snapshotReconciled = true,
): readonly QueuedMessage[] {
  // Cold adoption seeds an empty transcript and null projection before its
  // snapshot arrives. A persisted, already-accepted row must not expose Edit
  // or Remove in that interval: either action can mint a new identity before
  // the durable message with the old one is available to reconcile it.
  if (!snapshotReconciled) return [];
  const rows: QueuedMessage[] = [];
  const drawn = new Set<string>();
  for (const entry of held) {
    // Sending still owns this id even though it owns no row. If the queue has
    // not observed the start transition yet, drawing its copy would flash the
    // target back into the strip and invite a second click.
    drawn.add(entry.id);
    if (entry.state === "sending" || durableMessageIds.has(entry.id)) continue;
    rows.push({
      id: entry.id,
      text: entry.text,
      // The row is also what `beginQueuedSteer` persists back, so the skill
      // resources riding the held copy must survive the round trip (VC-49).
      ...(entry.resources === undefined ? {} : { resources: entry.resources }),
    });
  }
  for (const entry of queue)
    if (!drawn.has(entry.id) && !durableMessageIds.has(entry.id)) rows.push(entry);
  return rows;
}

/** Cold adoption is not reconciled until its first projection snapshot exists. */
export function hasReconciledSessionSnapshot(projection: unknown): boolean {
  return projection !== null && projection !== undefined;
}

/**
 * The held copies the release queue has finished with, and nothing else.
 *
 * A `queued` copy exists for one reason: the queue is renderer memory, so
 * without it a reload loses a message a person typed. Once the queue no longer
 * names it, the release either delivered it or the person removed the row —
 * both are answers, and neither leaves this surface holding the words.
 *
 * A matching durable transcript id wins for every state: it proves the same
 * stable message identity crossed the Session seam before a renderer died.
 * Otherwise only `queued` is inferred from queue disappearance; `sending` and
 * `unsent` still need an explicit durable match.
 */
export function settledHeldIds(
  held: readonly HeldMessage[],
  queue: readonly QueuedMessage[],
  durableMessageIds: ReadonlySet<string> = new Set(),
): readonly string[] {
  const live = new Set(queue.map((entry) => entry.id));
  return held.flatMap((entry) =>
    durableMessageIds.has(entry.id) || (entry.state === "queued" && !live.has(entry.id))
      ? [entry.id]
      : [],
  );
}

/* ---------------------------------------------------------------- blocked */

/**
 * Whether the runtime catalog has answered yet.
 *
 * `loading` and `empty` are different facts: the catalog resolves over a round
 * trip, so a surface reading `models.length === 0` as "nothing is configured"
 * tells the user to go choose models for as long as that takes. Only `empty` is
 * a blocked state, and only it earns a recovery action.
 *
 * `pinned` is the fourth reading and the one that is not about a round trip at
 * all: the Session's executor chooses its own model, so there is no catalog to
 * ask and no configuring left undone. It looks like `empty` from a distance and
 * means the opposite of it.
 */
export type CatalogState = "loading" | "ready" | "empty" | "error" | "pinned";

export interface SessionBlockerAction {
  label: string;
  act(): void;
}

export interface SessionBlockerState {
  message: string;
  /** The harness's own wording. It qualifies the headline; it is never it. */
  detail: string | null;
  tone: "error" | "waiting" | "unconfigured";
  /**
   * Null where nothing on this surface can fix it. A button that cannot help is
   * worse than no button: it spends the reader's one attempt at recovery and
   * then leaves them where they started, doubting the message too.
   */
  action: SessionBlockerAction | null;
  secondaryAction?: SessionBlockerAction | null;
}

/** What the plane reads to decide whether anything is stopping the typing. */
export interface SessionBlockerInput {
  /** The Session's own transport, as the resident slice reports it. */
  sessionError: string | null;
  attention: SessionAttentionProjection;
  catalogState: CatalogState;
  catalogError: string | null;
  /** This Session's model against the catalog — see {@link sessionModelStanding}. */
  sessionModel: SessionModelStanding | null;
}

export interface SessionBlockerActs {
  recover(): void;
  retryRuntime(): void;
  openSettings(): void;
}

/** Select the user's existing ticket terminal tab without creating a new one. */
export function terminalCompanionTabId(
  container:
    | {
        activeSessionId: string | null;
        tabs: readonly { sessionId: string }[];
      }
    | undefined,
): string | null {
  return container?.activeSessionId ?? container?.tabs.at(-1)?.sessionId ?? null;
}

/**
 * What actually stops you typing, and what to do about it — nothing else.
 *
 * It sits on the composer rather than in the transcript because it is about
 * whether you can write, not about what happened in the conversation, and a
 * failure that scrolls away with the history is one nobody can act on.
 *
 * Four sources, in the order they answer:
 *
 * 1. `sessionError` — this Session's own transport. If the stream is gone the
 *    attention we hold is a memory, so it does not get to speak over it.
 * 2. `sessionModel` — the Session is pinned to a model this profile cannot run.
 *    It outranks the attention because every failure such a Session will ever
 *    raise is downstream of this one fact, the harness's own report of it names
 *    a provider id and offers a sign-in the reader did not ask for, and this is
 *    the only one of the two that can be read *before* a message is spent on it.
 * 3. `attention.primary` — the harness stating a state to recover from.
 * 4. `catalogState` / `catalogError` — nothing configured yet, which auth would
 *    otherwise be mistaken for since an unauthenticated provider lists no models
 *    either, and the refresh that could not answer at all.
 *
 * **An open card suppresses what it is the answer to, and nothing more.** Being
 * asked a question is not a failure, so a card takes the place of
 * `input_required`, `permission_required` and the "no models" row it does not
 * need one for. It never takes the place of a failure: `sessionError` is where a
 * decision that did not reach the harness is reported, and a card that hid it
 * would be a card still sitting there looking answerable while the only report
 * of what went wrong stayed off screen.
 */
export function sessionBlocker(
  input: SessionBlockerInput,
  acts: SessionBlockerActs,
  asked: boolean,
): SessionBlockerState | null {
  const retry: SessionBlockerAction = { label: "Retry", act: acts.recover };
  const retryRuntime: SessionBlockerAction = { label: "Retry", act: acts.retryRuntime };
  const settings: SessionBlockerAction = { label: "Settings", act: acts.openSettings };
  if (input.sessionError !== null) {
    return { message: input.sessionError, detail: null, tone: "error", action: retry };
  }
  // Only a catalog that has answered may accuse the Session's model: while it
  // loads, every model reads as unavailable.
  const sessionModel = input.catalogState === "ready" ? input.sessionModel : null;
  if (sessionModel !== null && sessionModel.state !== "available") {
    return sessionModel.state === "authentication-required"
      ? {
          // The same fact the harness reports as `auth_required`, read before a
          // message is spent on it instead of after — so it goes to the same
          // place. What it does NOT carry is the exact-run Retry beside it:
          // nothing has run.
          message: `Sign-in required for ${sessionModel.providerLabel}`,
          detail: null,
          tone: "error",
          action: settings,
        }
      : {
          // No action, because the two this row could offer are both wrong.
          // Settings writes the app DEFAULT, copied into a Session at birth and
          // never re-read, so it cannot repin this one; Retry re-runs a model
          // that is gone. The pill directly under this row is the repair, and a
          // ready catalog means it is already offering something runnable.
          message: `Model unavailable for ${sessionModel.providerLabel}`,
          detail: null,
          tone: "error",
          action: null,
        };
  }
  const attention = input.attention.primary;
  if (attention) {
    return asked && answeredByCard(attention.kind)
      ? null
      : attentionBlocker(attention, retry, retryRuntime, settings);
  }
  // Only a catalog that has actually answered can say a person configured
  // nothing; `loading` looks identical from here and is not a blocked state.
  if (input.catalogState === "empty" && !asked) {
    return {
      message: "No models configured",
      detail: null,
      tone: "unconfigured",
      action: settings,
    };
  }
  // The model list failing to refresh, which is a different fact from there
  // being none — and from the Session's own transport. Settings is the action
  // because saving a preference is what re-asks the catalog.
  if (input.catalogError !== null && !asked) {
    return {
      message: "Models unavailable",
      detail: input.catalogError,
      tone: "error",
      action: settings,
    };
  }
  return null;
}

/** The two attention kinds a card standing on screen already answers. */
function answeredByCard(kind: SessionAttention["kind"]): boolean {
  return kind === "input_required" || kind === "permission_required";
}

/**
 * A provider-owned recovery: where to fix it, and the exact retry of the run it
 * broke, beside it.
 *
 * A signed-out provider reaches this surface twice — as the harness's own
 * `auth_required` after a run died, and as the Session's pinned model reading
 * unavailable in a catalog that has answered — and both lead to the same place,
 * because there is now only one place. Sign-in used to fork on whether a manual
 * Ticket terminal existed to hand off to; it happens inside Settings now, so a
 * project chat and a Ticket chat get the same answer and neither is sent to a
 * terminal to finish a Settings task.
 *
 * That is also why Retry is unconditional here. It used to be withheld from a
 * project chat, on the honest ground that retrying a run whose sign-in could
 * not be reached was offering a button that could not work. The sign-in is
 * reachable from both now, so the run is retryable from both.
 */
function providerRecovery(input: {
  message: string;
  detail: string | null;
  settings: SessionBlockerAction;
  retryRuntime: SessionBlockerAction;
}): SessionBlockerState {
  return {
    message: input.message,
    detail: input.detail,
    tone: "error",
    action: input.settings,
    secondaryAction: input.retryRuntime,
  };
}

/**
 * One line and one recovery action per attention kind, except Pi auth/config:
 * its existing terminal handoff and exact Retry are intentionally adjacent.
 *
 * The switch is total over the union and has no `default`: a kind added later
 * has to be answered here, not silently absorbed into whichever branch was
 * cheapest to reach.
 *
 * Which kinds earn a button, and why the rest do not:
 *
 * - **Settings + Retry** — Pi auth/configuration recovery sends you to Model
 *   Access, where signing in now happens, and then retries the exact failed run
 *   without submitting the user's message again. Both halves are offered to
 *   every Session: the sign-in no longer depends on a manual Ticket terminal
 *   being there to hand off to, so neither does the Retry that follows it.
 * - **Retry** — `transport_retrying`, `adapter_disconnected` and `rate_limited`.
 *   The first two are a connection to re-establish, which is exactly what
 *   `recover` does. A rate limit gets one because the wait is the whole fix; the
 *   provider's own time is shown when it sent one, and an absent one stays
 *   absent rather than becoming a guess.
 * - **Retry of the run** — `adapter_unrecoverable`. The kind is named for having
 *   no *automatic* recovery, and by the time it is raised the runtime has spent
 *   every attempt it makes on its own; the run itself is still there to try
 *   again, and re-running it is not the same act as re-establishing a
 *   connection that never dropped.
 * - **Nothing** — `context_limit_reached` (compaction does not exist yet, so the
 *   only true answer is a new Session); `quota_exhausted` (a spent allowance is
 *   not retryable and no local setting refills it); `partial_turn_interrupted`
 *   (a stopped turn left the composer usable — resending is typing, not
 *   recovering); `input_required` and `permission_required` (the answer lives on
 *   the interaction card, which outranks this row entirely).
 */
function attentionBlocker(
  attention: SessionAttention,
  retry: SessionBlockerAction,
  retryRuntime: SessionBlockerAction,
  settings: SessionBlockerAction,
): SessionBlockerState {
  const detail = attention.detail;
  switch (attention.kind) {
    case "auth_required":
      return providerRecovery({ message: "Sign-in required", detail, settings, retryRuntime });
    case "configuration_invalid":
      return providerRecovery({
        message: "Configuration invalid",
        detail,
        settings,
        retryRuntime,
      });
    case "transport_retrying":
      return { message: "Reconnecting", detail, tone: "waiting", action: retry };
    case "adapter_disconnected":
      return { message: "Disconnected", detail, tone: "error", action: retry };
    case "rate_limited":
      return {
        message: `Rate limited${untilClause(attention.retryAt)}`,
        detail,
        tone: "waiting",
        action: retry,
      };
    case "quota_exhausted":
      return {
        message: `Quota exhausted${untilClause(attention.resetAt)}`,
        detail,
        tone: "error",
        action: null,
      };
    case "context_limit_reached":
      return { message: "Context limit reached", detail, tone: "error", action: null };
    case "partial_turn_interrupted":
      return { message: "Turn interrupted", detail, tone: "waiting", action: null };
    case "adapter_unrecoverable":
      return { message: "Session stopped", detail, tone: "error", action: retryRuntime };
    case "input_required":
      return { message: "Waiting for an answer", detail, tone: "waiting", action: null };
    case "permission_required":
      return { message: "Waiting for approval", detail, tone: "waiting", action: null };
  }
}

/** A time the provider stated, or nothing at all. An absent one is not invented. */
function untilClause(instant: number | null): string {
  if (instant === null || !Number.isFinite(instant)) return "";
  const at = new Date(instant).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return ` until ${at}`;
}

/* --------------------------------------------------------------- identity */

/**
 * The list, with every element the previous one already had put back.
 *
 * A frame batch replaces the projection and the transcript wholesale, so
 * everything derived from them arrives with a new identity and, almost always,
 * unchanged contents — which invalidates every memo beneath it and lets one
 * streamed token re-group, re-segment and repaint a transcript that has not
 * changed. Handing back the previous value whenever the new one says the same
 * thing is what lets a memo below be trusted.
 *
 * The outer array is kept too when nothing in it moved, so a consumer memoized
 * on the list as a whole holds as well.
 */
export function holdList<T>(
  previous: readonly T[],
  items: readonly T[],
  same: (previous: T, next: T) => boolean,
): readonly T[] {
  const merged = items.map((item, index) => {
    const before = previous[index];
    return before !== undefined && same(before, item) ? before : item;
  });
  const unchanged =
    merged.length === previous.length && merged.every((item, index) => item === previous[index]);
  return unchanged ? previous : merged;
}

/**
 * Two turns are the same turn when they hold the same message objects.
 *
 * Identity rather than deep equality, and it is exact here: the transcript
 * projects the frame's own message, so a message the harness re-emitted is a
 * different object and one nothing happened to is the object it already was.
 */
export function sameMessages(left: readonly UIMessage[], right: readonly UIMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

/** An interaction is written once, when it opens; the id is the whole of it. */
export function sameInteractionId(left: SessionInteraction, right: SessionInteraction): boolean {
  return left.id === right.id;
}

/**
 * Content, not identity — the one predicate here that cannot be `===`.
 *
 * {@link heldStrip} builds a fresh row for every held message on every call, so
 * two runs over unchanged records answer with different objects saying the same
 * two things. A queued row IS its id and its text — nothing else about it is
 * drawn — plus the resource list it would deliver, compared by identity because
 * the strip reuses the stored array rather than minting one per frame, and a
 * held row whose resources genuinely changed must not keep answering for the
 * old ones through a stale identity.
 */
export function sameQueuedMessage(left: QueuedMessage, right: QueuedMessage): boolean {
  return left.id === right.id && left.text === right.text && left.resources === right.resources;
}
