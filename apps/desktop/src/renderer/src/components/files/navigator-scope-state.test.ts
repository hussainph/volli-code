/**
 * What the rail's navigators remember while their page is not on screen
 * (VC-406, the audit's low-priority finding).
 *
 * Three properties, and every one of them is a way this store could quietly
 * lie: the KEY (a folder or a query belongs to one checkout and must never be
 * read into another), the BOUND (a map that only grows is a leak across a long
 * session), and the RESTING state (a navigator at its root with no filter has
 * nothing to restore, and a slot spent on it is a slot taken from a scope that
 * does).
 */
import { describe, expect, it, beforeEach } from "vite-plus/test";

import {
  clearRememberedNavigatorViews,
  EMPTY_NAVIGATOR_VIEW,
  navigatorScopeKey,
  NAVIGATOR_SCOPE_LIMIT,
  readNavigatorView,
  rememberedNavigatorScopeCount,
  writeNavigatorView,
} from "./navigator-scope-state";

beforeEach(() => {
  clearRememberedNavigatorViews();
});

describe("the scope key", () => {
  it("separates Home's Main checkout from a ticket's worktree", () => {
    expect(navigatorScopeKey("files", { projectId: "p1" })).toBe("files:p1");
    expect(navigatorScopeKey("files", { projectId: "p1", ticketId: "t1" })).toBe("files:p1/t1");
  });

  it("separates the three pages, which answer different questions about one checkout", () => {
    const scope = { projectId: "p1", ticketId: "t1" };
    const keys = new Set([
      navigatorScopeKey("files", scope),
      navigatorScopeKey("search", scope),
      navigatorScopeKey("diffs", scope),
    ]);

    expect(keys.size).toBe(3);
  });

  it("keeps two tickets of one project apart", () => {
    expect(navigatorScopeKey("search", { projectId: "p1", ticketId: "t1" })).not.toBe(
      navigatorScopeKey("search", { projectId: "p1", ticketId: "t2" }),
    );
  });
});

describe("what is remembered", () => {
  it("gives a scope nobody has visited the resting state", () => {
    expect(readNavigatorView("search:p1")).toEqual(EMPTY_NAVIGATOR_VIEW);
  });

  it("hands back exactly what was left there", () => {
    writeNavigatorView("search:p1", { cwd: "", filtering: false, query: "needle" });

    expect(readNavigatorView("search:p1")).toEqual({
      cwd: "",
      filtering: false,
      query: "needle",
    });
  });

  it("forgets a state that is the resting one, rather than spending a slot on it", () => {
    writeNavigatorView("files:p1", { cwd: "src", filtering: false, query: "" });
    expect(rememberedNavigatorScopeCount()).toBe(1);

    writeNavigatorView("files:p1", EMPTY_NAVIGATOR_VIEW);

    expect(rememberedNavigatorScopeCount()).toBe(0);
    expect(readNavigatorView("files:p1")).toEqual(EMPTY_NAVIGATOR_VIEW);
  });

  it("holds plain data only — nothing that could keep a watch or a search alive", () => {
    writeNavigatorView("diffs:p1/t1", { cwd: "", filtering: true, query: "a.ts" });

    const held = readNavigatorView("diffs:p1/t1");

    expect(Object.values(held).every((value) => typeof value !== "function")).toBe(true);
    expect(JSON.parse(JSON.stringify(held))).toEqual(held);
  });
});

describe("the bound", () => {
  it("never holds more scopes than its limit, however many are touched", () => {
    for (let index = 0; index < NAVIGATOR_SCOPE_LIMIT * 3; index += 1) {
      writeNavigatorView(`files:p${index}`, { cwd: "src", filtering: false, query: "" });
    }

    expect(rememberedNavigatorScopeCount()).toBe(NAVIGATOR_SCOPE_LIMIT);
  });

  it("evicts the least recently touched scope, and a READ counts as touching", () => {
    for (let index = 0; index < NAVIGATOR_SCOPE_LIMIT; index += 1) {
      writeNavigatorView(`files:p${index}`, { cwd: `dir${index}`, filtering: false, query: "" });
    }
    // The oldest entry is the eviction candidate — until someone looks at it.
    expect(readNavigatorView("files:p0").cwd).toBe("dir0");

    writeNavigatorView("files:new", { cwd: "fresh", filtering: false, query: "" });

    expect(readNavigatorView("files:p0").cwd).toBe("dir0");
    // `p1` is the oldest now, and it is the one that went.
    expect(readNavigatorView("files:p1")).toEqual(EMPTY_NAVIGATOR_VIEW);
    expect(rememberedNavigatorScopeCount()).toBe(NAVIGATOR_SCOPE_LIMIT);
  });
});
