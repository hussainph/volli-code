import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { CredentialKeyring } from "../ports/credential-keyring";
import { SecretKeyUnavailableError } from "../ports/secret-key";
import {
  CREDENTIAL_FAMILIES,
  isCredentialFamily,
  selectorKey,
  validSelector,
  validValue,
} from "./credential-families";
import { credentialKeyId, CredentialKeySet, isCredentialKeyId } from "./credential-key-id";
import { CredentialLock } from "./credential-lock";
import { fileCredentialKeyring } from "./file-key";
import {
  CREDENTIAL_INVENTORY_FILE_NAME,
  CredentialRevisionConflictError,
  INVENTORY_SCHEMA,
  SealedInventory,
} from "./inventory";
import { envelopeHeader, openEnvelope, sealEnvelope } from "./sealed-envelope";
import { runChild, startChild } from "./test-support/processes";

let dir: string;
let path: string;
let keyPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-inventory-"));
  path = join(dir, CREDENTIAL_INVENTORY_FILE_NAME);
  keyPath = join(dir, "session-secrets.key");
});
afterEach(() => {
  new CredentialLock(join(dir, "host-credentials.lock")).close();
  rmSync(dir, { recursive: true, force: true });
});

function open(options: Partial<ConstructorParameters<typeof SealedInventory>[0]> = {}) {
  return new SealedInventory({
    path,
    keyring: fileCredentialKeyring({ path: keyPath }),
    ...options,
  });
}

const WEB = { provider: "brave" } as const;
const SENTINEL = "sk-sentinel-0123456789";

function digest(): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("credential families", () => {
  it("fixes each family's selector fields and value kind", () => {
    expect(CREDENTIAL_FAMILIES).toHaveLength(7);
    expect(isCredentialFamily("mcp")).toBe(true);
    expect(isCredentialFamily("toString")).toBe(false);
    expect(isCredentialFamily(7)).toBe(false);
    expect(validSelector("web-search", { provider: "exa" })).toBe(true);
    expect(validSelector("web-search", { provider: "exa", extra: "x" })).toBe(false);
    expect(validSelector("web-search", {})).toBe(false);
    expect(validSelector("web-search", { provider: "" })).toBe(false);
    expect(validSelector("web-search", { provider: "a\0b" })).toBe(false);
    expect(validSelector("web-search", { provider: 1 })).toBe(false);
    expect(validSelector("web-search", null)).toBe(false);
    expect(validSelector("web-search", ["exa"])).toBe(false);
    expect(validSelector("mcp", { serverId: "s", endpoint: "https://x" })).toBe(true);
    expect(validSelector("device-verifier", { hostId: "h", workspaceId: "w", deviceId: "d" })).toBe(
      true,
    );
    expect(validSelector("worker-verifier", { hostId: "h", workspaceId: "w" })).toBe(false);
    expect(validSelector("host-private", { purpose: "pairing" })).toBe(true);
    expect(validValue("mcp", { tokens: { access: "x" } })).toBe(true);
    expect(validValue("mcp", "flat")).toBe(false);
    expect(validValue("pi-provider", [])).toBe(false);
    expect(validValue("pi-provider", null)).toBe(false);
    expect(validValue("web-search", "")).toBe(false);
    expect(validValue("web-search", "a\0")).toBe(false);
    expect(selectorKey("session-env", { scope: "always", name: "K" })).not.toBe(
      selectorKey("session-env", { scope: "project", name: "K", projectId: "p" }),
    );
    expect(selectorKey("mcp", { endpoint: "e", serverId: "s" })).toBe(
      selectorKey("mcp", { serverId: "s", endpoint: "e" }),
    );
  });

  it("keeps Session-env to Project and Always secrets with safe names", () => {
    const project = { scope: "project", name: "STRIPE_KEY", projectId: "p1" };
    expect(validSelector("session-env", project)).toBe(true);
    expect(validSelector("session-env", { scope: "always", name: "STRIPE_KEY" })).toBe(true);
    expect(validSelector("session-env", { scope: "always", name: "K", projectId: "p" })).toBe(
      false,
    );
    expect(validSelector("session-env", { scope: "project", name: "STRIPE_KEY" })).toBe(false);
    expect(validSelector("session-env", { scope: "session", name: "STRIPE_KEY" })).toBe(false);
    expect(validSelector("session-env", { ...project, name: "PATH" })).toBe(false);
  });
});

