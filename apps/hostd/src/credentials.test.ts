import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  fileSecretKey,
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
  SecretStore,
} from "@volli/host-core/secrets";

import { runCredentialsReset, type CredentialsResetCommand } from "./credentials";
import { acquireInstanceLock } from "./instance-lock";

let dataDir: string;
let out: string;
let err: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hostd-credentials-"));
  out = "";
  err = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

const storePath = () => join(dataDir, SECRET_STORE_FILE_NAME);
const keyPath = () => join(dataDir, SECRET_KEY_FILE_NAME);

function seal(): Buffer {
  new SecretStore(storePath(), fileSecretKey({ path: keyPath() })).put({
    name: "DEPLOY_TOKEN",
    value: "token-sentinel-value",
    scope: "always",
  });
  return readFileSync(storePath());
}

function reset(confirmed: boolean, env: Record<string, string> = {}): number {
  const command: CredentialsResetCommand = { kind: "credentials-reset", dataDir, confirmed };
  return runCredentialsReset(command, {
    env,
    now: () => new Date("2026-10-05T08:00:00.000Z"),
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
}

describe("volli-hostd credentials reset", () => {
  it("refuses while a host holds the data directory", () => {
    const lock = acquireInstanceLock(dataDir);
    try {
      expect(reset(true)).toBe(1);
    } finally {
      lock.release();
    }
    expect(err).toMatch(
      /^volli-hostd: Another volli-hostd is serving .* Stop it before a reset\.\n$/,
    );
  });

  it("does nothing when saved credentials open, or there are none", () => {
    expect(reset(true)).toBe(0);
    expect(out).toBe("Saved credentials are empty; there is nothing to reset.\n");
    const sealed = seal();
    out = "";
    expect(reset(true)).toBe(0);
    expect(out).toBe("Saved credentials are ready; there is nothing to reset.\n");
    expect(readFileSync(storePath()).equals(sealed)).toBe(true);
  });

  it("says what it found and stops without --yes", () => {
    const sealed = seal();
    rmSync(keyPath());
    expect(reset(false)).toBe(1);
    expect(out).toMatch(/^Saved credentials are locked \(missing\)\.\nSaved secrets exist, but/);
    expect(err).toContain("To reset, run again with --yes.");
    expect(readdirSync(dataDir)).toContain(SECRET_STORE_FILE_NAME);
    expect(readFileSync(storePath()).equals(sealed)).toBe(true);
    expect(`${out}${err}`).not.toContain("token-sentinel-value");
  });

  it("sets a store it cannot open aside with --yes, keeps it, and says how to undo", () => {
    const sealed = seal();
    rmSync(keyPath());
    expect(reset(true)).toBe(0);
    const archive = readdirSync(dataDir).find((name) => name.includes(".locked-"))!;
    expect(archive).toMatch(/^session-secrets\.enc\.locked-20261005T080000Z-[0-9a-f]{8}$/);
    expect(readFileSync(join(dataDir, archive)).equals(sealed)).toBe(true);
    expect(out).toContain(
      `Set ${storePath()} aside as ${join(dataDir, archive)}. To undo: mv ${join(dataDir, archive)} ${storePath()}\n`,
    );
    expect(out).toMatch(/Saved credentials are now empty\.\n$/);
    // The instance lock was let go.
    acquireInstanceLock(dataDir).release();
  });

  it("uses the key file the service names, as boot does", () => {
    const elsewhere = join(dataDir, "elsewhere.key");
    new SecretStore(storePath(), fileSecretKey({ path: elsewhere })).put({
      name: "DEPLOY_TOKEN",
      value: "v",
      scope: "always",
    });
    expect(reset(true, { [SECRET_KEY_FILE_ENV]: elsewhere })).toBe(0);
    expect(out).toBe("Saved credentials are ready; there is nothing to reset.\n");
  });

  it("still names the fix for an unsafe key after a reset", () => {
    writeFileSync(storePath(), "garbage");
    writeFileSync(keyPath(), `${Buffer.alloc(32, 1).toString("base64")}\n`, { mode: 0o600 });
    chmodSync(keyPath(), 0o640);
    expect(reset(true)).toBe(0);
    expect(out).toMatch(/Saved credentials are now refused\.\nPermissions 0640 .* chmod 600 /);
  });

  it("names a corrupt store, and resets a refusal with nothing sealed", () => {
    writeFileSync(storePath(), "garbage");
    expect(reset(false)).toBe(1);
    expect(out).toMatch(
      /^Saved credentials are corrupt\.\nThe secret store .* could not be opened/,
    );
    out = "";
    rmSync(storePath());
    expect(reset(true, { [SECRET_KEY_FILE_ENV]: "relative.key" })).toBe(0);
    expect(out).not.toContain("Set ");
    expect(out).toMatch(/Saved credentials are now refused\.\n.*must be an absolute path/);
  });

  it("reports a reset that could not finish", () => {
    seal();
    rmSync(keyPath());
    vi.spyOn(SecretStore.prototype, "reset").mockImplementation(() => {
      throw new Error("Could not set the saved secrets aside.");
    });
    expect(reset(true)).toBe(1);
    expect(err).toBe("volli-hostd: Could not set the saved secrets aside.\n");
  });
});
