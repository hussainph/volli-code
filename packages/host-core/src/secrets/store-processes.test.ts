/**
 * Persistent Session secrets shared between processes (VC-642): desktop,
 * hostd and `volli-hostd credentials` on one data directory, played here by
 * real child `node` processes with the headless key file.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { CREDENTIAL_LOCK_FILE_NAME, CredentialLock } from "./credential-lock";
import { fileSecretKey, SECRET_KEY_FILE_NAME, SECRET_STORE_FILE_NAME } from "./file-key";
import { SecretStore } from "./store";
import { runChild, startChild } from "./test-support/processes";

let dir: string;
let path: string;
let key: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-secret-processes-"));
  path = join(dir, SECRET_STORE_FILE_NAME);
  key = join(dir, SECRET_KEY_FILE_NAME);
});
afterEach(() => {
  new CredentialLock(join(dir, CREDENTIAL_LOCK_FILE_NAME)).close();
  rmSync(dir, { recursive: true, force: true });
});

const open = () => new SecretStore(path, fileSecretKey({ path: key }));
const always = (name: string, value: string) => ({ name, value, scope: "always" as const });
const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex");
const temporaries = () => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

describe("Session secrets across processes", () => {
  it("merges saves and last-use updates from several processes: none is lost", async () => {
    const parent = open();
    parent.put(always("PARENT_0", "parent-0"));
    const children = [0, 1, 2].map((n) =>
      startChild({
        kind: "secret-put",
        path,
        key,
        inputs: Array.from({ length: 8 }, (_, i) => always(`CHILD_${n}_${i}`, `child-${n}-${i}`)),
      }),
    );
    // Meanwhile the parent saves, and injects (which commits last use).
    for (let i = 1; i <= 8; i += 1) {
      parent.put({ name: `PARENT_${i}`, value: `parent-${i}`, scope: "project", projectId: "p" });
      parent.environment("s", "p");
    }
    for (const child of children) expect(await child.next()).toEqual({ status: "ready" });
    await Promise.all(children.map((child) => child.exited));
    const names = parent.list().map((item) => item.name);
    expect(names).toHaveLength(9 + 24);
    expect(new Set(names).size).toBe(33);
    expect(Object.keys(parent.environment("s", "p"))).toHaveLength(33);
    expect(
      open()
        .list()
        .find((item) => item.name === "PARENT_0")?.lastUsedAt,
    ).toEqual(expect.any(Number));
    expect(temporaries()).toEqual([]);
  }, 30_000);

  it("injects nothing another process revoked, from the next command on", async () => {
    const parent = open();
    parent.put(always("STRIPE_KEY", "sk-revoked-sentinel"));
    expect(parent.environment("s", "p")).toEqual({ STRIPE_KEY: "sk-revoked-sentinel" });
    expect(await runChild({ kind: "secret-revoke", path, key, name: "STRIPE_KEY" })).toEqual({
      revoked: true,
    });
    expect(parent.environment("s", "p")).toEqual({});
    expect(parent.available("STRIPE_KEY", "s", "p")).toBe(false);
    expect(parent.list()).toEqual([]);
    // Output an earlier command printed stays scrubbed.
    expect(parent.redact("leaked sk-revoked-sentinel")).toBe("leaked ‹secret:STRIPE_KEY›");
  });

  it("injects, and redacts, what another process saved", async () => {
    const parent = open();
    expect(parent.status().state).toBe("empty");
    await runChild({
      kind: "secret-put",
      path,
      key,
      inputs: [always("NEW_TOKEN", "new-sentinel")],
    });
    expect(parent.available("NEW_TOKEN", "s", "p")).toBe(true);
    expect(parent.environment("s", "p")).toEqual({ NEW_TOKEN: "new-sentinel" });
    expect(parent.redact("got new-sentinel")).toBe("got ‹secret:NEW_TOKEN›");
    expect(parent.status().state).toBe("ready");
    // And the other way: a child's next command sees the parent's revocation.
    parent.revoke(parent.list()[0]!.id);
    expect(
      await runChild({ kind: "secret-env", path, key, sessionId: "s", projectId: "p" }),
    ).toEqual({ env: {} });
  });

  it("survives a writer killed at every step: the old file or the new, never torn", async () => {
    const parent = open();
    parent.put(always("OLD", "old-value"));
    for (const at of ["temporary-written", "temporary-synced", "renamed"] as const) {
      const child = startChild({
        kind: "secret-put",
        path,
        key,
        inputs: [always(`NEW_${at.replaceAll("-", "_").toUpperCase()}`, "new-value")],
        crashAt: at,
      });
      expect((await child.exited).signal).toBe("SIGKILL");
      const name = `NEW_${at.replaceAll("-", "_").toUpperCase()}`;
      const names = parent.list().map((item) => item.name);
      expect(names).toContain("OLD");
      // Committed only once renamed into place.
      expect(names.includes(name)).toBe(at === "renamed");
      parent.put(always(`AFTER_${at.replaceAll("-", "_").toUpperCase()}`, "after"));
      expect(temporaries()).toEqual([]);
    }
    const names = parent.list().map((item) => item.name);
    expect(names).toContain("NEW_RENAMED");
    expect(names).not.toContain("NEW_TEMPORARY_WRITTEN");
    expect(names).not.toContain("NEW_TEMPORARY_SYNCED");
    expect(parent.status().state).toBe("ready");
  }, 30_000);
});

describe("a key lost while the host runs (VC-641's known limit)", () => {
  it("locks stored secrets at the next read, not the next launch, and keeps the file", () => {
    const store = open();
    store.put(always("STORED", "stored-sentinel"));
    store.put({ name: "LIVE", value: "live", scope: "session", sessionId: "s" });
    const before = digest();
    const keyBytes = readFileSync(key);
    rmSync(key);
    expect(store.environment("s", "p")).toEqual({ LIVE: "live" });
    expect(store.status()).toEqual({
      state: "locked",
      reason: "missing",
      unavailable: ["session-env"],
    });
    expect(store.problem()).toContain(key);
    expect(() => store.put(always("NEW", "v"))).toThrow(
      expect.objectContaining({ reason: "missing" }),
    );
    // Never a new key, never a write over the sealed file.
    expect(readdirSync(dir).includes(SECRET_KEY_FILE_NAME)).toBe(false);
    expect(digest()).toBe(before);
    // Redaction still holds the value seen before the loss.
    expect(store.redact("stored-sentinel")).toBe("‹secret:STORED›");

    writeFileSync(key, keyBytes, { mode: 0o600 });
    expect(store.unlock().state).toBe("ready");
    expect(store.environment("s", "p")).toEqual({ STORED: "stored-sentinel", LIVE: "live" });
  });

  it("locks on a key replaced mid-run, and on the first save to find it", () => {
    const store = open();
    store.put(always("STORED", "stored-sentinel"));
    const before = digest();
    writeFileSync(key, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    expect(() => store.put(always("NEW", "v"))).toThrow(
      expect.objectContaining({ reason: "wrong-key" }),
    );
    expect(store.status()).toMatchObject({ state: "locked", reason: "wrong-key" });
    expect(store.environment("s", "p")).toEqual({});
    store.revoke("anything");
    expect(digest()).toBe(before);
  });

  it("revokes nothing, and throws nothing, when a revoke is the first to find the key gone", () => {
    const store = open();
    const item = store.put(always("STORED", "stored-sentinel"));
    const before = digest();
    rmSync(key);
    store.revoke(item.id);
    expect(store.status()).toMatchObject({ state: "locked", reason: "missing" });
    expect(digest()).toBe(before);
  });

  it("lets a revoke that cannot be committed reach its caller", () => {
    let full = false;
    const store = new SecretStore(path, fileSecretKey({ path: key }), {
      document: {
        step: (at) => {
          if (full && at === "temporary-written") throw new Error("disk full");
        },
      },
    });
    const item = store.put(always("STORED", "v"));
    full = true;
    expect(() => store.revoke(item.id)).toThrow("Could not persist encrypted secrets.");
    expect(
      open()
        .list()
        .map((stored) => stored.id),
    ).toEqual([item.id]);
  });

  it("answers a command with an error, not without its secrets, while another process holds the lock", async () => {
    const store = new SecretStore(path, fileSecretKey({ path: key }), {
      document: { lockTimeoutMs: 20 },
    });
    store.put(always("STORED", "stored-sentinel"));
    const child = startChild({ kind: "hold", lock: join(dir, CREDENTIAL_LOCK_FILE_NAME) });
    try {
      await child.next();
      expect(() => store.environment("s", "p")).toThrow("busy");
      expect(store.list()).toEqual([]);
      expect(store.status().state).toBe("ready");
      // Momentary: never remembered as a lock.
      const fresh = new SecretStore(path, fileSecretKey({ path: key }), {
        document: { lockTimeoutMs: 20 },
      });
      expect(fresh.status()).toMatchObject({ state: "locked", reason: "store-unreadable" });
      expect(fresh.hasValues()).toBe(false);
    } finally {
      child.process.kill("SIGKILL");
      await child.exited;
    }
    expect(store.environment("s", "p")).toEqual({ STORED: "stored-sentinel" });
  });
});