describe("key ids", () => {
  it("are 32 hex digits of a labelled hash, distinct from the legacy VSF1 id", () => {
    const key = Buffer.alloc(32, 7);
    const id = credentialKeyId(key);
    expect(isCredentialKeyId(id)).toBe(true);
    expect(isCredentialKeyId("ABC")).toBe(false);
    expect(isCredentialKeyId(undefined)).toBe(false);
    // Durable format, pinned.
    expect(id).toBe(
      createHash("sha256")
        .update("volli-credential-key-id:v2\0")
        .update(key)
        .digest()
        .subarray(0, 16)
        .toString("hex"),
    );
    const legacy = createHash("sha256")
      .update("volli-secret-key-id:v1\0")
      .update(key)
      .digest()
      .subarray(0, 8)
      .toString("hex");
    expect(id.startsWith(legacy)).toBe(false);
  });

  it("refuse a collision: two keys with one id resolve to neither, ever", () => {
    const set = new CredentialKeySet(() => "0".repeat(32));
    const first = Buffer.alloc(32, 1);
    expect(set.add(first)).toBe("0".repeat(32));
    expect(set.add(Buffer.from(first))).toBe("0".repeat(32));
    expect(set.get("0".repeat(32))).toEqual(first);
    expect(() => set.add(Buffer.alloc(32, 2))).toThrow("share one key id");
    expect(set.get("0".repeat(32))).toBeUndefined();
    expect(() => set.add(first)).toThrow("share one key id");
    const real = new CredentialKeySet();
    const id = real.add(first);
    expect(real.get(id)).toEqual(first);
    real.clear();
    expect(real.get(id)).toBeUndefined();
    expect(first.every((byte) => byte === 0)).toBe(true);
  });
});

describe("VHC1 envelope", () => {
  const key = { id: credentialKeyId(Buffer.alloc(32, 3)), key: Buffer.alloc(32, 3) };

  it("names its backend and key, authenticates the header, and uses a fresh nonce", () => {
    const sealed = sealEnvelope("file", key, "plain");
    expect(sealed.subarray(0, 4).toString()).toBe("VHC1");
    expect(envelopeHeader(sealed)).toEqual({ backend: "file", keyId: key.id });
    expect(envelopeHeader(sealEnvelope("keychain", key, "x")).backend).toBe("keychain");
    expect(openEnvelope(sealed, key.key)).toBe("plain");
    expect(sealEnvelope("file", key, "plain").equals(sealed)).toBe(false);
    const edited = Buffer.from(sealed);
    edited[4] = 2;
    expect(() => openEnvelope(edited, key.key)).toThrow();
    const otherId = Buffer.from(sealed);
    otherId[5]! ^= 1;
    expect(() => openEnvelope(otherId, key.key)).toThrow();
  });

  it("is never a legacy envelope, a short file or an unknown backend", () => {
    for (const bytes of [
      Buffer.concat([Buffer.from("VSF1"), randomBytes(60)]),
      Buffer.concat([Buffer.from("VSC1"), randomBytes(60)]),
      Buffer.from("VHC1"),
      Buffer.concat([Buffer.from("VHC1"), Buffer.from([9]), randomBytes(60)]),
    ]) {
      expect(() => envelopeHeader(bytes)).toThrow("Not a sealed credential inventory.");
    }
  });
});

