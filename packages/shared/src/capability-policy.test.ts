import { describe, expect, it } from "vite-plus/test";

import {
  capabilityRead,
  capabilityWrite,
  containsPath,
  guardsPath,
  HOME_SECRET_PATHS,
  isGitPlumbingPath,
  readDenial,
  sandboxWriteCarveOuts,
  writeCarveOut,
  writeDenial,
  type CapabilityPolicy,
} from "./capability-policy";

const HOME = "/Users/dev";
const WORKSPACE = `${HOME}/.volli/worktrees/p/VC-1-x`;
const USER_DATA = `${HOME}/Library/Application Support/Volli`;
const OWN_OUTPUT = `${USER_DATA}/pi-sessions/--ws--/mine.tool-output`;

function policy(overrides: Partial<CapabilityPolicy> = {}): CapabilityPolicy {
  return {
    readDeny: [...HOME_SECRET_PATHS.map((entry) => `${HOME}/${entry}`), "/Users/other", USER_DATA],
    readAllow: [OWN_OUTPUT],
    writableRoots: [WORKSPACE, `${HOME}/code/p/.git`],
    sandboxCarveOuts: false,
    ...overrides,
  };
}

describe("containment comparisons", () => {
  it("compares grants literally and denials folded", () => {
    expect(containsPath("/ws", "/ws/a")).toBe(true);
    expect(containsPath("/ws", "/ws-evil/a")).toBe(false);
    expect(containsPath("/ws", "/WS/a")).toBe(false);
    expect(guardsPath("/Users/dev/.ssh", "/Users/dev/.SSH/id")).toBe(true);
    expect(guardsPath("/Users/dev/.ssh", "/Users/dev/.sshx")).toBe(false);
  });
});

describe("capabilityRead", () => {
  it("reads machine-wide: siblings, toolchains, system headers, skills", () => {
    for (const path of [
      "/etc/hosts",
      "/usr/include/stdio.h",
      `${HOME}/code/sibling/README.md`,
      `${HOME}/Library/pnpm/store/v10/x`,
      `${HOME}/.nvm/versions/node/v22/bin/node`,
      `${HOME}/.agents/skills/animate/SKILL.md`,
      `${WORKSPACE}/src/app.ts`,
    ]) {
      expect(capabilityRead(policy(), path)).toEqual({ outcome: "allow" });
    }
  });

  it("refuses the secrets denylist, naming the store", () => {
    const verdict = capabilityRead(policy(), `${HOME}/.ssh/id_ed25519`);
    expect(verdict).toMatchObject({ outcome: "deny", denial: "secret" });
    expect(verdict.outcome === "deny" && verdict.reason).toContain(`${HOME}/.ssh`);
    for (const path of [
      `${HOME}/.aws/credentials`,
      `${HOME}/.config/gh/hosts.yml`,
      `${HOME}/.pi/agent/auth.json`,
      `${HOME}/.zshrc`,
      `${HOME}/.codex/auth.json`,
      `${HOME}/Library/Keychains/login.keychain-db`,
      "/Users/other/notes.txt",
    ]) {
      expect(capabilityRead(policy(), path).outcome, path).toBe("deny");
    }
  });

  it("refuses Volli's own data and every other Session's saved output, granting only its own", () => {
    expect(capabilityRead(policy(), `${USER_DATA}/mcp-credentials.json`).outcome).toBe("deny");
    expect(capabilityRead(policy(), `${USER_DATA}/volli.db`).outcome).toBe("deny");
    expect(
      capabilityRead(policy(), `${USER_DATA}/pi-sessions/--ws--/theirs.tool-output/a.txt`).outcome,
    ).toBe("deny");
    expect(capabilityRead(policy(), `${OWN_OUTPUT}/a.txt`)).toEqual({ outcome: "allow" });
    expect(readDenial(policy(), `${OWN_OUTPUT}-x/a.txt`)).toBe(USER_DATA);
  });

  it("lets the deepest match decide, and a tie go to the deny", () => {
    const tie = policy({ readDeny: ["/a/b"], readAllow: ["/a/b"] });
    expect(readDenial(tie, "/a/b/c")).toBe("/a/b");
    // Order in the list is not precedence: a shallower deny listed later loses.
    expect(readDenial(policy({ readDeny: ["/a/b", "/a"], readAllow: [] }), "/a/b/c")).toBe("/a/b");
    const shallowGrant = policy({ readDeny: ["/a/b"], readAllow: ["/a"] });
    expect(readDenial(shallowGrant, "/a/b/c")).toBe("/a/b");
    expect(readDenial(policy({ readDeny: [], readAllow: [] }), "/a")).toBeUndefined();
  });
});

