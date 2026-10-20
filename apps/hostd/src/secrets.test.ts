import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type CredentialKind,
  fileSecretKey,
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
  SecretStore,
} from "@volli/host-core/secrets";

import type { HostdLogger } from "./log";
import { logCredentials, openHeadlessSecrets } from "./secrets";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hostd-secrets-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function seal(keyPath = join(dataDir, SECRET_KEY_FILE_NAME)): void {
  new SecretStore(join(dataDir, SECRET_STORE_FILE_NAME), fileSecretKey({ path: keyPath })).put({
    name: "DEPLOY_TOKEN",
    value: "token-value",
    scope: "always",
  });
}

const LOCKED: readonly CredentialKind[] = ["session-env"];

describe("opening secrets at boot", () => {
  it("opens an empty profile without creating a key", () => {
    const secrets = openHeadlessSecrets(dataDir, {});
    expect(secrets).toMatchObject({
      keyPath: join(dataDir, SECRET_KEY_FILE_NAME),
      status: { state: "empty", reason: null, unavailable: [] },
      problem: null,
    });
    expect(secrets.store.list()).toEqual([]);
  });

  it("opens sealed secrets with their key, at an absolute VOLLI_SECRET_KEY_FILE too", () => {
    const keyPath = join(dataDir, "elsewhere.key");
    seal(keyPath);
    const secrets = openHeadlessSecrets(dataDir, { [SECRET_KEY_FILE_ENV]: keyPath });
    expect(secrets).toMatchObject({ keyPath, status: { state: "ready" }, problem: null });
    expect(secrets.store.list().map((secret) => secret.name)).toEqual(["DEPLOY_TOKEN"]);
  });

  it("refuses a relative VOLLI_SECRET_KEY_FILE without refusing to boot", () => {
    seal();
    const secrets = openHeadlessSecrets(dataDir, { [SECRET_KEY_FILE_ENV]: "keys/volli.key" });
    expect(secrets).toMatchObject({
      keyPath: null,
      status: { state: "refused", reason: "relative-path", unavailable: LOCKED },
      problem: 'VOLLI_SECRET_KEY_FILE must be an absolute path, and it is "keys/volli.key".',
    });
    expect(() => secrets.store.put({ name: "NEW", value: "v", scope: "always" })).toThrow(
      "must be an absolute path",
    );
  });

  it("refuses a key file other users could read, and never uses it", () => {
    const keyPath = join(dataDir, SECRET_KEY_FILE_NAME);
    writeFileSync(keyPath, `${Buffer.alloc(32, 1).toString("base64")}\n`, { mode: 0o600 });
    chmodSync(keyPath, 0o644);
    const secrets = openHeadlessSecrets(dataDir, {});
    expect(secrets.status).toEqual({ state: "refused", reason: "too-open", unavailable: LOCKED });
    expect(secrets.problem).toContain(`chmod 600 ${keyPath}`);
  });

  it("locks sealed secrets whose key is missing, rather than making a new one", () => {
    seal();
    const sealed = readFileSync(join(dataDir, SECRET_STORE_FILE_NAME));
    rmSync(join(dataDir, SECRET_KEY_FILE_NAME));
    const secrets = openHeadlessSecrets(dataDir, {});
    expect(secrets.status).toEqual({ state: "locked", reason: "missing", unavailable: LOCKED });
    expect(secrets.problem).toMatch(/is missing\. Put the key file back/);
    expect(readFileSync(join(dataDir, SECRET_STORE_FILE_NAME)).equals(sealed)).toBe(true);
  });

  it("calls a store that is not a sealed store at all corrupt, and names it", () => {
    writeFileSync(join(dataDir, SECRET_STORE_FILE_NAME), "garbage", { mode: 0o600 });
    const secrets = openHeadlessSecrets(dataDir, {});
    expect(secrets.status).toEqual({ state: "corrupt", reason: null, unavailable: LOCKED });
    expect(secrets.problem).toBe(
      `The secret store ${join(dataDir, SECRET_STORE_FILE_NAME)} could not be opened, so saved secrets are unavailable. Run \`volli-hostd credentials reset\` to set it aside (it is kept) and enter the secrets again.`,
    );
  });
});

describe("the boot log line", () => {
  type LogFn = HostdLogger["info"];
  function logger() {
    return {
      debug: vi.fn<LogFn>(),
      info: vi.fn<LogFn>(),
      warn: vi.fn<LogFn>(),
      error: vi.fn<LogFn>(),
    };
  }

  it("says the state when credentials are usable", () => {
    const log = logger();
    logCredentials(openHeadlessSecrets(dataDir, {}), log);
    expect(log.info).toHaveBeenCalledWith("credentials", {
      state: "empty",
      keyPath: join(dataDir, SECRET_KEY_FILE_NAME),
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns with the fix, and never a secret, when they are not", () => {
    seal();
    rmSync(join(dataDir, SECRET_KEY_FILE_NAME));
    const log = logger();
    logCredentials(openHeadlessSecrets(dataDir, {}), log);
    expect(log.warn).toHaveBeenCalledWith("serving without saved credentials", {
      state: "locked",
      reason: "missing",
      unavailable: LOCKED,
      fix: expect.stringMatching(/is missing/),
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("token-value");
  });
});