describe("file credential keyring", () => {
  it("creates a key only to seal, resolves only its own id, and notices a change on probe", () => {
    const keyring = fileCredentialKeyring({ path: keyPath });
    expect(keyring.backend).toBe("file");
    keyring.probe();
    expect(() => keyring.resolve("0".repeat(32))).toThrow(
      expect.objectContaining({ reason: "missing" }),
    );
    const active = keyring.active();
    expect(readFileSync(keyPath, "utf8").trim()).toBe(active.key.toString("base64"));
    expect(keyring.resolve(active.id)).toEqual(active.key);
    expect(() => keyring.resolve("0".repeat(32))).toThrow(
      expect.objectContaining({ reason: "wrong-key" }),
    );
    // Replaced while running: the next probe holds what the file holds now.
    const replacement = randomBytes(32);
    writeFileSync(keyPath, `${replacement.toString("base64")}\n`, { mode: 0o600 });
    expect(keyring.resolve(active.id)).toEqual(active.key);
    keyring.probe();
    expect(() => keyring.resolve(active.id)).toThrow(
      expect.objectContaining({ reason: "wrong-key" }),
    );
    expect(keyring.active().id).toBe(credentialKeyId(replacement));
    rmSync(keyPath);
    keyring.probe();
    expect(() => keyring.resolve(credentialKeyId(replacement))).toThrow(
      expect.objectContaining({ reason: "missing" }),
    );
    chmodSync(dir, 0o700);
    writeFileSync(keyPath, `${replacement.toString("base64")}\n`, { mode: 0o644 });
    expect(() => keyring.probe()).toThrow(expect.objectContaining({ reason: "too-open" }));
  });
});

