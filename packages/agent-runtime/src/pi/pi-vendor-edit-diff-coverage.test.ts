import { applyPatch } from "diff";
import { describe, expect, it } from "vite-plus/test";
import {
  applyEditsToNormalizedContent,
  applyReplacementsPreservingUnchangedLines,
  detectLineEnding,
  fuzzyFindText,
  generateDiffString,
  generateUnifiedPatch,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./vendor/pi-harness/tools/edit-diff";

// The copied editor must match the original snapshot, never cascade edits or
// silently normalize untouched file bytes when a fuzzy match is needed.
describe("vendored edit matching and preservation", () => {
  it.each([
    ["", "\n"],
    ["one\rtwo", "\n"],
    ["one\ntwo\r\n", "\n"],
    ["one\r\ntwo\n", "\r\n"],
  ] as const)("detects the first newline style in %j", (content, ending) => {
    expect(detectLineEnding(content)).toBe(ending);
    const normalized = normalizeToLF(content);
    expect(normalized).not.toContain("\r");
    expect(restoreLineEndings(normalized, ending)).toBe(
      ending === "\r\n" ? normalized.replaceAll("\n", "\r\n") : normalized,
    );
  });

  it("strips only a leading BOM and normalizes Unicode punctuation and trailing space", () => {
    expect(stripBom("\ufefftext\ufeff")).toEqual({ bom: "\ufeff", text: "text\ufeff" });
    expect(stripBom("text\ufeff")).toEqual({ bom: "", text: "text\ufeff" });
    expect(
      normalizeForFuzzyMatch("‘’‚‛ “ ” „ ‟ ‐‑‒–—―−\nＡ\u00a0\u2002\u200a\u202f\u205f\u3000B  \t"),
    ).toBe("'''' \" \" \" \" -------\nA      B");
  });

  it("returns exact offsets before fuzzy ones and leaves misses in original space", () => {
    expect(fuzzyFindText("prefix ‘target’  \n", "‘target’")).toEqual({
      found: true,
      index: 7,
      matchLength: 8,
      usedFuzzyMatch: false,
      contentForReplacement: "prefix ‘target’  \n",
    });
    expect(fuzzyFindText("Ａ  \n‘target’  \n", "'target'")).toEqual({
      found: true,
      index: 2,
      matchLength: 8,
      usedFuzzyMatch: true,
      contentForReplacement: "A\n'target'\n",
    });
    expect(fuzzyFindText("‘keep’  \n", "absent")).toEqual({
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: "‘keep’  \n",
    });
  });

  it("matches a reversed multi-edit list against one original, including CRLF arguments", () => {
    expect(
      applyEditsToNormalizedContent(
        "alpha\nbeta\ngamma\n",
        [
          { oldText: "beta\r\ngamma", newText: "third\r\nfourth" },
          { oldText: "alpha", newText: "beta" },
        ],
        "file.txt",
      ),
    ).toEqual({
      baseContent: "alpha\nbeta\ngamma\n",
      newContent: "beta\nthird\nfourth\n",
    });
  });

  it("preserves duplicated normalized lines by their matched offsets, not diff alignment", () => {
    const original = "‘same’  \nfirst ‘target’  \n‘same’\t\nnext ‘target’  \n‘keep’\t\n";
    expect(
      applyEditsToNormalizedContent(
        original,
        [
          { oldText: "first 'target'", newText: "FIRST" },
          { oldText: "next 'target'", newText: "NEXT" },
        ],
        "file.txt",
      ),
    ).toEqual({
      baseContent: original,
      newContent: "‘same’  \nFIRST\n‘same’\t\nNEXT\n‘keep’\t\n",
    });
  });

  it("groups disjoint edits sharing touched lines and preserves all other line blocks", () => {
    const original = "‘keep’  \n‘alpha’ and ‘beta’  \n‘gamma’  \n‘tail’\t";
    expect(
      applyEditsToNormalizedContent(
        original,
        [
          { oldText: "'beta'\n'gamma'", newText: "B\nG" },
          { oldText: "'alpha'", newText: "A" },
        ],
        "file.txt",
      ).newContent,
    ).toBe("‘keep’  \nA and B\nG\n‘tail’\t");
  });

  it.each([
    { text: "abc", edits: [{ oldText: "", newText: "x" }], message: "oldText must not be empty" },
    {
      text: "abc",
      edits: [
        { oldText: "a", newText: "x" },
        { oldText: "", newText: "y" },
      ],
      message: "edits[1].oldText must not be empty",
    },
    {
      text: "abc",
      edits: [{ oldText: "absent", newText: "x" }],
      message: "Could not find the exact text",
    },
    {
      text: "abc",
      edits: [
        { oldText: "a", newText: "x" },
        { oldText: "absent", newText: "y" },
      ],
      message: "Could not find edits[1]",
    },
    {
      text: "‘same’ 'same'",
      edits: [{ oldText: "'same'", newText: "x" }],
      message: "Found 2 occurrences of the text",
    },
    {
      text: "unique ‘same’ 'same'",
      edits: [
        { oldText: "unique", newText: "x" },
        { oldText: "'same'", newText: "y" },
      ],
      message: "Found 2 occurrences of edits[1]",
    },
    {
      text: "abc",
      edits: [{ oldText: "abc", newText: "abc" }],
      message: "replacement produced identical content",
    },
    {
      text: "abc",
      edits: [
        { oldText: "a", newText: "a" },
        { oldText: "c", newText: "c" },
      ],
      message: "replacements produced identical content",
    },
    {
      text: "abcdef",
      edits: [
        { oldText: "cde", newText: "x" },
        { oldText: "abc", newText: "y" },
      ],
      message: "edits[1] and edits[0] overlap",
    },
  ])("refuses unsafe replacements: $message", ({ text, edits, message }) => {
    expect(() => applyEditsToNormalizedContent(text, edits, "file.txt")).toThrow(message);
  });

  it("rejects invalid preservation coordinates rather than splicing unrelated lines", () => {
    expect(() => applyReplacementsPreservingUnchangedLines("a\nb", "a", [])).toThrow(
      "different line count",
    );
    for (const replacement of [
      { matchIndex: -1, matchLength: 1, newText: "x" },
      { matchIndex: 3, matchLength: 1, newText: "x" },
      { matchIndex: 1, matchLength: 4, newText: "x" },
    ]) {
      expect(() => applyReplacementsPreservingUnchangedLines("abc", "abc", [replacement])).toThrow(
        "outside the base content",
      );
    }
    expect(applyReplacementsPreservingUnchangedLines("", "", [])).toBe("");
    expect(
      applyReplacementsPreservingUnchangedLines("a  \nb  ", "a\nb", [
        { matchIndex: 2, matchLength: 1, newText: "B" },
        { matchIndex: 0, matchLength: 1, newText: "A" },
      ]),
    ).toBe("A\nB");
  });
});

describe("vendored edit diff presentation", () => {
  it("reports empty, pure-add, pure-remove and no-final-newline changes", () => {
    expect(generateDiffString("same\n", "same\n")).toEqual({
      diff: "",
      firstChangedLine: undefined,
    });
    expect(generateDiffString("", "new")).toEqual({ diff: "+1 new", firstChangedLine: 1 });
    expect(generateDiffString("old", "")).toEqual({ diff: "-1 old", firstChangedLine: 1 });
    expect(generateDiffString("same\nold", "same\nnew")).toEqual({
      diff: " 1 same\n-2 old\n+2 new",
      firstChangedLine: 2,
    });
  });

  it("keeps nearby change context without an ellipsis", () => {
    expect(generateDiffString("old\ncommon\nlast\n", "new\ncommon\nfinal\n", 1)).toEqual({
      diff: "-1 old\n+1 new\n 2 common\n-3 last\n+3 final",
      firstChangedLine: 1,
    });
  });

  it("bounds leading, middle and trailing context while maintaining padded line numbers", () => {
    const oldLines = Array.from({ length: 15 }, (_, index) => `line${index + 1}`);
    const newLines = [...oldLines];
    newLines[3] = "FIRST";
    newLines[11] = "SECOND";
    expect(generateDiffString(oldLines.join("\n") + "\n", newLines.join("\n") + "\n", 1)).toEqual({
      diff: "    ...\n  3 line3\n- 4 line4\n+ 4 FIRST\n  5 line5\n    ...\n 11 line11\n-12 line12\n+12 SECOND\n 13 line13\n    ...",
      firstChangedLine: 4,
    });
    expect(generateDiffString("a\nb\nc", "a\nB\nc", 1)).toEqual({
      diff: " 1 a\n-2 b\n+2 B\n 3 c",
      firstChangedLine: 2,
    });
  });

  it("creates an applicable unified patch with original paths and no final-newline loss", () => {
    for (const [before, after] of [
      ["old", "new"],
      ["a\nb\nc\n", "A\nb\nC\n"],
    ]) {
      const patch = generateUnifiedPatch("nested/file.txt", before, after, 1);
      expect(patch).toMatch(/^--- nested\/file.txt\n\+\+\+ nested\/file.txt\n@@/);
      expect(applyPatch(before, patch)).toBe(after);
    }
    expect(applyPatch("old\n", generateUnifiedPatch("file.txt", "old\n", "new\n"))).toBe("new\n");
  });
});
