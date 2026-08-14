import { describe, expect, it } from "vite-plus/test";

import { findTextEdits, reconcileText } from "./text-reconciliation";

describe("findTextEdits", () => {
  it("returns no edits for identical empty text", () => {
    expect(findTextEdits("", "")).toEqual([]);
  });

  it("refuses either input once it exceeds the text length cap", () => {
    const oversized = "x".repeat(1024 * 1024 + 1);

    expect(findTextEdits(oversized, "")).toBeNull();
    expect(findTextEdits("", oversized)).toBeNull();
  });
});

describe("reconcileText", () => {
  it("adopts disk text when the Monaco value is still the synchronized baseline", () => {
    expect(
      reconcileText({ baseline: "before\n", local: "before\n", disk: "agent edit\n" }),
    ).toEqual({
      kind: "adopt",
      value: "agent edit\n",
      nextBaseline: "agent edit\n",
    });
  });

  it("keeps a local-only draft while retaining the current disk baseline", () => {
    expect(
      reconcileText({ baseline: "before\n", local: "human draft\n", disk: "before\n" }),
    ).toEqual({
      kind: "keep-local",
      value: "human draft\n",
      nextBaseline: "before\n",
    });
  });

  it("treats matching local-save echo bytes as unchanged", () => {
    expect(reconcileText({ baseline: "before\n", local: "saved\n", disk: "saved\n" })).toEqual({
      kind: "unchanged",
      value: "saved\n",
      nextBaseline: "saved\n",
    });
  });

  it("merges one human and one agent edit in separate regions", () => {
    expect(
      reconcileText({
        baseline: "first\nkeep\nlast\n",
        local: "human first\nkeep\nlast\n",
        disk: "first\nkeep\nagent last\n",
      }),
    ).toEqual({
      kind: "merge",
      value: "human first\nkeep\nagent last\n",
      nextBaseline: "first\nkeep\nagent last\n",
    });
  });

  it("merges multiple disjoint edits from each side", () => {
    expect(
      reconcileText({
        baseline: "one\ntwo\nthree\nfour\nfive\n",
        local: "human one\ntwo\nthree\nhuman four\nfive\n",
        disk: "one\nagent two\nagent three\nfour\nfive\n",
      }),
    ).toEqual({
      kind: "merge",
      value: "human one\nagent two\nagent three\nhuman four\nfive\n",
      nextBaseline: "one\nagent two\nagent three\nfour\nfive\n",
    });
  });

  it("merges insertions at file boundaries with an edit between them", () => {
    expect(
      reconcileText({
        baseline: "one\ntwo\nthree\n",
        local: "human header\none\ntwo\nthree\nhuman footer\n",
        disk: "one\nagent two\nthree\n",
      }),
    ).toEqual({
      kind: "merge",
      value: "human header\none\nagent two\nthree\nhuman footer\n",
      nextBaseline: "one\nagent two\nthree\n",
    });
  });

  it("merges an append at EOF with an edit on an earlier line", () => {
    expect(
      reconcileText({
        baseline: "one\ntwo\n",
        local: "one\ntwo\nhuman appended\n",
        disk: "agent one\ntwo\n",
      }),
    ).toEqual({
      kind: "merge",
      value: "agent one\ntwo\nhuman appended\n",
      nextBaseline: "agent one\ntwo\n",
    });
  });

  it("merges edits that surround an astral character without splitting it", () => {
    expect(
      reconcileText({
        baseline: "title\n🚀 launch\ntail\n",
        local: "human title\n🚀 launch\ntail\n",
        disk: "title\n🚀 launch\nagent tail\n",
      }),
    ).toEqual({
      kind: "merge",
      value: "human title\n🚀 launch\nagent tail\n",
      nextBaseline: "title\n🚀 launch\nagent tail\n",
    });
  });

  it("refuses to invent a value neither side wrote when both retune the same line", () => {
    // Character-granular merging turned 100 → 1000 (local) and 100 → 200 (disk)
    // into 2000, a timeout nobody chose. Same base line ⇒ conflict.
    expect(
      reconcileText({
        baseline: "const timeout = 100;\n",
        local: "const timeout = 1000;\n",
        disk: "const timeout = 200;\n",
      }),
    ).toEqual({
      kind: "conflict",
      reason: "overlap",
      local: "const timeout = 1000;\n",
      disk: "const timeout = 200;\n",
    });
  });

  it("decides the same conflict whichever side is called local", () => {
    const both = {
      baseline: "const timeout = 100;\n",
      local: "const timeout = 1000;\n",
      disk: "const timeout = 200;\n",
    };

    expect(reconcileText(both).kind).toBe(
      reconcileText({ ...both, local: both.disk, disk: both.local }).kind,
    );
  });

  it("conflicts when both sides append to the same unterminated final line", () => {
    expect(
      reconcileText({ baseline: "one\ntwo", local: "one\ntwo local", disk: "one\ntwo disk" }).kind,
    ).toBe("conflict");
  });

  it("preserves exact local and disk text when both sides replace the same range", () => {
    expect(reconcileText({ baseline: "before\n", local: "human\n", disk: "agent\n" })).toEqual({
      kind: "conflict",
      reason: "overlap",
      local: "human\n",
      disk: "agent\n",
    });
  });

  it("treats an insertion at a replaced range boundary as a conflict", () => {
    expect(reconcileText({ baseline: "abc", local: "aXbc", disk: "aYc" })).toEqual({
      kind: "conflict",
      reason: "overlap",
      local: "aXbc",
      disk: "aYc",
    });
  });

  it("keeps deletion and recreation inputs lossless when they collide", () => {
    expect(
      reconcileText({
        baseline: "obsolete\r\n",
        local: "",
        disk: "agent recreation\r\n",
      }),
    ).toEqual({
      kind: "conflict",
      reason: "overlap",
      local: "",
      disk: "agent recreation\r\n",
    });
  });

  it("adopts recreated content from an empty clean model exactly", () => {
    expect(reconcileText({ baseline: "", local: "", disk: "recreated\r\n" })).toEqual({
      kind: "adopt",
      value: "recreated\r\n",
      nextBaseline: "recreated\r\n",
    });
  });

  it("merges CRLF text without changing line endings or a trailing newline", () => {
    expect(
      reconcileText({
        baseline: "one\r\ntwo\r\nthree\r\n",
        local: "human one\r\ntwo\r\nthree\r\n",
        disk: "one\r\ntwo\r\nagent three\r\n",
      }),
    ).toEqual({
      kind: "merge",
      value: "human one\r\ntwo\r\nagent three\r\n",
      nextBaseline: "one\r\ntwo\r\nagent three\r\n",
    });
  });

  // The standard budget allows 1,024 edit steps. A pure append of N characters
  // costs exactly N, so these two pin the boundary from either side.
  it("still merges a change sitting exactly on the maximum edit distance", () => {
    const baseline = "head\ntail\n";

    expect(
      reconcileText({
        baseline,
        local: baseline + "z".repeat(1024),
        disk: "agent head\ntail\n",
      }),
    ).toEqual({
      kind: "merge",
      value: "agent head\ntail\n" + "z".repeat(1024),
      nextBaseline: "agent head\ntail\n",
    });
  });

  it("preserves both versions once a change is one step past the maximum edit distance", () => {
    const baseline = "head\ntail\n";
    const local = baseline + "z".repeat(1025);
    const disk = "agent head\ntail\n";

    expect(reconcileText({ baseline, local, disk })).toEqual({
      kind: "conflict",
      reason: "budget",
      local,
      disk,
    });
  });

  it("returns a deterministic lossless conflict when a rewrite exceeds the diff budget", () => {
    const baseline = "a".repeat(10_000);
    const local = "b".repeat(10_000);
    const disk = "c".repeat(10_000);

    expect(reconcileText({ baseline, local, disk })).toEqual({
      kind: "conflict",
      reason: "budget",
      local,
      disk,
    });
  });
});
