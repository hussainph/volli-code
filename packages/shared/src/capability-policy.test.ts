import { describe, expect, it } from "vite-plus/test";

import {
  capabilityRead,
  capabilityWrite,
  containsPath,
  denialReason,
  foldSegment,
  guardsPath,
  hasGlob,
  HOME_CREDENTIAL_PATHS,
  HOME_PRIVATE_PATHS,
  isDeviceSink,
  isGitPlumbingPath,
  hostDataReach,
  linkedAlias,
  operandDenial,
  operandReach,
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
    credentialDeny: [
      ...HOME_CREDENTIAL_PATHS.map((entry) => `${HOME}/${entry}`),
      `${USER_DATA}/mcp-credentials.json`,
    ],
    privateDeny: [
      ...HOME_PRIVATE_PATHS.map((entry) => `${HOME}/${entry}`),
      "/Users/other",
      USER_DATA,
    ],
    hostDataDeny: [USER_DATA],
    readAllow: [OWN_OUTPUT],
    writableRoots: [WORKSPACE, `${HOME}/code/p/.git/objects`],
    protectedPaths: [`${WORKSPACE}/.git`],
    sandboxCarveOuts: false,
    hostDataAliases: [],
    linkedFiles: {},
    ...overrides,
  };
}

describe("comparisons", () => {
  it("compares grants literally and denials folded", () => {
    expect(containsPath("/ws", "/ws/a")).toBe(true);
    expect(containsPath("/ws", "/ws-evil/a")).toBe(false);
    expect(containsPath("/ws", "/WS/a")).toBe(false);
    expect(guardsPath("/Users/dev/.ssh", "/Users/dev/.SSH/id")).toBe(true);
    expect(guardsPath("/Users/dev/.ssh", "/Users/dev/.sshx")).toBe(false);
  });

  it("folds every spelling APFS resolves to one name", () => {
    // U+017F, the long s, which `toLowerCase` leaves alone.
    expect(guardsPath(`${HOME}/.ssh`, `${HOME}/.sſh/id_rsa`)).toBe(true);
    expect(
      guardsPath(`${HOME}/Library/Application Support`, `${HOME}/Library/Application ſupport/x`),
    ).toBe(true);
    // A decomposed spelling of a composed name.
    expect(guardsPath("/Users/dev/Données", "/Users/dev/Donne\u0301es/x")).toBe(true);
    expect(foldSegment("K")).toBe(foldSegment("\u212A"));
  });

  it("sees through the data-volume firmlink, on both sides", () => {
    expect(guardsPath(`${HOME}/.ssh`, `/System/Volumes/Data${HOME}/.ssh/id_rsa`)).toBe(true);
    expect(containsPath(WORKSPACE, `/System/Volumes/Data${WORKSPACE}/a.ts`)).toBe(true);
    expect(containsPath("/", "/System/Volumes/Data")).toBe(true);
  });
});