describe("capabilityWrite", () => {
  it("writes inside a writable root", () => {
    expect(capabilityWrite(policy(), `${WORKSPACE}/src/app.ts`)).toEqual({ outcome: "allow" });
    expect(capabilityWrite(policy(), `${HOME}/code/p/.git/objects/ab/cd`)).toEqual({
      outcome: "allow",
    });
  });

  it("writes a device sink wherever the roots are", () => {
    for (const sink of ["/dev/null", "/dev/stderr", "/dev/fd/3"]) {
      expect(capabilityWrite(policy(), sink)).toEqual({ outcome: "allow" });
    }
  });

  it("refuses a write outside every root, naming them", () => {
    const verdict = capabilityWrite(policy(), "/tmp/out.txt");
    expect(verdict).toMatchObject({ outcome: "deny", denial: "outside-roots" });
    expect(verdict.outcome === "deny" && verdict.reason).toContain(WORKSPACE);
  });

  it("never writes a secret, even through a read grant or a root laid over it", () => {
    expect(capabilityWrite(policy(), `${OWN_OUTPUT}/a.txt`)).toMatchObject({ denial: "secret" });
    expect(
      capabilityWrite(policy({ writableRoots: [HOME] }), `${HOME}/.ssh/authorized_keys`),
    ).toMatchObject({ denial: "secret" });
    // Outside every root the secret is still what the reason names.
    expect(capabilityWrite(policy(), `${HOME}/.zshrc`)).toMatchObject({ denial: "secret" });
  });

  it("writes where a project declared a root deeper than a denied store", () => {
    const declared = policy({ writableRoots: [WORKSPACE, `${HOME}/.config/myapp`] });
    expect(capabilityWrite(declared, `${HOME}/.config/myapp/settings.json`)).toEqual({
      outcome: "allow",
    });
    expect(writeDenial(declared, `${HOME}/.config/other/x`)).toBe(`${HOME}/.config`);
    // A tie goes to the deny.
    expect(writeDenial(policy({ writableRoots: [`${HOME}/.ssh`] }), `${HOME}/.ssh/config`)).toBe(
      `${HOME}/.ssh`,
    );
  });

  it("carves the plan's four out of every root", () => {
    for (const [path, denial] of [
      [`${WORKSPACE}/.git/hooks/pre-commit`, "git-metadata"],
      [`${WORKSPACE}/.git/config`, "git-metadata"],
      [`${WORKSPACE}/.gitmodules`, "git-metadata"],
      [`${WORKSPACE}/.volli/state.json`, "volli-state"],
      [`${HOME}/code/p/.git/hooks/post-checkout`, "git-metadata"],
      [`${HOME}/code/p/.git/config`, "git-metadata"],
      [`${HOME}/code/p/.git/worktrees/VC-1-x/config.worktree`, "git-metadata"],
    ] as const) {
      const verdict = capabilityWrite(policy(), path);
      expect(verdict, path).toMatchObject({ outcome: "deny", denial });
      expect(verdict.outcome === "deny" && verdict.reason).toContain(path);
    }
  });

  it("carves Seatbelt's own list only where the walls are Seatbelt's", () => {
    const scoped = policy({ sandboxCarveOuts: true });
    for (const name of [".vscode/settings.json", ".mcp.json", ".claude/commands/x.md", ".bashrc"]) {
      expect(capabilityWrite(scoped, `${WORKSPACE}/${name}`), name).toMatchObject({
        denial: "tool-config",
      });
      expect(capabilityWrite(policy(), `${WORKSPACE}/${name}`), name).toEqual({ outcome: "allow" });
    }
    expect(capabilityWrite(scoped, `${WORKSPACE}/src/claude/commands.ts`)).toEqual({
      outcome: "allow",
    });
    const verdict = capabilityWrite(scoped, `${WORKSPACE}/.idea/x`);
    expect(verdict.outcome === "deny" && verdict.reason).toContain("Scoped Session");
  });
});

