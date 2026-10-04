/**
 * The headless secret-key adapter (VC-559), through the real `SecretStore`.
 *
 * Runs in CI's Linux host lane (`Test (packages)`), so these are the round
 * trips a headless box makes. Every refusal asserts the same three things: it
 * is a typed {@link SecretKeyUnavailableError} that names the fix, it carries
 * no key material, and nothing on disk changed underneath it.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  fileSecretKey,
  isSecretKeyUnavailable,
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
  SecretKeyUnavailableError,
  secretKeyFilePath,
  SecretStore,
  type SecretKeyRefusal,
} from "./index";

/** Hooks a test can set to make one filesystem call misbehave. */
const faults = vi.hoisted(() => ({
  link: null as ((from: string, to: string) => void) | null,
  read: null as (() => number) | null,
  openDirectory: null as (() => number) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (from: string, to: string) => (faults.link ?? actual.linkSync)(from, to),
    readSync: (...args: Parameters<typeof actual.readSync>) =>
      faults.read === null ? actual.readSync(...args) : faults.read(),
    openSync: (...args: Parameters<typeof actual.openSync>) =>
      faults.openDirectory !== null && args[1] === "r"
        ? faults.openDirectory()
        : actual.openSync(...args),
  };
});

/**
 * A store sealed by desktop's keychain adapter (`VSC1`), captured from the
 * unchanged desktop code. The headless adapter must refuse it, not misread it.
 */
const KEYCHAIN_STORE_FIXTURE =
  "VlNDMQAAAD1maXh0dXJlLWtleWNoYWluOitzWW9UNUhlbmNrdEpDVnNIYXFXdGc1ZzBJNWl5b21IYXJISjluUU10dlU9wviighX7zVG9BpVcOAyVm/1ebKBhcFWx67Yee+WK/J4lQU2QQzdNpvX7RMK/4DlIoJlS1aBoQJLy69tNWsNltn52xDXyMm6VgiXSFGqEem/qJmZbW4rAgmw+KC86mgOExEEB0wXn1VThiRMqRTbsRc7pA1gYrvxKAuwWToJpgUfU12tpGmKhT9Z9CSLZLlw5oeZuC6o7BYlMENaDPLwgf2oSSQnlbKrGSXZuN3igMXUKLITGdtg+rn2HjTwFwvaw2HcIV/J6WmR2rZtR3Q2O7Wn364aEU5ixflcc8P9go2kZVa1k7wfueOz5BCNUNZLXw3mlnfB3gTTHqVLfI2/SVQkWV6/VhSeQecJaMOUvyZ+YS8L4rMqcejpj4GjdxnnFdDO9DiM1leHtv6pDvfHvT54V7zR+VUFw7GFfwiwsL4YyjjjbrZ1I3+LNrBwkDr0RqYowjzctJXVY7OajUBpmHA==";

const ROOT = process.getuid?.() === 0;

let dataDir: string;
let keyPath: string;
let storePath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "volli-file-key-"));
  keyPath = join(dataDir, SECRET_KEY_FILE_NAME);
  storePath = join(dataDir, SECRET_STORE_FILE_NAME);
});

