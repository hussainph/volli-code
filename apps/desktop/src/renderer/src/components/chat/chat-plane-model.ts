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
  SessionAttention,
  SessionAttentionProjection,
  SessionInteraction,
  SessionInteractionResolution,
} from "@volli/shared";
import { REASONING_LEVELS } from "@volli/shared";
import type { UIMessage } from "ai";

import type { InteractionSubmission } from "@renderer/chat/interaction";
import type { ComposerIntent } from "@renderer/chat/session-model";

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

export function messageRoute(intent: ComposerIntent, deliverable: boolean): MessageRoute {
  return intent !== "queue" && deliverable ? "send" : "hold";
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
  /**
   * Whether this Session has a manual terminal companion beside it — which only
   * a Ticket Session does.
   *
   * It decides the whole auth/configuration handoff, not just the Terminal
   * button: signing in is provider-owned and happens in that terminal, so the
   * exact-run Retry only means anything where the sign-in it follows can
   * actually happen. A project chat has neither and is sent to Settings.
   */
  terminalAvailable: boolean;
}

export interface SessionBlockerActs {
  recover(): void;
  retryRuntime(): void;
  openTerminal(): void;
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
  const terminal: SessionBlockerAction = { label: "Open Terminal", act: acts.openTerminal };
  const settings: SessionBlockerAction = { label: "Settings", act: acts.openSettings };
  if (input.sessionError !== null) {
    return { message: input.sessionError, detail: null, tone: "error", action: retry };
  }
  // Only a catalog that has answered may accuse the Session's model: while it
  // loads, every model reads as unavailable.
  const sessionModel = input.catalogState === "ready" ? input.sessionModel : null;
  if (sessionModel !== null && sessionModel.state !== "available") {
    return {
      message:
        sessionModel.state === "authentication-required"
          ? `Sign-in required for ${sessionModel.providerLabel}`
          : "Model unavailable",
      detail: null,
      tone: "error",
      action: settings,
    };
  }
  const attention = input.attention.primary;
  if (attention) {
    return asked && answeredByCard(attention.kind)
      ? null
      : attentionBlocker(
          attention,
          retry,
          retryRuntime,
          terminal,
          settings,
          input.terminalAvailable,
        );
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
 * One line and one recovery action per attention kind, except Pi auth/config:
 * its existing terminal handoff and exact Retry are intentionally adjacent.
 *
 * The switch is total over the union and has no `default`: a kind added later
 * has to be answered here, not silently absorbed into whichever branch was
 * cheapest to reach.
 *
 * Which kinds earn a button, and why the rest do not:
 *
 * - **Terminal + Retry** — Pi auth/configuration recovery uses an existing
 *   manual Ticket terminal for provider-owned sign-in, then retries the exact
 *   failed run without submitting the user's message again. Where there is no
 *   such terminal — a project chat — the pair collapses to Settings rather than
 *   to a Retry of a run nothing has fixed yet.
 * - **Retry** — `transport_retrying`, `adapter_disconnected` and `rate_limited`.
 *   The first two are a connection to re-establish, which is exactly what
 *   `recover` does. A rate limit gets one because the wait is the whole fix; the
 *   provider's own time is shown when it sent one, and an absent one stays
 *   absent rather than becoming a guess.
 * - **Nothing** — `context_limit_reached` (compaction does not exist yet, so the
 *   only true answer is a new Session); `quota_exhausted` (a spent allowance is
 *   not retryable and no local setting refills it); `partial_turn_interrupted`
 *   (a stopped turn left the composer usable — resending is typing, not
 *   recovering); `adapter_unrecoverable` (the kind is named for having no
 *   recovery); `input_required` and `permission_required` (the answer lives on
 *   the interaction card, which outranks this row entirely).
 */
function attentionBlocker(
  attention: SessionAttention,
  retry: SessionBlockerAction,
  retryRuntime: SessionBlockerAction,
  terminal: SessionBlockerAction,
  settings: SessionBlockerAction,
  terminalAvailable: boolean,
): SessionBlockerState {
  const detail = attention.detail;
  switch (attention.kind) {
    case "auth_required":
      return terminalAvailable
        ? {
            message: "Sign-in required",
            detail,
            tone: "error",
            action: terminal,
            secondaryAction: retryRuntime,
          }
        : { message: "Sign-in required", detail, tone: "error", action: settings };
    case "configuration_invalid":
      return terminalAvailable
        ? {
            message: "Configuration invalid",
            detail,
            tone: "error",
            action: terminal,
            secondaryAction: retryRuntime,
          }
        : { message: "Configuration invalid", detail, tone: "error", action: settings };
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
      return { message: "Session stopped", detail, tone: "error", action: null };
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
