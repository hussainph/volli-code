import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_CHANGE_KINDS,
  BOARD_RESOURCE_KINDS,
  compareBoardCursors,
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

describe("compareBoardCursors", () => {
  it("orders two cursors of one feed by their sequence", () => {
    expect(compareBoardCursors("3:abc:7", "3:abc:7")).toBe(0);
    expect(compareBoardCursors("3:abc:7", "3:abc:12")).toBeLessThan(0);
    expect(compareBoardCursors("3:abc:12", "3:abc:7")).toBeGreaterThan(0);
    // Numeric, never lexical.
    expect(compareBoardCursors("0:i:10", "0:i:9")).toBeGreaterThan(0);
  });

  it("has no order across feeds: another instance, another epoch, another Workspace", () => {
    expect(compareBoardCursors("3:abc:7", "3:xyz:7")).toBeNull();
    expect(compareBoardCursors("3:abc:7", "4:abc:7")).toBeNull();
    expect(compareBoardCursors("p1:3", "p2:3")).toBeNull();
  });

  it("has no order for a cursor it cannot read", () => {
    for (const bad of [
      "",
      "7",
      ":7",
      "3:abc:",
      "3:abc:x",
      "3:abc:-1",
      "3:abc:1.5",
      "3:abc:99999999999999999999",
    ]) {
      expect(compareBoardCursors(bad, "3:abc:7")).toBeNull();
      expect(compareBoardCursors("3:abc:7", bad)).toBeNull();
    }
  });
});
