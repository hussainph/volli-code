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
});
