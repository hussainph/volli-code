import { describe, expect, it } from "vite-plus/test";

import type { IndexedFile } from "./file-ref";
import { quickOpenMatch, rankQuickOpenFiles } from "./quick-open-rank";

function indexed(relPath: string, artifact = false): IndexedFile {
  return { relPath, kind: "other", artifact };
}

/** The audit's worked example (VC-299 / A13): the file the +1000 bonus used to win with. */
const AUDIT_ARTIFACT = indexed(".volli/artifacts/design-audit/audit-motion-perf.md", true);
const ROOT_README = indexed("README.md");

const ranked = (query: string, index: readonly IndexedFile[], limit?: number) =>
  rankQuickOpenFiles({ query, index, limit }).map((file) => file.relPath);

describe("quickOpenMatch", () => {
  it("puts a whole-relPath hit in the exact-path tier", () => {
    expect(quickOpenMatch("src/main.ts", "src/main.ts")?.tier).toBe("exact-path");
  });

  it("puts a whole-basename hit in the exact-name tier", () => {
    expect(quickOpenMatch("package.json", "apps/desktop/package.json")?.tier).toBe("exact-name");
  });

  it("puts a basename the query starts in the name-prefix tier", () => {
    expect(quickOpenMatch("readme", "README.md")?.tier).toBe("name-prefix");
  });

  it("puts scattered basename characters in the name-subsequence tier", () => {
    expect(quickOpenMatch("qom", "src/quick-open-model.ts")?.tier).toBe("name-subsequence");
  });

  it("falls back to the path-subsequence tier when only the directories match", () => {
    const match = quickOpenMatch("readme", ".volli/artifacts/design-audit/audit-motion-perf.md");
    expect(match?.tier).toBe("path-subsequence");
  });

  it("answers null when the query is not a subsequence of the path at all", () => {
    expect(quickOpenMatch("xyz", "src/main.ts")).toBeNull();
  });

  it("is case-insensitive in both directions", () => {
    expect(quickOpenMatch("README", "readme.md")?.tier).toBe("name-prefix");
    expect(quickOpenMatch("readme.md", "README.MD")?.tier).toBe("exact-path");
  });

  it("matches everything for an empty query, in one tier with nothing to sort by", () => {
    expect(quickOpenMatch("", "a/b/c/deep.ts")).toEqual({ tier: "path-subsequence", score: 0 });
  });

  it("scores a name-tier match by the basename, so path shape cannot leak into it", () => {
    // Same basename, different directories: indistinguishable before the
    // tie-breakers run, or a deep path could out-score a shallow one on match
    // quality and depth would never get its say.
    expect(quickOpenMatch("readme", "README.md")).toEqual(
      quickOpenMatch("readme", "docs/guides/README.md"),
    );
  });

  it("scores a path-tier match by the whole path — there is no basename hit to score", () => {
    const match = quickOpenMatch("srcmain", "src/main.ts");
    expect(match?.tier).toBe("path-subsequence");
    expect(match?.score).toBeGreaterThan(0);
  });
});

