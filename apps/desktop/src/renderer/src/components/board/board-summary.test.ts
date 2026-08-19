import { describe, expect, it } from "vite-plus/test";

import { boardSummary } from "./board-summary";
import type { TicketSessionActivity } from "./board-session-activity";

function summary(
  visible: number,
  total: number,
  activityByTicket: Record<string, TicketSessionActivity> = {},
) {
  return boardSummary({ visible, total, activityByTicket });
}

describe("the count", () => {
  it("is the bare total while the whole board is on screen", () => {
    expect(summary(12, 12).count).toBe("12");
  });

  it("states the filter's effect the moment one narrows the board", () => {
    expect(summary(3, 12).count).toBe("3 of 12");
  });

  it("says a filter matched nothing rather than going quiet", () => {
    expect(summary(0, 12).count).toBe("0 of 12");
  });

  it("says nothing at all about an empty board — its empty state speaks for it", () => {
    expect(summary(0, 0).count).toBeNull();
  });
});

describe("live work", () => {
  it("counts the two states a card can be in", () => {
    expect(summary(9, 9, { a: "working", b: "waiting", c: "working" })).toMatchObject({
      working: 2,
      waiting: 1,
    });
  });

  it("is zero when nothing is running", () => {
    expect(summary(9, 9)).toMatchObject({ working: 0, waiting: 0 });
  });

  it("counts the whole board, not the filtered view", () => {
    // The one reading nobody can afford to lose behind a chip is "an agent is
    // waiting for you" — so a filter narrows the count and never the pulse.
    expect(summary(1, 9, { a: "waiting", b: "working" })).toMatchObject({
      count: "1 of 9",
      working: 1,
      waiting: 1,
    });
  });
});
