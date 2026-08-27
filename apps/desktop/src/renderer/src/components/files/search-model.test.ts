/**
 * The Search page's decisions (VC-193, plan §4.7) — the scope a query is sent
 * under, what a result is grouped into, and the sentence a capped search owes
 * the person reading it.
 */
import { describe, expect, it } from "vite-plus/test";

import type { FileSearchMatch } from "../../../../ipc/contract";
import {
  searchGroups,
  searchHighlight,
  searchInput,
  searchMatchKey,
  searchQuery,
  searchRevealTarget,
  searchSummary,
  searchTruncationNote,
} from "./search-model";

function match(over: Partial<FileSearchMatch> = {}): FileSearchMatch {
  return { line: 12, column: 7, preview: "const needle = 1;", start: 6, end: 12, ...over };
}

describe("searchQuery", () => {
  it("trims what is worth sending", () => {
    expect(searchQuery("  needle  ")).toBe("needle");
  });

  it("treats an empty or whitespace box as no question at all", () => {
    expect(searchQuery("")).toBeNull();
    expect(searchQuery("   ")).toBeNull();
  });
});

describe("searchInput", () => {
  it("sends Home's scope as the project alone — the main checkout", () => {
    expect(searchInput({ kind: "home", projectId: "p1" }, "needle")).toEqual({
      projectId: "p1",
      query: "needle",
    });
  });

  it("sends a Ticket workspace's own pair, so the search runs in its worktree", () => {
    expect(searchInput({ kind: "ticket", projectId: "p1", ticketId: "t1" }, "needle")).toEqual({
      projectId: "p1",
      ticketId: "t1",
      query: "needle",
    });
  });
});

describe("searchGroups", () => {
  it("names each file and the folder that disambiguates it", () => {
    expect(
      searchGroups([
        { relPath: "src/components/row.tsx", matches: [match()] },
        { relPath: "README.md", matches: [match(), match({ line: 40 })] },
      ]),
    ).toEqual([
      {
        relPath: "src/components/row.tsx",
        name: "row.tsx",
        dir: "src/components",
        matches: [match()],
      },
      { relPath: "README.md", name: "README.md", dir: "", matches: [match(), match({ line: 40 })] },
    ]);
  });
});

describe("searchSummary", () => {
  it("counts matches and files, in the singular where there is one of them", () => {
    expect(searchSummary({ matches: 1, files: ["a"], limit: "none" })).toBe("1 match in 1 file");
    expect(searchSummary({ matches: 4, files: ["a", "b"], limit: "none" })).toBe(
      "4 matches in 2 files",
    );
  });

  // The 1 MiB read cap's posture: a number that is not the answer to the
  // question asked has to say so in the same breath.
  it("says a capped count is only the first of them", () => {
    expect(searchSummary({ matches: 500, files: ["a"], limit: "matches" })).toBe(
      "First 500 matches in 1 file",
    );
  });

  it("says a search that ran out of time did", () => {
    expect(searchSummary({ matches: 12, files: ["a"], limit: "time" })).toBe(
      "12 matches in 1 file before the search ran out of time",
    );
  });
});

describe("searchTruncationNote", () => {
  it("says nothing when nothing was cut", () => {
    expect(searchTruncationNote("none")).toBeNull();
  });

  it("names the consequence rather than the constant", () => {
    expect(searchTruncationNote("matches")).toBe("There may be more matches than these.");
    expect(searchTruncationNote("time")).toBe(
      "The search stopped early; there may be more matches.",
    );
  });
});

describe("searchHighlight", () => {
  it("splits a preview on main's own offsets rather than re-finding the query", () => {
    expect(searchHighlight(match())).toEqual({
      before: "const ",
      hit: "needle",
      after: " = 1;",
    });
  });

  it("drops an indented line's leading whitespace and moves the offsets with it", () => {
    expect(
      searchHighlight(match({ preview: "      const needle = 1;", start: 12, end: 18 })),
    ).toEqual({ before: "const ", hit: "needle", after: " = 1;" });
  });

  it("never inverts a range a windowed preview clipped", () => {
    const clipped = searchHighlight(match({ preview: "    needle", start: 2, end: 1 }));
    expect(clipped.hit).toBe("");
    expect(clipped.before + clipped.hit + clipped.after).toBe("needle");
  });
});

describe("searchRevealTarget", () => {
  // The query's length, not the preview's: a windowed preview can carry a
  // clipped copy of the match, and a selection built from it would stop short.
  it("lands on the match with the typed query's own length", () => {
    expect(searchRevealTarget(match(), "needle")).toEqual({ line: 12, column: 7, length: 6 });
  });
});

describe("searchMatchKey", () => {
  it("distinguishes two matches on one line of one file", () => {
    expect(searchMatchKey("a.ts", match())).toBe("a.ts:12:7");
    expect(searchMatchKey("a.ts", match({ column: 30 }))).toBe("a.ts:12:30");
  });
});
