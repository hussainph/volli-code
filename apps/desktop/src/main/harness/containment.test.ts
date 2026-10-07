/**
 * Harness containment (VC-703): every home-derived path a volli-drive
 * instance's main process resolves sits inside its scratch root, or the app
 * refuses to boot. Temp dirs only; the owner's home is a string here, never
 * read.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  HARNESS_FORBIDDEN_ENV,
  HARNESS_REQUIRED_ENV,
  HARNESS_SCRATCH_PATH_ENV,
  checkHarnessContainment,
} from "./containment";

const OWNER_HOME = "/Users/volli-owner-not-real";

let scratch: string;
beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "volli-harness-contain-")));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function env(root = scratch): Record<string, string | undefined> {
  return {
    VOLLI_HARNESS_SCRATCH: root,
    HOME: join(root, "home"),
    VOLLI_AGENT_HOME: join(root, "home"),
    VOLLI_WORKTREE_HOME_DIR: join(root, "wt"),
    PI_CODING_AGENT_DIR: join(root, "home", ".pi", "agent"),
    VOLLI_DB_PATH: join(root, "ud", "volli.db"),
    VOLLI_HARNESS_DIR: join(root, "harness"),
    XDG_CONFIG_HOME: join(root, "home", ".config"),
    XDG_DATA_HOME: join(root, "home", ".local", "share"),
    XDG_CACHE_HOME: join(root, "home", ".cache"),
    ZDOTDIR: join(root, "zdot"),
    GIT_CONFIG_GLOBAL: join(root, "home", ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

const check = (
  e: Record<string, string | undefined>,
  over: { userDataDir?: string; isPackaged?: boolean; ownerHome?: string } = {},
) =>
  checkHarnessContainment({
    env: e,
    userDataDir: over.userDataDir ?? join(scratch, "ud"),
    isPackaged: over.isPackaged ?? false,
    ownerHome: over.ownerHome ?? OWNER_HOME,
  });

describe("checkHarnessContainment", () => {
  it("accepts volli-drive's layout and hands back the scratch agent home", () => {
    const result = check(env());
    expect(result).toMatchObject({
      ok: true,
      containment: { scratch, agentHome: join(scratch, "home"), userDataDir: join(scratch, "ud") },
    });
  });

  it.each(HARNESS_SCRATCH_PATH_ENV)("refuses %s outside the scratch root", (name) => {
    const result = check({ ...env(), [name]: join(OWNER_HOME, ".agents") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join("\n")).toContain(name);
  });

  it.each(HARNESS_SCRATCH_PATH_ENV)("refuses %s unset or relative", (name) => {
    expect(check({ ...env(), [name]: undefined }).ok).toBe(false);
    expect(check({ ...env(), [name]: "home" }).ok).toBe(false);
  });

  it("refuses a --user-data-dir outside scratch, or none", () => {
    expect(
      check(env(), { userDataDir: "/Users/someone/Library/Application Support/Volli Code" }).ok,
    ).toBe(false);
    expect(check(env(), { userDataDir: "" }).ok).toBe(false);
  });

  it("refuses a path that escapes through .. or a symlink inside scratch", () => {
    expect(check({ ...env(), HOME: join(scratch, "home", "..", "..", "elsewhere") }).ok).toBe(
      false,
    );
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "volli-harness-outside-")));
    try {
      symlinkSync(outside, join(scratch, "link"));
      const result = check({ ...env(), VOLLI_AGENT_HOME: join(scratch, "link", "home") });
      expect(result.ok).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a missing, relative or home-overlapping scratch root", () => {
    expect(check({ ...env(), VOLLI_HARNESS_SCRATCH: undefined }).ok).toBe(false);
    expect(check({ ...env(), VOLLI_HARNESS_SCRATCH: "tmp/x" }).ok).toBe(false);
    expect(check({ ...env(), VOLLI_HARNESS_SCRATCH: join(scratch, "nope") }).ok).toBe(false);
    // The owner's home inside scratch (scratch = an ancestor) or the reverse.
    expect(check(env(), { ownerHome: join(scratch, "home") }).ok).toBe(false);
    const nested = join(scratch, "inner");
    mkdirSync(nested);
    expect(check(env(nested), { ownerHome: scratch, userDataDir: join(nested, "ud") }).ok).toBe(
      false,
    );
  });

  it("refuses packaged builds outright", () => {
    const result = check(env(), { isPackaged: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/dev-build only/);
  });

  it("requires the scratch-repo git settings and no inherited ssh-agent", () => {
    for (const name of Object.keys(HARNESS_REQUIRED_ENV)) {
      expect(check({ ...env(), [name]: undefined }).ok).toBe(false);
    }
    for (const name of HARNESS_FORBIDDEN_ENV) {
      expect(check({ ...env(), [name]: "/private/tmp/agent.sock" }).ok).toBe(false);
    }
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The enumeration this module's doc promises: every place main reaches a home
 * directory. A new `getPath("home")` or `homedir()` fails here until it is
 * accounted for (and contained) above.
 */
describe("home-derived paths main uses", () => {
  const MAIN = join(__dirname, "..");
  const sites = sources(MAIN).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line, index) => ({ file: relative(MAIN, file), line: index + 1, text: line.trim() }))
      .filter(
        ({ text }) =>
          !text.startsWith("//") &&
          !text.startsWith("*") &&
          !text.startsWith("/*") &&
          /getPath\("home"\)|\bhomedir\(\)/.test(text),
      ),
  );

  it("are exactly the known, contained ones", () => {
    expect(sites.map(({ file, text }) => `${file}: ${text}`)).toEqual([
      // Contained by HOME (Node's homedir reads $HOME first).
      "fs-deps.ts: homeDir: homedir(),",
      // Electron's home ignores $HOME on macOS: only reached outside harness
      // mode, where the contained VOLLI_AGENT_HOME is authoritative instead.
      'index.ts: : ((isDev ? process.env["VOLLI_AGENT_HOME"] : undefined) ?? app.getPath("home"));',
      // Contained by HOME too: accepting a remote host's key writes the
      // known_hosts ssh itself reads (VC-700).
      "remote-hosts.ts: await acceptHostKeys({ target, offer, home: homedir(), logger });",
    ]);
  });

  it("index.ts uses the contained agent home whenever harness mode is on", () => {
    const index = readFileSync(join(MAIN, "index.ts"), "utf8");
    expect(index).toMatch(
      /const agentToolsHome = harnessGuard\.active\n\s+\? harnessGuard\.containment\.agentHome\n\s+: \(\(isDev/,
    );
    // Every install/repair/remove path takes that one value.
    expect(index.match(/home: agentToolsHome/g)?.length).toBeGreaterThan(3);
    expect(index).not.toMatch(/home: app\.getPath/);
  });
});