describe("writeCarveOut", () => {
  it("reaches submodule plumbing and a linked worktree's own config", () => {
    expect(isGitPlumbingPath("/r/.git/modules/a/hooks/pre-commit")).toBe(true);
    expect(isGitPlumbingPath("/r/.git/modules/a/modules/b/config")).toBe(true);
    expect(isGitPlumbingPath("/r/.GIT/HOOKS/x")).toBe(true);
    expect(isGitPlumbingPath("/r/.git/config.worktree")).toBe(true);
    expect(isGitPlumbingPath("/r/.git/worktrees/w/config.worktree")).toBe(true);
  });

  it("leaves the rest of a git directory to git", () => {
    for (const path of [
      "/r/.git/index",
      "/r/.git/refs/heads/main",
      "/r/.git/worktrees/w/HEAD",
      "/r/.git/worktrees/w",
      "/r/.git/modules/a/index",
      "/r/.git/modules/hooks",
      "/r/.git/worktrees/w/x/config.worktree",
      "/r/.github/hooks/x",
    ]) {
      expect(isGitPlumbingPath(path), path).toBe(false);
    }
  });

  it("reaches a submodule whose name holds a slash", () => {
    expect(isGitPlumbingPath("/r/.git/modules/vendor/lib/hooks/pre-commit")).toBe(true);
    expect(isGitPlumbingPath("/r/.git/modules/vendor/lib/config")).toBe(true);
  });

  it("matches .volli only at a root's top", () => {
    expect(writeCarveOut(policy(), `${WORKSPACE}/src/.volli/x`)).toBeNull();
    expect(writeCarveOut(policy(), `${WORKSPACE}/.vollibration`)).toBeNull();
  });

  it("judges below each root, so a carve-out name above the root carves nothing", () => {
    const underVscode = policy({
      writableRoots: ["/Users/dev/.vscode/extensions/mine"],
      sandboxCarveOuts: true,
    });
    expect(writeCarveOut(underVscode, "/Users/dev/.vscode/extensions/mine/src/a.ts")).toBeNull();
    expect(writeCarveOut(underVscode, "/Users/dev/.vscode/extensions/mine/.vscode/x")).toBe(
      "tool-config",
    );
    expect(writeCarveOut(policy(), "/tmp/outside/.git/hooks/x")).toBeNull();
  });

  it("refuses when any root that holds the path carves it", () => {
    const nested = policy({ writableRoots: [`${HOME}/code`, `${HOME}/code/p`] });
    expect(writeCarveOut(nested, `${HOME}/code/p/.volli/x`)).toBe("volli-state");
    expect(writeCarveOut(nested, `${HOME}/code/p/src/a.ts`)).toBeNull();
  });
});

describe("sandboxWriteCarveOuts", () => {
  it("spells the plan's four for an ordinary root, rooted rather than relative", () => {
    expect(sandboxWriteCarveOuts("/ws", false)).toEqual([
      "/ws/.volli",
      "/ws/**/.git/hooks",
      "/ws/**/.git/config",
      "/ws/**/.git/config.worktree",
      "/ws/**/.git/worktrees/*/config.worktree",
      "/ws/**/.git/modules/**/hooks",
      "/ws/**/.git/modules/**/config",
      "/ws/**/.gitmodules",
    ]);
  });

  it("judges a git-directory root from its own component, and adds Seatbelt's list when scoped", () => {
    const patterns = sandboxWriteCarveOuts("/r/.git", true);
    expect(patterns).toEqual(
      expect.arrayContaining(["/r/.git/hooks", "/r/.git/config", "/r/.git/**/.git/hooks"]),
    );
    expect(patterns).toEqual(
      expect.arrayContaining(["/r/.git/**/.vscode", "/r/.git/**/.mcp.json"]),
    );
  });
});
