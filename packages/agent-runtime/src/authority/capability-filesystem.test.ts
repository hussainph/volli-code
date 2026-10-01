import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityRead } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

const fault = vi.hoisted(() => ({
  operation: "",
  path: "",
  caller: "",
  occurrence: 1,
  seen: 0,
  hits: 0,
  code: "",
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fail = (operation: string, path: unknown) => {
    if (
      operation !== fault.operation ||
      String(path) !== fault.path ||
      !new Error().stack?.includes(fault.caller)
    )
      return;
    if (++fault.seen !== fault.occurrence) return;
    fault.hits++;
    throw Object.assign(new Error("injected policy filesystem failure"), { code: fault.code });
  };
  const realpath = Object.assign(
    (...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args),
    {
      native: (...args: Parameters<typeof actual.realpathSync.native>) => {
        fail("realpath", args[0]);
        return actual.realpathSync.native(...args);
      },
    },
  );
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      fail("lstat", args[0]);
      return actual.lstatSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      fail("stat", args[0]);
      return actual.statSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      fail("readdir", args[0]);
      return actual.readdirSync(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      fail("readFile", args[0]);
      return actual.readFileSync(...args);
    },
    readlinkSync: (...args: Parameters<typeof actual.readlinkSync>) => {
      fail("readlink", args[0]);
      return actual.readlinkSync(...args);
    },
    realpathSync: realpath,
    opendirSync: (...args: Parameters<typeof actual.opendirSync>) => {
      fail("opendir", args[0]);
      const directory = actual.opendirSync(...args);
      const read = directory.readSync.bind(directory);
      const close = directory.closeSync.bind(directory);
      directory.readSync = () => {
        fail("read", args[0]);
        return read();
      };
      directory.closeSync = () => {
        // Close the real handle even when injecting a close error.
        close();
        fail("close", args[0]);
      };
      return directory;
    },
  };
});
// This test only models dummy stores, never enumerates the machine's keychains.
vi.mock("@volli/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@volli/shared")>()),
  SYSTEM_CREDENTIAL_PATHS: [],
}));
import { resolveCapabilityPolicy } from "./capability";
import { policyFilesystem } from "./policy-filesystem";

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "volli-policy-filesystem-")));
  const usersRoot = join(base, "users");
  const home = join(usersRoot, "dummy-home");
  const workspace = join(base, "workspace");
  const support = join(home, "Library", "Application Support");
  const firefox = join(support, "Firefox", "Profiles");
  const browser = join(support, "Google", "Chrome");
  const ssh = join(home, ".ssh");
  const gitDir = join(base, "git-admin");
  const grant = join(home, "Library", "private", "grant");
  for (const path of [
    workspace,
    ssh,
    gitDir,
    grant,
    join(browser, "Default"),
    join(firefox, "dummy.default"),
  ])
    mkdirSync(path, { recursive: true });
  const cookie = join(firefox, "dummy.default", "cookies.sqlite");
  const key = join(ssh, "dummy-key");
  const critical = join(base, "dummy-db");
  const dotfile = join(home, ".dummy-rc");
  const linkedDotfile = join(home, ".linked-rc");
  const appCookie = join(support, "Firefox", "Cookies");
  const browserCookie = join(browser, "Default", "Cookies");
  const localState = join(browser, "Local State");
  for (const path of [cookie, key, critical, dotfile, appCookie, browserCookie, localState])
    writeFileSync(path, "dummy-data-never-real");
  symlinkSync(dotfile, linkedDotfile);
  for (const [source, name] of [
    [cookie, "cookie-alias"],
    [key, "key-alias"],
    [critical, "db-alias"],
  ])
    linkSync(source!, join(workspace, name!));
  writeFileSync(join(workspace, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "commondir"), `${base}/common\n`);
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/dummy\n");
  const input = {
    workspacePath: workspace,
    home,
    usersRoot,
    xdgConfigHome: join(home, ".config"),
    grants: [grant],
    criticalHostDataPaths: [critical],
    sandboxCarveOuts: true,
  };
  return {
    base,
    home,
    workspace,
    support,
    firefox,
    browser,
    ssh,
    gitDir,
    grant,
    cookie,
    key,
    critical,
    dotfile,
    linkedDotfile,
    appCookie,
    browserCookie,
    localState,
    usersRoot,
    input,
  };
}

