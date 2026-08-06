/**
 * The chat plane's decisions, without a plane.
 *
 * Everything here is a rule the surface has to get right and a renderer cannot
 * help it get right: what stops a person typing and what to offer them about it,
 * how a decision and the redirection behind it are ordered, and which rows a
 * streamed token is allowed to repaint.
 */
import type {
  RuntimeSelection,
  SessionAttention,
  SessionAttentionProjection,
  SessionInteraction,
  SessionInteractionResolution,
} from "@volli/shared";
import type { UIMessage } from "ai";

import type { SessionTodo } from "@renderer/chat/activity";
import type { InteractionSubmission } from "@renderer/chat/interaction";
import type { ComposerIntent } from "@renderer/chat/session-model";

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
 */
export type CatalogState = "loading" | "ready" | "empty" | "error";

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
}

/** What the plane reads to decide whether anything is stopping the typing. */
export interface SessionBlockerInput {
  /** The Session's own transport, as the resident slice reports it. */
  sessionError: string | null;
  attention: SessionAttentionProjection;
  catalogState: CatalogState;
  catalogError: string | null;
}

export interface SessionBlockerActs {
  recover(): void;
  openSettings(): void;
}

/**
 * What actually stops you typing, and what to do about it — nothing else.
 *
 * It sits on the composer rather than in the transcript because it is about
 * whether you can write, not about what happened in the conversation, and a
 * failure that scrolls away with the history is one nobody can act on.
 *
 * Three sources, in the order they answer:
 *
 * 1. `sessionError` — this Session's own transport. If the stream is gone the
 *    attention we hold is a memory, so it does not get to speak over it.
 * 2. `attention.primary` — the harness stating a state to recover from.
 * 3. `catalogState` / `catalogError` — nothing configured yet, which auth would
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
  const settings: SessionBlockerAction = { label: "Settings", act: acts.openSettings };
  if (input.sessionError !== null) {
    return { message: input.sessionError, detail: null, tone: "error", action: retry };
  }
  const attention = input.attention.primary;
  if (attention) {
    return asked && answeredByCard(attention.kind)
      ? null
      : attentionBlocker(attention, retry, settings);
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
 * One line and at most one action per attention kind.
 *
 * The switch is total over the union and has no `default`: a kind added later
 * has to be answered here, not silently absorbed into whichever branch was
 * cheapest to reach.
 *
 * Which kinds earn a button, and why the rest do not:
 *
 * - **Settings** — `auth_required` and `configuration_invalid`. Both are facts
 *   about what is configured, and Settings is where that is changed.
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
  settings: SessionBlockerAction,
): SessionBlockerState {
  const detail = attention.detail;
  switch (attention.kind) {
    case "auth_required":
      return { message: "Sign-in required", detail, tone: "error", action: settings };
    case "configuration_invalid":
      return { message: "Configuration invalid", detail, tone: "error", action: settings };
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

/**
 * The plan, by value — the one thing here identity cannot answer for, since it
 * is re-derived from the messages rather than carried by them.
 */
export function sameTodos(
  left: readonly SessionTodo[] | null,
  right: readonly SessionTodo[] | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (left.length !== right.length) return false;
  return left.every((todo, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      todo.id === other.id &&
      todo.content === other.content &&
      todo.status === other.status &&
      todo.priority === other.priority
    );
  });
}

/** Every step of a plan is finished, so the dock has nothing left to report. */
export function todosSettled(todos: readonly SessionTodo[]): boolean {
  return todos.every((todo) => todo.status === "completed" || todo.status === "cancelled");
}

/**
 * Whether a re-resolved selection says anything new.
 *
 * The catalog answers again whenever an executor appears or a preference is
 * saved, and it almost always resolves to the pick already held. Writing it back
 * regardless replaces the Session's slice, and everything reading that slice
 * repaints with it — the plane, and the tab's own title and liveness dot — to
 * say what was already on screen.
 */
export function sameSelection(left: RuntimeSelection, right: RuntimeSelection): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.variant === right.variant &&
    left.agent === right.agent
  );
}
