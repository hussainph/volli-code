/**
 * The rules the peek was designed from, asserted without a pointer.
 *
 * Ported from the lab's `session-peek-wireframe-model.test.ts`: every test here
 * is a sentence a screenshot could not check — "no accidental open while
 * sweeping rows", "a pin owns the surface", "Esc · click-away · list scroll also
 * close it", "a dismissal is not undone by the pointer still resting on the
 * row". The cases about the fixture's draft, delivery and Undo are gone with
 * those concerns (plan §3.2).
 */
import { describe, expect, it } from "vite-plus/test";

import {
  initialPeekState,
  isPeekShowing,
  peekReducer,
  PEEK_CONFIRMATION_MS,
  PEEK_DWELL_MS,
  PEEK_FOCUS_DWELL_MS,
  PEEK_GRACE_MS,
  PEEK_SUPPRESSION_MS,
  PEEK_WARM_DWELL_MS,
  type PeekEvent,
  type PeekState,
  type PeekTarget,
} from "./peek-machine";

const ROW: PeekTarget = { rowId: "chat:chat-2", surface: "nav" };
const OTHER_ROW: PeekTarget = { rowId: "chat:chat-4", surface: "nav" };
const RAIL_ROW: PeekTarget = { rowId: "chat:chat-2", surface: "rail" };

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

describe("the timings", () => {
  it("names the decided rungs rather than leaving them to a view", () => {
    // D1, and the two the lab left as controls are now constants.
    expect(PEEK_DWELL_MS).toBe(350);
    expect(PEEK_WARM_DWELL_MS).toBe(150);
    expect(PEEK_SUPPRESSION_MS).toBe(1000);
    expect(PEEK_GRACE_MS).toBe(300);
    expect(PEEK_FOCUS_DWELL_MS).toBe(250);
    expect(PEEK_CONFIRMATION_MS).toBe(2000);
    // The warm switch only makes sense as the shorter of the two.
    expect(PEEK_WARM_DWELL_MS).toBeLessThan(PEEK_DWELL_MS);
  });
});

