/**
 * Harness mode's keychain guard (VC-703).
 *
 * `volli-drive` launches a live, isolated build of this app so an agent can
 * drive it and prove what a person would see. That build runs on a shared Mac
 * beside the owner's real Volli, so it must never reach the macOS keychain:
 * no prompt, no item read, no item written. This module is the whole of that
 * promise, and it is **inert unless `VOLLI_HARNESS=1`** — set by `volli-drive`
 * and by nothing else.
 *
 * In harness mode:
 *
 * 0. **The boot is refused unless it is contained** (`containment.ts`): a dev
 *    build, with every home-derived path inside the instance's scratch root.
 *    Nothing below runs otherwise.
 * 1. **Every `safeStorage` method is replaced by a trap** before anything can
 *    call it. A trap records the call (a line on stderr and a JSON line in
 *    `<VOLLI_HARNESS_DIR>/keychain-violations.jsonl`), throws
 *    {@link HarnessKeychainViolation}, and schedules the process to exit with
 *    {@link HARNESS_VIOLATION_EXIT_CODE}. A caller that swallows the throw
 *    (the legacy migration's `keychainAnswers` does) still fails the run.
 *    If a trap cannot be installed (a non-writable property), the guard
 *    refuses to boot: fail closed, never "mostly guarded".
 * 2. **The app's keychain-backed ports are swapped for file-backed ones**:
 *    the Session-secrets codec becomes host-core's `fileSecretKey` and the
 *    credential keyring becomes `fileCredentialKeyring`, each a random
 *    per-instance key created lazily under `<VOLLI_HARNESS_DIR>/keys/`. Those
 *    are the ports a headless host already runs on, so the harness exercises
 *    real sealing, just not the keychain.
 * 3. **Chromium is told not to use the keychain either**: `use-mock-keychain`
 *    and `password-store=basic`, the switches the agent browser already
 *    launches with (`@volli/host-core` `chromium-launch.ts`).
 * 4. **`shell.openExternal` & co. only record** (`shell-recorder.ts`): no
 *    owner browser, Finder reveal or Trash.
 * 5. **The guard announces itself** in `<VOLLI_HARNESS_DIR>/harness-guard.json`
 *    so `volli-drive doctor` can prove it is active in the running process,
 *    and every trap carries {@link HARNESS_TRAP} so the supervisor can check
 *    the live `safeStorage` object without calling it.
 *
 * Electron is injected, never imported, so every rule here is unit-tested
 * without a keychain anywhere near the test.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

import { hostLogger } from "@volli/host-core/log";

import {
  checkHarnessContainment,
  HARNESS_CONTAINMENT_MARKER,
  type HarnessContainment,
} from "./containment";
import {
  HARNESS_EXTERNAL_REQUESTS_FILE,
  HARNESS_RECORDER_MARKER,
  installShellRecorder,
} from "./shell-recorder";

const harnessLog = hostLogger("harness");

/** The one switch. Only `volli-drive` sets it. */
export const HARNESS_ENV = "VOLLI_HARNESS";
/** The instance's scratch directory: keys, the guard record, violations. */
export const HARNESS_DIR_ENV = "VOLLI_HARNESS_DIR";
/**
 * A string that survives bundling, so `volli-drive doctor` can tell a build
 * that carries this guard from one that predates it before launching it.
 */
export const HARNESS_GUARD_MARKER = "volli-harness-keychain-guard:v1";
/** Marks a trap, so a live `safeStorage` can be checked without being called. */
export const HARNESS_TRAP: unique symbol = Symbol.for("volli.harness.keychainTrap") as never;
/** How a run that touched the keychain ends. Distinct from any crash code. */
export const HARNESS_VIOLATION_EXIT_CODE = 86;
/** Where the guard announces itself, inside the harness directory. */
export const HARNESS_GUARD_FILE = "harness-guard.json";
/** Where violations are appended, inside the harness directory. */
export const HARNESS_VIOLATIONS_FILE = "keychain-violations.jsonl";
/** Where the per-instance keys live, inside the harness directory. */
export const HARNESS_KEYS_DIR = "keys";

/**
 * Every `safeStorage` method Electron documents, trapped even when absent on
 * this platform, so an Electron upgrade that adds one cannot slip past the
 * enumeration below unnoticed by the tests that pin this list.
 */
export const SAFE_STORAGE_METHODS = [
  "isEncryptionAvailable",
  "encryptString",
  "decryptString",
  "getSelectedStorageBackend",
  "setUsePlainTextEncryption",
  "isAsyncEncryptionAvailable",
  "encryptStringAsync",
  "decryptStringAsync",
] as const;

/** Chromium switches that keep its own key storage off the OS keychain. */
export const HARNESS_CHROMIUM_SWITCHES: readonly (readonly [string, string?])[] = [
  ["use-mock-keychain"],
  ["password-store", "basic"],
];

