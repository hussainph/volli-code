import { describe, expect, it } from "vite-plus/test";

import {
  CLEANUP_PRESERVATION_RULES,
  isWorktreePreservationRule,
  preservationRuleText,
  WORKTREE_PRESERVATION_RULES,
  type WorktreePreservationRule,
} from "./worktree-preservation";

describe("worktree preservation vocabulary", () => {
  it("gives every rule id one sentence", () => {
    for (const rule of WORKTREE_PRESERVATION_RULES) {
      const text = preservationRuleText(rule, { retentionDays: 14 });
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("{");
    }
  });

  it("names the retention window inside the recency rule", () => {
    expect(preservationRuleText("recent-use", { retentionDays: 9 })).toContain("9 day");
    expect(preservationRuleText("recent-use", { retentionDays: 1 })).toContain("1 day");
  });

  it("keeps the cleanup policy a subset of the whole vocabulary", () => {
    for (const rule of CLEANUP_PRESERVATION_RULES) {
      expect(WORKTREE_PRESERVATION_RULES).toContain(rule);
    }
  });

  it("covers every rule the audit named as a safeguard", () => {
    const required: WorktreePreservationRule[] = [
      "branches",
      "ownership",
      "ticket-linked",
      "uncommitted-changes",
      "untracked-files",
      "unpushed-commits",
      "git-operation",
      "submodule-drift",
      "locked",
      "unreadable-git",
      "unknown-age",
      "recent-use",
      "active",
      "recheck",
    ];
    for (const rule of required) expect(CLEANUP_PRESERVATION_RULES).toContain(rule);
  });

  it("recognises its own ids and refuses anything else", () => {
    expect(isWorktreePreservationRule("branches")).toBe(true);
    expect(isWorktreePreservationRule("nonsense")).toBe(false);
    expect(isWorktreePreservationRule(7)).toBe(false);
    expect(isWorktreePreservationRule(null)).toBe(false);
  });

  it("renders an unrecognised stored id rather than dropping it", () => {
    expect(preservationRuleText("from-a-later-version", { retentionDays: 14 })).toContain(
      "from-a-later-version",
    );
  });
});
