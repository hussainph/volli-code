import { describe, expect, it, vi } from "vite-plus/test";

import {
  credentialHelperExplanation,
  credentialHelperIssues,
  type CredentialHelperIssue,
} from "./credential-helper-diagnostics";

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

  // The stock-Mac case the VC-94 review caught live: Apple's /usr/bin/git
  // (Apple Git-155) reports the Xcode-bundled gitconfig — the file that
  // enables osxkeychain by default — with scope `unknown`. Dropping
  // unclassified scopes would call exactly that setup safe while a Session
  // push can still hang on the keychain prompt.
  it("reports Apple Git's unclassified Xcode-bundled scope instead of dropping it", async () => {
    await expect(
      credentialHelperIssues("/work/acme", {
        readCredentialHelperConfig: async () =>
          gitConfigOutput([
            [
              "unknown",
              "file:/Applications/Xcode.app/Contents/Developer/usr/share/git-core/gitconfig",
              "osxkeychain",
            ],
          ]),
      }),
    ).resolves.toEqual([
      {
        kind: "osxkeychain-may-prompt-gui",
        helper: "osxkeychain",
        scope: "unknown",
        location: "/Applications/Xcode.app/Contents/Developer/usr/share/git-core/gitconfig",
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

function issue(scope: CredentialHelperIssue["scope"], location: string): CredentialHelperIssue {
  return { kind: "osxkeychain-may-prompt-gui", helper: "osxkeychain", scope, location };
}

describe("credentialHelperExplanation", () => {
  it("says what happened, why a Session could not answer, and the one thing that fixes it", () => {
    const text = credentialHelperExplanation(issue("global", "/Users/me/.gitconfig"));

    expect(text).toContain("Git asked for credentials it could not get.");
    expect(text).toContain("Your global Git configuration");
    expect(text).toContain("/Users/me/.gitconfig");
    expect(text).toContain("osxkeychain");
    expect(text).toContain("a Session cannot answer");
    expect(text).toContain("gh auth login");
  });

  it("names every scope Git can report, including the one it does not classify", () => {
    // Apple Git reports its Xcode-bundled gitconfig — the file that enables
    // osxkeychain on a stock Mac — with a scope Git itself calls unknown.
    expect(credentialHelperExplanation(issue("system", "/etc/gitconfig"))).toContain(
      "Your system Git configuration",
    );
    expect(credentialHelperExplanation(issue("repo-local", "/work/acme/.git/config"))).toContain(
      "This project's Git configuration",
    );
    expect(credentialHelperExplanation(issue("command", "command line"))).toContain(
      "A Git command setting",
    );
    expect(credentialHelperExplanation(issue("unknown", "/Applications/Xcode.app"))).toContain(
      "Your Git configuration",
    );
  });

  // Volli never rewrites the user's Git configuration, and this sentence never
  // asks them to either: the fix is a sign-in, not an edit.
  it("asks for no configuration change", () => {
    const text = credentialHelperExplanation(issue("global", "/Users/me/.gitconfig"));

    expect(text.toLowerCase()).not.toContain("git config --");
    expect(text.toLowerCase()).not.toContain("remove");
  });
});