export type HarnessMode =
  | { readonly kind: "off" }
  | { readonly kind: "on"; readonly dir: string }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Reads the switch. Unset or empty is off: every ordinary launch, packaged or
 * dev, takes the keychain path it always took. `1` is on, and needs an
 * absolute harness directory. Any other value is refused rather than read as
 * off: a mistyped harness launch must not fall back to the real keychain.
 */
export function harnessMode(env: Readonly<Record<string, string | undefined>>): HarnessMode {
  const value = env[HARNESS_ENV];
  if (value === undefined || value === "") return { kind: "off" };
  if (value !== "1") {
    return { kind: "refused", reason: `${HARNESS_ENV} must be "1" or unset, not "${value}".` };
  }
  const dir = env[HARNESS_DIR_ENV];
  if (dir === undefined || dir === "" || !isAbsolute(dir)) {
    return {
      kind: "refused",
      reason: `${HARNESS_ENV}=1 needs ${HARNESS_DIR_ENV} set to an absolute scratch directory.`,
    };
  }
  return { kind: "on", dir };
}

/** A keychain call in harness mode. Never caught on purpose by this module. */
export class HarnessKeychainViolation extends Error {
  readonly code = "harness-keychain-violation";
  readonly method: string;
  constructor(method: string) {
    super(
      `safeStorage.${method} was called in harness mode (${HARNESS_ENV}=1). ` +
        "The harness never touches the keychain; this run fails.",
    );
    this.name = "HarnessKeychainViolation";
    this.method = method;
  }
}

export interface ViolationSink {
  /** Called once per trapped call, before the throw. Must not throw. */
  (method: string): void;
}

/**
 * Replaces every function on `target` (own and inherited, short of
 * `Object.prototype`) plus every name in {@link SAFE_STORAGE_METHODS} with a
 * trap. Returns the trapped names. Throws when a trap did not take: the
 * caller must refuse to boot.
 */
export function installKeychainTrap(target: object, onViolation: ViolationSink): string[] {
  const names = new Set<string>(SAFE_STORAGE_METHODS);
  for (let proto: object | null = target; proto && proto !== Object.prototype;) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && typeof descriptor.value === "function") names.add(name);
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  const record = target as Record<string, unknown>;
  const failed: string[] = [];
  for (const name of names) {
    const trap = Object.assign(
      (..._args: unknown[]): never => {
        try {
          onViolation(name);
        } catch {
          // The sink's own failure must not turn a violation into a pass.
        }
        throw new HarnessKeychainViolation(name);
      },
      { [HARNESS_TRAP]: true },
    );
    try {
      Object.defineProperty(record, name, {
        value: trap,
        writable: false,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // Recorded below: a sealed or frozen object refuses the define.
    }
    if (!isTrap(record[name])) failed.push(name);
  }
  if (failed.length > 0) {
    throw new Error(
      `Harness mode could not guard safeStorage (${failed.join(", ")}); refusing to start.`,
    );
  }
  return [...names].toSorted();
}

/** Whether `value` is a trap this module installed. */
export function isTrap(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[HARNESS_TRAP] === true
  );
}

/** Every listed method on `target` is a trap: the live check `doctor` makes. */
export function keychainTrapped(target: object): boolean {
  const record = target as Record<string, unknown>;
  return SAFE_STORAGE_METHODS.every((name) => isTrap(record[name]));
}

export interface HarnessPaths {
  readonly dir: string;
  readonly keysDir: string;
  readonly secretKeyFile: string;
  readonly credentialKeyFile: string;
  readonly guardFile: string;
  readonly violationsFile: string;
  readonly externalRequestsFile: string;
}

export function harnessPaths(dir: string): HarnessPaths {
  const keysDir = join(dir, HARNESS_KEYS_DIR);
  return {
    dir,
    keysDir,
    secretKeyFile: join(keysDir, "session-secrets.key"),
    credentialKeyFile: join(keysDir, "host-credentials.key"),
    guardFile: join(dir, HARNESS_GUARD_FILE),
    violationsFile: join(dir, HARNESS_VIOLATIONS_FILE),
    externalRequestsFile: join(dir, HARNESS_EXTERNAL_REQUESTS_FILE),
  };
}

/** The slice of Electron's `app` the guard needs. */
export interface HarnessApp {
  commandLine: {
    appendSwitch(name: string, value?: string): void;
    getSwitchValue(name: string): string;
  };
  readonly isPackaged: boolean;
  exit(code?: number): void;
}

export interface HarnessGuardDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly app: HarnessApp;
  /** Electron's `safeStorage`, trapped in place. */
  readonly safeStorage: object;
  /** Electron's `shell`: its OS-reaching methods become recorders. */
  readonly shell: object;
  /** The owner's passwd home, which no harness path may sit in. */
  readonly ownerHome?: string;
  readonly realpath?: (path: string) => string;
  readonly pid?: number;
  readonly log?: (line: string) => void;
  /** Defers the violation exit so the throw reaches its caller first. */
  readonly defer?: (fn: () => void) => void;
  readonly now?: () => number;
}

