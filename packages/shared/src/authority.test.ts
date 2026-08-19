import { describe, expect, it } from "vite-plus/test";

import {
  AUTHORITY_RULE_IDS,
  BUILTIN_RULE_PACK_HASH,
  hashRulePack,
  isOverridableAuthorityRule,
  NON_CODING_TOOL_IDS,
  OVERRIDABLE_AUTHORITY_RULES,
} from "./authority";

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

describe("non-coding tool vocabulary", () => {
  /**
   * The pack hash pinned to the value it had before any tool was named here.
   *
   * Naming the tools a Session can be offered is not a rule, and a rule pack
   * whose identity moved because of it would silently invalidate every denial
   * recorded under the old one. The literal is the independent source of truth:
   * it came from the pack as it stood, not from re-running the hash.
   */
  it("leaves the built-in rule pack's identity where it was", () => {
    expect(BUILTIN_RULE_PACK_HASH).toBe("d5e3dd88");
  });

  it("names no tool that a coding bundle could also name", () => {
    // `CodingToolId` is a type with no runtime list, so the overlap is checked
    // against the spellings the bundle actually carries. A name in both
    // vocabularies would be a tool two different rules had an opinion about.
    for (const tool of NON_CODING_TOOL_IDS) {
      expect(["read", "edit", "write", "execute"]).not.toContain(tool);
    }
  });
});

describe("isOverridableAuthorityRule", () => {
  it("is true for every rule a person may overrule when Volli stops and asks", () => {
    for (const rule of OVERRIDABLE_AUTHORITY_RULES) {
      expect(isOverridableAuthorityRule(rule)).toBe(true);
    }
  });

  it("is false for a hard-deny rule and for a call the gate could not even read", () => {
    expect(isOverridableAuthorityRule("command.persistence")).toBe(false);
    expect(isOverridableAuthorityRule("call.unreadable")).toBe(false);
  });

  it("keeps every overridable rule inside the built-in pack, so the pack cannot drift from what it lets a person overrule", () => {
    for (const rule of OVERRIDABLE_AUTHORITY_RULES) {
      expect(AUTHORITY_RULE_IDS).toContain(rule);
    }
  });
});
