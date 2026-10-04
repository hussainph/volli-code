import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  fileSecretKey,
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
  SecretStore,
} from "@volli/host-core/secrets";

import { HostdBootError } from "./boot-error";
import { openHeadlessSecrets } from "./secrets";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hostd-secrets-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function bootError(env: Record<string, string> = {}): HostdBootError {
  try {
    openHeadlessSecrets(dataDir, env);
  } catch (error) {
    expect(error).toBeInstanceOf(HostdBootError);
    return error as HostdBootError;
  }
  throw new Error("expected boot to be refused");
}

function seal(keyPath = join(dataDir, SECRET_KEY_FILE_NAME)): void {
  new SecretStore(join(dataDir, SECRET_STORE_FILE_NAME), fileSecretKey({ path: keyPath })).put({
    name: "DEPLOY_TOKEN",
    value: "token-value",
    scope: "always",
  });
}

describe("opening secrets at boot", () => {
  it("opens an empty profile without creating a key", () => {
    const secrets = openHeadlessSecrets(dataDir, {});
    expect(secrets).toMatchObject({ keyPath: join(dataDir, SECRET_KEY_FILE_NAME), key: "absent" });
    expect(secrets.store.list()).toEqual([]);
  });

  it("opens sealed secrets with their key, at an absolute VOLLI_SECRET_KEY_FILE too", () => {
    const keyPath = join(dataDir, "elsewhere.key");
    seal(keyPath);
    const secrets = openHeadlessSecrets(dataDir, { [SECRET_KEY_FILE_ENV]: keyPath });
    expect(secrets).toMatchObject({ keyPath, key: "present" });
    expect(secrets.store.list().map((secret) => secret.name)).toEqual(["DEPLOY_TOKEN"]);
  });

  it("refuses a relative VOLLI_SECRET_KEY_FILE", () => {
    const error = bootError({ [SECRET_KEY_FILE_ENV]: "keys/volli.key" });
    expect(error.reason).toBe("secret-key");
    expect(error.fields).toEqual({ refusal: "relative-path" });
    expect(error.message).toBe(
      'VOLLI_SECRET_KEY_FILE must be an absolute path, and it is "keys/volli.key".',
    );
  });

  it("refuses a key file other users could read, before anything is sealed", () => {
    const keyPath = join(dataDir, SECRET_KEY_FILE_NAME);
    writeFileSync(keyPath, `${Buffer.alloc(32, 1).toString("base64")}\n`, { mode: 0o600 });
    chmodSync(keyPath, 0o644);
    const error = bootError();
    expect(error.fields).toEqual({ refusal: "too-open" });
    expect(error.message).toContain(`chmod 600 ${keyPath}`);
  });

  it("refuses sealed secrets whose key is missing, rather than making a new one", () => {
    seal();
    rmSync(join(dataDir, SECRET_KEY_FILE_NAME));
    const error = bootError();
    expect(error.fields).toEqual({ refusal: "missing" });
    expect(error.message).toMatch(/is missing\. Put the key file back/);
  });

  it("names the store when it is not a sealed store at all", () => {
    writeFileSync(join(dataDir, SECRET_STORE_FILE_NAME), "garbage", { mode: 0o600 });
    const error = bootError();
    expect(error.reason).toBe("secret-store");
    expect(error.message).toBe(
      `The secret store ${join(dataDir, SECRET_STORE_FILE_NAME)} could not be opened. Move it aside to start with no saved secrets.`,
    );
  });
});
