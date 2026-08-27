import { describe, expect, it } from "vite-plus/test";

import { tabDropOrder } from "./tab-reorder";

/** A Home strip mid-sitting; "board" is deliberately NOT among the movable ids. */
const ids = ["terminal-1", "chat:c1", "file:src/app.ts"];

describe("tabDropOrder", () => {
  it("puts the dragged tab where the tab it was dropped on sits", () => {
    expect(tabDropOrder(ids, "file:src/app.ts", "terminal-1")).toEqual({
      movedId: "file:src/app.ts",
      ids: ["file:src/app.ts", "terminal-1", "chat:c1"],
    });
    expect(tabDropOrder(ids, "terminal-1", "file:src/app.ts")).toEqual({
      movedId: "terminal-1",
      ids: ["chat:c1", "file:src/app.ts", "terminal-1"],
    });
  });

  it("refuses a drop on the permanent first tab", () => {
    // The Board / Body tab is not in `ids`, so index 0 cannot be landed on —
    // there is nowhere for the arrangement to put a tab in front of it.
    expect(tabDropOrder(ids, "chat:c1", "board")).toBeNull();
  });

  it("refuses a drop on nothing, and a tab dropped on itself", () => {
    expect(tabDropOrder(ids, "chat:c1", null)).toBeNull();
    expect(tabDropOrder(ids, "chat:c1", "chat:c1")).toBeNull();
  });

  it("refuses a drag of a tab this strip does not draw", () => {
    expect(tabDropOrder(ids, "chat:stale", "terminal-1")).toBeNull();
  });
});
