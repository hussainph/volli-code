/**
 * Which card inherits the keyboard's place when a journey comes back (VC-419).
 *
 * The cases here are the ones a running board makes expensive to stage and a
 * reader meets routinely: the origin survived, it was filtered out from under
 * them, it was archived or hard-deleted while they were reading it, it was the
 * last card of its column, its whole column emptied. Every one of them is the
 * difference between focus landing somewhere a person can carry on from and
 * focus landing on BODY — the failure VC-322 recorded.
 */
import { describe, expect, it } from "vite-plus/test";

import { restoreFocusTarget, type TicketFocusOrigin } from "./ticket-focus-origin";

const COLUMN = ["a", "b", "c", "d"];

/** An origin as `rememberTicketFocusOrigin` records one: identity plus its neighbourhood. */
function origin(ticketId: string, siblingIds: readonly string[] = COLUMN): TicketFocusOrigin {
  return {
    projectId: "p1",
    ticketId,
    siblingIds,
    index: siblingIds.indexOf(ticketId),
  };
}

describe("restoreFocusTarget", () => {
  it("returns the origin itself whenever the board still shows it", () => {
    expect(restoreFocusTarget(origin("b"), COLUMN)).toBe("b");
  });

  it("returns the origin even when its column no longer holds it — a move is not a removal", () => {
    // The ticket changed status while it was open: same board, different
    // column. Focus follows the TICKET, not the slot it used to sit in.
    expect(restoreFocusTarget(origin("b"), ["a", "c", "d", "b"])).toBe("b");
  });

  it("takes the following card when the origin was filtered out", () => {
    // `c` slid up into the line `b` was on; that is where the eye already is.
    expect(restoreFocusTarget(origin("b"), ["a", "c", "d"])).toBe("c");
  });

  it("takes the following card when the origin was archived or deleted while open", () => {
    // Indistinguishable from a filter here, and deliberately so: both are "the
    // id is no longer shown", which is the only fact this decision needs.
    expect(restoreFocusTarget(origin("c"), ["a", "b", "d"])).toBe("d");
  });

  it("walks backwards when the origin was the last card of its column", () => {
    expect(restoreFocusTarget(origin("d"), ["a", "b", "c"])).toBe("c");
  });

  it("skips neighbours that are gone too, in both directions", () => {
    // A filter that removed `b`, `c` and `d` leaves only the card above.
    expect(restoreFocusTarget(origin("c"), ["a"])).toBe("a");
    // …and one that took everything above `d` still reaches forward first.
    expect(restoreFocusTarget(origin("a", ["a", "b", "c"]), ["c"])).toBe("c");
  });

  it("prefers the following card over the preceding one", () => {
    expect(restoreFocusTarget(origin("b"), ["a", "c"])).toBe("c");
  });

  it("gives up rather than inventing a place when the whole neighbourhood is gone", () => {
    // An emptied column, or a board that is no longer showing any of it: focus
    // is left exactly where it is instead of jumping somewhere arbitrary.
    expect(restoreFocusTarget(origin("b"), [])).toBeNull();
    expect(restoreFocusTarget(origin("b"), ["x", "y"])).toBeNull();
  });

  it("never answers with the origin id itself through the neighbour walk", () => {
    // A `shownIds` that somehow holds the origin is answered by the first
    // branch; the walk below it must not hand back the missing card.
    const stale: TicketFocusOrigin = {
      projectId: "p1",
      ticketId: "b",
      siblingIds: ["b", "b"],
      index: 0,
    };
    expect(restoreFocusTarget(stale, ["a"])).toBeNull();
  });

  it("recovers the index of an origin whose record did not carry one", () => {
    // `index: -1` is what a card that was not among its own mounted siblings
    // records — a row that arrived in the same frame as the keypress.
    const unplaced: TicketFocusOrigin = {
      projectId: "p1",
      ticketId: "c",
      siblingIds: COLUMN,
      index: -1,
    };
    expect(restoreFocusTarget(unplaced, ["a", "b", "d"])).toBe("d");
  });

  it("returns null for an origin that is in neither the shown set nor its own siblings", () => {
    const orphan: TicketFocusOrigin = {
      projectId: "p1",
      ticketId: "z",
      siblingIds: COLUMN,
      index: -1,
    };
    expect(restoreFocusTarget(orphan, COLUMN)).toBeNull();
  });

  it("clamps a recorded index that is past the end of its siblings", () => {
    // A stale record cannot read out of bounds; the backward walk starts from
    // the end of the list it actually has.
    const stale: TicketFocusOrigin = {
      projectId: "p1",
      ticketId: "b",
      siblingIds: ["a", "b"],
      index: 9,
    };
    expect(restoreFocusTarget(stale, ["a"])).toBe("a");
  });
});
