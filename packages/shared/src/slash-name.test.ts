import { describe, expect, it } from "vite-plus/test";

import {
  isSlashInvocationName,
  isSlashNameCharacter,
  type CheckedSlashInvocationName,
} from "./slash-name";

describe("slash invocation names", () => {
  it("accepts every character shared by commands and verbs", () => {
    expect(isSlashInvocationName("pr:Review_2-now")).toBe(true);
    for (const character of "pr:Review_2-now") {
      expect(isSlashNameCharacter(character)).toBe(true);
    }
  });

  it("rejects empty and partly unspellable names", () => {
    expect(isSlashInvocationName("")).toBe(false);
    expect(isSlashInvocationName("ship it")).toBe(false);
    expect(isSlashNameCharacter(" ")).toBe(false);
    expect(isSlashNameCharacter("ab")).toBe(false);
  });

  it("carries the same decision at the literal type boundary", () => {
    const valid: CheckedSlashInvocationName<"command:compact"> = "command:compact";
    expect(valid).toBe("command:compact");

    // @ts-expect-error A declaration that the runtime parser cannot consume is rejected.
    const invalid: CheckedSlashInvocationName<"bad.name"> = "bad.name";
    expect(invalid).toBe("bad.name");
  });
});