describe("readDenial", () => {
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

  it("names the tier: credential material apart from private data", () => {
    expect(readDenial(policy(), `${HOME}/.ssh/id_ed25519`)).toEqual({
      entry: `${HOME}/.ssh`,
      tier: "credential",
    });
    expect(readDenial(policy(), `${HOME}/.aws/credentials`)?.tier).toBe("credential");
    expect(readDenial(policy(), `${HOME}/.aws/config`)?.tier).toBe("private");
    expect(readDenial(policy(), `${HOME}/.config/gh/hosts.yml`)?.tier).toBe("credential");
    expect(readDenial(policy(), `${HOME}/.config/nvim/init.lua`)?.tier).toBe("private");
    expect(readDenial(policy(), `${HOME}/.zshrc`)?.tier).toBe("private");
    expect(readDenial(policy(), "/Users/other/notes.txt")?.tier).toBe("private");
    expect(readDenial(policy(), `${USER_DATA}/mcp-credentials.json`)?.tier).toBe("credential");
    expect(readDenial(policy(), `${USER_DATA}/volli.db`)?.tier).toBe("private");
  });

  it("grants a Session its own saved output, never another Session's", () => {
    expect(readDenial(policy(), `${OWN_OUTPUT}/a.txt`)).toBeUndefined();
    expect(readDenial(policy(), `${USER_DATA}/pi-sessions/--ws--/theirs.tool-output/a`)).toEqual({
      entry: USER_DATA,
      tier: "private",
    });
    expect(readDenial(policy(), `${OWN_OUTPUT}-x/a.txt`)?.entry).toBe(USER_DATA);
  });

  it("lets a grant win a tie with a private entry, and never reach into a credential", () => {
    // A workspace that IS ~/.pi reads its own tree, but not the key inside it.
    const piWorkspace = policy({ readAllow: [`${HOME}/.pi`] });
    expect(readDenial(piWorkspace, `${HOME}/.pi/notes.md`)).toBeUndefined();
    expect(readDenial(piWorkspace, `${HOME}/.pi/agent/auth.json`)?.tier).toBe("credential");
    // Depth, not list order, decides between private entries.
    expect(
      readDenial(policy({ privateDeny: ["/a/b", "/a"], readAllow: [] }), "/a/b/c")?.entry,
    ).toBe("/a/b");
    expect(readDenial(policy({ privateDeny: ["/a/b"], readAllow: ["/a"] }), "/a/b/c")?.entry).toBe(
      "/a/b",
    );
  });

  it("answers a denied read as a verdict naming the tier", () => {
    expect(capabilityRead(policy(), `${HOME}/.ssh/id`)).toMatchObject({
      outcome: "deny",
      denial: "credential",
    });
  });

  it("writes its reasons by tier", () => {
    expect(denialReason("/x", { entry: "/x", tier: "credential" })).toContain("holds credentials");
    expect(denialReason("/x", { entry: "/x", tier: "private" })).toContain(
      "needs the user's approval",
    );
  });
});

