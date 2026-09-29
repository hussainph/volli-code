/**
 * VC-30 — the peek's state machine, lifted out of the view.
 *
 * `docs/plans/hover-peek-wireframe.excalidraw` (v2) argues about RULES, not
 * pixels: hover reads and never acts, a pin survives the pointer walking away,
 * a dismissal suppresses the next accidental open, an answer exists only after
 * an explicit Send. Every one of those is a statement about state over time,
 * which is exactly the part a screenshot cannot check and a pointer cannot be
 * trusted to demonstrate twice — so it lives here as a pure reducer with its
 * own tests, and the scratch beside it owns only timers, geometry and ink.
 *
 * WHAT IS DELIBERATELY NOT HERE. No clocks and no timers: the reducer is told
 * `now` by the caller and told when a dwell or a grace window ELAPSED. That
 * keeps the dwell delay a lab control (300/400/500ms) rather than a constant
 * baked into the rules, and it keeps the tests free of fake timers.
 *
 * THIS IS A PROTOTYPE'S MODEL. `delivered` is a fixture-local map, not a
 * transcript; `send-settled` is a lab control, not a network; `undo` deletes a
 * local entry and CANCELS NOTHING — a real Undo needs a delivery the runtime
 * can still retract, and whether Sessions can offer that is an open question
 * this file cannot answer. See the note on {@link UNDO_MS}.
 */

import type { SessionInteractionPrompt } from "@volli/shared";
import {
  isPromptAnswered,
  promptDraft,
  selectOption,
  setPromptResponse,
  type InteractionDraft,
} from "@volli/session-presentation";

/** The dwell rungs the wireframe leaves undecided ("300 / 400 / 500 ms?"). */
export const DWELL_CHOICES = [300, 400, 500] as const;
export type DwellMs = (typeof DWELL_CHOICES)[number];
export const DEFAULT_DWELL: DwellMs = 400;

/**
 * The row→card bridge. The pointer has to cross a gap to reach the card, and a
 * card that closes mid-crossing is a card you cannot use (WCAG 1.4.13's
 * "hoverable"). Closing is therefore deferred by this much after the pointer
 * has left BOTH the row and the card.
 */
export const GRACE_MS = 300;

/**
 * How long after an explicit dismissal a hover is refused.
 *
 * Without it, Escape or a click-away is undone by the pointer still resting on
 * the row that opened the peek: it closes and immediately re-opens, which reads
 * as the dismissal not working.
 */
export const SUPPRESSION_MS = 1000;

/** How long a successful send's confirmation holds the peek open before it closes. */
export const CONFIRMATION_MS = 2000;

/**
 * How long Undo stays reachable.
 *
 * The wireframe proposes both "peek stays ~2 s with this confirmation" and
 * "Undo (5 s)", which cannot both live on the peek — the surface is gone at 2s
 * while the affordance is promised for 5. The scratch resolves it by moving the
 * receipt OFF the peek: the peek closes at {@link CONFIRMATION_MS} and a
 * separate receipt strip holds Undo for the full window.
 *
 * MOCK. Undoing here removes a fixture entry. Nothing is recalled, because
 * nothing was sent. Whether a delivered answer can actually be retracted — and
 * for how long — is a backend guarantee this prototype does not have.
 */
export const UNDO_MS = 5000;

/** Which sidebar a row was pointed at in. The peek opens INWARD from either. */
export type PeekSurface = "nav" | "rail";

/** One row, identified by the session it stands for and the list it is in. */
export interface PeekTarget {
  readonly rowId: string;
  readonly surface: PeekSurface;
}

/**
 * Who owns keyboard focus.
 *
 * `"none"` is the hover path and the whole point of it: a peek that appears
 * under the pointer must leave focus exactly where the person put it. Focus
 * only ever moves on an explicit pin, which is what makes the Escape ladder
 * (field → dialog → unpin → close) a ladder rather than a single step.
 */
export type FocusOwner = "none" | "row" | "dialog" | "field";

export type SendOutcome = "success" | "failure";

export type SendState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly answer: string }
  | { readonly kind: "sent"; readonly answer: string; readonly at: number }
  | { readonly kind: "failed"; readonly answer: string; readonly reason: string };

/** An ordinary message has its own draft, separate from every question. */
export const MESSAGE_PROMPT_ID = "peek-message";

export interface DeliveredAnswer {
  readonly answer: string;
  readonly at: number;
}

export type DismissReason = "click-away" | "list-scroll" | "escape";

export interface PeekState {
  /** The peek on screen, or none. */
  readonly shown: PeekTarget | null;
  /** The peek held open for answering. Survives pointer travel and focus moving away. */
  readonly pinned: PeekTarget | null;
  /** The row under the pointer (or the stepped-to row). Not enough to open anything. */
  readonly hovered: PeekTarget | null;
  /** Whether the pointer is inside the card — the other half of the bridge. */
  readonly overCard: boolean;
  readonly draft: InteractionDraft;
  readonly questionIndex: number;
  readonly send: SendState;
  readonly focus: FocusOwner;
  /** Hover is refused until this timestamp. Set by dismissal only. */
  readonly suppressedUntil: number;
  /** Fixture-local "transcript": what a send would have delivered, per session. */
  readonly delivered: Readonly<Record<string, DeliveredAnswer>>;
  /** The last simulated "open session", so the lab can say what it would have done. */
  readonly opened: string | null;
}

