import { describe, expect, it } from "vite-plus/test";

import {
  arrangeTabs,
  EMPTY_TAB_ORDER,
  movedTabOrder,
  renamedTabOrder,
  sanitizeTabOrder,
  type OrderedTab,
} from "./tab-order";

/** Composed strips are lists of descriptors; only `id` is this model's business. */
function tabs(...ids: readonly string[]): readonly OrderedTab[] {
  return ids.map((id) => ({ id }));
}

function drawn(arranged: readonly OrderedTab[]): readonly string[] {
  return arranged.map((tab) => tab.id);
}

describe("arrangeTabs", () => {
  const home = tabs("board", "terminal-1", "chat:1", "file:a.ts", "file:b.ts");

  it("returns the composed order by identity when there is no arrangement", () => {
    expect(arrangeTabs(home, EMPTY_TAB_ORDER, 1)).toBe(home);
  });

  it("sorts the movable tabs by the overlay", () => {
    const order = ["file:b.ts", "chat:1", "file:a.ts", "terminal-1"];
    expect(drawn(arrangeTabs(home, order, 1))).toEqual([
      "board",
      "file:b.ts",
      "chat:1",
      "file:a.ts",
      "terminal-1",
    ]);
  });

  it("keeps the permanent leading tab first however the overlay names it", () => {
    const order = ["file:a.ts", "board", "terminal-1"];
    expect(drawn(arrangeTabs(home, order, 1))[0]).toBe("board");
  });

  it("appends tabs the overlay does not name, in composed order", () => {
    const order = ["file:b.ts"];
    expect(drawn(arrangeTabs(home, order, 1))).toEqual([
      "board",
      "file:b.ts",
      "terminal-1",
      "chat:1",
      "file:a.ts",
    ]);
  });

  it("leaves the strip alone when the overlay names none of its tabs", () => {
    const order = ["chat:gone", "file:closed.ts"];
    expect(arrangeTabs(home, order, 1)).toBe(home);
  });

  it("arranges an overlay that is older than the strip, ids it lost and all", () => {
    // The VC-105 shape: two of the three ids are Sessions that have not come
    // back yet. The one that is here still lands where it was put.
    const strip = tabs("board", "chat:c", "file:a.ts");
    const order = ["chat:c", "chat:gone", "terminal-gone", "file:a.ts"];
    expect(drawn(arrangeTabs(strip, order, 1))).toEqual(["board", "chat:c", "file:a.ts"]);
  });

  it("moves every tab when no leading tab is permanent", () => {
    expect(drawn(arrangeTabs(tabs("a", "b"), ["b", "a"]))).toEqual(["b", "a"]);
  });
});

describe("movedTabOrder", () => {
  const strip = ["a", "b", "c"];

  it("drops the moved id into its new index", () => {
    expect(movedTabOrder(strip, "a", 2)).toEqual(["b", "c", "a"]);
    expect(movedTabOrder(strip, "c", 0)).toEqual(["c", "a", "b"]);
  });

  it("clamps an index past either end", () => {
    expect(movedTabOrder(strip, "a", 9)).toEqual(["b", "c", "a"]);
    expect(movedTabOrder(strip, "c", -2)).toEqual(["c", "a", "b"]);
  });

  it("returns the strip by identity for a drop that changed nothing", () => {
    expect(movedTabOrder(strip, "b", 1)).toBe(strip);
    expect(movedTabOrder(strip, "missing", 0)).toBe(strip);
  });
});

describe("renamedTabOrder", () => {
  const strip = ["file:a.ts", "chat:c1", "file:b.ts"];

  it("follows a tab to its new id without moving it", () => {
    expect(renamedTabOrder(strip, "file:a.ts", "file:renamed.ts")).toEqual([
      "file:renamed.ts",
      "chat:c1",
      "file:b.ts",
    ]);
  });

  it("absorbs a mention already sitting on the destination id", () => {
    // `renameFile` absorbs a stale tab on the destination path rather than
    // leaving two tabs for one file; the arrangement says the same thing.
    expect(renamedTabOrder(strip, "file:a.ts", "file:b.ts")).toEqual(["file:b.ts", "chat:c1"]);
  });

  it("returns the order by identity when it does not name the old id", () => {
    expect(renamedTabOrder(strip, "file:gone.ts", "file:new.ts")).toBe(strip);
    expect(renamedTabOrder(strip, "file:a.ts", "file:a.ts")).toBe(strip);
    expect(renamedTabOrder(EMPTY_TAB_ORDER, "file:a.ts", "file:b.ts")).toBe(EMPTY_TAB_ORDER);
  });
});

describe("sanitizeTabOrder", () => {
  it("keeps ids in order, dropping anything that is not a usable id", () => {
    expect(sanitizeTabOrder(["file:a.ts", 7, null, "", { id: "x" }, "chat:1"])).toEqual([
      "file:a.ts",
      "chat:1",
    ]);
  });

  it("collapses a duplicate onto its first mention", () => {
    expect(sanitizeTabOrder(["a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("degrades a shape that is not a list, and one that holds nothing usable", () => {
    expect(sanitizeTabOrder(undefined)).toBe(EMPTY_TAB_ORDER);
    expect(sanitizeTabOrder({ 0: "a" })).toBe(EMPTY_TAB_ORDER);
    expect(sanitizeTabOrder([1, 2])).toBe(EMPTY_TAB_ORDER);
  });

  it("never prunes an id merely because nothing on screen answers to it", () => {
    // The whole point of the tolerant read: a Session that has not hydrated
    // looks exactly like a Session that is gone, and only one of those may
    // lose its place.
    expect(sanitizeTabOrder(["chat:not-hydrated-yet"])).toEqual(["chat:not-hydrated-yet"]);
  });

  it("is stable under a second pass", () => {
    const once = sanitizeTabOrder(["a", "b", "a", 3]);
    expect(sanitizeTabOrder(once)).toEqual(once);
  });
});