describe("operandDenial", () => {
  it("reaches a denied entry through a glob, and only through a glob that can name it", () => {
    expect(operandReach(`${HOME}/.ss?/id*`, `${HOME}/.ssh`)).toBe("inside");
    expect(operandReach(`${HOME}/.ss[h]`, `${HOME}/.ssh`)).toBe("inside");
    expect(operandReach(`${HOME}/.s[!x]h/k`, `${HOME}/.ssh`)).toBe("inside");
    expect(operandReach(`${HOME}/*`, `${HOME}/.ssh`)).toBeNull();
    expect(operandReach(`${HOME}/L*`, `${HOME}/Library/Keychains`)).toBe("ancestor");
    expect(operandReach(`${HOME}/.x[y`, `${HOME}/.x[y/z`)).toBe("ancestor");
    expect(operandDenial(policy(), `${HOME}/.ss?/id*`, false)?.tier).toBe("credential");
    expect(operandDenial(policy(), `${HOME}/.zsh*`, false)?.tier).toBe("private");
    expect(operandDenial(policy(), `${WORKSPACE}/src/*.ts`, false)).toBeUndefined();
    expect(hasGlob("a*b")).toBe(true);
    expect(hasGlob("plain")).toBe(false);
  });

  it("refuses a recursive reader handed a directory above a denied entry", () => {
    expect(operandDenial(policy(), HOME, false)).toBeUndefined();
    expect(operandDenial(policy(), HOME, true)).toEqual({
      entry: `${HOME}/.ssh`,
      tier: "credential",
    });
    expect(operandDenial(policy(), "/Users/other", true)?.tier).toBe("private");
    expect(operandDenial(policy(), `${HOME}/code`, true)).toBeUndefined();
    // A private entry the Session was granted is not one a recursive read reaches.
    const piWorkspace = policy({
      credentialDeny: [],
      privateDeny: [`${HOME}/.pi`],
      readAllow: [`${HOME}/.pi`],
    });
    expect(operandDenial(piWorkspace, `${HOME}/.pi`, true)).toBeUndefined();
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
      expect(isDeviceSink(sink)).toBe(true);
    }
  });

  it("refuses a write outside every root, naming them", () => {
    const verdict = capabilityWrite(policy(), "/tmp/out.txt");
    expect(verdict).toMatchObject({ outcome: "deny", denial: "outside-roots" });
    expect(verdict.outcome === "deny" && verdict.reason).toContain(WORKSPACE);
  });

  it("never writes the host's data, whatever root or grant covers it (VC-480)", () => {
    for (const path of [
      `${OWN_OUTPUT}/a.txt`,
      `${USER_DATA}/volli.db`,
      `${USER_DATA}/volli.db-wal`,
      `${USER_DATA}/pi-sessions/--ws--/other.jsonl`,
      `${USER_DATA}/VOLLI.DB`,
    ]) {
      expect(capabilityWrite(policy(), path), path).toMatchObject({ denial: "host-data" });
      // A root laid over it, or one inside it, does not make it writable.
      for (const root of [`${HOME}/Library`, USER_DATA, `${USER_DATA}/pi-sessions`]) {
        expect(writeDenial(policy({ writableRoots: [root] }), path)?.tier, root).toBe("host-data");
      }
    }
    // Reading it stays private, and so approvable; the credential file inside stays a credential.
    expect(readDenial(policy(), `${USER_DATA}/volli.db`)?.tier).toBe("private");
    expect(writeDenial(policy(), `${USER_DATA}/mcp-credentials.json`)?.tier).toBe("credential");
    const verdict = capabilityWrite(policy(), `${USER_DATA}/volli.db`);
    expect(verdict.outcome === "deny" && verdict.reason).toContain("with or without approval");
  });

  it("reaches the host's data through a command that can change it, inside or, for a whole-tree change, above", () => {
    expect(hostDataReach(policy(), `${USER_DATA}/volli.db`, false)).toEqual({
      entry: USER_DATA,
      tier: "host-data",
    });
    expect(hostDataReach(policy(), `${USER_DATA}/*.db`, false)?.tier).toBe("host-data");
    expect(hostDataReach(policy(), `${HOME}/Library`, false)).toBeUndefined();
    expect(hostDataReach(policy(), `${HOME}/Library`, true)?.tier).toBe("host-data");
    expect(hostDataReach(policy(), `${WORKSPACE}/x`, true)).toBeUndefined();
  });

  it("never writes a credential, and a private entry only from a root at least as deep", () => {
    expect(capabilityWrite(policy({ writableRoots: [HOME] }), `${HOME}/.zshrc`)).toMatchObject({
      denial: "private",
    });
    const piWorkspace = policy({ writableRoots: [`${HOME}/.pi`] });
    expect(capabilityWrite(piWorkspace, `${HOME}/.pi/notes.md`)).toEqual({ outcome: "allow" });
    expect(writeDenial(piWorkspace, `${HOME}/.pi/agent/auth.json`)?.tier).toBe("credential");
    expect(capabilityWrite(policy(), `${HOME}/.zshrc`)).toMatchObject({ denial: "private" });
  });

  it("carves the plan's metadata out of every root", () => {
    for (const [path, denial] of [
      [`${WORKSPACE}/.git`, "git-metadata"],
      [`${WORKSPACE}/.gitmodules`, "git-metadata"],
      [`${WORKSPACE}/.volli/state.json`, "volli-state"],
      [`${WORKSPACE}/vendor/lib/.git/HEAD`, "git-metadata"],
      [`${HOME}/code/p/.git/objects/info/alternates`, "git-metadata"],
    ] as const) {
      const verdict = capabilityWrite(policy(), path);
      expect(verdict, path).toMatchObject({ outcome: "deny", denial });
      expect(verdict.outcome === "deny" && verdict.reason).toContain(path);
    }
    // A Main checkout's own .git: plumbing refused, the rest is git's to write.
    const main = policy({ writableRoots: ["/r"], protectedPaths: [] });
    expect(capabilityWrite(main, "/r/.git/hooks/pre-commit")).toMatchObject({
      denial: "git-metadata",
    });
    expect(capabilityWrite(main, "/r/.git/config.lock")).toMatchObject({ denial: "git-metadata" });
    expect(capabilityWrite(main, "/r/.git/index")).toEqual({ outcome: "allow" });
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
    // Inside a git directory slice, the list is judged from that `.git` down.
    expect(
      capabilityWrite(
        policy({ writableRoots: ["/r/.git/objects"], sandboxCarveOuts: true }),
        "/r/.git/objects/ab/cd",
      ),
    ).toEqual({ outcome: "allow" });
  });
});

