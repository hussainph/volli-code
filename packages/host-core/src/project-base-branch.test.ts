import { describe, expect, it, vi } from "vite-plus/test";

import { detectProjectBaseBranch, detectProjectBaseBranchAsync } from "./project-base-branch";

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

describe("detectProjectBaseBranchAsync", () => {
  it("prefers origin/HEAD without looking up the local branch", async () => {
    const git = vi.fn(async () => "refs/remotes/origin/trunk\n");
    await expect(detectProjectBaseBranchAsync("/repo", git)).resolves.toBe("trunk");
    expect(git).toHaveBeenCalledExactlyOnceWith(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      "/repo",
    );
  });

  it("falls back to the local branch for missing or invalid remote defaults", async () => {
    const missingRemote = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "symbolic-ref") throw new Error("no remote");
      return "feature/local\n";
    });
    await expect(detectProjectBaseBranchAsync("/repo", missingRemote)).resolves.toBe(
      "feature/local",
    );
    expect(missingRemote).toHaveBeenLastCalledWith(["branch", "--show-current"], "/repo");

    const invalidRemote = vi.fn(async (args: readonly string[]) =>
      args[0] === "symbolic-ref" ? "refs/remotes/origin/invalid name\n" : "main\n",
    );
    await expect(detectProjectBaseBranchAsync("/repo", invalidRemote)).resolves.toBe("main");
  });

  it("returns null when neither branch can be detected", async () => {
    await expect(
      detectProjectBaseBranchAsync("/repo", async () => {
        throw new Error("not a git repository");
      }),
    ).resolves.toBeNull();
    await expect(detectProjectBaseBranchAsync("/repo", async () => "\n")).resolves.toBeNull();
  });
});