type Fixture = ReturnType<typeof fixture>;
type Site = {
  name: string;
  operation: string;
  caller: string;
  path: (f: Fixture) => string;
  directory?: boolean;
  occurrence?: number;
};
// Every syntactic filesystem call, and every discovery/walk context sharing it.
const sites: Site[] = [
  {
    name: "canonical component",
    operation: "lstat",
    caller: "resolveFilesystemPath",
    path: (f) => f.home,
  },
  {
    name: "canonical link target",
    operation: "readlink",
    caller: "resolveFilesystemPath",
    path: (f) => f.linkedDotfile,
  },
  {
    name: "canonical stored prefix",
    operation: "realpath",
    caller: "resolveFilesystemPath",
    path: (f) => f.home,
  },
  {
    name: "worktree pointer stat",
    operation: "lstat",
    caller: "worktreeGitOf",
    path: (f) => join(f.workspace, ".git"),
  },
  {
    name: "worktree pointer read",
    operation: "readFile",
    caller: "worktreeGitOf",
    path: (f) => join(f.workspace, ".git"),
  },
  {
    name: "worktree common directory read",
    operation: "readFile",
    caller: "worktreeGitOf",
    path: (f) => join(f.gitDir, "commondir"),
  },
  {
    name: "worktree HEAD read",
    operation: "readFile",
    caller: "worktreeGitOf",
    path: (f) => join(f.gitDir, "HEAD"),
  },
  ...[
    ["Application Support", (f: Fixture) => f.support],
    ["Chromium profiles", (f: Fixture) => f.browser],
    ["Firefox profiles", (f: Fixture) => f.firefox],
    ["home dotfiles", (f: Fixture) => f.home],
    ["other homes", (f: Fixture) => f.usersRoot],
  ].map(([name, path]) => ({
    name: String(name),
    path: path as Site["path"],
    operation: "readdir",
    caller: "entriesOf",
    directory: true,
  })),
  {
    name: "home dotfiles for link index",
    operation: "readdir",
    caller: "entriesOf",
    path: (f) => f.home,
    directory: true,
    occurrence: 2,
  },
  ...[
    ["app credential existence", (f: Fixture) => f.appCookie],
    ["browser key existence", (f: Fixture) => f.localState],
    ["Chromium credential existence", (f: Fixture) => f.browserCookie],
    ["Firefox credential existence", (f: Fixture) => f.cookie],
  ].map(([name, path]) => ({
    name: String(name),
    path: path as Site["path"],
    operation: "lstat",
    caller: "exists",
  })),
  {
    name: "dotfile directory target",
    operation: "stat",
    caller: "linksToDirectory",
    path: (f) => f.linkedDotfile,
  },
  {
    name: "dotfile directory target for link index",
    operation: "stat",
    caller: "linksToDirectory",
    path: (f) => f.linkedDotfile,
    occurrence: 2,
  },
  {
    name: "critical file identity",
    operation: "lstat",
    caller: "fileIdentity",
    path: (f) => f.critical,
  },
  { name: "grant root", operation: "lstat", caller: "grantRoot", path: (f) => f.grant },
  {
    name: "protected git path",
    operation: "lstat",
    caller: "protectedPathsOf",
    path: (f) => join(f.workspace, ".git"),
  },
  ...(["source", "alias"] as const).flatMap((walk) => {
    const rows: Site[] = [
      {
        name: `${walk} walk root`,
        operation: "lstat",
        caller: "visit",
        path: (f: Fixture) => (walk === "source" ? f.ssh : f.workspace),
      },
      {
        name: `${walk} walk child`,
        operation: "lstat",
        caller: "visit",
        path: (f: Fixture) => (walk === "source" ? f.key : join(f.workspace, "key-alias")),
      },
    ];
    return rows.concat(
      ["opendir", "read", "close"].map((operation) => ({
        name: `${walk} walk ${operation}`,
        operation,
        caller: "visit",
        directory: true,
        path: (f: Fixture) => (walk === "source" ? f.ssh : f.workspace),
      })),
    );
  }),
];
const errors = ["EACCES", "EPERM", "EIO", "ELOOP", "ENOTDIR", "EMFILE", "ENOENT"];

