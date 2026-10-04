import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SecretKeyPort } from "../ports/secret-key";
import { isSecretName, SecretStore } from "./store";

// A real authenticated cipher fixture: unlike base64, neither metadata nor
// values are recoverable from the file without the injected codec's key.
function codec(): SecretKeyPort {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    }),
    decryptString: vi.fn((value: Buffer) => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    }),
  };
}

let dir: string;
let path: string;
let encryption: SecretKeyPort;
let store: SecretStore;
beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), ".secret-store-test-"));
  path = join(dir, "credentials.enc");
  encryption = codec();
  store = new SecretStore(path, encryption);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function unavailable(): SecretKeyPort {
  return {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(() => {
      throw new Error("must not encrypt");
    }),
    decryptString: vi.fn(() => {
      throw new Error("must not decrypt");
    }),
  };
}

function caught(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected operation to fail");
}

describe("SecretStore persistence", () => {
  it("is lazy, encrypts one blob including metadata, and reopens only durable scopes", () => {
    expect(encryption.isEncryptionAvailable).not.toHaveBeenCalled();
    const global = store.put({ name: "API_TOKEN", value: "durable-global-value", scope: "always" });
    const project = store.put({
      name: "PROJECT_TOKEN",
      value: "durable-project-value",
      scope: "project",
      projectId: "p",
    });
    store.put({
      name: "SESSION_TOKEN",
      value: "ephemeral-session-value",
      scope: "session",
      sessionId: "s",
      projectId: "p",
    });
    const bytes = readFileSync(path);
    for (const value of [
      "durable-global-value",
      "durable-project-value",
      "ephemeral-session-value",
      "API_TOKEN",
      global.id,
    ]) {
      expect(bytes.includes(Buffer.from(value))).toBe(false);
    }
    const decrypted = JSON.parse(encryption.decryptString(bytes));
    expect(decrypted.version).toBe(1);
    expect(decrypted.secrets).toHaveLength(2);
    expect(JSON.stringify(decrypted)).not.toContain("ephemeral-session-value");
    const relaunched = new SecretStore(path, encryption);
    expect(encryption.decryptString).toHaveBeenCalledTimes(1);
    expect(relaunched.list()).toEqual([global, project]);
    expect(relaunched.environment("s", "p")).toEqual({
      API_TOKEN: "durable-global-value",
      PROJECT_TOKEN: "durable-project-value",
    });
    expect(relaunched.redact("durable-global-value")).toBe("‹secret:API_TOKEN›");
  });

  it("pins writes and reads to 0600 and leaves no temporary files", () => {
    store.put({ name: "TOKEN", value: "value", scope: "always" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o666);
    new SecretStore(path, encryption).list();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.put({ name: "TOKEN", value: "replacement", scope: "always" });
    expect(readdirSync(dir)).toEqual(["credentials.enc"]);
  });

  it("keeps session values entirely in memory without encryption", () => {
    const disabled = unavailable();
    const memory = new SecretStore(path, disabled);
    const item = memory.put({
      name: "TOKEN",
      value: "memory-only",
      scope: "session",
      sessionId: "s",
    });
    expect(memory.environment("s", "p")).toEqual({ TOKEN: "memory-only" });
    expect(memory.list()[0]?.id).toBe(item.id);
    expect(memory.redact("memory-only")).toBe("‹secret:TOKEN›");
    memory.revoke(item.id);
    expect(memory.environment("s", "p")).toEqual({});
    expect(disabled.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(disabled.encryptString).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(new SecretStore(path, disabled).list()).toEqual([]);
  });

  it("fails closed without encryption, with no plaintext fallback or memory mutation", () => {
    const disabled = unavailable();
    const locked = new SecretStore(path, disabled);
    for (const scope of ["always", "project"] as const) {
      const error = caught(() =>
        locked.put({ name: "TOKEN", value: "private-value", scope, projectId: "p" }),
      );
      expect(error.message).not.toContain("private-value");
      expect(error.cause).toBeUndefined();
    }
    expect(locked.list()).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(disabled.encryptString).not.toHaveBeenCalled();

    store.put({ name: "TOKEN", value: "existing-value", scope: "always" });
    const before = readFileSync(path);
    expect(() => new SecretStore(path, disabled).list()).toThrow(
      "Could not decrypt secret storage.",
    );
    expect(disabled.decryptString).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before);
  });

  it("does not follow a symlink, overwrite it on failed load, or touch its target", () => {
    const target = join(dir, "target.enc");
    const original = new SecretStore(target, encryption);
    original.put({ name: "TOKEN", value: "planted-value", scope: "always" });
    const before = readFileSync(target);
    symlinkSync(target, path);
    expect(() => store.list()).toThrow("Could not read secret storage.");
    expect(() => store.put({ name: "TOKEN", value: "mine", scope: "always" })).toThrow();
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target)).toEqual(before);
    expect(encryption.decryptString).not.toHaveBeenCalled();
  });

  it("rejects non-files and does not destroy corrupt ciphertext", () => {
    mkdirSync(path);
    expect(() => store.list()).toThrow("Could not decrypt secret storage.");
    rmSync(path, { recursive: true });
    writeFileSync(path, "corrupt private-value");
    const before = readFileSync(path);
    const error = caught(() =>
      store.put({ name: "TOKEN", value: "replacement-private-value", scope: "always" }),
    );
    expect(error.message).toBe("Could not decrypt secret storage.");
    expect(error.cause).toBeUndefined();
    expect(readFileSync(path)).toEqual(before);
  });

  it("sanitizes codec failures and preserves the previous commit on failed replacement", () => {
    store.put({ name: "TOKEN", value: "original-value", scope: "always" });
    const before = readFileSync(path);
    vi.mocked(encryption.encryptString).mockImplementation(() => {
      throw new Error("replacement-value leaked by codec");
    });
    const error = caught(() =>
      store.put({ name: "TOKEN", value: "replacement-value", scope: "always" }),
    );
    expect(error.message).toBe("Could not persist encrypted secrets.");
    expect(error.cause).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir)).toEqual(["credentials.enc"]);
    vi.mocked(encryption.decryptString).mockImplementation(() => {
      throw new Error("original-value leaked by codec");
    });
    expect(caught(() => new SecretStore(path, encryption).list()).message).toBe(
      "Could not decrypt secret storage.",
    );
  });

  it("sanitizes filesystem write errors, does not update memory, and cleans temporary files", () => {
    store.list(); // Cache the empty store before placing a directory at the file path.
    mkdirSync(path);
    const error = caught(() =>
      store.put({ name: "TOKEN", value: "private-value", scope: "always" }),
    );
    expect(error.message).toBe("Could not persist encrypted secrets.");
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual(["credentials.enc"]);
  });

  it.each([
    { version: 2, secrets: [] },
    { version: 1, secrets: {} },
    {
      version: 1,
      secrets: [{ id: "x", name: "PATH", value: "unsafe", scope: "always", lastUsedAt: null }],
    },
    {
      version: 1,
      secrets: [
        {
          id: "x",
          name: "TOKEN",
          value: "unsafe",
          scope: "session",
          sessionId: "s",
          lastUsedAt: null,
        },
      ],
    },
    {
      version: 1,
      secrets: [{ id: "x", name: "TOKEN", value: "unsafe", scope: "always", lastUsedAt: "bad" }],
    },
  ])("rejects malformed decrypted schemas without leaking or overwriting them (%#)", (file) => {
    writeFileSync(path, encryption.encryptString(JSON.stringify(file)));
    const before = readFileSync(path);
    expect(caught(() => store.list()).message).toBe("Could not decrypt secret storage.");
    expect(readFileSync(path)).toEqual(before);
  });
});

