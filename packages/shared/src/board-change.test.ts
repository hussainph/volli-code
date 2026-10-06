import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_CHANGE_KINDS,
  BOARD_RESOURCE_KINDS,
  FEED_RESNAPSHOT_REQUIRED,
  FeedResnapshotRequiredError,
  isFeedResnapshotRequired,
} from "./board-change";

describe("the board's change-feed vocabulary", () => {
  it("names a closed set of kinds and resources", () => {
    expect(BOARD_CHANGE_KINDS).toEqual(["project", "ticket", "label", "comment", "ticketEvent"]);
    expect(Object.isFrozen(BOARD_RESOURCE_KINDS)).toBe(true);
    expect(Object.values(BOARD_RESOURCE_KINDS)).toEqual(["ticket", "comment", "label"]);
  });

  it("brands a cursor that cannot resume, across module instances", () => {
    const error = new FeedResnapshotRequiredError();
    expect(isFeedResnapshotRequired(error)).toBe(true);
    expect(error.name).toBe("FeedResnapshotRequiredError");
    expect(error.message).toMatch(/snapshot/);
    expect(new FeedResnapshotRequiredError("gone").message).toBe("gone");
    expect(FEED_RESNAPSHOT_REQUIRED).toBe(Symbol.for("@volli/feed-resnapshot-required"));
    expect(isFeedResnapshotRequired({ [FEED_RESNAPSHOT_REQUIRED]: true })).toBe(true);
    for (const other of [new Error("x"), null, undefined, "x", 1, {}]) {
      expect(isFeedResnapshotRequired(other)).toBe(false);
    }
  });
});
