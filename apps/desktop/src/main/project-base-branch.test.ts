import { describe, expect, it, vi } from "vite-plus/test";

import { detectProjectBaseBranch } from "./project-base-branch";

describe("detectProjectBaseBranch", () => {
  it("prefers the remote default branch and falls back without failing project add", () => {
    const remoteDefault = vi.fn(() => "refs/remotes/origin/trunk\n");
    expect(detectProjectBaseBranch("/repo", remoteDefault)).toBe("trunk");
    expect(remoteDefault).toHaveBeenCalledWith(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      "/repo",
    );

    expect(
      detectProjectBaseBranch("/repo", (args) => {
        if (args[0] === "symbolic-ref") throw new Error("no remote");
        return "feature/local\n";
      }),
    ).toBe("feature/local");
    expect(
      detectProjectBaseBranch("/repo", () => {
        throw new Error("not a git repository");
      }),
    ).toBeNull();
  });
});