describe("git plumbing", () => {
  it("reaches config, hooks, worktree pointers, submodules and alternates", () => {
    for (const path of [
      "/r/.git/hooks/pre-commit",
      "/r/.GIT/HOOKS/x",
      "/r/.git/config",
      "/r/.git/config.lock",
      "/r/.git/config.worktree",
      "/r/.git/worktrees/w/commondir",
      "/r/.git/worktrees/w/gitdir",
      "/r/.git/worktrees/w/config.worktree",
      "/r/.git/modules/a/hooks/pre-commit",
      "/r/.git/modules/vendor/lib/config",
      "/r/.git/objects/info/alternates",
      "/r/.git/objects/info/http-alternates",
    ]) {
      expect(isGitPlumbingPath(path), path).toBe(true);
    }
  });

  it("leaves what git itself writes to git", () => {
    for (const path of [
      "/r/.git/index",
      "/r/.git/refs/heads/main",
      "/r/.git/worktrees/w/HEAD",
      "/r/.git/worktrees/w",
      "/r/.git/modules/a/index",
      "/r/.git/modules/hooks",
      "/r/.git/objects/info/packs",
      "/r/.git/objects/info",
      "/r/.git/objects/ab/cd",
      "/r/.github/hooks/x",
    ]) {
      expect(isGitPlumbingPath(path), path).toBe(false);
    }
  });

  it("matches .volli only at a root's top, and judges each root that holds a path", () => {
    expect(writeCarveOut(policy(), `${WORKSPACE}/src/.volli/x`)).toBeNull();
    expect(writeCarveOut(policy(), `${WORKSPACE}/.vollibration`)).toBeNull();
    expect(writeCarveOut(policy(), "/tmp/outside/.git/hooks/x")).toBeNull();
    const nested = policy({
      writableRoots: [`${HOME}/code`, `${HOME}/code/p`],
      protectedPaths: [],
    });
    expect(writeCarveOut(nested, `${HOME}/code/p/.volli/x`)).toBe("volli-state");
    expect(writeCarveOut(nested, `${HOME}/code/p/src/a.ts`)).toBeNull();
  });
});

describe("sandboxWriteCarveOuts", () => {
  it("spells an ordinary root's carve-outs rooted, with literals that also block renames", () => {
    expect(sandboxWriteCarveOuts("/ws", false)).toEqual([
      "/ws/.volli",
      "/ws/.git/hooks",
      "/ws/.git/config",
      "/ws/.git/config.lock",
      "/ws/.git/config.worktree",
      "/ws/.git/objects/info/alternates",
      "/ws/.git/objects/info/http-alternates",
      "/ws/.git/worktrees/*/commondir",
      "/ws/.git/worktrees/*/gitdir",
      "/ws/.git/worktrees/*/config.worktree",
      "/ws/.git/modules/**/hooks",
      "/ws/.git/modules/**/config",
      "/ws/*/**/.git",
      "/ws/**/.gitmodules",
    ]);
    expect(sandboxWriteCarveOuts("/ws", true)).toEqual(
      expect.arrayContaining(["/ws/**/.vscode", "/ws/**/.mcp.json"]),
    );
  });

  it("spells a git-directory slice from its .git", () => {
    expect(sandboxWriteCarveOuts("/r/.git/worktrees/w", true)).toEqual(
      expect.arrayContaining(["/r/.git/hooks", "/r/.git/worktrees/*/gitdir"]),
    );
  });
});

describe("linkedAlias", () => {
  it("names a multiply-linked file by the denied path it shares an inode with", () => {
    const linked = policy({ linkedFiles: { "1:42": `${HOME}/.ssh/id_rsa` } });
    expect(linkedAlias(linked, `${WORKSPACE}/k`, "1:42")).toBe(`${HOME}/.ssh/id_rsa`);
    expect(linkedAlias(linked, `${WORKSPACE}/k`, "1:43")).toBe(`${WORKSPACE}/k`);
  });
});