describe("dwell", () => {
  it("does not open on arrival — only when the dwell completes on that row", () => {
    const arrived = run([{ type: "hover-row", target: ROW }]);
    expect(arrived.shown).toBeNull();
    expect(arrived.hovered).toEqual(ROW);

    const dwelt = peekReducer(arrived, { type: "dwell-elapsed", target: ROW, now: 1000 });
    expect(dwelt.shown).toEqual(ROW);
    expect(isPeekShowing(dwelt, ROW)).toBe(true);
    expect(isPeekShowing(dwelt, OTHER_ROW)).toBe(false);
    expect(isPeekShowing(initialPeekState, ROW)).toBe(false);
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

  it("opens nothing when the pointer has left the list entirely", () => {
    const state = run([
      { type: "hover-row", target: ROW },
      { type: "hover-leave-row" },
      { type: "dwell-elapsed", target: ROW, now: 1000 },
    ]);
    expect(state.hovered).toBeNull();
    expect(state.shown).toBeNull();
  });

  it("never takes focus on the hover path", () => {
    expect(run(hoverOpen(ROW)).focus).toBe("none");
  });

  it("opens at once on the keyboard path, still without focus moving", () => {
    const state = run([{ type: "open-now", target: ROW, now: 1000 }]);
    expect(state.shown).toEqual(ROW);
    expect(state.hovered).toEqual(ROW);
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
    expect(state.overCard).toBe(true);
    expect(state.shown).toEqual(ROW);
  });

  it("keeps the peek while the pointer is still on its row", () => {
    const state = run([...hoverOpen(ROW), { type: "card-leave" }, { type: "grace-elapsed" }]);
    expect(state.shown).toEqual(ROW);
  });

  it("closes once the pointer has left both, and does NOT suppress the next hover", () => {
    const state = run([
      ...hoverOpen(ROW),
      { type: "hover-leave-row" },
      { type: "card-enter" },
      { type: "card-leave" },
      { type: "grace-elapsed" },
    ]);
    expect(state.shown).toBeNull();
    expect(state.focus).toBe("none");
    expect(state.suppressedUntil).toBe(0);
  });

  it("refuses to re-open for a second after an explicit dismissal", () => {
    const dismissedAt = 5000;
    const closed = run([
      ...hoverOpen(ROW, 4000),
      { type: "dismiss", reason: "click-away", now: dismissedAt },
    ]);
    expect(closed.shown).toBeNull();
    expect(closed.suppressedUntil).toBe(dismissedAt + PEEK_SUPPRESSION_MS);

    // The pointer never left the row, so the dwell fires again immediately.
    const tooSoon = peekReducer(closed, {
      type: "dwell-elapsed",
      target: ROW,
      now: dismissedAt + PEEK_DWELL_MS,
    });
    expect(tooSoon.shown).toBeNull();
    // And so does the keyboard's own route in.
    expect(
      peekReducer(closed, { type: "open-now", target: ROW, now: dismissedAt + PEEK_DWELL_MS })
        .shown,
    ).toBeNull();

    const later = peekReducer(closed, {
      type: "dwell-elapsed",
      target: ROW,
      now: dismissedAt + PEEK_SUPPRESSION_MS + 1,
    });
    expect(later.shown).toEqual(ROW);
  });

  it("closes on a list scroll as well as a click-away", () => {
    const state = run([...hoverOpen(ROW), { type: "dismiss", reason: "list-scroll", now: 2000 }]);
    expect(state.shown).toBeNull();
    expect(state.suppressedUntil).toBe(2000 + PEEK_SUPPRESSION_MS);
  });

  it("closes on a pointerdown WITHOUT suppressing — a row is a drag source", () => {
    const state = run([...hoverOpen(ROW), { type: "dismiss", reason: "pointer-down", now: 2000 }]);
    expect(state.shown).toBeNull();
    // Nothing is refused afterwards: the drag lands somewhere, and whatever the
    // pointer comes to rest on next still peeks.
    expect(state.suppressedUntil).toBe(0);
  });

  it("has nothing to dismiss when no card is open", () => {
    const state = run([{ type: "hover-row", target: ROW }]);
    expect(peekReducer(state, { type: "dismiss", reason: "click-away", now: 3000 })).toBe(state);
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
    // Nor does the keyboard's open-now steal it.
    expect(peekReducer(state, { type: "open-now", target: OTHER_ROW, now: 4000 }).shown).toEqual(
      ROW,
    );
  });

  it("ignores click-away and scroll, so an answer in progress cannot be lost", () => {
    const pinned = run([...hoverOpen(ROW), { type: "pin", target: ROW }]);
    expect(
      peekReducer(pinned, { type: "dismiss", reason: "click-away", now: 9000 }).pinned,
    ).toEqual(ROW);
    expect(
      peekReducer(pinned, { type: "dismiss", reason: "list-scroll", now: 9000 }).shown,
    ).toEqual(ROW);
    expect(
      peekReducer(pinned, { type: "dismiss", reason: "pointer-down", now: 9000 }).shown,
    ).toEqual(ROW);
  });

  it("moves focus into the dialog, and only on the pin", () => {
    expect(run(hoverOpen(ROW)).focus).toBe("none");
    expect(run([...hoverOpen(ROW), { type: "pin", target: ROW }]).focus).toBe("dialog");
  });

  it("releases to the read-only peek it was, handing focus back to the row", () => {
    const released = run([...hoverOpen(ROW), { type: "pin", target: ROW }, { type: "unpin" }]);
    expect(released.pinned).toBeNull();
    expect(released.shown).toEqual(ROW);
    expect(released.focus).toBe("row");
  });

  it("owns no focus to hand back when the card behind it is already gone", () => {
    const pinnedWithoutCard = run([{ type: "pin", target: ROW }, { type: "grace-elapsed" }]);
    const released = peekReducer({ ...pinnedWithoutCard, shown: null }, { type: "unpin" });
    expect(released.focus).toBe("none");
  });

  it("keeps a field's focus label inside the card, and only while pinned", () => {
    const inField = run([...hoverOpen(ROW), { type: "pin", target: ROW }, { type: "focus-field" }]);
    expect(inField.focus).toBe("field");
    expect(peekReducer(inField, { type: "blur-field" }).focus).toBe("dialog");
    // Unpinned there is no dialog to fall back to, so the label stands.
    const unpinnedField = run([...hoverOpen(ROW), { type: "focus-field" }]);
    expect(peekReducer(unpinnedField, { type: "blur-field" }).focus).toBe("field");
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
    expect(closed.suppressedUntil).toBe(6200 + PEEK_SUPPRESSION_MS);
  });

  it("unpins a card whose peek is already gone without claiming the row's focus", () => {
    const pinned = run([{ type: "pin", target: ROW }]);
    const escaped = peekReducer({ ...pinned, shown: null }, { type: "escape", now: 7000 });
    expect(escaped.pinned).toBeNull();
    expect(escaped.focus).toBe("none");
  });

  it("does nothing when there is nothing open", () => {
    expect(peekReducer(initialPeekState, { type: "escape", now: 1 })).toBe(initialPeekState);
  });
});
