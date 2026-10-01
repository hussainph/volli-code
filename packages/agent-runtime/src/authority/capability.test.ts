import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilityRead,
  capabilityWrite,
  HOME_CREDENTIAL_PATHS,
  HOME_PRIVATE_PATHS,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

const indexFault: { stat?: string; directory?: string; read?: string; code?: string } = {};
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fail = (path: unknown, expected: string | undefined) => {
    if (expected !== undefined && String(path) === expected)
      throw Object.assign(new Error("index fault"), { code: indexFault.code });
  };
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      fail(args[0], indexFault.stat);
      return actual.lstatSync(...args);
    },
    opendirSync: (...args: Parameters<typeof actual.opendirSync>) => {
      fail(args[0], indexFault.directory);
      const directory = actual.opendirSync(...args);
      const read = directory.readSync.bind(directory);
      directory.readSync = () => {
        fail(args[0], indexFault.read);
        return read();
      };
      return directory;
    },
  };
});
import { gitCommonDirOf, resolveCapabilityPolicy, usersRootFor, worktreeGitOf } from "./capability";

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

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

/** A repository with one commit, and a linked worktree on its own branch. */
function repository(base: string): { main: string; worktree: string } {
  const main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "--quiet", "--initial-branch=main");
  git(
    main,
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
  git(main, "worktree", "add", "--quiet", "-b", "volli/VC-1-x", worktree);
  return { main, worktree };
}