describe("SealedInventory", { timeout: 30_000 }, () => {
  it("starts empty, makes no key and no file until a save", () => {
    const store = open();
    expect(store.status()).toEqual({ state: "empty", reason: null, unavailable: [] });
    expect(store.list("web-search")).toEqual([]);
    expect(store.get("web-search", WEB)).toBeNull();
    expect(store.remove("web-search", WEB)).toBe(false);
    expect(store.problem()).toBeNull();
    expect(readdirSync(dir)).toEqual(["host-credentials.lock"]);
  });

  it("seals typed records under a named key, keeping ids and bumping revisions", () => {
    let now = 1000;
    const store = open({ now: () => now });
    const first = store.put("web-search", WEB, SENTINEL);
    expect(first).toMatchObject({
      family: "web-search",
      selector: WEB,
      revision: 1,
      updatedAt: 1000,
    });
    expect(store.status().state).toBe("ready");
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 4).toString()).toBe("VHC1");
    expect(bytes.includes(Buffer.from(SENTINEL))).toBe(false);
    expect(readFileSync(path).length).toBeGreaterThan(0);
    now = 2000;
    const second = store.put("web-search", WEB, "sk-second");
    expect(second).toEqual({ ...first, revision: 2, updatedAt: 2000 });
    const oauth = { access: "a", refresh: "r", expires: 3, providerField: { kept: true } };
    store.put("pi-provider", { provider: "anthropic" }, oauth);
    expect(store.get("pi-provider", { provider: "anthropic" })?.value).toEqual(oauth);
    expect(store.list("web-search")).toEqual([second]);
    expect(JSON.stringify(store.list("pi-provider"))).not.toContain("refresh");
    expect(store.get("web-search", WEB)?.value).toBe("sk-second");
    expect(store.get("web-search", { provider: "exa" })).toBeNull();
    // What is on disk: the payload's own fields, under this key.
    const plain = JSON.parse(
      openEnvelope(readFileSync(path), fileCredentialKeyring({ path: keyPath }).active().key),
    ) as Record<string, unknown>;
    expect(plain).toMatchObject({ schema: INVENTORY_SCHEMA, generation: 3 });
    expect(plain["inventory"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.remove("web-search", WEB)).toBe(true);
    expect(store.get("web-search", WEB)).toBeNull();
    expect(store.remove("web-search", WEB)).toBe(false);
    expect(() => store.put("web-search", { provider: "x", y: "z" }, "v")).toThrow(
      "Invalid credential.",
    );
    expect(() => store.put("mcp", { serverId: "s", endpoint: "e" }, "flat")).toThrow(
      "Invalid credential.",
    );
  });

  it("commits against a record: a late refresh loses to a sign-out or a new sign-in", () => {
    const store = open();
    const other = open();
    const nobody = { id: "00000000-0000-4000-8000-000000000000", revision: 1 };
    expect(() => store.put("web-search", WEB, "v", { expect: nobody })).toThrow(
      CredentialRevisionConflictError,
    );
    const read = store.put("web-search", WEB, "v1", { expect: null });
    expect(() => store.put("web-search", WEB, "again", { expect: null })).toThrow(
      CredentialRevisionConflictError,
    );
    other.put("web-search", WEB, "new sign-in");
    expect(() => store.put("web-search", WEB, "late refresh", { expect: read })).toThrow(
      CredentialRevisionConflictError,
    );
    expect(() => store.remove("web-search", WEB, { expect: read })).toThrow(
      CredentialRevisionConflictError,
    );
    expect(store.get("web-search", WEB)?.value).toBe("new sign-in");
    const current = store.get("web-search", WEB)!;
    // The same id at another revision is not the record that was read either.
    expect(() =>
      store.put("web-search", WEB, "x", { expect: { id: current.id, revision: read.revision } }),
    ).toThrow(CredentialRevisionConflictError);
    const refreshed = store.put("web-search", WEB, "refreshed", { expect: current });
    expect(refreshed.id).toBe(current.id);
    expect(refreshed.revision).toBeGreaterThan(current.revision);
    expect(store.remove("web-search", WEB, { expect: refreshed })).toBe(true);
    expect(store.remove("web-search", WEB, { expect: null })).toBe(false);
  });

  it("never repeats a record's identity: remove, recreate, then a late refresh loses (ABA)", () => {
    const store = open();
    const selector = { provider: "verify" };
    const old = store.put("pi-provider", selector, { type: "oauth", refresh: "old" });
    store.remove("pi-provider", selector);
    const newer = store.put("pi-provider", selector, { type: "oauth", refresh: "new-sign-in" });
    expect(newer.id).not.toBe(old.id);
    expect(newer.revision).toBeGreaterThan(old.revision);
    expect(() =>
      store.put(
        "pi-provider",
        selector,
        { type: "oauth", refresh: "stale-refresh" },
        { expect: old },
      ),
    ).toThrow(CredentialRevisionConflictError);
    expect(store.get("pi-provider", selector)?.value).toEqual({
      type: "oauth",
      refresh: "new-sign-in",
    });
    // Revisions grow with every commit, so even a removed record's number is never reused.
    const revisions = [old, newer, store.put("web-search", WEB, "w")].map((r) => r.revision);
    expect(revisions).toEqual([...revisions].toSorted((a, b) => a - b));
    expect(new Set(revisions).size).toBe(3);
  });

  it("sees another instance's revocation on the next read, without restarting", () => {
    const reader = open();
    const writer = open();
    writer.put("web-search", WEB, SENTINEL);
    expect(reader.get("web-search", WEB)?.value).toBe(SENTINEL);
    writer.remove("web-search", WEB);
    expect(reader.get("web-search", WEB)).toBeNull();
  });

  it("notices a key lost or replaced mid-run, and leaves the file byte-identical", () => {
    const store = open();
    store.put("web-search", WEB, SENTINEL);
    const before = digest();
    const key = readFileSync(keyPath);
    rmSync(keyPath);
    expect(store.get("web-search", WEB)).toBeNull();
    expect(store.status()).toEqual({
      state: "locked",
      reason: "missing",
      unavailable: CREDENTIAL_FAMILIES,
    });
    expect(store.problem()).toContain(keyPath);
    expect(() => store.put("web-search", WEB, "x")).toThrow(SecretKeyUnavailableError);
    expect(digest()).toBe(before);
    expect(readdirSync(dir).includes("session-secrets.key")).toBe(false);
    // Sticky until unlock, then open again with the key back.
    writeFileSync(keyPath, key, { mode: 0o600 });
    expect(store.status().state).toBe("locked");
    expect(store.unlock().state).toBe("ready");
    writeFileSync(keyPath, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    expect(store.list("web-search")).toEqual([]);
    expect(store.status()).toMatchObject({ state: "locked", reason: "wrong-key" });
    expect(digest()).toBe(before);
  });

  it("locks on a save that is the first to find the key gone", () => {
    const store = open();
    store.put("web-search", WEB, SENTINEL);
    const before = digest();
    rmSync(keyPath);
    expect(() => store.put("web-search", { provider: "exa" }, "x")).toThrow(
      expect.objectContaining({ reason: "missing" }),
    );
    expect(store.status()).toMatchObject({ state: "locked", reason: "missing" });
    expect(() => store.remove("web-search", WEB)).toThrow(
      expect.objectContaining({ reason: "missing" }),
    );
    expect(digest()).toBe(before);
  });

  it("gates only the families it is given", () => {
    open().put("web-search", WEB, SENTINEL);
    rmSync(keyPath);
    expect(open({ families: ["web-search"] }).status().unavailable).toEqual(["web-search"]);
  });

  it("is locked by another backend's envelope, a refused key, or a newer schema, never rewritten", () => {
    const key = { id: credentialKeyId(Buffer.alloc(32, 9)), key: Buffer.alloc(32, 9) };
    writeFileSync(path, sealEnvelope("keychain", key, "{}"));
    expect(open().status()).toMatchObject({ state: "locked", reason: "other-adapter" });
    writeFileSync(keyPath, `${key.key.toString("base64")}\n`, { mode: 0o600 });
    const newer = JSON.stringify({ schema: INVENTORY_SCHEMA + 1, anything: "new" });
    writeFileSync(path, sealEnvelope("file", key, newer));
    const before = digest();
    const store = open();
    expect(store.status()).toMatchObject({ state: "locked", reason: "newer-format" });
    expect(store.problem()).toBeNull();
    expect(() => store.put("web-search", WEB, "x")).toThrow("newer Volli");
    expect(digest()).toBe(before);
    chmodSync(keyPath, 0o644);
    expect(open().status()).toMatchObject({ state: "refused", reason: "too-open" });
  });

  it("is corrupt when the key opens something that is not a valid inventory", () => {
    const key = { id: credentialKeyId(Buffer.alloc(32, 5)), key: Buffer.alloc(32, 5) };
    writeFileSync(keyPath, `${key.key.toString("base64")}\n`, { mode: 0o600 });
    const record = {
      id: "r1",
      family: "web-search",
      selector: WEB,
      value: "v",
      revision: 1,
      updatedAt: 1,
    };
    const valid = { schema: 1, inventory: "0".repeat(36), generation: 1, records: [record] };
    writeFileSync(path, sealEnvelope("file", key, JSON.stringify(valid)));
    expect(open().get("web-search", WEB)?.value).toBe("v");
    for (const payload of [
      "not json",
      "null",
      { ...valid, schema: 0 },
      { ...valid, schema: "1" },
      { ...valid, inventory: "short" },
      { ...valid, inventory: 7 },
      { ...valid, generation: 0 },
      { ...valid, generation: 1.5 },
      { ...valid, records: {} },
      { ...valid, records: [null] },
      { ...valid, records: [{ ...record, id: 1 }] },
      { ...valid, records: [record, { ...record, selector: { provider: "exa" } }] },
      { ...valid, records: [record, { ...record, id: "r2" }] },
      { ...valid, records: [{ ...record, family: "ssh" }] },
      { ...valid, records: [{ ...record, selector: { provider: "" } }] },
      { ...valid, records: [{ ...record, value: { not: "a string" } }] },
      { ...valid, records: [{ ...record, revision: 0 }] },
      { ...valid, records: [{ ...record, updatedAt: "now" }] },
      { ...valid, records: [{ ...record, updatedAt: Number.POSITIVE_INFINITY }] },
      { ...valid, records: [{ ...record, updatedAt: -1 }] },
    ]) {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      writeFileSync(path, sealEnvelope("file", key, text));
      expect(open().status(), text).toEqual({
        state: "corrupt",
        reason: null,
        unavailable: CREDENTIAL_FAMILIES,
      });
    }
    // Unknown record fields are dropped, never listed.
    writeFileSync(
      path,
      sealEnvelope(
        "file",
        key,
        JSON.stringify({ ...valid, records: [{ ...record, leak: SENTINEL }] }),
      ),
    );
    expect(JSON.stringify(open().get("web-search", WEB))).not.toContain(SENTINEL);
    // A tampered ciphertext under the right key is corrupt too.
    const sealed = sealEnvelope("file", key, JSON.stringify(valid));
    sealed[sealed.length - 1]! ^= 1;
    writeFileSync(path, sealed);
    expect(open().status().state).toBe("corrupt");
  });

  it("never re-keys by saving over a file sealed under another key", () => {
    const store = open();
    store.put("web-search", WEB, "v");
    const before = digest();
    const original = fileCredentialKeyring({ path: keyPath }).active();
    // A keyring that opens the old key but would seal under a new one.
    const rotating: CredentialKeyring = {
      backend: "file",
      probe() {},
      resolve: () => original.key,
      active: () => ({ id: credentialKeyId(Buffer.alloc(32, 1)), key: Buffer.alloc(32, 1) }),
    };
    const other = open({ keyring: rotating });
    expect(other.get("web-search", WEB)?.value).toBe("v");
    expect(() => other.put("web-search", WEB, "w")).toThrow("Could not persist encrypted secrets.");
    expect(other.status().state).toBe("ready");
    expect(digest()).toBe(before);
  });

  it("resets only a locked or corrupt inventory, keeping the file aside", () => {
    const store = open();
    expect(() => store.reset()).toThrow("nothing to reset");
    store.put("web-search", WEB, SENTINEL);
    const before = digest();
    rmSync(keyPath);
    expect(store.status().state).toBe("locked");
    const reset = store.reset(new Date("2026-10-05T00:00:00Z"));
    expect(reset.archive).toMatch(/^host-credentials\.enc\.locked-20261005T000000Z-[0-9a-f]{8}$/);
    expect(reset.synced).toBe(true);
    expect(reset.status.state).toBe("empty");
    expect(
      createHash("sha256")
        .update(readFileSync(join(dir, reset.archive!)))
        .digest("hex"),
    ).toBe(before);
    expect(store.put("web-search", WEB, "re-entered").revision).toBe(1);
    chmodSync(keyPath, 0o644);
    const refused = open();
    expect(refused.status().state).toBe("refused");
    expect(() => refused.reset()).toThrow("unsafe");
    chmodSync(keyPath, 0o600);
  });

  it("reports a reset that found nothing to move, and one that could not move it", () => {
    writeFileSync(path, "VHC1 but garbage");
    const store = open();
    expect(store.status().state).toBe("corrupt");
    rmSync(path);
    expect(store.reset()).toMatchObject({
      archive: null,
      synced: true,
      status: { state: "empty" },
    });
    // A directory where the file should be: corrupt, and link(2) cannot move it.
    mkdirSync(path);
    const again = open();
    expect(again.status().state).toBe("corrupt");
    expect(() => again.reset()).toThrow(/^Could not set the saved credentials aside\.$/);
  });

  it("answers busy for that read alone, never stale ready, while another process holds the lock", async () => {
    const store = open();
    store.put("web-search", WEB, "v");
    expect(store.status().state).toBe("ready");
    const child = startChild({ kind: "hold", lock: join(dir, "host-credentials.lock") });
    const busy = { state: "locked", reason: "busy", unavailable: CREDENTIAL_FAMILIES };
    try {
      await child.next();
      expect(open().status()).toEqual(busy);
      expect(store.get("web-search", WEB)).toBeNull();
      // A store that was ready says busy, not ready, and its records and status agree.
      expect(store.status()).toEqual(busy);
      expect(store.snapshot("web-search")).toEqual({ records: [], status: busy });
      expect(store.list("web-search")).toEqual([]);
      expect(store.problem()).toContain("busy");
      expect(() => store.put("web-search", WEB, "w")).toThrow("busy");
      expect(() => store.reset()).toThrow("busy");
    } finally {
      child.process.kill("SIGKILL");
      await child.exited;
    }
    expect(open().get("web-search", WEB)?.value).toBe("v");
    // Never remembered.
    expect(store.snapshot("web-search")).toMatchObject({
      records: [{ selector: WEB }],
      status: { state: "ready" },
    });
  });

  it("never offers a reset over a lock file it cannot use, and says how to fix it", () => {
    const store = open();
    store.put("web-search", WEB, "v");
    const before = digest();
    const lock = join(dir, "host-credentials.lock");
    new CredentialLock(lock).close();
    rmSync(lock);
    mkdirSync(lock);
    const blocked = open();
    expect(blocked.status()).toEqual({
      state: "locked",
      reason: "lock-unusable",
      unavailable: CREDENTIAL_FAMILIES,
    });
    expect(blocked.problem()).toContain(lock);
    expect(() => blocked.reset()).toThrow("Fix the lock file");
    expect(digest()).toBe(before);
    rmSync(lock, { recursive: true });
    expect(blocked.unlock().state).toBe("ready");
  });
});

