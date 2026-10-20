/**
 * The rules the wireframe argues about, asserted without a pointer.
 *
 * Every test here is a sentence from `hover-peek-wireframe.excalidraw` v2 that
 * a screenshot could not check: "no accidental answers while sweeping rows",
 * "the answer goes to the pinned session", "Esc · click-away · list scroll also
 * close it", "on failure stay pinned + show the error". The view's timers and
 * geometry are not in scope — those are judged in the lab by hand.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DWELL,
  draftAnswer,
  initialPeekState,
  MESSAGE_PROMPT_ID,
  peekReducer,
  SUPPRESSION_MS,
  type PeekEvent,
  type PeekState,
  type PeekTarget,
} from "./session-peek-wireframe-model";

const ROW: PeekTarget = { rowId: "session-2", surface: "nav" };
const OTHER_ROW: PeekTarget = { rowId: "session-4", surface: "nav" };
const RAIL_ROW: PeekTarget = { rowId: "session-2", surface: "rail" };

const OPTIONS = [
  { id: "redis", label: "Redis — fast, adds a dependency", description: "Fast" },
  { id: "postgres", label: "Postgres — slower, no new infra", description: "No new service" },
] as const;
const PROMPT = {
  id: "cache",
  label: "Choose a cache",
  detail: null,
  options: OPTIONS,
  multiple: false,
  custom: true,
} as const;
const CHOICES = { ...PROMPT, custom: false };
const select = (optionId: string): PeekEvent => ({
  type: "select-option",
  prompt: PROMPT,
  optionId,
});
const type = (text: string): PeekEvent => ({ type: "type-other", promptId: PROMPT.id, text });

function run(events: readonly PeekEvent[], from: PeekState = initialPeekState): PeekState {
  return events.reduce(peekReducer, from);
}

/** Hover a row and wait out its dwell — the pointer path, in two events. */
function hoverOpen(target: PeekTarget, now = 1000): PeekEvent[] {
  return [
    { type: "hover-row", target },
    { type: "dwell-elapsed", target, now },
  ];
}

describe("dwell", () => {
  it("does not open on arrival — only when the dwell completes on that row", () => {
    const arrived = run([{ type: "hover-row", target: ROW }]);
    expect(arrived.shown).toBeNull();

    const dwelt = peekReducer(arrived, { type: "dwell-elapsed", target: ROW, now: 1000 });
    expect(dwelt.shown).toEqual(ROW);
  });

  it("opens nothing when the pointer passed through to another row", () => {
    // The sweep: arrive on 2, arrive on 4, and 2's dwell lands late.
    const state = run([
      { type: "hover-row", target: ROW },
      { type: "hover-row", target: OTHER_ROW },
      { type: "dwell-elapsed", target: ROW, now: 1000 },
    ]);
    expect(state.shown).toBeNull();
  });

  it("never takes focus on the hover path", () => {
    expect(run(hoverOpen(ROW)).focus).toBe("none");
  });

  it("opens at once on the keyboard path, still without focus moving", () => {
    const state = run([{ type: "open-now", target: ROW, now: 1000 }]);
    expect(state.shown).toEqual(ROW);
    expect(state.focus).toBe("none");
  });

  it("has one peek at a time, whichever sidebar the row is in", () => {
    const state = run([...hoverOpen(ROW), ...hoverOpen(RAIL_ROW, 2000)]);
    expect(state.shown).toEqual(RAIL_ROW);
  });
});