describe("SecretStore scopes and metadata", () => {
  it("restricts scopes and uses session > project > always precedence", () => {
    const global = store.put({ name: "TOKEN", value: "global", scope: "always" });
    const project = store.put({
      name: "TOKEN",
      value: "project",
      scope: "project",
      projectId: "p",
    });
    const session = store.put({
      name: "TOKEN",
      value: "session",
      scope: "session",
      sessionId: "s",
      projectId: "p",
    });
    store.put({ name: "OTHER", value: "other", scope: "project", projectId: "elsewhere" });
    store.put({ name: "ISOLATED", value: "isolated", scope: "session", sessionId: "another" });
    expect(store.environment("s", "p")).toEqual({ TOKEN: "session" });
    expect(store.environment("other-session", "p")).toEqual({ TOKEN: "project" });
    expect(store.environment("s", "elsewhere")).toEqual({ TOKEN: "global", OTHER: "other" });
    expect(store.list("p").map((item) => item.id)).toEqual([global.id, project.id, session.id]);
    expect(store.list().every((item) => !("value" in item))).toBe(true);
    const copy = store.list()[0]!;
    copy.name = "MUTATED";
    expect(store.list()[0]?.name).toBe("TOKEN");
  });

  it("updates lastUsedAt only for selected values and persists durable timestamps", () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    const global = store.put({ name: "TOKEN", value: "global", scope: "always" });
    const project = store.put({
      name: "TOKEN",
      value: "project",
      scope: "project",
      projectId: "p",
    });
    const session = store.put({
      name: "SESSION",
      value: "session",
      scope: "session",
      sessionId: "s",
    });
    expect(store.environment("s", "p")).toEqual({ TOKEN: "project", SESSION: "session" });
    expect(store.list().find((item) => item.id === global.id)?.lastUsedAt).toBeNull();
    expect(store.list().find((item) => item.id === project.id)?.lastUsedAt).toBe(12345);
    expect(store.list().find((item) => item.id === session.id)?.lastUsedAt).toBe(12345);
    expect(
      new SecretStore(path, encryption).list().find((item) => item.id === project.id)?.lastUsedAt,
    ).toBe(12345);
  });

  it("replaces only a matching slot, revokes durably, and ends only the named session", () => {
    const global = store.put({ name: "TOKEN", value: "old-global", scope: "always" });
    const replacement = store.put({ name: "TOKEN", value: "new-global", scope: "always" });
    expect(replacement.id).toBe(global.id);
    store.put({ name: "TOKEN", value: "project", scope: "project", projectId: "p" });
    store.put({ name: "TOKEN", value: "session-s", scope: "session", sessionId: "s" });
    store.put({ name: "TOKEN", value: "session-t", scope: "session", sessionId: "t" });
    store.endSession("s");
    expect(store.environment("s", "p")).toEqual({ TOKEN: "project" });
    expect(store.environment("t", "p")).toEqual({ TOKEN: "session-t" });
    store.revoke(global.id);
    store.revoke("not-present");
    expect(new SecretStore(path, encryption).environment("s", "elsewhere")).toEqual({});
    expect(store.list()).toHaveLength(2);
  });
});

