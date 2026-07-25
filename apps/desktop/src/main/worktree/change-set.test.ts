import { describe, expect, it } from "vite-plus/test";

import { changeSetSnapshot } from "./change-set";
import { scriptedGit } from "./scripted-git";

describe("changeSetSnapshot — clean worktree", () => {
  it("stamps resolved base and HEAD SHAs with an empty file list", () => {
    const { git, calls } = scriptedGit((args) => {
      // No origin/<base> remote-tracking ref.
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no such ref");
      if (args[0] === "rev-parse" && args[1] === "main") return "basesha\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "headsha\n";
      if (args[0] === "diff") return "";
      if (args[0] === "status") return "";
      if (args[0] === "ls-files") return "";
      return "";
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseRevision).toBe("basesha");
    expect(result.value.headRevision).toBe("headsha");
    expect(result.value.files).toEqual([]);
    expect(result.value.insertions).toBe(0);
    expect(result.value.deletions).toBe(0);
    expect(result.value.revision.length).toBeGreaterThan(0);

    // Path-safety and rename detection are acceptance criteria — assert the argv contract.
    const nameStatus = calls.find((c) => c.args[0] === "diff" && c.args.includes("--name-status"));
    expect(nameStatus?.args).toContain("-z");
    expect(nameStatus?.args).toContain("-M");
    const numstat = calls.find((c) => c.args[0] === "diff" && c.args.includes("--numstat"));
    expect(numstat?.args).toContain("-z");
    expect(numstat?.args).toContain("-M");
  });
});
