import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityRead, capabilityWrite, HOME_SECRET_PATHS } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { gitCommonDirOf, resolveCapabilityPolicy, usersRootFor } from "./capability";

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "volli-capability-")));
}

/** A users' directory with this home, another user's, `Shared`, and a dotfile. */
function users(): { usersRoot: string; home: string; other: string } {
  const usersRoot = scratch();
  const home = join(usersRoot, "dev");
  const other = join(usersRoot, "someone");
  for (const directory of [home, other, join(usersRoot, "Shared")]) mkdirSync(directory);
  writeFileSync(join(usersRoot, ".localized"), "");
  return { usersRoot, home, other };
}

describe("resolveCapabilityPolicy", () => {
  it("denies the named secrets, every top-level dotfile the home holds, and other users' homes", () => {
    const { usersRoot, home, other } = users();
    writeFileSync(join(home, ".custom-token"), "t");
    // An rc file kept in a dotfiles repository: denied by name AND at its target,
    // because the kernel matches the resolved file.
    const dotfiles = join(usersRoot, "dev", "dotfiles");
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, "zshrc"), "export TOKEN=x");
    symlinkSync(join(dotfiles, "zshrc"), join(home, ".linked-rc"));
    // A linked dot-DIRECTORY is a dot-directory: not denied unless named.
    symlinkSync(dotfiles, join(home, ".dotfiles"));
    // A dangling link is a file that is not there yet: denied by its name.
    symlinkSync(join(usersRoot, "gone"), join(home, ".dangling"));
    mkdirSync(join(home, ".nvm"));
    mkdirSync(join(home, ".agents"));
    const workspace = join(home, "code", "p");
    mkdirSync(workspace, { recursive: true });

    const policy = resolveCapabilityPolicy({
      workspacePath: workspace,
      home,
      usersRoot,
      sandboxCarveOuts: false,
    });

    expect(policy.readDeny).toEqual(
      expect.arrayContaining([
        ...HOME_SECRET_PATHS.map((entry) => join(home, entry)),
        join(home, ".custom-token"),
        join(home, ".linked-rc"),
        join(dotfiles, "zshrc"),
        join(home, ".dangling"),
        other,
        "/Library/Keychains",
      ]),
    );
    // A dot-DIRECTORY is denied only when named: toolchains and skills live in them.
    for (const allowed of [
      join(home, ".nvm"),
      join(home, ".agents"),
      join(home, ".dotfiles"),
      dotfiles,
      join(usersRoot, "Shared"),
    ]) {
      expect(policy.readDeny).not.toContain(allowed);
    }
    expect(policy.readDeny).not.toContain(home);
    expect(policy.writableRoots).toEqual([workspace]);
  });

  it("knows where each platform keeps its users' homes", () => {
    expect(usersRootFor("darwin")).toBe("/Users");
    expect(usersRootFor("linux")).toBe("/home");
    expect(usersRootFor("win32")).toBeUndefined();
  });

  it("denies no siblings for a home outside the users' directory", () => {
    const { usersRoot } = users();
    const home = scratch();
    const policy = resolveCapabilityPolicy({
      workspacePath: home,
      home,
      usersRoot,
      sandboxCarveOuts: false,
    });
    expect(policy.readDeny).not.toContain(join(usersRoot, "someone"));
  });

  it("adds the host's private roots, and carves back only grants that sit inside a deny", () => {
    const base = scratch();
    const userData = join(base, "userData");
    const own = join(userData, "pi-sessions", "--ws--", "own.tool-output");
    mkdirSync(own, { recursive: true });
    const bin = join(userData, "bin");
    mkdirSync(bin);
    const linked = join(userData, "pi-sessions", "--ws--", "linked.tool-output");
    symlinkSync(join(base, "elsewhere"), linked);
    const outside = join(base, "not-denied");
    mkdirSync(outside);
    const workspace = join(base, "ws");
    mkdirSync(workspace);

    const policy = resolveCapabilityPolicy({
      workspacePath: workspace,
      home: join(base, "home"),
      privateRoots: [userData],
      // Not created yet: the grant covers it once it exists.
      grants: [
        own,
        bin,
        linked,
        outside,
        userData,
        join(userData, "pi-sessions", "later.tool-output"),
      ],
      sandboxCarveOuts: false,
    });

    expect(policy.readDeny).toContain(userData);
    // A root no resolver can canonicalize is kept as written rather than dropped.
    const unresolvable = join(base, "x".repeat(400), "y");
    expect(
      resolveCapabilityPolicy({
        workspacePath: workspace,
        home: join(base, "home"),
        privateRoots: [unresolvable],
        sandboxCarveOuts: false,
      }).readDeny,
    ).toContain(unresolvable);
    expect(policy.readAllow).toEqual([
      own,
      bin,
      join(userData, "pi-sessions", "later.tool-output"),
    ]);
    expect(capabilityRead(policy, join(userData, "mcp-credentials.json")).outcome).toBe("deny");
    expect(capabilityRead(policy, join(own, "tc.txt")).outcome).toBe("allow");
  });

  it("makes a worktree's common git directory a root, and canonicalizes declared and runtime roots", () => {
    const base = scratch();
    const main = join(base, "main");
    mkdirSync(main);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
    git("init", "--quiet");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "i",
    );
    const worktree = join(base, "wt");
    git("worktree", "add", "--quiet", worktree);
    const declared = join(base, "declared");
    mkdirSync(declared);
    const linkToDeclared = join(base, "declared-link");
    symlinkSync(declared, linkToDeclared);

    expect(gitCommonDirOf(worktree)).toBe(join(main, ".git"));
    expect(gitCommonDirOf(main)).toBeUndefined();

    const policy = resolveCapabilityPolicy({
      workspacePath: worktree,
      home: join(base, "home"),
      writableRoots: [linkToDeclared],
      runtimeRoots: [join(base, "scratch")],
      sandboxCarveOuts: true,
    });
    expect(policy.writableRoots).toEqual([
      worktree,
      join(main, ".git"),
      declared,
      join(base, "scratch"),
    ]);
    expect(policy.sandboxCarveOuts).toBe(true);
    // Commits land; hooks and config do not.
    expect(capabilityWrite(policy, join(main, ".git", "objects", "ab", "cd")).outcome).toBe(
      "allow",
    );
    expect(capabilityWrite(policy, join(main, ".git", "hooks", "pre-commit")).outcome).toBe("deny");
    expect(capabilityWrite(policy, join(main, "src.ts")).outcome).toBe("deny");
  });

  it("reads no common directory from a .git file it cannot follow", () => {
    const base = scratch();
    writeFileSync(join(base, ".git"), "not a pointer\n");
    expect(gitCommonDirOf(base)).toBeUndefined();
    const dangling = scratch();
    writeFileSync(join(dangling, ".git"), "gitdir: ./nowhere\n");
    expect(gitCommonDirOf(dangling)).toBeUndefined();
    const absolute = scratch();
    const gitDir = join(absolute, "gd");
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, "commondir"), `${absolute}/common\n`);
    writeFileSync(join(absolute, ".git"), `gitdir: ${gitDir}\n`);
    expect(gitCommonDirOf(absolute)).toBe(join(absolute, "common"));
  });
});