describe("the row→card bridge and dismissal", () => {
  it("keeps the peek while the pointer is crossing into the card", () => {
    const state = run([
      ...hoverOpen(ROW),
      { type: "hover-leave-row" },
      { type: "card-enter" },
      { type: "grace-elapsed" },
    ]);
    expect(state.shown).toEqual(ROW);
  });

  it("closes once the pointer has left both, and does NOT suppress the next hover", () => {
    const state = run([
      ...hoverOpen(ROW),
      { type: "hover-leave-row" },
      { type: "card-leave" },
      { type: "grace-elapsed" },
    ]);
    expect(state.shown).toBeNull();
    expect(state.suppressedUntil).toBe(0);
  });

  it("refuses to re-open for a second after an explicit dismissal", () => {
    const dismissedAt = 5000;
    const closed = run([
      ...hoverOpen(ROW, 4000),
      { type: "dismiss", reason: "click-away", now: dismissedAt },
    ]);
    expect(closed.shown).toBeNull();
    expect(closed.suppressedUntil).toBe(dismissedAt + SUPPRESSION_MS);

    // The pointer never left the row, so the dwell fires again immediately.
    const tooSoon = peekReducer(closed, {
      type: "dwell-elapsed",
      target: ROW,
      now: dismissedAt + DEFAULT_DWELL,
    });
    expect(tooSoon.shown).toBeNull();

    const later = peekReducer(closed, {
      type: "dwell-elapsed",
      target: ROW,
      now: dismissedAt + SUPPRESSION_MS + 1,
    });
    expect(later.shown).toEqual(ROW);
  });

  it("closes on a list scroll as well as a click-away", () => {
    const state = run([...hoverOpen(ROW), { type: "dismiss", reason: "list-scroll", now: 2000 }]);
    expect(state.shown).toBeNull();
  });
});

describe("the pin", () => {
  it("survives the pointer walking off the row and the card", () => {
    const state = run([
      ...hoverOpen(ROW),
      { type: "pin", target: ROW },
      { type: "hover-leave-row" },
      { type: "card-leave" },
      { type: "grace-elapsed" },
    ]);
    expect(state.pinned).toEqual(ROW);
    expect(state.shown).toEqual(ROW);
  });

  it("does not hand the surface to another row that is hovered", () => {
    const state = run([
      ...hoverOpen(ROW),
      { type: "pin", target: ROW },
      ...hoverOpen(OTHER_ROW, 3000),
    ]);
    expect(state.shown).toEqual(ROW);
    expect(state.pinned).toEqual(ROW);
    // The other row still knows it is hovered — it draws its own fill.
    expect(state.hovered).toEqual(OTHER_ROW);
  });

  it("ignores click-away and scroll, so an answer in progress cannot be lost", () => {
    const pinned = run([...hoverOpen(ROW), { type: "pin", target: ROW }]);
    expect(
      peekReducer(pinned, { type: "dismiss", reason: "click-away", now: 9000 }).pinned,
    ).toEqual(ROW);
    expect(
      peekReducer(pinned, { type: "dismiss", reason: "list-scroll", now: 9000 }).shown,
    ).toEqual(ROW);
  });

  it("moves focus into the dialog, and only on the pin", () => {
    expect(run(hoverOpen(ROW)).focus).toBe("none");
    expect(run([...hoverOpen(ROW), { type: "pin", target: ROW }]).focus).toBe("dialog");
  });

  it("keeps a half-made answer when re-pinned, and drops it when the recipient changes", () => {
    const drafted = run([
      ...hoverOpen(ROW),
      { type: "pin", target: ROW },
      type("Postgres, and note the reason in the PR"),
    ]);
    expect(peekReducer(drafted, { type: "pin", target: ROW }).draft.cache?.response).toContain(
      "Postgres",
    );

    const moved = peekReducer(drafted, { type: "pin", target: OTHER_ROW });
    expect(moved.draft).toEqual({});
    expect(moved.questionIndex).toBe(0);
  });
});

