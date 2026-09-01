import { describe, expect, it } from "vite-plus/test";

import {
  AUTHORITY_RULE_IDS,
  BUDGET_CAUSE_IDS,
  BUILTIN_RULE_PACK_HASH,
  hashRulePack,
  isBudgetCause,
  isOverridableAuthorityRule,
  NON_CODING_TOOL_IDS,
  OVERRIDABLE_AUTHORITY_RULES,
} from "./authority";

describe("hashRulePack", () => {
  it("is stable for the same rule list", () => {
    expect(hashRulePack(AUTHORITY_RULE_IDS)).toBe(hashRulePack([...AUTHORITY_RULE_IDS]));
    expect(BUILTIN_RULE_PACK_HASH).toBe(hashRulePack(AUTHORITY_RULE_IDS));
  });

  it("pins the built-in pack's hash as a literal, so a pack change is a decision and not a recomputation", () => {
    // The assertion above is a tautology — both sides recompute from the same
    // list, so a rule added tomorrow satisfies it silently. This one does not,
    // and VC-44 is why it now matters: the hash is written into every
    // attachment's durable Authority Snapshot, so a pack that changed without
    // anyone noticing leaves every older denial citing a pack id that no longer
    // corresponds to any pack that ever ran. Nine rules, `d5e3dd88` before VC-3
    // deleted `tool.not-bundled`.
    expect(AUTHORITY_RULE_IDS).toHaveLength(9);
    expect(BUILTIN_RULE_PACK_HASH).toBe("dca89a93");
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
   * The pack's identity, pinned to a literal and moved exactly once.
   *
   * It read `d5e3dd88` for the ten-rule pack. VC-3 deleted `tool.not-bundled`,
   * which is a change to the pack and so must be a change to its identity — the
   * hash exists to make a changed pack undetectable in neither direction. The
   * literal is the independent source of truth: it came from the pack as it
   * stands, not from re-running the hash over whatever the list happens to say,
   * which is what makes this test able to fail.
   *
   * Naming a tool below is still not a rule and still must not move it.
   */
  it("pins the built-in rule pack's identity, which moved when the pack lost a rule", () => {
    expect(BUILTIN_RULE_PACK_HASH).toBe("dca89a93");
    expect(AUTHORITY_RULE_IDS).toHaveLength(9);
    expect(AUTHORITY_RULE_IDS).not.toContain("tool.not-bundled");
  });

  it("names no tool that a coding bundle could also name", () => {
    // `CodingToolId` is a type with no runtime list, so the overlap is checked
    // against the spellings the bundle actually carries. A name in both
    // vocabularies would be one tool wired two ways.
    for (const tool of NON_CODING_TOOL_IDS) {
      expect(["read", "edit", "write", "execute"]).not.toContain(tool);
    }
  });
});

describe("isBudgetCause", () => {
  it("recognises the budget namespace without classifying authority rules as budgets", () => {
    expect(BUDGET_CAUSE_IDS).toEqual(["budget.delegation-children"]);
    expect(isBudgetCause("budget.delegation-children")).toBe(true);
    expect(isBudgetCause("call.unreadable")).toBe(false);
    expect(isBudgetCause("command.persistence")).toBe(false);
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

  it("pins the membership itself, so moving a rule across the line is a decision and not a diff", () => {
    // Asserted as a literal for the reason the pack hash is: the split is a
    // judgement about what a person's "yes" could carry out, and it should cost
    // a test edit to change. VC-44 moved the two workspace-containment rules
    // onto the overridable side when it wired the gate — Seatbelt used to make
    // consent moot and no longer exists, and Volli's own skills index asks a
    // Session to read a personal-tier SKILL.md outside the workspace.
    expect([...OVERRIDABLE_AUTHORITY_RULES]).toEqual([
      "path.outside-workspace",
      "path.git-internals",
      "path.volli-internals",
      "command.git-escapes-workspace",
      "command.git-discards-work",
    ]);
  });

  it("leaves every rule whose grant would outlive the Session unoverridable", () => {
    // The hard-deny case: consent could be honoured and must not be. A login
    // item, a disabled certificate check and a weakened SIP all survive the
    // Session that asked for them, and a person answering mid-task is not in a
    // position to weigh that.
    for (const rule of [
      "command.tls-weakening",
      "command.persistence",
      "command.platform-weakening",
      "command.destructive-removal",
    ] as const) {
      expect(isOverridableAuthorityRule(rule)).toBe(false);
    }
  });
});