afterEach(() => {
  faults.link = null;
  faults.read = null;
  faults.openDirectory = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  chmodSync(dataDir, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
});

/** A fresh process's view: a new adapter and a new store over the same files. */
function relaunch(path = keyPath): SecretStore {
  return new SecretStore(storePath, fileSecretKey({ path }));
}

function saveTwo(store: SecretStore): void {
  store.put({ name: "STRIPE_API_KEY", value: "sk_headless_always", scope: "always" });
  store.put({
    name: "DEPLOY_TOKEN",
    value: "headless-project-token",
    scope: "project",
    projectId: "project-a",
  });
}

function refusal(run: () => unknown): SecretKeyUnavailableError {
  try {
    run();
  } catch (error) {
    if (isSecretKeyUnavailable(error)) return error;
    throw error;
  }
  throw new Error("expected a secret-key refusal");
}

function expectRefused(
  run: () => unknown,
  reason: SecretKeyRefusal,
  says: string | RegExp,
): SecretKeyUnavailableError {
  const error = refusal(run);
  expect(error).toBeInstanceOf(SecretKeyUnavailableError);
  expect(error).toMatchObject({
    name: "SecretKeyUnavailableError",
    code: "secret-key-unavailable",
  });
  expect(error.reason).toBe(reason);
  expect(error.message).toMatch(says);
  return error;
}

function keyLine(): string {
  return readFileSync(keyPath, "utf8").trim();
}

describe("where the key lives", () => {
  it("defaults to the data directory, and honours an absolute VOLLI_SECRET_KEY_FILE", () => {
    expect(secretKeyFilePath("/var/lib/volli", {})).toBe("/var/lib/volli/session-secrets.key");
    expect(secretKeyFilePath("/var/lib/volli", { [SECRET_KEY_FILE_ENV]: "" })).toBe(
      "/var/lib/volli/session-secrets.key",
    );
    expect(
      secretKeyFilePath("/var/lib/volli", { [SECRET_KEY_FILE_ENV]: "/run/credentials/key" }),
    ).toBe("/run/credentials/key");
    vi.stubEnv(SECRET_KEY_FILE_ENV, "/etc/volli/secret.key");
    expect(secretKeyFilePath(dataDir)).toBe("/etc/volli/secret.key");
  });

  it("refuses a relative VOLLI_SECRET_KEY_FILE instead of guessing a directory", () => {
    expectRefused(
      () => secretKeyFilePath("/var/lib/volli", { [SECRET_KEY_FILE_ENV]: "keys/volli.key" }),
      "relative-path",
      'VOLLI_SECRET_KEY_FILE must be an absolute path, and it is "keys/volli.key".',
    );
  });
});

describe("the file key round trip", () => {
  it("touches nothing until a secret is saved, then makes one owner-only key", () => {
    const store = relaunch();
    expect(store.list()).toEqual([]);
    store.put({ name: "SESSION_ONLY", value: "memory", scope: "session", sessionId: "s1" });
    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(storePath)).toBe(false);

    saveTwo(store);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyPath, "utf8")).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(Buffer.from(keyLine(), "base64")).toHaveLength(32);
    // No temporary key sibling survives the create.
    expect(readdirSync(dataDir).toSorted()).toEqual([SECRET_STORE_FILE_NAME, SECRET_KEY_FILE_NAME]);

    const sealed = readFileSync(storePath);
    expect(sealed.subarray(0, 4).toString()).toBe("VSF1");
    for (const plain of ["sk_headless_always", "headless-project-token", "STRIPE_API_KEY"]) {
      expect(sealed.includes(Buffer.from(plain))).toBe(false);
    }
    expect(sealed.includes(Buffer.from(keyLine()))).toBe(false);
  });

  it("opens in the next process with the same key, and keeps sealing under it", () => {
    saveTwo(relaunch());
    const key = keyLine();

    const reopened = relaunch();
    expect(reopened.environment("s1", "project-a")).toEqual({
      STRIPE_API_KEY: "sk_headless_always",
      DEPLOY_TOKEN: "headless-project-token",
    });
    reopened.put({ name: "THIRD", value: "third-value", scope: "always" });
    expect(keyLine()).toBe(key);
    expect(
      relaunch()
        .list()
        .map((item) => item.name)
        .toSorted(),
    ).toEqual(["DEPLOY_TOKEN", "STRIPE_API_KEY", "THIRD"]);
  });

  it("uses a key file outside the data directory, creating its directory owner-only", () => {
    const elsewhere = join(dataDir, "elsewhere", "nested", "volli.key");
    saveTwo(relaunch(elsewhere));
    expect(existsSync(keyPath)).toBe(false);
    expect(statSync(elsewhere).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "elsewhere", "nested")).mode & 0o777).toBe(0o700);
    expect(relaunch(elsewhere).environment("s1", "project-a")).toMatchObject({
      STRIPE_API_KEY: "sk_headless_always",
    });
  });

  it("adopts a key the owner wrote by hand", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    writeFileSync(keyPath, `  ${key}\n\n`, { mode: 0o600 });
    saveTwo(relaunch());
    expect(keyLine()).toBe(key);
    expect(relaunch().list()).toHaveLength(2);
  });

  it("adopts the key another process linked first, and leaves no temporary file", () => {
    const winner = Buffer.alloc(32, 9).toString("base64");
    faults.link = () => {
      writeFileSync(keyPath, `${winner}\n`, { mode: 0o600 });
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    saveTwo(relaunch());
    faults.link = null;
    expect(keyLine()).toBe(winner);
    expect(readdirSync(dataDir).toSorted()).toEqual([SECRET_STORE_FILE_NAME, SECRET_KEY_FILE_NAME]);
    expect(relaunch().list()).toHaveLength(2);
  });

  it("reports a key that vanished between losing the race and reading it", () => {
    faults.link = () => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    expectRefused(() => saveTwo(relaunch()), "unreadable", /could not read or create/);
    expect(existsSync(storePath)).toBe(false);
  });

  it("keeps a key whose directory cannot be synced", () => {
    faults.openDirectory = () => {
      throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
    };
    saveTwo(relaunch());
    faults.openDirectory = null;
    expect(relaunch().list()).toHaveLength(2);
  });
});