describe("redaction", () => {
  it("redacts exact occurrences longest first, escapes regex syntax, and retains historical values", () => {
    const short = store.put({ name: "SHORT", value: "abc", scope: "always" });
    store.put({ name: "LONG", value: "abcdef", scope: "session", sessionId: "s" });
    const regex = store.put({ name: "REGEX", value: "a.*[$]\\", scope: "session", sessionId: "s" });
    store.put({ name: "OLD", value: "old-value", scope: "session", sessionId: "s" });
    store.put({ name: "OLD", value: "new-value", scope: "session", sessionId: "s" });
    store.revoke(short.id);
    store.revoke(regex.id);
    store.endSession("s");
    expect(store.redact("abcdef abc a.*[$]\\ old-value new-value abc ABC")).toBe(
      "‹secret:LONG› ‹secret:SHORT› ‹secret:REGEX› ‹secret:OLD› ‹secret:OLD› ‹secret:SHORT› ABC",
    );
    expect(new SecretStore(path, encryption).redact("abc old-value")).toBe("abc old-value");
  });

  it("retains revoked and replaced persistent values only until relaunch", () => {
    const item = store.put({ name: "TOKEN", value: "old-durable-value", scope: "always" });
    store.put({ name: "TOKEN", value: "new-durable-value", scope: "always" });
    expect(store.redact("old-durable-value new-durable-value")).toBe(
      "‹secret:TOKEN› ‹secret:TOKEN›",
    );
    expect(new SecretStore(path, encryption).redact("old-durable-value new-durable-value")).toBe(
      "old-durable-value ‹secret:TOKEN›",
    );
    store.revoke(item.id);
    expect(store.redact("old-durable-value new-durable-value")).toBe(
      "‹secret:TOKEN› ‹secret:TOKEN›",
    );
    expect(new SecretStore(path, encryption).redact("old-durable-value new-durable-value")).toBe(
      "old-durable-value new-durable-value",
    );
  });

  it("does not recursively redact markers or interpret dollar replacement syntax", () => {
    store.put({ name: "FIRST", value: "$&", scope: "session", sessionId: "s" });
    store.put({ name: "SECOND", value: "secret", scope: "session", sessionId: "s" });
    expect(store.redact("$& secret")).toBe("‹secret:FIRST› ‹secret:SECOND›");
    expect(store.redact("unmatched")).toBe("unmatched");
  });
});