describe("complete attachment filesystem boundary", () => {
  it.each([new Error("unknown"), null, "non-error", { code: undefined }])(
    "refuses a filesystem failure without an errno: %s",
    (error) => {
      expect(() =>
        policyFilesystem("/dummy/path", "stat", () => {
          throw error;
        }),
      ).toThrow(
        'Cannot inspect path "/dummy/path" because the filesystem reported an unknown error; refusing Scoped attachment.',
      );
    },
  );

  it("refuses a symlink cycle at attachment instead of retaining a lexical policy", () => {
    const f = fixture();
    try {
      const loop = join(f.base, "loop");
      symlinkSync(loop, loop);
      expect(() => resolveCapabilityPolicy({ ...f.input, credentialPaths: [loop] })).toThrow(
        `Cannot resolve "${loop}" because too many symbolic links were followed; refusing Scoped attachment.`,
      );
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });
  it.each(sites.flatMap((site) => errors.map((code) => ({ site, code }))))(
    "$site.name — $code",
    ({ site, code }) => {
      const f = fixture();
      try {
        // Positive control: a complete policy protects both kinds of alias.
        const policy = resolveCapabilityPolicy(f.input);
        expect(policy.credentialDeny).toContain(join(f.workspace, "cookie-alias"));
        expect(policy.hostDataAliases).toContain(join(f.workspace, "db-alias"));
        Object.assign(fault, {
          operation: site.operation,
          path: site.path(f),
          caller: site.caller,
          occurrence: site.occurrence ?? 1,
          seen: 0,
          hits: 0,
          code,
        });
        if (code === "ENOENT" || (code === "ENOTDIR" && !site.directory)) {
          expect(() => resolveCapabilityPolicy(f.input)).not.toThrow();
        } else {
          expect(() => resolveCapabilityPolicy(f.input)).toThrow(fault.path);
          // Reset so a second assertion exercises exactly the same failing call.
          fault.seen = 0;
          expect(() => resolveCapabilityPolicy(f.input)).toThrow(/refusing Scoped attachment/u);
        }
        // A passing assertion with an unexercised injection is not coverage.
        expect(fault.hits).toBe(
          code === "ENOENT" || (code === "ENOTDIR" && !site.directory) ? 1 : 2,
        );
      } finally {
        fault.operation = "";
        rmSync(f.base, { recursive: true, force: true });
      }
    },
  );

  it("refuses an unreadable Firefox Profiles directory containing a workspace hard-link alias", () => {
    const f = fixture();
    try {
      expect(
        capabilityRead(resolveCapabilityPolicy(f.input), join(f.workspace, "cookie-alias")).outcome,
      ).toBe("deny");
      chmodSync(f.firefox, 0o000);
      expect(() => resolveCapabilityPolicy(f.input)).toThrow(f.firefox);
      expect(() => resolveCapabilityPolicy(f.input)).toThrow(
        /permission was denied; refusing Scoped attachment/u,
      );
    } finally {
      chmodSync(f.firefox, 0o700);
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  it("accepts ENOTDIR for a genuinely non-directory path component, not directory enumeration", () => {
    const f = fixture();
    try {
      const absent = join(f.critical, "not-a-directory", "child");
      expect(() =>
        resolveCapabilityPolicy({
          ...f.input,
          credentialPaths: [absent],
          criticalHostDataPaths: [absent],
          grants: [absent],
        }),
      ).not.toThrow();
      rmSync(f.firefox, { recursive: true });
      writeFileSync(f.firefox, "not a directory");
      expect(() => resolveCapabilityPolicy(f.input)).toThrow(f.firefox);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });
});
