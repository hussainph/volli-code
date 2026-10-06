/**
 * The harness keychain guard (VC-703): inert unless `VOLLI_HARNESS=1`, and
 * when on, no `safeStorage` call can succeed or go unnoticed.
 *
 * Every keychain here is a fake. Nothing in this file can reach the OS
 * keychain: Electron is never imported, and the "safeStorage" objects are
 * plain records whose methods fail the test if they are ever reached.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  HARNESS_CHROMIUM_SWITCHES,
  HARNESS_GUARD_MARKER,
  HARNESS_TRAP,
  HARNESS_VIOLATION_EXIT_CODE,
  HarnessKeychainViolation,
  SAFE_STORAGE_METHODS,
  harnessMode,
  harnessPaths,
  installHarnessGuard,
  installKeychainTrap,
  isTrap,
  keychainTrapped,
} from "./keychain-guard";
import { HARNESS_CONTAINMENT_MARKER } from "./containment";
import { harnessSecretPorts } from "./secret-ports";
import { HARNESS_RECORDER_MARKER, RECORDED_SHELL_METHODS, isRecorder } from "./shell-recorder";

const reached = (name: string) => () => {
  throw new Error(`the real keychain method ${name} was reached`);
};

/** A safeStorage stand-in whose real methods fail the test if ever called. */
function fakeSafeStorage(): Record<string, (...args: unknown[]) => unknown> {
  return Object.fromEntries(SAFE_STORAGE_METHODS.map((name) => [name, vi.fn(reached(name))]));
}

/** An object that fails the test on ANY property access: proof of "untouched". */
function untouchable(label: string): object {
  return new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`${label} was touched (${String(key)})`);
      },
      set(_target, key) {
        throw new Error(`${label} was written (${String(key)})`);
      },
      defineProperty(_target, key) {
        throw new Error(`${label} was redefined (${String(key)})`);
      },
      has(_target, key) {
        throw new Error(`${label} was queried (${String(key)})`);
      },
      ownKeys() {
        throw new Error(`${label} was enumerated`);
      },
      getPrototypeOf() {
        throw new Error(`${label} was inspected`);
      },
    },
  );
}

function fakeApp(userDataDir = "") {
  return {
    commandLine: { appendSwitch: vi.fn(), getSwitchValue: vi.fn(() => userDataDir) },
    isPackaged: false,
    exit: vi.fn(),
  };
}

/** A shell stand-in whose real methods fail the test if ever called. */
function fakeShell(): Record<string, (...args: unknown[]) => unknown> {
  return Object.fromEntries(
    ["openExternal", "openPath", "showItemInFolder", "trashItem"].map((name) => [
      name,
      vi.fn(() => {
        throw new Error(`the real shell.${name} was reached`);
      }),
    ]),
  );
}

/** Not a real home: a string the containment check compares against. */
const OWNER_HOME = "/Users/volli-owner-not-real";