export type HarnessGuard =
  | { readonly active: false }
  | {
      readonly active: true;
      readonly paths: HarnessPaths;
      readonly trapped: readonly string[];
      readonly recorded: readonly string[];
      readonly containment: HarnessContainment;
    };

/**
 * Installs harness mode, or does nothing. Call once, at the top of main,
 * before `app.whenReady` and before anything can reach `safeStorage`.
 *
 * Off: returns `{ active: false }` having touched nothing — not the switches,
 * not `safeStorage`, not the filesystem. Refused: logs and exits non-zero.
 * On: traps `safeStorage`, appends the Chromium switches, writes the guard
 * record and returns the paths the file-backed ports use.
 */
export function installHarnessGuard(deps: HarnessGuardDeps): HarnessGuard {
  const mode = harnessMode(deps.env);
  if (mode.kind === "off") return { active: false };
  // Before the desktop log is installed: the host log's default root prints
  // this at error level on stderr, `[volli-harness] …` intact (VC-699).
  const log = deps.log ?? ((line: string) => harnessLog.error(line));
  if (mode.kind === "refused") {
    log(`[volli-harness] ${mode.reason}`);
    deps.app.exit(HARNESS_VIOLATION_EXIT_CODE);
    // `app.exit` returns before the process is gone: nothing after this may
    // run as if harness mode were off.
    throw new Error(mode.reason);
  }
  // Every home-derived path inside the scratch root, or no boot at all.
  const contained = checkHarnessContainment({
    env: deps.env,
    userDataDir: deps.app.commandLine.getSwitchValue("user-data-dir"),
    isPackaged: deps.app.isPackaged,
    ownerHome: deps.ownerHome ?? userInfo().homedir,
    ...(deps.realpath ? { realpath: deps.realpath } : {}),
  });
  if (!contained.ok) {
    const reason = `harness containment failed; refusing to start: ${contained.problems.join("; ")}`;
    log(`[volli-harness] ${reason}`);
    deps.app.exit(HARNESS_VIOLATION_EXIT_CODE);
    throw new Error(reason);
  }
  const containment = contained.containment;
  const paths = harnessPaths(mode.dir);
  const defer = deps.defer ?? ((fn: () => void) => setImmediate(fn));
  const now = deps.now ?? Date.now;
  mkdirSync(paths.keysDir, { recursive: true, mode: 0o700 });
  let exitScheduled = false;
  const onViolation: ViolationSink = (method) => {
    log(`[volli-harness] KEYCHAIN VIOLATION: safeStorage.${method} called in harness mode`);
    try {
      appendFileSync(
        paths.violationsFile,
        `${JSON.stringify({ method, at: now(), stack: new Error().stack ?? null })}\n`,
      );
    } catch {
      // The exit below still fails the run.
    }
    if (!exitScheduled) {
      exitScheduled = true;
      defer(() => deps.app.exit(HARNESS_VIOLATION_EXIT_CODE));
    }
  };
  let trapped: string[];
  try {
    trapped = installKeychainTrap(deps.safeStorage, onViolation);
  } catch (error) {
    log(`[volli-harness] ${(error as Error).message}`);
    deps.app.exit(HARNESS_VIOLATION_EXIT_CODE);
    throw error;
  }
  let recorded: string[];
  try {
    recorded = installShellRecorder(deps.shell, paths.externalRequestsFile, now);
  } catch (error) {
    log(`[volli-harness] ${(error as Error).message}`);
    deps.app.exit(HARNESS_VIOLATION_EXIT_CODE);
    throw error;
  }
  for (const [name, value] of HARNESS_CHROMIUM_SWITCHES) {
    if (value === undefined) deps.app.commandLine.appendSwitch(name);
    else deps.app.commandLine.appendSwitch(name, value);
  }
  writeFileSync(
    paths.guardFile,
    `${JSON.stringify(
      {
        marker: HARNESS_GUARD_MARKER,
        pid: deps.pid ?? process.pid,
        installedAt: now(),
        trapped,
        chromiumSwitches: HARNESS_CHROMIUM_SWITCHES.map(([n, v]) => (v ? `--${n}=${v}` : `--${n}`)),
        secretKey: { backend: "file", path: paths.secretKeyFile },
        credentialKeyring: { backend: "file", path: paths.credentialKeyFile },
        containment: { marker: HARNESS_CONTAINMENT_MARKER, ...containment },
        shellRecorder: {
          marker: HARNESS_RECORDER_MARKER,
          recorded,
          file: paths.externalRequestsFile,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  log(`[volli-harness] ${HARNESS_GUARD_MARKER} active: safeStorage trapped (${trapped.length})`);
  return { active: true, paths, trapped, recorded, containment };
}