describe("answering", () => {
  const pinned = run([...hoverOpen(ROW), { type: "pin", target: ROW }]);

  it("selects without sending — nothing reaches the session until Send", () => {
    const selected = peekReducer(pinned, select("postgres"));
    expect(selected.draft.cache?.optionIds).toEqual(["postgres"]);
    expect(selected.delivered).toEqual({});
    expect(selected.send).toEqual({ kind: "idle" });
  });

  it("keeps the recipient locked until an in-flight send settles", () => {
    const sending = peekReducer(pinned, { type: "send", answer: "Postgres" });
    expect(peekReducer(sending, { type: "pin", target: OTHER_ROW })).toBe(sending);
    expect(peekReducer(sending, { type: "unpin" })).toBe(sending);
    expect(peekReducer(sending, { type: "escape", now: 4000 })).toBe(sending);
    const sent = peekReducer(sending, { type: "send-settled", outcome: "success", now: 4000 });
    expect(sent.delivered[ROW.rowId]?.answer).toBe("Postgres");
    expect(peekReducer(sent, { type: "send", answer: "Redis" })).toBe(sent);
  });

  it("refuses a Send with nothing selected and nothing typed", () => {
    expect(peekReducer(pinned, { type: "send", answer: null }).send).toEqual({ kind: "idle" });
  });

  it("keeps declared custom text separate from a selected option", () => {
    const typed = peekReducer(pinned, type("Neither — use the filesystem"));
    expect(typed.draft.cache?.response).toBe("Neither — use the filesystem");
    expect(draftAnswer(typed.draft, [PROMPT])).toBe("Neither — use the filesystem");
  });

  it("delivers to the PINNED session even if the pointer is elsewhere", () => {
    const sent = run(
      [
        select("postgres"),
        ...hoverOpen(OTHER_ROW, 3000),
        { type: "send", answer: "Postgres — slower, no new infra" },
        { type: "send-settled", outcome: "success", now: 4000 },
      ],
      pinned,
    );
    expect(Object.keys(sent.delivered)).toEqual([ROW.rowId]);
    expect(sent.delivered[ROW.rowId]?.answer).toBe("Postgres — slower, no new infra");
  });

  it("holds the confirmation until it elapses, then closes and resets", () => {
    const sent = run(
      [
        select("redis"),
        { type: "send", answer: "Redis — fast, adds a dependency" },
        { type: "send-settled", outcome: "success", now: 4000 },
      ],
      pinned,
    );
    expect(sent.send.kind).toBe("sent");
    expect(sent.shown).toEqual(ROW);

    const closed = peekReducer(sent, { type: "confirmation-elapsed" });
    expect(closed.shown).toBeNull();
    expect(closed.pinned).toBeNull();
    expect(closed.send).toEqual({ kind: "idle" });
    // The delivery outlives the surface — that is what the receipt is drawn from.
    expect(closed.delivered[ROW.rowId]?.answer).toBe("Redis — fast, adds a dependency");
  });

  it("stays pinned and visible on failure, with the reason and no delivery", () => {
    const failed = run(
      [
        select("postgres"),
        { type: "send", answer: "Postgres — slower, no new infra" },
        {
          type: "send-settled",
          outcome: "failure",
          now: 4000,
          reason: "Question superseded — the session asked something else.",
        },
      ],
      pinned,
    );
    expect(failed.pinned).toEqual(ROW);
    expect(failed.shown).toEqual(ROW);
    expect(failed.send).toEqual({
      kind: "failed",
      answer: "Postgres — slower, no new infra",
      reason: "Question superseded — the session asked something else.",
    });
    expect(failed.delivered).toEqual({});
    // And it survives everything that closes an unpinned peek.
    expect(peekReducer(failed, { type: "dismiss", reason: "click-away", now: 5000 }).shown).toEqual(
      ROW,
    );
  });

  it("drops the fixture delivery on Undo — the simulated retraction", () => {
    const sent = run(
      [
        select("redis"),
        { type: "send", answer: "Redis — fast, adds a dependency" },
        { type: "send-settled", outcome: "success", now: 4000 },
        { type: "confirmation-elapsed" },
      ],
      pinned,
    );
    const undone = peekReducer(sent, { type: "undo", rowId: ROW.rowId });
    expect(undone.delivered).toEqual({});
    // Undoing something that was never delivered changes nothing.
    expect(peekReducer(undone, { type: "undo", rowId: ROW.rowId })).toBe(undone);
  });
});