describe("resolveCapabilityPolicy", () => {
  it("puts key material in the credential tier and the rest of the denylist in the private one", () => {
    const { usersRoot, home, other } = users();
    writeFileSync(join(home, ".custom-token"), "t");
    // An rc file kept in a dotfiles repository: denied by name AND at its target,
    // because the kernel matches the resolved file.
    const dotfiles = join(home, "dotfiles");
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
      xdgConfigHome: join(home, ".config"),
      sandboxCarveOuts: false,
    });

    expect(policy.credentialDeny).toEqual(
      expect.arrayContaining([
        ...HOME_CREDENTIAL_PATHS.map((entry) => join(home, entry)),
        "/Library/Keychains",
      ]),
    );
    expect(policy.privateDeny).toEqual(
      expect.arrayContaining([
        ...HOME_PRIVATE_PATHS.map((entry) => join(home, entry)),
        join(home, ".custom-token"),
        join(home, ".linked-rc"),
        join(dotfiles, "zshrc"),
        join(home, ".dangling"),
        other,
      ]),
    );
    for (const allowed of [
      join(home, ".nvm"),
      join(home, ".agents"),
      join(home, ".dotfiles"),
      dotfiles,
      join(usersRoot, "Shared"),
      home,
    ]) {
      expect([...policy.credentialDeny, ...policy.privateDeny]).not.toContain(allowed);
    }
    expect(policy.writableRoots).toEqual([workspace]);
    expect(policy.protectedPaths).toEqual([]);
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
    expect(policy.privateDeny).not.toContain(join(usersRoot, "someone"));
  });

  it("follows a config home moved by XDG_CONFIG_HOME, its credentials included", () => {
    const base = scratch();
    const config = join(base, "xdg");
    mkdirSync(config);
    const policy = resolveCapabilityPolicy({
      workspacePath: base,
      home: join(base, "home"),
      xdgConfigHome: config,
      sandboxCarveOuts: false,
    });
    expect(policy.privateDeny).toContain(config);
    expect(policy.credentialDeny).toContain(join(config, "gh", "hosts.yml"));
  });

  it("puts every browser and Electron credential store it finds in the credential tier", () => {
    const base = scratch();
    const home = join(base, "home");
    const support = join(home, "Library", "Application Support");
    for (const file of [
      "Slack/Local State",
      "Slack/Cookies",
      "Google/Chrome/Local State",
      "Google/Chrome/Default/Login Data",
      "Google/Chrome/Profile 1/Network/Cookies",
      "Firefox/Profiles/x.default/logins.json",
    ]) {
      mkdirSync(join(support, file, ".."), { recursive: true });
      writeFileSync(join(support, file), "");
    }
    const policy = resolveCapabilityPolicy({ workspacePath: base, home, sandboxCarveOuts: false });
    for (const file of [
      "Slack/Local State",
      "Slack/Cookies",
      "Google/Chrome/Local State",
      "Google/Chrome/Default/Login Data",
      "Google/Chrome/Profile 1/Network/Cookies",
      "Firefox/Profiles/x.default/logins.json",
    ]) {
      expect(policy.credentialDeny, file).toContain(join(support, file));
    }
    expect(capabilityRead(policy, join(support, "Slack", "logs", "x.log"))).toMatchObject({
      denial: "private",
    });
  });

  it("adds the host's own data, and carves back only grants inside the private tier", () => {
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
    const credentials = join(userData, "mcp-credentials.json");

    const policy = resolveCapabilityPolicy({
      workspacePath: workspace,
      home: join(base, "home"),
      privateRoots: [userData],
      credentialPaths: [credentials],
      grants: [own, bin, linked, outside, credentials, join(userData, "later.tool-output")],
      sandboxCarveOuts: false,
    });

    expect(policy.privateDeny).toContain(userData);
    expect(policy.credentialDeny).toContain(credentials);
    expect(policy.readAllow).toEqual([own, bin, join(userData, "later.tool-output")]);
    expect(capabilityRead(policy, credentials)).toMatchObject({ denial: "credential" });
    expect(capabilityRead(policy, join(userData, "volli.db"))).toMatchObject({ denial: "private" });
    expect(capabilityRead(policy, join(own, "tc.txt")).outcome).toBe("allow");
    // A root no resolver can canonicalize is kept as written rather than dropped.
    const unresolvable = join(base, "x".repeat(400), "y");
    expect(
      resolveCapabilityPolicy({
        workspacePath: workspace,
        home: join(base, "home"),
        privateRoots: [unresolvable],
        sandboxCarveOuts: false,
      }).privateDeny,
    ).toContain(unresolvable);
  });

  it("lets a workspace that IS a private directory own its tree, but not the credentials in it", () => {
    const base = scratch();
    const home = join(base, "home");
    const pi = join(home, ".pi");
    mkdirSync(join(pi, "agent"), { recursive: true });
    writeFileSync(join(pi, "agent", "auth.json"), "{}");
    const policy = resolveCapabilityPolicy({ workspacePath: pi, home, sandboxCarveOuts: false });
    expect(policy.readAllow).toContain(pi);
    expect(capabilityRead(policy, join(pi, "notes.md")).outcome).toBe("allow");
    expect(capabilityWrite(policy, join(pi, "notes.md")).outcome).toBe("allow");
    expect(capabilityRead(policy, join(pi, "agent", "auth.json"))).toMatchObject({
      denial: "credential",
    });
  });

  it("drops a grant the kernel would revoke: inside a deny that sits inside another grant", () => {
    const base = scratch();
    const home = join(base, "home");
    const support = join(home, "Library", "Application Support");
    const inner = join(support, "App", "data", "own.tool-output");
    mkdirSync(inner, { recursive: true });
    // A workspace over the private root holding the inner grant.
    const workspace = join(support, "App");
    const policy = resolveCapabilityPolicy({
      workspacePath: workspace,
      home,
      privateRoots: [join(support, "App", "data")],
      grants: [inner],
      sandboxCarveOuts: false,
    });
    expect(policy.readAllow).toContain(workspace);
    expect(policy.readAllow).not.toContain(inner);
  });

  it("indexes hard links into the denylist, by device and inode", () => {
    const base = scratch();
    const home = join(base, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    writeFileSync(join(home, ".ssh", "known_hosts"), "");
    linkSync(join(home, ".ssh", "id_ed25519"), join(base, "planted"));
    const policy = resolveCapabilityPolicy({ workspacePath: base, home, sandboxCarveOuts: false });
    const planted = lstatSync(join(base, "planted"));
    expect(policy.linkedFiles[`${planted.dev}:${planted.ino}`]).toBe(
      join(home, ".ssh", "id_ed25519"),
    );
    expect(Object.keys(policy.linkedFiles)).toHaveLength(1);
    // A partial index would open the kernel boundary: refuse the attachment.
    expect(() =>
      resolveCapabilityPolicy({
        workspacePath: base,
        home,
        sandboxCarveOuts: false,
        linkIndexBudget: 0,
      }),
    ).toThrow(/hard-link index.*entry limit/u);
  });

  it("records workspace aliases of critical Volli data independently of the general link budget", () => {
    const base = scratch();
    const workspace = join(base, "workspace");
    const userData = join(base, "userData");
    mkdirSync(join(workspace, "nested"), { recursive: true });
    mkdirSync(userData);
    const db = join(userData, "volli.db");
    const alias = join(workspace, "nested", "cache.db");
    const singleton = join(userData, "singleton.json");
    const localCritical = join(workspace, "local-critical.db");
    const unrelated = join(workspace, "unrelated.txt");
    writeFileSync(db, "authority");
    writeFileSync(singleton, "one name");
    writeFileSync(localCritical, "local");
    writeFileSync(unrelated, "ordinary");
    linkSync(db, alias);
    // Cover both non-matching workspace links and a critical source whose
    // second name is outside the workspace: neither is a literal alias to deny.
    linkSync(unrelated, join(workspace, "unrelated-too.txt"));
    linkSync(localCritical, join(base, "local-critical-outside.db"));

    const policy = resolveCapabilityPolicy({
      workspacePath: workspace,
      home: join(base, "home"),
      privateRoots: [userData],
      criticalHostDataPaths: [db, `${db}-wal`, `${db}-shm`, singleton, localCritical],
      sandboxCarveOuts: true,
    });
    const linked = lstatSync(alias);
    expect(policy.hostDataAliases).toEqual([alias]);
    expect(policy.linkedFiles[`${linked.dev}:${linked.ino}`]).toBe(db);
  });
});

