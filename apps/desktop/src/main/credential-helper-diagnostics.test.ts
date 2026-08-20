import { describe, expect, it, vi } from "vite-plus/test";

import { credentialHelperIssues } from "./credential-helper-diagnostics";

function gitConfigOutput(
  entries: ReadonlyArray<readonly [scope: string, origin: string, helper: string]>,
): string {
  return `${entries.flat().join("\0")}\0`;
}

describe("credentialHelperIssues", () => {
  it("names an effective osxkeychain helper and the global config file Git reported", async () => {
    const readCredentialHelperConfig = vi.fn(async () =>
      gitConfigOutput([["global", "file:/Users/me/.gitconfig", "osxkeychain"]]),
    );

    await expect(
      credentialHelperIssues("/work/acme", { readCredentialHelperConfig }),
    ).resolves.toEqual([
      {
        kind: "osxkeychain-may-prompt-gui",
        helper: "osxkeychain",
        scope: "global",
        location: "/Users/me/.gitconfig",
      },
    ]);
    expect(readCredentialHelperConfig).toHaveBeenCalledWith("/work/acme");
  });

  it("names an effective osxkeychain helper Git inherited from system configuration", async () => {
    await expect(
      credentialHelperIssues("/work/acme", {
        readCredentialHelperConfig: async () =>
          gitConfigOutput([["system", "file:/etc/gitconfig", "osxkeychain"]]),
      }),
    ).resolves.toEqual([
      {
        kind: "osxkeychain-may-prompt-gui",
        helper: "osxkeychain",
        scope: "system",
        location: "/etc/gitconfig",
      },
    ]);
  });

  it("does not flag an inherited osxkeychain helper after Git's repo-local empty reset", async () => {
    const readCredentialHelperConfig = vi.fn(async () =>
      gitConfigOutput([
        ["system", "file:/etc/gitconfig", "osxkeychain"],
        ["global", "file:/Users/me/.gitconfig", "osxkeychain"],
        ["local", "file:/work/acme/.git/config", ""],
        ["local", "file:/work/acme/.git/config", "!/usr/local/bin/gh auth git-credential"],
      ]),
    );

    await expect(
      credentialHelperIssues("/work/acme", { readCredentialHelperConfig }),
    ).resolves.toEqual([]);
  });

  it("attributes a remaining worktree helper to the repo-local config that enables it", async () => {
    const readCredentialHelperConfig = vi.fn(async () =>
      gitConfigOutput([
        ["system", "file:/etc/gitconfig", "osxkeychain"],
        ["local", "file:/work/acme/.git/config", ""],
        [
          "worktree",
          "file:/work/acme/.git/worktrees/feature/config.worktree",
          "osxkeychain --timeout=1",
        ],
      ]),
    );

    await expect(
      credentialHelperIssues("/work/acme", { readCredentialHelperConfig }),
    ).resolves.toEqual([
      {
        kind: "osxkeychain-may-prompt-gui",
        helper: "osxkeychain",
        scope: "repo-local",
        location: "/work/acme/.git/worktrees/feature/config.worktree",
      },
    ]);
  });

  it("does not read Git config when no project is in scope", async () => {
    const readCredentialHelperConfig = vi.fn(async () => gitConfigOutput([]));

    await expect(credentialHelperIssues(null, { readCredentialHelperConfig })).resolves.toEqual([]);
    expect(readCredentialHelperConfig).not.toHaveBeenCalled();
  });

  it("leaves a failed Git read undiagnosed rather than calling the project safe", async () => {
    await expect(
      credentialHelperIssues("/work/acme", {
        readCredentialHelperConfig: async () => {
          throw new Error("not a repository");
        },
      }),
    ).resolves.toEqual([]);
  });
});
