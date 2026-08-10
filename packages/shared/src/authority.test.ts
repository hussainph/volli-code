import { describe, expect, it } from "vite-plus/test";

import { AUTHORITY_RULE_IDS, BUILTIN_RULE_PACK_HASH, hashRulePack } from "./authority";

describe("hashRulePack", () => {
  it("is stable for the same rule list", () => {
    expect(hashRulePack(AUTHORITY_RULE_IDS)).toBe(hashRulePack([...AUTHORITY_RULE_IDS]));
    expect(BUILTIN_RULE_PACK_HASH).toBe(hashRulePack(AUTHORITY_RULE_IDS));
  });

  it("changes when the pack is reordered, so pack order is part of its identity", () => {
    expect(hashRulePack(AUTHORITY_RULE_IDS.toReversed())).not.toBe(BUILTIN_RULE_PACK_HASH);
  });

  it("changes when a rule is added or removed", () => {
    expect(hashRulePack([...AUTHORITY_RULE_IDS, "rule.new"])).not.toBe(BUILTIN_RULE_PACK_HASH);
    expect(hashRulePack(AUTHORITY_RULE_IDS.slice(1))).not.toBe(BUILTIN_RULE_PACK_HASH);
  });

  it("separates rules, so a split cannot collide with a join", () => {
    expect(hashRulePack(["ab", "c"])).not.toBe(hashRulePack(["a", "bc"]));
  });

  it("returns the FNV-1a offset basis for an empty pack", () => {
    expect(hashRulePack([])).toBe("811c9dc5");
  });

  it("always returns eight hex digits", () => {
    expect(BUILTIN_RULE_PACK_HASH).toMatch(/^[0-9a-f]{8}$/);
    expect(hashRulePack(["path.outside-workspace"])).toMatch(/^[0-9a-f]{8}$/);
  });
});
