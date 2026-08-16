import { describe, expect, it } from "vite-plus/test";

import { resolveBaseBranch } from "./base";
import { scriptedGit } from "./scripted-git";

/** A git that answers `rev-parse --verify` true only for the refs in `existing`. */
function gitWithRefs(existing: Set<string>) {
  return scriptedGit((args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const ref = args[3]!;
      if (existing.has(ref)) return "sha\n";
      throw new Error("bad ref");
    }
    if (args[0] === "symbolic-ref") throw new Error("no remote");
    if (args[0] === "branch" && args[1] === "--show-current") return "detected-main\n";
    return "";
  });
}

describe("resolveBaseBranch", () => {
  it("prefers the ticket base over the project base and detection", async () => {
    const { gitAsync: git } = gitWithRefs(new Set(["refs/heads/feature"]));
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "feature",
        projectBaseBranch: "main",
      }),
    ).toEqual({ name: "feature", startPoint: "feature" });
  });

  it("falls back to the project base when the ticket has none", async () => {
    const { gitAsync: git } = gitWithRefs(new Set(["refs/heads/main"]));
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: null,
        projectBaseBranch: "main",
      }),
    ).toEqual({ name: "main", startPoint: "main" });
  });

  it("falls back to detectProjectBaseBranch when neither is set", async () => {
    const { gitAsync: git } = gitWithRefs(new Set(["refs/heads/detected-main"]));
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: null,
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "detected-main", startPoint: "detected-main" });
  });

  it("uses the remote-tracking ref as start point when no local branch exists", async () => {
    const { gitAsync: git } = gitWithRefs(new Set(["refs/remotes/origin/main"]));
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "main",
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "main", startPoint: "refs/remotes/origin/main" });
  });

  it("strips an origin/ prefix off a base picked from the remote-tracking list", async () => {
    // The composer's base chip offers `origin/main`; what gets STAMPED is
    // `main`, so later readers (`git fetch origin <base>`) name a ref the
    // remote actually has, while the worktree still starts from origin's tip.
    const { gitAsync: git } = gitWithRefs(new Set(["refs/heads/main", "refs/remotes/origin/main"]));
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "origin/main",
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "main", startPoint: "refs/remotes/origin/main" });
  });

  it("keeps a second remote's prefix, so nothing later measures against origin's branch of that name", async () => {
    // A fork checkout's picker offers `upstream/main` (state.ts lists all of
    // refs/remotes). Stripping it would fork the worktree from upstream and then
    // fetch, diff and PR against origin's OWN `main` — a different branch, with
    // an `origin/main` present here to make the substitution possible.
    const { gitAsync: git } = gitWithRefs(
      new Set(["refs/remotes/upstream/main", "refs/remotes/origin/main"]),
    );
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "upstream/main",
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "upstream/main", startPoint: "refs/remotes/upstream/main" });
  });

  it("keeps a slashed base that is a real local branch as itself", async () => {
    const { gitAsync: git } = gitWithRefs(new Set(["refs/heads/feature/x"]));
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "feature/x",
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "feature/x", startPoint: "feature/x" });
  });

  it("preserves a slashed branch name under a remote prefix", async () => {
    const { gitAsync: git } = gitWithRefs(new Set(["refs/remotes/origin/feature/x"]));
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "origin/feature/x",
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "feature/x", startPoint: "refs/remotes/origin/feature/x" });
  });

  it("returns the bare name as start point when neither local nor remote ref exists", async () => {
    const { gitAsync: git } = gitWithRefs(new Set());
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "main",
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "main", startPoint: "main" });
  });

  it("returns null when no base name can be determined at all", async () => {
    const { gitAsync: git } = scriptedGit((args) => {
      if (args[0] === "symbolic-ref") throw new Error("no remote");
      if (args[0] === "branch") throw new Error("empty repo");
      throw new Error("bad ref");
    });
    expect(
      await resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: null,
        projectBaseBranch: null,
      }),
    ).toBeNull();
  });

  it("never fetches — no network-touching git subcommand is invoked", async () => {
    const { gitAsync: git, calls } = gitWithRefs(new Set(["refs/heads/main"]));
    await resolveBaseBranch(git, {
      projectPath: "/repo",
      ticketBaseBranch: "main",
      projectBaseBranch: null,
    });
    expect(calls.some((c) => c.args[0] === "fetch")).toBe(false);
  });
});
