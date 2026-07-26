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
});
