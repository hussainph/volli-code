import { describe, expect, it } from "vite-plus/test";

import {
  BUDGET_CAUSE_IDS,
  CONFIRM_CAUSE_IDS,
  isBudgetCause,
  isConfirmCause,
  isCredentialConfirmCause,
  NON_CODING_TOOL_IDS,
} from "./authority";

describe("non-coding tool vocabulary", () => {
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

describe("isConfirmCause", () => {
  it("recognises the confirmation namespace, apart from rules and budgets", () => {
    expect(CONFIRM_CAUSE_IDS).toEqual([
      "confirm.mcp-install",
      "confirm.mcp-remove",
      "confirm.mcp-sign-in",
      "confirm.mcp-credential",
    ]);
    for (const cause of CONFIRM_CAUSE_IDS) {
      expect(isConfirmCause(cause), cause).toBe(true);
      // A confirmation is not a budget: nothing was spent, and no allowance is
      // extended by answering yes.
      expect(isBudgetCause(cause), cause).toBe(false);
    }
    expect(isConfirmCause("budget.delegation-children")).toBe(false);
    expect(isConfirmCause("call.unreadable")).toBe(false);
    expect(isConfirmCause("command.persistence")).toBe(false);
  });

  it("tells the credential questions apart from the confirmations they can follow (VC-470)", () => {
    expect(CONFIRM_CAUSE_IDS.filter(isCredentialConfirmCause)).toEqual([
      "confirm.mcp-sign-in",
      "confirm.mcp-credential",
    ]);
    expect(isCredentialConfirmCause("budget.delegation-children")).toBe(false);
  });
});
