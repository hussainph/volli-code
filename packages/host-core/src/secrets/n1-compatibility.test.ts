/**
 * N-1 compatibility of persistent Session secrets (VC-642). External users run
 * releases cut from main, so after this upgrade an existing store must open
 * with identical contents, and the release before it (N-1) must open, use and
 * write everything this build writes. `test-support/n1/` holds main's exact
 * store, codec and key adapter at the base commit (`3966e6233`); the first test
 * proves the copies are byte-identical by their git blob ids, so this is the
 * shipped code, not a re-implementation.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CREDENTIAL_LOCK_FILE_NAME, CredentialLock } from "./credential-lock";
import { fileSecretKey, SECRET_KEY_FILE_NAME, SECRET_STORE_FILE_NAME } from "./file-key";
import { SecretStore } from "./store";
import { fileSecretKey as n1FileSecretKey } from "./test-support/n1/secrets/file-key";
import { SecretStore as N1SecretStore } from "./test-support/n1/secrets/store";

/** main's blob ids at `3966e6233`, as `git rev-parse 3966e6233:<path>` prints them. */
const MAIN_BLOBS: Readonly<Record<string, string>> = {
  "secrets/store.ts": "392822e7e4a01628e7aa60b3fbf5e2339bed1f95",
  "secrets/file-key.ts": "a8667cfd6ae19eeb2e38e4bc6edf1c0ed0feb909",
  "secrets/credential-state.ts": "d5fdbaa525ffb74958ac0bcca41f133b2af49c50",
  "secrets/pending-notice-secret.ts": "7d5b0e23af816854826919224e74846ba401f623",
  "ports/secret-key.ts": "982e6cf26bcdb8b142a67ae337b75200c0f2e55c",
};

/** `git hash-object`: SHA-1 over `blob <length>\0` and the bytes. */
function gitBlobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

let dir: string;
let path: string;
let key: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-n1-"));
  path = join(dir, SECRET_STORE_FILE_NAME);
  key = join(dir, SECRET_KEY_FILE_NAME);
  // Injection records last use; one clock keeps both builds' views comparable.
  vi.spyOn(Date, "now").mockReturnValue(1_791_000_000_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  new CredentialLock(join(dir, CREDENTIAL_LOCK_FILE_NAME)).close();
  rmSync(dir, { recursive: true, force: true });
});

const current = () => new SecretStore(path, fileSecretKey({ path: key }));
const previous = () => new N1SecretStore(path, n1FileSecretKey({ path: key }));

/** Everything a person or a command can observe of a store. */
function observe(store: SecretStore | N1SecretStore) {
  return {
    status: store.status(),
    list: store.list(),
    env: store.environment("s", "p"),
    elsewhere: store.environment("s", "q"),
  };
}

describe("N-1 compatibility of the Session-secrets file", () => {
  it("tests against main's exact code", () => {
    for (const [file, blob] of Object.entries(MAIN_BLOBS)) {
      const bytes = readFileSync(new URL(`./test-support/n1/${file}`, import.meta.url));
      expect(gitBlobId(bytes), file).toBe(blob);
    }
  });

  it("opens a store N-1 wrote with identical contents", () => {
    const old = previous();
    old.put({ name: "ALWAYS_TOKEN", value: "always-value", scope: "always" });
    old.put({ name: "PROJECT_TOKEN", value: "project-value", scope: "project", projectId: "p" });
    old.environment("s", "p");
    const written = readFileSync(path);
    const before = previous().list();
    const upgraded = current();
    expect(upgraded.list()).toEqual(before);
    expect(upgraded.status().state).toBe("ready");
    expect(upgraded.available("PROJECT_TOKEN", "s", "p")).toBe(true);
    // Opening, listing and checking changed nothing on disk.
    expect(readFileSync(path)).toEqual(written);
    expect(observe(upgraded)).toEqual(observe(previous()));
  });

  it("writes only what N-1 opens, uses and writes back, in both directions", () => {
    const now = current();
    const always = now.put({ name: "ALWAYS_TOKEN", value: "always-value", scope: "always" });
    now.put({ name: "PROJECT_TOKEN", value: "project-value", scope: "project", projectId: "p" });
    now.put({ name: "GONE", value: "gone-value", scope: "always" });
    now.revoke(now.list().find((item) => item.name === "GONE")!.id);
    now.environment("s", "p");
    expect(readFileSync(path).subarray(0, 4).toString()).toBe("VSF1");
    // N-1 sees exactly what this build sees.
    const old = previous();
    expect(observe(old)).toEqual(observe(current()));
    expect(old.status().state).toBe("ready");
    // N-1 writes over it, and this build reads N-1's writes.
    old.put({ name: "ALWAYS_TOKEN", value: "replaced-by-n1", scope: "always" });
    old.revoke(old.list().find((item) => item.name === "PROJECT_TOKEN")!.id);
    const reread = current();
    expect(reread.list()).toEqual(previous().list());
    expect(reread.list().map((item) => item.id)).toEqual([always.id]);
    expect(reread.environment("s", "p")).toEqual({ ALWAYS_TOKEN: "replaced-by-n1" });
    // The only new file is the lock, which N-1 never opens.
    expect(readdirSync(dir).toSorted()).toEqual(
      [CREDENTIAL_LOCK_FILE_NAME, SECRET_STORE_FILE_NAME, SECRET_KEY_FILE_NAME].toSorted(),
    );
  });

  it("leaves N-1's lost-key path as it was: locked, byte-identical, never re-keyed", () => {
    current().put({ name: "TOKEN", value: "v", scope: "always" });
    const sealed = readFileSync(path);
    rmSync(key);
    const old = previous();
    expect(old.status()).toMatchObject({ state: "locked", reason: "missing" });
    expect(current().status()).toMatchObject({ state: "locked", reason: "missing" });
    expect(readFileSync(path)).toEqual(sealed);
  });
});