export type PeekEvent =
  /** The pointer (or keyboard focus) arrived on a row. Starts the dwell; opens nothing. */
  | { readonly type: "hover-row"; readonly target: PeekTarget }
  | { readonly type: "hover-leave-row" }
  /** The dwell for `target` completed with the pointer still on it. */
  | { readonly type: "dwell-elapsed"; readonly target: PeekTarget; readonly now: number }
  /** The keyboard path: Space opens at once rather than waiting out a dwell. */
  | { readonly type: "open-now"; readonly target: PeekTarget; readonly now: number }
  | { readonly type: "card-enter" }
  | { readonly type: "card-leave" }
  | { readonly type: "grace-elapsed" }
  | { readonly type: "pin"; readonly target: PeekTarget }
  | { readonly type: "unpin" }
  | {
      readonly type: "select-option";
      readonly prompt: SessionInteractionPrompt;
      readonly optionId: string;
    }
  | { readonly type: "type-other"; readonly promptId: string; readonly text: string }
  | { readonly type: "question-step"; readonly index: number; readonly count: number }
  | { readonly type: "fixture-question-changed" }
  | { readonly type: "focus-field" }
  | { readonly type: "blur-field" }
  /** `answer` is `null` when nothing is selected and nothing is typed. */
  | { readonly type: "send"; readonly answer: string | null }
  | {
      readonly type: "send-settled";
      readonly outcome: SendOutcome;
      readonly now: number;
      readonly reason?: string;
    }
  | { readonly type: "confirmation-elapsed" }
  | { readonly type: "undo"; readonly rowId: string }
  | { readonly type: "escape"; readonly now: number }
  | { readonly type: "dismiss"; readonly reason: DismissReason; readonly now: number }
  | { readonly type: "open-session"; readonly rowId: string }
  | { readonly type: "clear-opened" };

const EMPTY_DRAFT: InteractionDraft = {};

export const initialPeekState: PeekState = {
  shown: null,
  pinned: null,
  hovered: null,
  overCard: false,
  draft: EMPTY_DRAFT,
  questionIndex: 0,
  send: { kind: "idle" },
  focus: "none",
  suppressedUntil: 0,
  delivered: {},
  opened: null,
};

function sameTarget(a: PeekTarget | null, b: PeekTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.rowId === b.rowId && a.surface === b.surface;
}

/** Display-only transcript line for the lab. Actual wire answers are per-prompt ids/response. */
export function draftAnswer(
  draft: InteractionDraft,
  prompts: readonly SessionInteractionPrompt[],
): string | null {
  if (prompts.length === 0) return promptDraft(draft, MESSAGE_PROMPT_ID).response.trim() || null;
  if (!prompts.every((prompt) => isPromptAnswered(prompt, draft))) return null;
  return prompts
    .map((prompt) => {
      const answer = promptDraft(draft, prompt.id);
      const choices = prompt.options
        .filter((option) => answer.optionIds.includes(option.id))
        .map((option) => option.label);
      const text = prompt.custom ? answer.response.trim() : "";
      return `${prompts.length > 1 ? `${prompt.label} — ` : ""}${[...choices, ...(text ? [text] : [])].join(", ")}`;
    })
    .join(" · ");
}

/** A closed peek that refuses to re-open for {@link SUPPRESSION_MS}. */
function dismissed(state: PeekState, now: number): PeekState {
  return {
    ...state,
    shown: null,
    pinned: null,
    overCard: false,
    focus: "none",
    suppressedUntil: now + SUPPRESSION_MS,
  };
}