describe("rankQuickOpenFiles", () => {
  it("puts the root README above the artifact the +1000 bonus used to win with", () => {
    // The audit's worked example (A13). Through `scoreFileMatch` this same
    // index came back the other way round, 1030 to 46.
    expect(ranked("README", [AUDIT_ARTIFACT, ROOT_README])).toEqual([
      "README.md",
      ".volli/artifacts/design-audit/audit-motion-perf.md",
    ]);
  });

  it("puts an exact basename ahead of an artifact and of a path-only match", () => {
    expect(
      ranked("package.json", [
        indexed(".volli/artifacts/package.json-audit.md", true),
        indexed("packages/shared/src/app.json.ts"),
        indexed("apps/desktop/package.json"),
      ]),
    ).toEqual([
      "apps/desktop/package.json",
      ".volli/artifacts/package.json-audit.md",
      "packages/shared/src/app.json.ts",
    ]);
  });

  it("ranks the five tiers in order for one query", () => {
    expect(
      ranked("readme", [
        indexed("reader/docs/me-notes.ts"),
        indexed("re-a-d-me-notes.md"),
        indexed("readme-draft.md"),
        indexed("docs/README"),
        indexed("readme"),
      ]),
    ).toEqual([
      "readme", // 1. exact relative path
      "docs/README", // 2. exact basename
      "readme-draft.md", // 3. basename prefix
      "re-a-d-me-notes.md", // 4. basename subsequence
      "reader/docs/me-notes.ts", // 5. relative-path subsequence
    ]);
  });

  it("keeps a partial basename above a path-only subsequence match", () => {
    expect(ranked("main", [indexed("mxaxixn/other.ts"), indexed("src/main.ts")])).toEqual([
      "src/main.ts",
      "mxaxixn/other.ts",
    ]);
  });

  it("breaks a tie inside one tier by match quality, ahead of artifact status", () => {
    // Both are basename-subsequence matches. `open` lands on a word boundary in
    // one and mid-word in the other, and that is a fact about the query the
    // person typed — artifact status is only a fact about the file.
    expect(
      ranked("open", [
        indexed(".volli/artifacts/operand-notes.md", true),
        indexed("src/quick-open-model.ts"),
      ]),
    ).toEqual(["src/quick-open-model.ts", ".volli/artifacts/operand-notes.md"]);
  });

  it("breaks a same-quality tie by artifact status, whichever way the index lists them", () => {
    const files = [indexed("notes.md"), indexed(".volli/artifacts/notes.md", true)];
    const expected = [".volli/artifacts/notes.md", "notes.md"];
    expect(ranked("notes", files)).toEqual(expected);
    expect(ranked("notes", files.toReversed())).toEqual(expected);
  });

  it("breaks a tie between two ordinary files by path depth", () => {
    expect(ranked("main", [indexed("a/b/c/d/main.ts"), indexed("main.ts")])).toEqual([
      "main.ts",
      "a/b/c/d/main.ts",
    ]);
  });

  it("breaks a last tie by relative path, so index order never decides", () => {
    const files = [indexed("src/b/main.ts"), indexed("src/a/main.ts"), indexed("src/c/main.ts")];
    const expected = ["src/a/main.ts", "src/b/main.ts", "src/c/main.ts"];
    expect(ranked("main", files)).toEqual(expected);
    expect(ranked("main", files.toReversed())).toEqual(expected);
  });

  it("does not let unrelated artifacts move the top result", () => {
    const noise = [
      indexed(".volli/artifacts/read-me-later.md", true),
      indexed(".volli/artifacts/design-audit/render-media.md", true),
      indexed(".volli/artifacts/reports/ready-made-summary.md", true),
    ];
    expect(ranked("README", [AUDIT_ARTIFACT, ROOT_README])[0]).toBe("README.md");
    expect(ranked("README", [...noise, AUDIT_ARTIFACT, ROOT_README])[0]).toBe("README.md");
  });

  it("drops non-matches", () => {
    expect(ranked("xyz", [indexed("src/main.ts")])).toEqual([]);
  });

  it("ranks an empty query by shape alone — artifacts, then shallow paths", () => {
    expect(
      ranked("", [
        indexed("a/b/c/deep.ts"),
        indexed("top.ts"),
        indexed(".volli/artifacts/x.md", true),
      ]),
    ).toEqual([".volli/artifacts/x.md", "top.ts", "a/b/c/deep.ts"]);
  });

  it("bounds the list when a limit is given, and returns everything when it is not", () => {
    const index = Array.from({ length: 5 }, (_unused, n) => indexed(`src/main${n}.ts`));
    expect(ranked("main", index, 2)).toEqual(["src/main0.ts", "src/main1.ts"]);
    expect(ranked("main", index)).toHaveLength(5);
  });

  it("returns the index entries themselves, so a row can still read kind and artifact", () => {
    expect(rankQuickOpenFiles({ query: "readme", index: [AUDIT_ARTIFACT, ROOT_README] })).toEqual([
      ROOT_README,
      AUDIT_ARTIFACT,
    ]);
  });
});