describe("the Escape ladder", () => {
  it("steps field → dialog → unpin → close, restoring focus to the row", () => {
    const inField = run([...hoverOpen(ROW), { type: "pin", target: ROW }, { type: "focus-field" }]);

    const outOfField = peekReducer(inField, { type: "escape", now: 6000 });
    expect(outOfField.focus).toBe("dialog");
    expect(outOfField.pinned).toEqual(ROW);

    const unpinned = peekReducer(outOfField, { type: "escape", now: 6100 });
    expect(unpinned.pinned).toBeNull();
    expect(unpinned.shown).toEqual(ROW);
    expect(unpinned.focus).toBe("row");

    const closed = peekReducer(unpinned, { type: "escape", now: 6200 });
    expect(closed.shown).toBeNull();
    expect(closed.focus).toBe("none");
    expect(closed.suppressedUntil).toBe(6200 + SUPPRESSION_MS);
  });

  it("does nothing when there is nothing open", () => {
    expect(peekReducer(initialPeekState, { type: "escape", now: 1 })).toBe(initialPeekState);
  });
});

describe("draftAnswer", () => {
  it("requires each prompt and respects custom capability", () => {
    expect(draftAnswer({}, [PROMPT])).toBeNull();
    expect(draftAnswer({ cache: { optionIds: [], response: "sqlite" } }, [CHOICES])).toBeNull();
    expect(
      draftAnswer({ cache: { optionIds: ["redis"], response: "stale custom text" } }, [CHOICES]),
    ).toBe("Redis — fast, adds a dependency");
    expect(draftAnswer({ cache: { optionIds: [], response: " sqlite " } }, [PROMPT])).toBe(
      "sqlite",
    );
    expect(draftAnswer({ [MESSAGE_PROMPT_ID]: { optionIds: [], response: " hello " } }, [])).toBe(
      "hello",
    );
  });

  it("formats multiple choices and questions from declared labels, not descriptions", () => {
    const multi = { ...CHOICES, multiple: true };
    const next = { ...CHOICES, id: "rollout", label: "Rollout" };
    const draft = {
      cache: { optionIds: ["redis", "postgres"], response: "" },
      rollout: { optionIds: ["redis"], response: "" },
    };
    expect(draftAnswer(draft, [multi, next])).toBe(
      "Choose a cache — Redis — fast, adds a dependency, Postgres — slower, no new infra · Rollout — Redis — fast, adds a dependency",
    );
    expect(draftAnswer({ cache: draft.cache }, [multi, next])).toBeNull();
  });

  it("resets the lab's changed question without leaking a draft to another capability", () => {
    const pinned = run([...hoverOpen(ROW), { type: "pin", target: ROW }]);
    const drafted = run([select("redis"), { type: "question-step", index: 1, count: 2 }], pinned);
    const changed = peekReducer(drafted, { type: "fixture-question-changed" });
    expect(changed.draft).toEqual({});
    expect(changed.questionIndex).toBe(0);
    expect(changed.send.kind).toBe("idle");
    const sending = peekReducer(drafted, { type: "send", answer: "Redis" });
    expect(peekReducer(sending, { type: "fixture-question-changed" })).toBe(sending);
  });

  it("keeps steps and drafts while navigating, and never sends on selection", () => {
    const pinned = run([...hoverOpen(ROW), { type: "pin", target: ROW }]);
    const selected = run(
      [
        select("redis"),
        { type: "question-step", index: 1, count: 2 },
        { type: "question-step", index: 0, count: 2 },
      ],
      pinned,
    );
    expect(selected.draft.cache?.optionIds).toEqual(["redis"]);
    expect(selected.questionIndex).toBe(0);
    expect(selected.delivered).toEqual({});
    const multi = { ...CHOICES, multiple: true };
    const toggled = run(
      [
        { type: "select-option", prompt: multi, optionId: "redis" },
        { type: "select-option", prompt: multi, optionId: "postgres" },
        { type: "select-option", prompt: multi, optionId: "redis" },
      ],
      pinned,
    );
    expect(toggled.draft.cache?.optionIds).toEqual(["postgres"]);
  });
});

describe("open session", () => {
  it("records the simulated navigation rather than performing one", () => {
    const opened = peekReducer(initialPeekState, { type: "open-session", rowId: ROW.rowId });
    expect(opened.opened).toBe(ROW.rowId);
    expect(peekReducer(opened, { type: "clear-opened" }).opened).toBeNull();
  });
});