describe("live output redaction", () => {
  it("withholds a trailing prefix until a multiline credential is complete", () => {
    store.put({
      name: "MULTILINE",
      value: "Ready ALMOND123\nWALNUT456",
      scope: "session",
      sessionId: "s",
    });
    expect(store.redactPartial("log\nReady ALMOND")).toBe("log\n‹secret:MULTILINE›");
    expect(store.redactPartial("log\nReady ALMOND123\nWAL")).toBe("log\n‹secret:MULTILINE›");
    expect(store.redactPartial("log\nReady ALMOND123\nWALNUT456")).toBe("log\n‹secret:MULTILINE›");
    expect(store.redactPartial("log\nReady elsewhere")).toBe("log\nReady elsewhere");
  });

  it("uses the longest trailing prefix and handles repeated overlapping characters", () => {
    store.put({ name: "SHORT", value: "abc", scope: "session", sessionId: "s" });
    store.put({ name: "LONG", value: "ababaX", scope: "session", sessionId: "s" });
    expect(store.redactPartial("done ababa")).toBe("done ‹secret:LONG›");
    store.put({ name: "REPEATED", value: "AAA", scope: "session", sessionId: "s" });
    expect(store.redactPartial("AAAA")).toBe("‹secret:REPEATED›");
  });

  it("retains revoked values without recursively rewriting generated markers", () => {
    const secret = store.put({ name: "TOKEN", value: "secret", scope: "session", sessionId: "s" });
    store.revoke(secret.id);
    expect(store.redactPartial("secret sec")).toBe("‹secret:TOKEN› ‹secret:TOKEN›");
    expect(store.redactPartial("")).toBe("");
    store.put({ name: "ONE", value: "x", scope: "session", sessionId: "s" });
    expect(store.redactPartial("x")).toBe("‹secret:ONE›");
  });

  it("never scans generated marker endings as credential prefixes", () => {
    store.put({ name: "TOKEN", value: "opaque-value", scope: "session", sessionId: "s" });
    store.put({ name: "OTHER", value: "TOKEN›\nsecond-line", scope: "session", sessionId: "s" });
    expect(store.redactPartial("opaque-value")).toBe("‹secret:TOKEN›");
  });

  it("protects an incomplete multiline value that overlaps a shorter complete value", () => {
    store.put({ name: "SHORT", value: "abc", scope: "session", sessionId: "s" });
    store.put({ name: "LONG", value: "abc\nnext-line", scope: "session", sessionId: "s" });
    expect(store.redactPartial("safe abc\n")).toBe("safe ‹secret:LONG›");
  });

  it.each([
    ["Bearer", "ready Bearer SYNTHETIC_CREDENTIAL\n", "SYNTHETIC_CREDENTIAL"],
    ["Basic", "ready Basic SYNTHETIC_CREDENTIAL\n", "SYNTHETIC_CREDENTIAL"],
    ["TOKEN", "ready TOKEN=SYNTHETIC_CREDENTIAL\n", "SYNTHETIC_CREDENTIAL"],
    ["Cookie", "ready Cookie: name=SYNTHETIC_CREDENTIAL\n", "SYNTHETIC_CREDENTIAL"],
    ["ghp_", "ready ghp_SYNTHETIC_CREDENTIAL\n", "SYNTHETIC_CREDENTIAL"],
    ["://", "ready https://alice:SYNTHETIC_CREDENTIAL@example.test/path\n", "SYNTHETIC_CREDENTIAL"],
  ])("protects shared source context before a stored %s can erase it", (value, text, body) => {
    store.put({ name: "TOKEN", value, scope: "session", sessionId: "s" });
    expect(store.redactPartial(text)).not.toContain(body);
    expect(store.redactPartial(text)).toContain("ready");
  });

  it("protects the suffix of a multiline exact value overlapping a shared token", () => {
    store.put({
      name: "TOKEN",
      value: "ghp_SYNTHETIC_CREDENTIAL\nOPAQUE_SUFFIX",
      scope: "session",
      sessionId: "s",
    });
    expect(store.redactPartial("ready ghp_SYNTHETIC_CREDENTIAL\nOPAQUE_SUFFIX\n")).not.toContain(
      "OPAQUE_SUFFIX",
    );
    expect(store.redactPartial("ready ghp_SYNTHETIC_CREDENTIAL\nOPAQUE")).not.toContain("OPAQUE");
  });

  it("protects original PEM bodies when exact credentials erase their delimiters", () => {
    store.put({ name: "SHORT", value: "-", scope: "session", sessionId: "s" });
    const opening = "TOKEN=-----BEGIN PRIVATE KEY-----\nSYNTHETIC_BODY\n";
    expect(store.redactPartial(opening)).not.toContain("SYNTHETIC_BODY");
    expect(store.redactPartial(`${opening}-----END PRIVATE KEY-----\nready\n`)).toBe(
      "[redacted]\nready\n",
    );
  });

  it("does not lose an unmatched PEM merely because another overlapping label closed", () => {
    const text = "safe\n-----BEGIN A-----\n-----BEGIN B-----\n-----END A-----\nOPAQUE_BODY\n";
    expect(store.redactPartial(text)).toBe("safe\n[redacted]");
  });

  it("merges overlapping exact-value and PEM spans from original text", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_BODY\n-----END PRIVATE KEY-----";
    store.put({
      name: "TOKEN",
      value: `prefix ${pem}\nOPAQUE_SUFFIX`,
      scope: "session",
      sessionId: "s",
    });
    expect(store.redactPartial(`prefix ${pem}\nOPAQUE_SUFFIX\nready`)).toBe(
      "‹secret:TOKEN›\nready",
    );
    expect(store.redactPartial(`prefix ${pem}\nOPAQUE`)).toBe("‹secret:TOKEN›");
  });

  it("scans complete repetitive credentials and overlapping occurrences linearly", () => {
    store.put({ name: "LONG", value: "A".repeat(40_000), scope: "session", sessionId: "s" });
    expect(store.redact(`prefix ${"A".repeat(100_000)} suffix`)).toBe(
      "prefix ‹secret:LONG› suffix",
    );
  });

  it("handles a long repeated credential prefix with a linear overlap scan", () => {
    store.put({ name: "LONG", value: `${"a".repeat(40_000)}b`, scope: "session", sessionId: "s" });
    expect(store.redactPartial(`log ${"a".repeat(30_000)}`)).toBe("log ‹secret:LONG›");
  });

  it("leaves output unchanged when no credentials exist", () => {
    expect(store.redactPartial("listening on :5173")).toBe("listening on :5173");
  });
});

