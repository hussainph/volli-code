import { describe, expect, it } from "vite-plus/test";

import { COMMAND_INTENT_CONFLICT, isCommandIntentConflict } from "./command-intent-conflict";

describe("the command-intent conflict brand (VC-564 A2)", () => {
  it("recognizes any ledger's error that carries it, and nothing else", () => {
    class LedgerIntentConflict extends Error {
      readonly [COMMAND_INTENT_CONFLICT] = true as const;
    }
    expect(isCommandIntentConflict(new LedgerIntentConflict("reused"))).toBe(true);
    expect(isCommandIntentConflict({ [COMMAND_INTENT_CONFLICT]: true })).toBe(true);
    // The brand is a well-known symbol: a copy of this module still matches.
    expect(COMMAND_INTENT_CONFLICT).toBe(Symbol.for("@volli/command-intent-conflict"));
    for (const other of [
      new Error("different intent"),
      { commandIntentConflict: true },
      { [COMMAND_INTENT_CONFLICT]: "yes" },
      null,
      "conflict",
    ]) {
      expect(isCommandIntentConflict(other)).toBe(false);
    }
  });
});
