/**
 * The comparison that keeps an agent's output off the board's render path.
 *
 * This is the regression guard for the canary.8 crash: `Board` re-rendering
 * about once a second per busy terminal is what re-rendered `DndContext` from
 * outside a drag, and that is what let dnd-kit's measure loop run away to
 * React error #185. The hook holds its previous map whenever this says the two
 * agree, so "an agent is still working" stops being a render at all.
 *
 * Tested as a pure function rather than through the hook for the reason
 * `ticket-dialog-host.test.tsx` records: renderer tests server-render once, so
 * re-renders cannot be counted here. What can be pinned down is the predicate
 * the identity hold is built on.
 */
import { describe, expect, it } from "vite-plus/test";

import { sameActivity } from "./use-board-session-activity";

describe("sameActivity", () => {
  it("holds when both maps say the same thing about the same tickets", () => {
    expect(sameActivity({ a: "working", b: "waiting" }, { a: "working", b: "waiting" })).toBe(true);
  });

  it("holds across a rebuild that produced a fresh but equal object", () => {
    // The real shape of the bug: `buildBoardSessionActivity` mints a new object
    // on every output bump, and for most bumps it says exactly what the last
    // one said. Key ORDER is an artifact of which pane bumped, never a change.
    expect(sameActivity({ a: "working", b: "waiting" }, { b: "waiting", a: "working" })).toBe(true);
  });

  it("releases when a ticket's word changes", () => {
    expect(sameActivity({ a: "working" }, { a: "waiting" })).toBe(false);
  });

  it("releases when a ticket starts or stops running", () => {
    expect(sameActivity({}, { a: "working" })).toBe(false);
    expect(sameActivity({ a: "working" }, {})).toBe(false);
  });

  it("releases when one ticket is swapped for another at the same count", () => {
    // Equal sizes, so a length check alone would call these the same map.
    expect(sameActivity({ a: "working" }, { b: "working" })).toBe(false);
  });

  it("says two empty boards agree", () => {
    expect(sameActivity({}, {})).toBe(true);
  });
});