describe("validation and non-disclosure", () => {
  it.each(["TOKEN", "API_KEY_2", `A${"X".repeat(127)}`])("accepts credential name %s", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each([
    "",
    "lowercase",
    "2TOKEN",
    "TOKEN-X",
    "TOKEN\n",
    `A${"X".repeat(128)}`,
    "PATH",
    "HOME",
    "ENV",
    "BASH_ENV",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "VOLLI_TOKEN",
    "SHELL",
    "IFS",
    "NODE_PATH",
    "ELECTRON_RUN_AS_NODE",
    "NPM_CONFIG_PREFIX",
    "PYTHONPATH",
    "RUBYOPT",
    "PERL5OPT",
    "GIT_SSH_COMMAND",
    "GIT_CONFIG_COUNT",
    "SSH_AUTH_SOCK",
    "PROMPT_COMMAND",
    "XDG_CONFIG_HOME",
  ])("rejects invalid or process-control name %s", (name) => {
    expect(isSecretName(name)).toBe(false);
    const error = caught(() => store.put({ name, value: "private-value", scope: "always" }));
    expect(error.message).toBe("Invalid secret input.");
    expect(existsSync(path)).toBe(false);
  });

  it("rejects missing scope identifiers, empty/NUL values, and invalid scopes", () => {
    for (const input of [
      { name: "TOKEN", value: "private-value", scope: "session" as const },
      { name: "TOKEN", value: "private-value", scope: "project" as const },
      { name: "TOKEN", value: "", scope: "always" as const },
      { name: "TOKEN", value: "private\0value", scope: "always" as const },
      { name: "TOKEN", value: "private-value", scope: "invalid" as "always" },
    ])
      expect(caught(() => store.put(input)).message).toBe("Invalid secret input.");
    expect(store.list()).toEqual([]);
  });

  it("never logs secrets, including codec failures", () => {
    const spies = ["log", "warn", "error", "info", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined),
    );
    const item = store.put({ name: "TOKEN", value: "private-value", scope: "always" });
    expect(JSON.stringify(item)).not.toContain("private-value");
    expect(JSON.stringify(store.list())).not.toContain("private-value");
    store.environment("s", "p");
    store.revoke(item.id);
    vi.mocked(encryption.encryptString).mockImplementation(() => {
      throw new Error("private-value");
    });
    caught(() => store.put({ name: "TOKEN", value: "private-value", scope: "always" }));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