/** The environment volli-drive hands a contained instance rooted at `scratch`. */
function harnessEnv(scratch: string): Record<string, string> {
  return {
    VOLLI_HARNESS: "1",
    VOLLI_HARNESS_DIR: scratch,
    VOLLI_HARNESS_SCRATCH: scratch,
    HOME: join(scratch, "home"),
    VOLLI_AGENT_HOME: join(scratch, "home"),
    VOLLI_WORKTREE_HOME_DIR: join(scratch, "wt"),
    PI_CODING_AGENT_DIR: join(scratch, "home", ".pi", "agent"),
    VOLLI_DB_PATH: join(scratch, "ud", "volli.db"),
    XDG_CONFIG_HOME: join(scratch, "home", ".config"),
    XDG_DATA_HOME: join(scratch, "home", ".local", "share"),
    XDG_CACHE_HOME: join(scratch, "home", ".cache"),
    ZDOTDIR: join(scratch, "zdot"),
    GIT_CONFIG_GLOBAL: join(scratch, "home", ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-harness-guard-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("harnessMode", () => {
  it("is off when VOLLI_HARNESS is unset or empty", () => {
    expect(harnessMode({})).toEqual({ kind: "off" });
    expect(harnessMode({ VOLLI_HARNESS: "" })).toEqual({ kind: "off" });
    expect(harnessMode({ VOLLI_HARNESS_DIR: "/tmp/x" })).toEqual({ kind: "off" });
  });

  it("is on only for exactly 1 with an absolute directory", () => {
    expect(harnessMode({ VOLLI_HARNESS: "1", VOLLI_HARNESS_DIR: "/tmp/x" })).toEqual({
      kind: "on",
      dir: "/tmp/x",
    });
  });

  it("refuses rather than falls back to off on any other value", () => {
    for (const value of ["0", "true", "yes", " 1", "1 "]) {
      expect(harnessMode({ VOLLI_HARNESS: value, VOLLI_HARNESS_DIR: "/tmp/x" }).kind).toBe(
        "refused",
      );
    }
  });

  it("refuses harness mode without an absolute scratch directory", () => {
    expect(harnessMode({ VOLLI_HARNESS: "1" }).kind).toBe("refused");
    expect(harnessMode({ VOLLI_HARNESS: "1", VOLLI_HARNESS_DIR: "" }).kind).toBe("refused");
    expect(harnessMode({ VOLLI_HARNESS: "1", VOLLI_HARNESS_DIR: "scratch/x" }).kind).toBe(
      "refused",
    );
  });
});

describe("installHarnessGuard when off", () => {
  it("touches nothing: not safeStorage, not the command line, not the filesystem", () => {
    const app = untouchable("app");
    const safeStorage = untouchable("safeStorage");
    const guard = installHarnessGuard({
      env: { VOLLI_HARNESS_DIR: dir },
      app: app as never,
      safeStorage,
      shell: untouchable("shell"),
      log: () => {
        throw new Error("logged while off");
      },
    });
    expect(guard).toEqual({ active: false });
    expect(existsSync(join(dir, "harness-guard.json"))).toBe(false);
    expect(existsSync(join(dir, "keys"))).toBe(false);
  });

  it("leaves a real-shaped safeStorage's methods exactly as they were", () => {
    const safeStorage = fakeSafeStorage();
    const before = { ...safeStorage };
    const app = fakeApp();
    const shell = fakeShell();
    const shellBefore = { ...shell };
    installHarnessGuard({ env: {}, app, safeStorage, shell });
    expect(shell).toEqual(shellBefore);
    expect(safeStorage).toEqual(before);
    expect(keychainTrapped(safeStorage)).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  });
});

describe("installHarnessGuard when refused", () => {
  it("exits non-zero and throws so nothing boots as if harness mode were off", () => {
    const app = fakeApp();
    const log = vi.fn();
    expect(() =>
      installHarnessGuard({
        env: { VOLLI_HARNESS: "1" },
        app,
        safeStorage: fakeSafeStorage(),
        shell: fakeShell(),
        log,
      }),
    ).toThrow(/VOLLI_HARNESS_DIR/);
    expect(app.exit).toHaveBeenCalledWith(HARNESS_VIOLATION_EXIT_CODE);
  });

  it("fails closed when safeStorage cannot be trapped", () => {
    const app = fakeApp(join(dir, "ud"));
    const frozen = Object.freeze(fakeSafeStorage());
    expect(() =>
      installHarnessGuard({
        env: harnessEnv(dir),
        app,
        safeStorage: frozen,
        shell: fakeShell(),
        ownerHome: OWNER_HOME,
        log: () => {},
      }),
    ).toThrow(/could not guard safeStorage/);
    expect(app.exit).toHaveBeenCalledWith(HARNESS_VIOLATION_EXIT_CODE);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});

describe("installHarnessGuard when on", () => {
  function install(overrides: { defer?: (fn: () => void) => void } = {}) {
    const app = fakeApp(join(dir, "ud"));
    const safeStorage = fakeSafeStorage();
    const originals = { ...safeStorage };
    const shell = fakeShell();
    const shellOriginals = { ...shell };
    const log = vi.fn();
    const guard = installHarnessGuard({
      env: harnessEnv(dir),
      app,
      safeStorage,
      shell,
      ownerHome: OWNER_HOME,
      log,
      pid: 4242,
      now: () => 1000,
      defer: overrides.defer ?? ((fn) => fn()),
    });
    return { app, safeStorage, originals, shell, shellOriginals, log, guard };
  }

  it("traps every safeStorage method, and no call reaches the real one", async () => {
    const { safeStorage, originals } = install();
    expect(keychainTrapped(safeStorage)).toBe(true);
    for (const name of SAFE_STORAGE_METHODS) {
      expect(() => safeStorage[name]!("x")).toThrow(HarnessKeychainViolation);
      expect(originals[name]).not.toHaveBeenCalled();
    }
  });

  it("fails the run on a call even when the caller swallows the throw", () => {
    const deferred: (() => void)[] = [];
    const { app, safeStorage } = install({ defer: (fn) => deferred.push(fn) });
    // What `legacy-safe-storage.ts`'s keychainAnswers does with a throw.
    const answers = () => {
      try {
        return safeStorage.isEncryptionAvailable!() as boolean;
      } catch {
        return false;
      }
    };
    expect(answers()).toBe(false);
    expect(app.exit).not.toHaveBeenCalled();
    for (const fn of deferred) fn();
    expect(app.exit).toHaveBeenCalledWith(HARNESS_VIOLATION_EXIT_CODE);
  });

  it("records each violation with the method name", () => {
    const { safeStorage, log } = install();
    expect(() => safeStorage.encryptString!("secret")).toThrow(/encryptString/);
    expect(() => safeStorage.decryptStringAsync!(Buffer.from("x"))).toThrow();
    const lines = readFileSync(join(dir, "keychain-violations.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).method)).toEqual([
      "encryptString",
      "decryptStringAsync",
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("KEYCHAIN VIOLATION"));
    // The value handed to the trap is never recorded.
    expect(lines.join("\n")).not.toContain("secret");
  });

  it("exits once, however many calls trip it", () => {
    const { app, safeStorage } = install();
    for (let i = 0; i < 3; i++) expect(() => safeStorage.encryptString!("x")).toThrow();
    expect(app.exit).toHaveBeenCalledTimes(1);
  });

  it("appends Chromium's mock-keychain and basic password-store switches", () => {
    const { app } = install();
    expect(app.commandLine.appendSwitch.mock.calls).toEqual([
      ["use-mock-keychain"],
      ["password-store", "basic"],
    ]);
    expect(HARNESS_CHROMIUM_SWITCHES).toHaveLength(2);
  });

  it("announces itself for doctor, with file-backed ports inside the scratch dir", () => {
    const { guard } = install();
    expect(guard.active).toBe(true);
    const record = JSON.parse(readFileSync(join(dir, "harness-guard.json"), "utf8"));
    expect(record).toMatchObject({
      marker: HARNESS_GUARD_MARKER,
      pid: 4242,
      secretKey: { backend: "file", path: join(dir, "keys", "session-secrets.key") },
      credentialKeyring: { backend: "file", path: join(dir, "keys", "host-credentials.key") },
      chromiumSwitches: ["--use-mock-keychain", "--password-store=basic"],
    });
    expect(record.trapped).toEqual(expect.arrayContaining([...SAFE_STORAGE_METHODS]));
    expect(statSync(join(dir, "harness-guard.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "keys")).mode & 0o777).toBe(0o700);
    expect(record.containment).toMatchObject({
      marker: HARNESS_CONTAINMENT_MARKER,
      agentHome: join(realpathSync.native(dir), "home"),
    });
    expect(record.shellRecorder).toMatchObject({ marker: HARNESS_RECORDER_MARKER });
  });

  it("forces the agent-tools home into scratch and returns it for index.ts", () => {
    const { guard } = install();
    if (!guard.active) throw new Error("guard inactive");
    expect(guard.containment.agentHome).toBe(join(realpathSync.native(dir), "home"));
    expect(guard.containment.scratch).toBe(realpathSync.native(dir));
  });

  it("replaces shell.openExternal & co. with recorders that open nothing", async () => {
    const { shell, shellOriginals } = install();
    await expect(shell.openExternal!("https://example.invalid/x")).resolves.toBeUndefined();
    await expect(shell.openPath!("/some/file")).resolves.toBe("");
    expect(shell.showItemInFolder!("/some/file")).toBeUndefined();
    await expect(shell.trashItem!("/some/file")).resolves.toBeUndefined();
    for (const name of RECORDED_SHELL_METHODS) {
      expect(isRecorder(shell[name])).toBe(true);
      expect(shellOriginals[name]).not.toHaveBeenCalled();
    }
    const lines = readFileSync(join(dir, "external-requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((l) => [l.method, l.args])).toEqual([
      ["openExternal", ["https://example.invalid/x"]],
      ["openPath", ["/some/file"]],
      ["showItemInFolder", ["/some/file"]],
      ["trashItem", ["/some/file"]],
    ]);
  });
});

describe("installHarnessGuard containment refusals", () => {
  function attempt(env: Record<string, string | undefined>, opts: { packaged?: boolean } = {}) {
    const app = { ...fakeApp(join(dir, "ud")), isPackaged: opts.packaged ?? false };
    const safeStorage = fakeSafeStorage();
    const before = { ...safeStorage };
    const shell = fakeShell();
    const shellBefore = { ...shell };
    let error: unknown = null;
    try {
      installHarnessGuard({ env, app, safeStorage, shell, ownerHome: OWNER_HOME, log: () => {} });
    } catch (caught) {
      error = caught;
    }
    return { app, error, safeStorage, before, shell, shellBefore };
  }

  it("refuses to boot, before trapping anything, when a home path leaves scratch", () => {
    const result = attempt({ ...harnessEnv(dir), VOLLI_AGENT_HOME: OWNER_HOME });
    expect(String(result.error)).toMatch(/VOLLI_AGENT_HOME .* outside the scratch root/);
    expect(result.app.exit).toHaveBeenCalledWith(HARNESS_VIOLATION_EXIT_CODE);
    expect(result.app.commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(result.safeStorage).toEqual(result.before);
    expect(existsSync(join(dir, "harness-guard.json"))).toBe(false);
  });

  it("refuses a packaged build in harness mode", () => {
    const result = attempt(harnessEnv(dir), { packaged: true });
    expect(String(result.error)).toMatch(/dev-build only/);
    expect(result.app.exit).toHaveBeenCalledWith(HARNESS_VIOLATION_EXIT_CODE);
  });
});

describe("installKeychainTrap", () => {
  it("also traps methods it was not told about, own or inherited", () => {
    class Base {
      inheritedKeychainCall() {
        throw new Error("reached");
      }
    }
    const target = Object.assign(new Base(), { futureKeychainCall: () => "reached" });
    const trapped = installKeychainTrap(target, () => {});
    expect(trapped).toEqual(
      expect.arrayContaining(["futureKeychainCall", "inheritedKeychainCall"]),
    );
    expect(() => target.futureKeychainCall()).toThrow(HarnessKeychainViolation);
    expect(() => target.inheritedKeychainCall()).toThrow(HarnessKeychainViolation);
  });

  it("still throws when the violation sink itself throws", () => {
    const target = fakeSafeStorage();
    installKeychainTrap(target, () => {
      throw new Error("sink broke");
    });
    expect(() => target.encryptString!("x")).toThrow(HarnessKeychainViolation);
  });

  it("refuses when a property cannot be replaced", () => {
    const target = fakeSafeStorage();
    Object.defineProperty(target, "encryptString", {
      value: () => "x",
      writable: false,
      configurable: false,
    });
    expect(() => installKeychainTrap(target, () => {})).toThrow(/encryptString/);
  });

  it("marks traps so a live object can be checked without being called", () => {
    const target = fakeSafeStorage();
    expect(keychainTrapped(target)).toBe(false);
    installKeychainTrap(target, () => {});
    expect(isTrap(target.encryptString)).toBe(true);
    expect((target.encryptString as unknown as Record<symbol, unknown>)[HARNESS_TRAP]).toBe(true);
    expect(isTrap(() => {})).toBe(false);
    expect(isTrap(undefined)).toBe(false);
  });
});

describe("harnessSecretPorts", () => {
  it("seals and opens with a per-instance random key in the scratch dir, no keychain", () => {
    const paths = harnessPaths(dir);
    installHarnessGuard({
      env: harnessEnv(dir),
      app: fakeApp(join(dir, "ud")),
      safeStorage: fakeSafeStorage(),
      shell: fakeShell(),
      ownerHome: OWNER_HOME,
      log: () => {},
    });
    const ports = harnessSecretPorts(paths);
    // Lazy: nothing is created until something is sealed.
    expect(existsSync(paths.secretKeyFile)).toBe(false);
    const sealed = ports.secretKey.encryptString("hello");
    expect(sealed.subarray(0, 4).toString()).toBe("VSF1");
    expect(ports.secretKey.decryptString(sealed)).toBe("hello");
    expect(statSync(paths.secretKeyFile).mode & 0o777).toBe(0o600);

    expect(ports.keyring.backend).toBe("file");
    const active = ports.keyring.active();
    expect(active.key).toHaveLength(32);
    expect(ports.keyring.resolve(active.id).equals(active.key)).toBe(true);
    expect(existsSync(paths.credentialKeyFile)).toBe(true);

    // Two instances never share a key.
    const other = mkdtempSync(join(tmpdir(), "volli-harness-guard-other-"));
    try {
      const otherPorts = harnessSecretPorts(harnessPaths(other));
      expect(() => otherPorts.secretKey.decryptString(sealed)).toThrow();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