describe("hard-link index limits and all granted roots", () => {
  it("refuses attachment when a planted credential's .ssh folder is unreadable", () => {
    const base = scratch();
    const home = join(base, "home");
    const workspace = join(base, "workspace");
    const ssh = join(home, ".ssh");
    mkdirSync(ssh, { recursive: true });
    mkdirSync(workspace);
    const key = join(ssh, "id_ed25519");
    writeFileSync(key, "dummy-credential-never-real");
    linkSync(key, join(workspace, "planted"));
    const input = {
      workspacePath: workspace,
      home,
      xdgConfigHome: join(home, ".config"),
      sandboxCarveOuts: true,
    };
    try {
      // Positive control: the scan finds the planted alias when it can read .ssh.
      expect(resolveCapabilityPolicy(input).credentialDeny).toContain(join(workspace, "planted"));
      chmodSync(ssh, 0o000);
      expect(() => resolveCapabilityPolicy(input)).toThrow(
        `Cannot scan folder "${ssh}" because permission was denied; refusing Scoped attachment.`,
      );
    } finally {
      chmodSync(ssh, 0o700);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each(["EACCES", "EPERM", "EIO"])("refuses critical-file stat failure %s", (code) => {
    const base = scratch();
    const db = join(base, "volli.db");
    writeFileSync(db, "dummy-host-data");
    indexFault.stat = db;
    indexFault.code = code;
    try {
      expect(() =>
        resolveCapabilityPolicy({
          workspacePath: base,
          home: join(base, "home"),
          sandboxCarveOuts: true,
          criticalHostDataPaths: [db],
        }),
      ).toThrow(code === "EIO" ? "index fault" : `Cannot scan folder "${base}"`);
    } finally {
      delete indexFault.stat;
      delete indexFault.code;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("allows absent credential folders and critical files", () => {
    const base = scratch();
    try {
      expect(() =>
        resolveCapabilityPolicy({
          workspacePath: base,
          home: join(base, "missing-home"),
          xdgConfigHome: join(base, "missing-config"),
          sandboxCarveOuts: true,
          criticalHostDataPaths: [join(base, "missing-db")],
        }),
      ).not.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses an incomplete alias walk at its entry or time limit", () => {
    const base = scratch();
    const workspace = join(base, "workspace");
    const home = join(base, "home");
    mkdirSync(workspace);
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const key = join(home, ".ssh", "id_ed25519");
    writeFileSync(key, "key");
    linkSync(key, join(workspace, "alias"));
    const input = { workspacePath: workspace, home, sandboxCarveOuts: true };
    expect(() => resolveCapabilityPolicy({ ...input, aliasIndexBudget: 0 })).toThrow(
      /hard-link index.*entry limit/u,
    );
    expect(() => resolveCapabilityPolicy({ ...input, linkIndexTimeoutMs: 0 })).toThrow(
      /hard-link index.*time limit/u,
    );
  });

  it.each(["stat", "directory", "read"] as const)(
    "handles %s errors without silently skipping an unscannable writable root",
    (operation) => {
      const base = scratch();
      const workspace = join(base, "workspace");
      const home = join(base, "home");
      const source = join(home, ".ssh");
      mkdirSync(workspace);
      mkdirSync(source, { recursive: true });
      const db = join(base, "db");
      writeFileSync(db, "db");
      linkSync(db, join(workspace, "alias"));
      const input = {
        workspacePath: workspace,
        home,
        sandboxCarveOuts: true,
        criticalHostDataPaths: [db],
      };
      try {
        for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO"]) {
          indexFault.code = code;
          for (const path of [source, workspace]) {
            indexFault[operation] = path;
            if (code === "ENOENT" || code === "ENOTDIR") {
              expect(() => resolveCapabilityPolicy(input)).not.toThrow();
            } else {
              const folder = operation === "stat" ? join(path, "..") : path;
              expect(() => resolveCapabilityPolicy(input)).toThrow(
                code === "EACCES" || code === "EPERM"
                  ? `Cannot scan folder "${folder}" because permission was denied; refusing Scoped attachment.`
                  : "index fault",
              );
            }
          }
        }
      } finally {
        delete indexFault.stat;
        delete indexFault.directory;
        delete indexFault.read;
        delete indexFault.code;
      }
    },
  );

  it("denies credential aliases in the worktree's granted git slices too", () => {
    const base = scratch();
    const { main, worktree } = repository(base);
    const home = join(base, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const key = join(home, ".ssh", "id_ed25519");
    const alias = join(main, ".git", "objects", "credential-alias");
    writeFileSync(key, "key");
    linkSync(key, alias);
    const policy = resolveCapabilityPolicy({
      workspacePath: worktree,
      home,
      sandboxCarveOuts: true,
    });
    expect(policy.credentialDeny).toContain(alias);
    expect(capabilityRead(policy, alias).outcome).toBe("deny");
    expect(capabilityWrite(policy, alias).outcome).toBe("deny");
  });
});

describe("a Ticket worktree's repository", () => {
  it("writes only the slices of the common git directory its commits need", () => {
    const { main, worktree } = repository(scratch());
    const common = join(main, ".git");
    const own = worktreeGitOf(worktree);
    expect(own).toEqual({
      gitDir: join(common, "worktrees", "wt"),
      commonDir: common,
      branch: "volli/VC-1-x",
    });
    expect(gitCommonDirOf(worktree)).toBe(common);
    expect(gitCommonDirOf(main)).toBeUndefined();

    const policy = resolveCapabilityPolicy({ workspacePath: worktree, sandboxCarveOuts: true });
    const ref = join(common, "refs", "heads", "volli", "VC-1-x");
    expect(policy.writableRoots).toEqual([
      worktree,
      join(common, "objects"),
      join(common, "worktrees", "wt"),
      join(common, "packed-refs.lock"),
      ref,
      `${ref}.lock`,
      join(common, "logs", "refs", "heads", "volli", "VC-1-x"),
    ]);
    expect(policy.protectedPaths).toEqual([join(worktree, ".git")]);
    const allowed = (path: string) => capabilityWrite(policy, path).outcome;
    expect(allowed(join(common, "objects", "ab", "cd"))).toBe("allow");
    expect(allowed(join(common, "worktrees", "wt", "index"))).toBe("allow");
    expect(allowed(ref)).toBe("allow");
    // Redirection and shared state stay out of reach.
    for (const path of [
      join(worktree, ".git"),
      join(common, "worktrees", "wt", "commondir"),
      join(common, "worktrees", "wt", "gitdir"),
      join(common, "objects", "info", "alternates"),
      join(common, "hooks", "post-checkout"),
      join(common, "config"),
      join(common, "HEAD"),
      join(common, "index"),
      join(common, "packed-refs"),
      join(common, "refs", "heads", "main"),
      join(common, "refs", "stash"),
    ]) {
      expect(allowed(path), path).toBe("deny");
    }
  });

  it("writes no branch ref for a detached worktree", () => {
    const base = scratch();
    const { main } = repository(base);
    const detached = join(base, "detached");
    git(main, "worktree", "add", "--quiet", "--detach", detached);
    const common = join(main, ".git");
    expect(
      resolveCapabilityPolicy({ workspacePath: detached, sandboxCarveOuts: true }).writableRoots,
    ).toEqual([
      detached,
      join(common, "objects"),
      join(common, "worktrees", "detached"),
      join(common, "packed-refs.lock"),
    ]);
  });

  it("protects a Main checkout's other worktrees' state", () => {
    const { main } = repository(scratch());
    const policy = resolveCapabilityPolicy({ workspacePath: main, sandboxCarveOuts: true });
    expect(policy.protectedPaths).toEqual([join(main, ".git", "worktrees")]);
    expect(capabilityWrite(policy, join(main, ".git", "worktrees", "wt", "HEAD")).outcome).toBe(
      "deny",
    );
    expect(capabilityWrite(policy, join(main, ".git", "index")).outcome).toBe("allow");
  });

  it("reads no repository from a .git file it cannot follow", () => {
    const base = scratch();
    writeFileSync(join(base, ".git"), "not a pointer\n");
    expect(worktreeGitOf(base)).toBeUndefined();
    const dangling = scratch();
    writeFileSync(join(dangling, ".git"), "gitdir: ./nowhere\n");
    expect(worktreeGitOf(dangling)).toBeUndefined();
    const absolute = scratch();
    const gitDir = join(absolute, "gd");
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, "commondir"), `${absolute}/common\n`);
    writeFileSync(join(absolute, ".git"), `gitdir: ${gitDir}\n`);
    // No HEAD, or a detached one, names no branch to write.
    expect(worktreeGitOf(absolute)).toEqual({
      gitDir,
      commonDir: join(absolute, "common"),
      branch: null,
    });
    writeFileSync(join(gitDir, "HEAD"), "0123456789abcdef\n");
    expect(worktreeGitOf(absolute)?.branch).toBeNull();
  });
});
