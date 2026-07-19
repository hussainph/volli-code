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
  it("prefers the ticket base over the project base and detection", () => {
    const { git } = gitWithRefs(new Set(["refs/heads/feature"]));
    expect(
      resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "feature",
        projectBaseBranch: "main",
      }),
    ).toEqual({ name: "feature", startPoint: "feature" });
  });

  it("falls back to the project base when the ticket has none", () => {
    const { git } = gitWithRefs(new Set(["refs/heads/main"]));
    expect(
      resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: null,
        projectBaseBranch: "main",
      }),
    ).toEqual({ name: "main", startPoint: "main" });
  });

  it("falls back to detectProjectBaseBranch when neither is set", () => {
    const { git } = gitWithRefs(new Set(["refs/heads/detected-main"]));
    expect(
      resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: null,
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "detected-main", startPoint: "detected-main" });
  });

  it("uses the remote-tracking ref as start point when no local branch exists", () => {
    const { git } = gitWithRefs(new Set(["refs/remotes/origin/main"]));
    expect(
      resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "main",
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "main", startPoint: "refs/remotes/origin/main" });
  });

  it("returns the bare name as start point when neither local nor remote ref exists", () => {
    const { git } = gitWithRefs(new Set());
    expect(
      resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: "main",
        projectBaseBranch: null,
      }),
    ).toEqual({ name: "main", startPoint: "main" });
  });

  it("returns null when no base name can be determined at all", () => {
    const { git } = scriptedGit((args) => {
      if (args[0] === "symbolic-ref") throw new Error("no remote");
      if (args[0] === "branch") throw new Error("empty repo");
      throw new Error("bad ref");
    });
    expect(
      resolveBaseBranch(git, {
        projectPath: "/repo",
        ticketBaseBranch: null,
        projectBaseBranch: null,
      }),
    ).toBeNull();
  });

  it("never fetches — no network-touching git subcommand is invoked", () => {
    const { git, calls } = gitWithRefs(new Set(["refs/heads/main"]));
    resolveBaseBranch(git, {
      projectPath: "/repo",
      ticketBaseBranch: "main",
      projectBaseBranch: null,
    });
    expect(calls.some((c) => c.args[0] === "fetch")).toBe(false);
  });
});
