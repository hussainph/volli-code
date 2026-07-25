import type { IndexedFile } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { fileRefTokenAt, rankFileRefCompletions, renderFileRefChips } from "./file-refs";

function indexed(relPath: string, artifact = false): IndexedFile {
  return { relPath, artifact };
}

describe("fileRefTokenAt", () => {
  it("matches an `@` token at the start of the document", () => {
    expect(fileRefTokenAt({ text: "@src/a.ts", offset: 9 })).toEqual({
      from: 0,
      to: 9,
      query: "src/a.ts",
    });
  });

  it("matches a bare `@` with nothing typed yet", () => {
    expect(fileRefTokenAt({ text: "see @", offset: 5 })).toEqual({ from: 4, to: 5, query: "" });
  });

  it("matches after whitespace and after an opening paren", () => {
    expect(fileRefTokenAt({ text: "see @a.md", offset: 9 })?.query).toBe("a.md");
    expect(fileRefTokenAt({ text: "(@a.md", offset: 6 })?.query).toBe("a.md");
    expect(fileRefTokenAt({ text: "one\n@a.md", offset: 9 })?.query).toBe("a.md");
  });

  it("refuses an `@` glued to a word — an email is not a file ref", () => {
    expect(fileRefTokenAt({ text: "me@host.com", offset: 11 })).toBeNull();
  });

  it("is null when there is no `@` before the caret at all", () => {
    expect(fileRefTokenAt({ text: "plain words", offset: 11 })).toBeNull();
    expect(fileRefTokenAt({ text: "", offset: 0 })).toBeNull();
  });

  it("stops at the caret, so the tail of a token is not part of the query", () => {
    expect(fileRefTokenAt({ text: "@src/a.ts", offset: 4 })).toEqual({
      from: 0,
      to: 4,
      query: "src",
    });
  });

  it("clamps an out-of-range offset instead of reading past the text", () => {
    expect(fileRefTokenAt({ text: "@a.md", offset: 99 })?.query).toBe("a.md");
    expect(fileRefTokenAt({ text: "@a.md", offset: -1 })).toBeNull();
  });
});

describe("rankFileRefCompletions", () => {
  const index = [
    indexed("src/board/card.tsx"),
    indexed(".volli/artifacts/plan.md", true),
    indexed("docs/plan-b.md"),
  ];

  it("inserts the full `@relPath` and shows basename over directory", () => {
    const first = rankFileRefCompletions({ query: "card", index }).find(
      (entry) => entry.kind === "file",
    );
    expect(first).toMatchObject({
      kind: "file",
      label: "card.tsx",
      detail: "src/board",
      insertText: "@src/board/card.tsx",
    });
  });

  it("ranks artifacts above ordinary files for the same query", () => {
    const results = rankFileRefCompletions({ query: "plan", index });
    expect(results.map((entry) => entry.insertText)).toEqual([
      "@.volli/artifacts/plan.md",
      "@docs/plan-b.md",
    ]);
  });

  it("drops paths the ref grammar cannot express", () => {
    // A space truncates the token, so `@my notes.md` would never parse back.
    const results = rankFileRefCompletions({ query: "notes", index: [indexed("my notes.md")] });
    expect(results.some((entry) => entry.kind === "file")).toBe(false);
  });

  it("caps the list at 50 — it is a peek surface, not a search", () => {
    const many = Array.from({ length: 80 }, (_, n) => indexed(`docs/file-${n}.md`));
    const results = rankFileRefCompletions({ query: "file", index: many });
    expect(results.filter((entry) => entry.kind === "file")).toHaveLength(50);
  });

  it("pins a Create artifact row above every match", () => {
    const results = rankFileRefCompletions({ query: "plan", index });
    expect(results[0].kind).toBe("file");
    const withNewName = rankFileRefCompletions({ query: "roadmap", index });
    expect(withNewName[0]).toMatchObject({
      kind: "create",
      name: "roadmap",
      relPath: ".volli/artifacts/roadmap.md",
      insertText: "@.volli/artifacts/roadmap.md",
      label: 'Create artifact "roadmap.md"',
    });
    expect(withNewName[0].sortText < (withNewName[1]?.sortText ?? "z")).toBe(true);
  });

  it("omits the Create row when that exact artifact already exists", () => {
    const results = rankFileRefCompletions({ query: "plan.md", index });
    expect(results.some((entry) => entry.kind === "create")).toBe(false);
  });

  it("omits the Create row for a name no artifact may have", () => {
    expect(
      rankFileRefCompletions({ query: "../escape", index }).some((e) => e.kind === "create"),
    ).toBe(false);
  });

  it("gives every row the same filter text so Monaco cannot re-filter the ranking", () => {
    const results = rankFileRefCompletions({ query: "plan", index });
    expect(results.map((entry) => entry.filterText)).toEqual(["@plan", "@plan"]);
  });

  it("orders matches by descending score through zero-padded sort keys", () => {
    const results = rankFileRefCompletions({ query: "plan", index });
    expect(results.map((entry) => entry.sortText)).toEqual(["01", "02"]);
  });
});

describe("renderFileRefChips", () => {
  it("chips a ref that resolves, leaving its text in the document", () => {
    const render = renderFileRefChips({
      text: "see @docs/plan.md now",
      resolvedPaths: new Set(["docs/plan.md"]),
    });
    expect(render.chips).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 18 },
        relPath: "docs/plan.md",
      },
    ]);
    expect(render.decorations[0].options.inlineClassName).toBe("volli-md-file-chip");
    expect(render.decorations[0].options.inlineClassNameAffectsLetterSpacing).toBe(true);
  });

  it("leaves an unresolved ref as plain text", () => {
    const render = renderFileRefChips({
      text: "see @docs/gone.md",
      resolvedPaths: new Set(["docs/plan.md"]),
    });
    expect(render.chips).toEqual([]);
    expect(render.decorations).toEqual([]);
  });
});
