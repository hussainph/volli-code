import { describe, expect, it } from "vite-plus/test";

import { reconcileText } from "./text-reconciliation";

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