export function peekReducer(state: PeekState, event: PeekEvent): PeekState {
  switch (event.type) {
    case "hover-row":
      // Recorded, never acted on. Two things follow: passing the pointer across
      // a band opens nothing (the view restarts the dwell on every new row),
      // and hovering a DIFFERENT row while one is pinned does not steal the
      // pinned recipient — the answer keeps going where the label says.
      return { ...state, hovered: event.target };

    case "hover-leave-row":
      return { ...state, hovered: null };

    case "dwell-elapsed": {
      if (event.now < state.suppressedUntil) return state;
      // A pin owns the surface until it is released.
      if (state.pinned !== null) return state;
      // The dwell that completes must be the row still under the pointer.
      if (!sameTarget(state.hovered, event.target)) return state;
      return { ...state, shown: event.target };
    }

    case "open-now": {
      if (event.now < state.suppressedUntil) return state;
      if (state.pinned !== null) return state;
      return { ...state, hovered: event.target, shown: event.target };
    }

    case "card-enter":
      return { ...state, overCard: true };

    case "card-leave":
      return { ...state, overCard: false };

    case "grace-elapsed": {
      // The bridge: anything still holding the peek keeps it. A pin holds it
      // even with the pointer on the other side of the window.
      if (state.pinned !== null) return state;
      if (state.hovered !== null || state.overCard) return state;
      // Not a dismissal: drifting away must not suppress the next hover.
      return { ...state, shown: null, focus: "none" };
    }

    case "pin": {
      if (state.send.kind === "sending") return state;
      const switching = !sameTarget(state.pinned, event.target);
      return {
        ...state,
        shown: event.target,
        pinned: event.target,
        // Focus moves HERE and nowhere else. The dialog itself takes it, not
        // the field — options are select-then-Send, and a field that grabs
        // focus on pin is a field that eats the next keystroke.
        focus: "dialog",
        // Re-pinning the same row resumes its half-made answer; pinning another
        // row starts clean, so no text can be sent to a session it was not
        // written for.
        draft: switching ? EMPTY_DRAFT : state.draft,
        questionIndex: switching ? 0 : state.questionIndex,
        send: switching ? { kind: "idle" } : state.send,
      };
    }

    case "unpin":
      if (state.send.kind === "sending") return state;
      // Released, not closed: the card stays as the read-only peek it was
      // before the pin, and focus returns to the row.
      return { ...state, pinned: null, focus: state.shown === null ? "none" : "row" };

    case "select-option":
      if (state.send.kind === "sending" || state.send.kind === "sent") return state;
      return { ...state, draft: selectOption(state.draft, event.prompt, event.optionId) };

    case "type-other":
      if (state.send.kind === "sending" || state.send.kind === "sent") return state;
      return { ...state, draft: setPromptResponse(state.draft, event.promptId, event.text) };

    case "question-step":
      if (state.send.kind === "sending" || state.send.kind === "sent") return state;
      return { ...state, questionIndex: Math.max(0, Math.min(event.index, event.count - 1)) };

    case "fixture-question-changed":
      // A lab switch changes the question behind the same row. Never carry an
      // answer to a different fixture, and do not change an in-flight delivery.
      if (state.send.kind === "sending" || state.send.kind === "sent") return state;
      return { ...state, draft: EMPTY_DRAFT, questionIndex: 0, send: { kind: "idle" } };

    case "focus-field":
      return { ...state, focus: "field" };

    case "blur-field":
      return { ...state, focus: state.pinned === null ? state.focus : "dialog" };

    case "send": {
      if (state.pinned === null) return state;
      // Nothing selected and nothing typed: the form has no answer to send, so
      // Send is inert rather than sending an empty string.
      if (event.answer === null) return state;
      if (state.send.kind === "sending" || state.send.kind === "sent") return state;
      return { ...state, send: { kind: "sending", answer: event.answer } };
    }

    case "send-settled": {
      if (state.send.kind !== "sending" || state.pinned === null) return state;
      const { answer } = state.send;
      if (event.outcome === "failure") {
        // Stays pinned and on screen with the reason. A failed answer that
        // closed the surface would be an answer nobody knows was lost.
        return {
          ...state,
          send: {
            kind: "failed",
            answer,
            reason: event.reason ?? "Send failed.",
          },
        };
      }
      return {
        ...state,
        send: { kind: "sent", answer, at: event.now },
        // The only write in the whole machine — the badge flip and the
        // transcript line are projections of this, so neither can happen
        // before a send.
        delivered: { ...state.delivered, [state.pinned.rowId]: { answer, at: event.now } },
      };
    }

    case "confirmation-elapsed": {
      if (state.send.kind !== "sent") return state;
      return {
        ...state,
        shown: null,
        pinned: null,
        overCard: false,
        focus: "none",
        draft: EMPTY_DRAFT,
        send: { kind: "idle" },
      };
    }

    case "undo": {
      const { [event.rowId]: removed, ...rest } = state.delivered;
      if (removed === undefined) return state;
      return { ...state, delivered: rest };
    }

    case "escape": {
      // The ladder, one rung per press.
      if (state.focus === "field") return { ...state, focus: "dialog" };
      if (state.send.kind === "sending") return state;
      if (state.pinned !== null) {
        return { ...state, pinned: null, focus: state.shown === null ? "none" : "row" };
      }
      if (state.shown !== null) return dismissed(state, event.now);
      return state;
    }

    case "dismiss": {
      // Click-away and list scroll are ignored while pinned: a person answering
      // a question must not lose the form by clicking the thing they are
      // reading. Escape is the way out, and it has its own ladder.
      if (state.pinned !== null) return state;
      if (state.shown === null) return state;
      return dismissed(state, event.now);
    }

    case "open-session":
      // Lab simulation. In the app this navigates; here it only records the
      // intent so the scratch can say what would have happened.
      return { ...state, opened: event.rowId };

    case "clear-opened":
      return { ...state, opened: null };
  }
}

/** Whether the answering form is what the peek is currently showing. */
export function isAnswering(state: PeekState): boolean {
  return state.pinned !== null;
}

/** Whether a row's peek is the one on screen. */
export function isShowing(state: PeekState, target: PeekTarget): boolean {
  return sameTarget(state.shown, target);
}
