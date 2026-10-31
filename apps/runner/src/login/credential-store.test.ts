import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { piHostCredentials } from "@volli/agent-runtime";
import {
  CREDENTIAL_INVENTORY_FILE_NAME,
  CredentialLock,
  fileCredentialKeyring,
  SealedInventory,
} from "@volli/host-core/secrets";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RunnerCredentialStore } from "./credential-store";

const dirs: string[] = [];
function fixture() {
  const base = resolve(".scratch/login-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "store-"));
  dirs.push(dir);
  const key = join(dir, "key");
  return { dir, key, store: new RunnerCredentialStore(dir, key) };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = { type: "api_key", key: "TEST-ONLY-KEY-not-a-real-credential" } as const;

describe("runner sealed Pi credential store", () => {
  it("round-trips under owner-only permissions, and another daemon store reports the provider", async () => {
    const f = fixture();
    const daemon = new RunnerCredentialStore(f.dir, f.key);
    expect(await f.store.read("anthropic")).toBeUndefined();
    expect(await f.store.list()).toEqual([]);
    await f.store.modify("anthropic", async () => key);
    expect(await daemon.read("anthropic")).toEqual(key);
    expect(await piHostCredentials(daemon).stored()).toEqual([
      { providerId: "anthropic", type: "api-key", expiresAt: null },
    ]);
    const path = join(f.dir, CREDENTIAL_INVENTORY_FILE_NAME);
    expect(readFileSync(path).includes(Buffer.from(key.key))).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(f.key).mode & 0o777).toBe(0o600);
    await f.store.delete("anthropic");
    expect(await daemon.list()).toEqual([]);
    expect(await daemon.read("anthropic")).toBeUndefined();
    await f.store.delete("anthropic");
  });

  it("serializes a refresh against logout from another store and merges other providers", async () => {
    const f = fixture();
    const other = new RunnerCredentialStore(f.dir, f.key);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refresh = f.store.modify("openai", async () => {
      entered.resolve();
      await release.promise;
      return { type: "oauth", access: "TEST-access", refresh: "TEST-refresh", expires: 100 };
    });
    await entered.promise;
    const logout = other.delete("openai");
    release.resolve();
    await refresh;
    await logout;
    expect(await other.read("openai")).toBeUndefined();
    await Promise.all([
      f.store.modify("anthropic", async () => key),
      other.modify("openai", async () => key),
    ]);
    expect((await f.store.list()).map((row) => row.providerId).toSorted()).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(await other.modify("anthropic", async () => undefined)).toEqual(key);
    await expect(
      f.store.modify("anthropic", async () => {
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");
    expect(await f.store.read("anthropic")).toEqual(key);
  });

  it("refuses a missing or unsafe key without overwriting saved credentials", async () => {
    const f = fixture();
    await f.store.modify("anthropic", async () => key);
    const original = readFileSync(join(f.dir, CREDENTIAL_INVENTORY_FILE_NAME));
    chmodSync(f.key, 0o644);
    const refused = new RunnerCredentialStore(f.dir, f.key);
    await expect(refused.list()).rejects.toThrow("unavailable");
    await expect(refused.read("anthropic")).rejects.toThrow("unavailable");
    await expect(refused.modify("anthropic", async () => key)).rejects.toThrow("unavailable");
    chmodSync(f.key, 0o600);
    rmSync(f.key);
    await expect(new RunnerCredentialStore(f.dir, f.key).delete("anthropic")).rejects.toThrow();
    expect(readFileSync(join(f.dir, CREDENTIAL_INVENTORY_FILE_NAME))).toEqual(original);
  });

  it("rejects malformed stored tags without printing values", async () => {
    const f = fixture();
    const inventory = new SealedInventory({
      path: join(f.dir, CREDENTIAL_INVENTORY_FILE_NAME),
      keyring: fileCredentialKeyring({ path: f.key }),
    });
    inventory.put("pi-provider", { provider: "anthropic" }, { type: "invalid-secret-tag" });
    await expect(f.store.read("anthropic")).rejects.toThrow("invalid format");
  });

  it("waits for transient shared-inventory contention instead of reporting an empty set", async () => {
    const f = fixture();
    await f.store.modify("anthropic", async () => key);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = new CredentialLock(join(f.dir, "host-credentials.lock")).with(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const reading = f.store.read("anthropic");
    setTimeout(() => release.resolve(), 60);
    expect(await reading).toEqual(key);
    await held;
  });

  it("refuses an inventory reset while reading and bounds busy waits", async () => {
    const f = fixture();
    await f.store.modify("anthropic", async () => key);
    const get = vi.spyOn(SealedInventory.prototype, "get").mockReturnValueOnce(null);
    await expect(f.store.read("anthropic")).rejects.toThrow("changed while reading");
    get.mockRestore();
    const snapshot = vi.spyOn(SealedInventory.prototype, "snapshot");
    snapshot.mockReturnValueOnce({
      records: [
        {
          id: "record",
          revision: 1,
          updatedAt: 1,
          family: "pi-provider",
          selector: { provider: "gone" },
        },
      ],
      status: { state: "ready", reason: null, unavailable: [] },
    });
    await expect(f.store.list()).rejects.toThrow("changed while reading");
    snapshot.mockReturnValue({
      records: [],
      status: { state: "locked", reason: "busy", unavailable: ["pi-provider"] },
    });
    const now = vi.spyOn(Date, "now");
    let clock = 0;
    now.mockImplementation(() => {
      clock += 10_001;
      return clock;
    });
    await expect(f.store.list()).rejects.toThrow("busy");
    now.mockRestore();
    snapshot.mockRestore();
  });

  it("honors aborted storage operations, including abort during a refresh", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    const options = { signal: abort.signal };
    await expect(f.store.read("a", options)).rejects.toThrow();
    await expect(f.store.list(options)).rejects.toThrow();
    await expect(f.store.delete("a", options)).rejects.toThrow();
    await expect(f.store.modify("a", async () => key, options)).rejects.toThrow();
    const during = new AbortController();
    await expect(
      f.store.modify(
        "a",
        async () => {
          during.abort();
          return key;
        },
        { signal: during.signal },
      ),
    ).rejects.toThrow();
    expect(await f.store.read("a")).toBeUndefined();
  });
});