describe("a key file other users could read", () => {
  it.each([
    ["0644", 0o644],
    ["0640", 0o640],
    ["0604", 0o604],
    ["0660", 0o660],
  ])("refuses mode %s, as ssh does, and says how to fix it", (octal, mode) => {
    saveTwo(relaunch());
    const before = readFileSync(storePath);
    chmodSync(keyPath, mode);
    const error = expectRefused(
      () => relaunch().list(),
      "too-open",
      `Permissions ${octal} on the secret key file ${keyPath} are too open: other users on this machine could read it, so Volli will not use it. Run: chmod 600 ${keyPath}`,
    );
    expect(error.message).not.toContain(keyLine());
    // Sealing is refused too: nothing is written under a key others can read.
    expectRefused(
      () => relaunch().put({ name: "NEW", value: "v", scope: "always" }),
      "too-open",
      /chmod 600/,
    );
    expect(readFileSync(storePath).equals(before)).toBe(true);

    chmodSync(keyPath, 0o600);
    expect(relaunch().list()).toHaveLength(2);
  });

  it("refuses a hand-made key that is too open before it is ever used", () => {
    writeFileSync(keyPath, `${Buffer.alloc(32, 1).toString("base64")}\n`, { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    expectRefused(() => saveTwo(relaunch()), "too-open", /chmod 600/);
    expect(existsSync(storePath)).toBe(false);
  });

  it("refuses a key file that belongs to another user", () => {
    saveTwo(relaunch());
    const owner = statSync(keyPath).uid;
    vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
    expectRefused(
      () => relaunch().list(),
      "wrong-owner",
      `The secret key file ${keyPath} belongs to uid ${owner}, not to the user Volli runs as (uid ${owner + 1}), so Volli will not use it. Run: chown ${owner + 1} ${keyPath}`,
    );
  });
});

describe("a missing, different or foreign key", () => {
  it("refuses to open sealed secrets whose key file is gone, and never makes a new key", () => {
    saveTwo(relaunch());
    const before = readFileSync(storePath);
    rmSync(keyPath);

    const store = relaunch();
    const error = expectRefused(
      () => store.list(),
      "missing",
      `Saved secrets exist, but their key file ${keyPath} is missing. Put the key file back (mode 0600) to open them. Volli will not make a new key while they exist: to start over, delete ${SECRET_STORE_FILE_NAME} beside the database and enter the secrets again.`,
    );
    expect(error.message).not.toContain("sk_headless");
    // Saving, injecting and redacting all need the inventory open first.
    expectRefused(
      () => store.put({ name: "NEW", value: "new-value", scope: "always" }),
      "missing",
      /is missing/,
    );
    expectRefused(() => store.environment("s1", "project-a"), "missing", /is missing/);
    expectRefused(() => store.redact("text"), "missing", /is missing/);
    expect(existsSync(keyPath)).toBe(false);
    expect(readFileSync(storePath).equals(before)).toBe(true);
  });

  it("refuses a key file that is not the key the secrets were sealed with", () => {
    saveTwo(relaunch());
    const before = readFileSync(storePath);
    const other = Buffer.alloc(32, 3).toString("base64");
    writeFileSync(keyPath, `${other}\n`, { mode: 0o600 });

    const store = relaunch();
    const error = expectRefused(
      () => store.list(),
      "wrong-key",
      `The key file ${keyPath} is not the key the saved secrets were sealed with. Put the original key file back, or delete ${SECRET_STORE_FILE_NAME} beside the database and enter the secrets again.`,
    );
    expect(error.message).not.toContain(other);
    expectRefused(
      () => store.put({ name: "NEW", value: "v", scope: "always" }),
      "wrong-key",
      /original key file/,
    );
    expect(readFileSync(storePath).equals(before)).toBe(true);
    expect(keyLine()).toBe(other);
  });

  it("refuses a store sealed under another key even after sealing with its own", () => {
    saveTwo(relaunch());
    const sealedElsewhere = readFileSync(storePath);
    const codec = fileSecretKey({ path: join(dataDir, "second.key") });
    codec.encryptString("loads the second key");
    expectRefused(() => codec.decryptString(sealedElsewhere), "wrong-key", /not the key/);
  });

  it("refuses secrets the macOS keychain sealed, and leaves them for the person to remove", () => {
    const keychainSealed = Buffer.from(KEYCHAIN_STORE_FIXTURE, "base64");
    writeFileSync(storePath, keychainSealed, { mode: 0o600 });

    const store = relaunch();
    expectRefused(
      () => store.list(),
      "other-adapter",
      `The saved secrets were sealed by the macOS keychain, and this host seals with a key file, so it cannot open them. Delete ${SECRET_STORE_FILE_NAME} beside the database and enter the secrets again.`,
    );
    expectRefused(
      () => store.put({ name: "NEW", value: "v", scope: "always" }),
      "other-adapter",
      /macOS keychain/,
    );
    expect(existsSync(keyPath)).toBe(false);
    expect(readFileSync(storePath).equals(keychainSealed)).toBe(true);

    // The documented recovery: remove the file, enter the secrets again.
    rmSync(storePath);
    saveTwo(relaunch());
    expect(relaunch().list()).toHaveLength(2);
  });

  it("answers a corrupt or unknown envelope with the store's generic refusal", () => {
    saveTwo(relaunch());
    const sealed = readFileSync(storePath);
    const cases = [
      Buffer.concat([sealed.subarray(0, -1), Buffer.from([sealed.at(-1)! ^ 1])]),
      // The header is authenticated: a flipped magic is not a VSF1 envelope.
      Buffer.concat([Buffer.from("VSF2"), sealed.subarray(4)]),
      Buffer.from("VSF1short"),
      Buffer.alloc(0),
    ];
    for (const bytes of cases) {
      writeFileSync(storePath, bytes, { mode: 0o600 });
      expect(() => relaunch().list()).toThrow(new Error("Could not decrypt secret storage."));
    }
  });
});

describe("a key file Volli cannot use", () => {
  it("refuses a directory where the key should be", () => {
    mkdirSync(keyPath);
    expectRefused(
      () => saveTwo(relaunch()),
      "not-a-file",
      `The secret key path ${keyPath} is not a regular file. Point VOLLI_SECRET_KEY_FILE at a key file, or move what is there aside so Volli can create one.`,
    );
    expect(existsSync(storePath)).toBe(false);
  });

  it.each([
    ["garbage", "not a key at all\n"],
    ["a short key", `${Buffer.alloc(16, 1).toString("base64")}\n`],
    [
      "two keys",
      `${Buffer.alloc(32, 1).toString("base64")}\n${Buffer.alloc(32, 2).toString("base64")}\n`,
    ],
    ["an oversized file", "A".repeat(4096)],
  ])("refuses %s, without quoting it", (_label, content) => {
    writeFileSync(keyPath, content, { mode: 0o600 });
    const error = expectRefused(
      () => saveTwo(relaunch()),
      "malformed",
      `The secret key file ${keyPath} does not hold a key. It must be one line: 32 random bytes in base64, as \`openssl rand -base64 32\` prints. If secrets were saved with the key this file used to hold, put that key back instead.`,
    );
    expect(error.message).not.toContain(content.trim().slice(0, 12));
    expect(existsSync(storePath)).toBe(false);
  });

  it.skipIf(ROOT)("refuses a key file it may not read", () => {
    saveTwo(relaunch());
    chmodSync(keyPath, 0o000);
    expectRefused(
      () => relaunch().list(),
      "unreadable",
      `Volli could not read or create the secret key file ${keyPath} (EACCES). The user Volli runs as must be able to read it, and to write its directory the first time.`,
    );
  });

  it("refuses a key file whose read fails", () => {
    saveTwo(relaunch());
    faults.read = () => {
      throw Object.assign(new Error("io"), { code: "EIO" });
    };
    expectRefused(() => relaunch().list(), "unreadable", /\(EIO\)/);
  });

  it.skipIf(ROOT)("refuses to create a key where it may not write", () => {
    chmodSync(dataDir, 0o500);
    const elsewhere = join(dataDir, "keys", "volli.key");
    expectRefused(
      () => fileSecretKey({ path: elsewhere }).encryptString("x"),
      "unreadable",
      /could not read or create the secret key file .*volli\.key \(EACCES\)/,
    );
  });

  it("reports a failure with no error code plainly", () => {
    faults.link = () => {
      throw new Error("no code");
    };
    expectRefused(
      () => fileSecretKey({ path: keyPath }).encryptString("x"),
      "unreadable",
      `Volli could not read or create the secret key file ${keyPath}. The user Volli runs as must be able to read it, and to write its directory the first time.`,
    );
    expect(readdirSync(dataDir)).toEqual([]);
  });
});