describe("SealedInventory across processes", { timeout: 30_000 }, () => {
  const command = (kind: string, extra: Record<string, unknown>) => ({
    kind,
    path,
    key: keyPath,
    family: "web-search",
    ...extra,
  });

  it("merges concurrent writers' records: no update is lost", async () => {
    const parent = open();
    parent.put("web-search", { provider: "parent" }, "p");
    const writers = [0, 1, 2, 3].map((n) =>
      startChild(
        command("put", {
          selectors: Array.from({ length: 10 }, (_, i) => ({ provider: `w${n}-${i}` })),
          value: `from-${n}`,
        }),
      ),
    );
    for (let i = 0; i < 10; i += 1) parent.put("web-search", { provider: `parent-${i}` }, "p");
    for (const writer of writers) expect(await writer.next()).toEqual({ status: "ready" });
    await Promise.all(writers.map((writer) => writer.exited));
    const providers = parent.list("web-search").map((record) => record.selector["provider"]);
    expect(providers).toHaveLength(51);
    expect(new Set(providers).size).toBe(51);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }, 30_000);

  it("sees another process's revocation on the next read, and theirs sees ours", async () => {
    const parent = open();
    parent.put("web-search", WEB, SENTINEL);
    expect(parent.get("web-search", WEB)?.value).toBe(SENTINEL);
    expect(await runChild(command("remove", { selector: WEB }))).toEqual({ removed: true });
    expect(parent.get("web-search", WEB)).toBeNull();
    parent.put("web-search", WEB, "second");
    const second = parent.get("web-search", WEB)!;
    expect(await runChild(command("get", { selector: WEB }))).toMatchObject({
      record: { value: "second", id: second.id, revision: second.revision },
    });
  });

  it("survives a writer killed at every step: old or new, never torn, then writable", async () => {
    const parent = open();
    parent.put("web-search", WEB, "old");
    for (const at of ["temporary-written", "temporary-synced", "renamed"] as const) {
      const child = startChild(
        command("crash", { selector: { provider: `crash-${at}` }, value: "new", at }),
      );
      expect((await child.exited).signal).toBe("SIGKILL");
      const committed = at === "renamed";
      expect(parent.get("web-search", { provider: `crash-${at}` })?.value ?? null).toBe(
        committed ? "new" : null,
      );
      expect(parent.get("web-search", WEB)?.value).toBe("old");
      // The dead writer's lock is gone, and its temporary is swept by the next write.
      parent.put("web-search", { provider: `after-${at}` }, "ok");
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
    expect(parent.status().state).toBe("ready");
  }, 30_000);
});
