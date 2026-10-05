/**
 * The typed inventory as a mirror of a canonical source kept elsewhere
 * (VC-643, step E): `SealedInventory.mirror` and the receipts it keeps.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { CredentialKeyring } from "../ports/credential-keyring";
import { CredentialLock, CredentialLockBusyError } from "./credential-lock";
import { SealedFileChangedError } from "./durable-file";
import { fileCredentialKeyring } from "./file-key";
import {
  CREDENTIAL_INVENTORY_FILE_NAME,
  SealedInventory,
  type MirrorEntry,
  type MirrorSnapshot,
} from "./inventory";
import { SealedFileUnverifiedError } from "./sealed-document";
import { openEnvelope, envelopeHeader, sealEnvelope } from "./sealed-envelope";

let dir: string;
let path: string;
let keyPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-inventory-mirror-"));
  path = join(dir, CREDENTIAL_INVENTORY_FILE_NAME);
  keyPath = join(dir, "session-secrets.key");
});
afterEach(() => {
  new CredentialLock(join(dir, "host-credentials.lock")).close();
  rmSync(dir, { recursive: true, force: true });
});

const SOURCE = "0123456789abcdef0123456789abcdef";
const BRAVE = "brave-sentinel-value-1";
const EXA = "exa-sentinel-value-2";

function open(options: Partial<ConstructorParameters<typeof SealedInventory>[0]> = {}) {
  return new SealedInventory({
    path,
    keyring: fileCredentialKeyring({ path: keyPath }),
    ...options,
  });
}

function snapshot(revision: number, entries: Record<string, string>): MirrorSnapshot {
  return {
    entries: Object.entries(entries).map(([provider, value]): MirrorEntry => ({
      selector: { provider },
      value,
    })),
    receipt: { source: SOURCE, revision },
  };
}

/** The decrypted plaintext of the file, for checking what was sealed. */
function plaintext(keyring: CredentialKeyring = fileCredentialKeyring({ path: keyPath })) {
  const bytes = readFileSync(path);
  return JSON.parse(openEnvelope(bytes, keyring.resolve(envelopeHeader(bytes).keyId))) as {
    receipts?: Record<string, unknown>;
    records: Array<{ id: string; family: string; revision: number; value: unknown }>;
    generation: number;
    inventory: string;
  };
}

describe("SealedInventory.mirror", { timeout: 30_000 }, () => {
  it("writes nothing and makes no key for an empty source with no file", () => {
    const outcome = open().mirror("web-search", () => snapshot(0, {}));
    expect(outcome).toEqual({
      kind: "current",
      receipt: { source: SOURCE, revision: 0 },
      inventory: null,
      generation: null,
      records: 0,
    });
    expect(() => readFileSync(path)).toThrow();
    expect(() => readFileSync(keyPath)).toThrow();
  });

  it("seals the source with a receipt, verified, and writes nothing when it is current", () => {
    const inventory = open();
    const sealed = inventory.mirror("web-search", () => snapshot(3, { brave: BRAVE, exa: EXA }));
    expect(sealed).toMatchObject({ kind: "sealed", records: 2, generation: 1 });
    expect(sealed.inventory).toMatch(/^[0-9a-f-]{36}$/);
    const file = plaintext();
    expect(file.receipts).toEqual({ "web-search": { source: SOURCE, revision: 3 } });
    expect(inventory.get("web-search", { provider: "brave" })?.value).toBe(BRAVE);
    const bytes = readFileSync(path);
    const again = open().mirror("web-search", () => snapshot(3, { exa: EXA, brave: BRAVE }));
    expect(again).toEqual({ ...sealed, kind: "current" });
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("drops cleared rows, so a stale mirror never keeps a cleared key", () => {
    const inventory = open();
    inventory.mirror("web-search", () => snapshot(1, { brave: BRAVE, exa: EXA }));
    const cleared = inventory.mirror("web-search", () => snapshot(2, { exa: EXA }));
    expect(cleared).toMatchObject({ kind: "sealed", records: 1 });
    expect(inventory.get("web-search", { provider: "brave" })).toBeNull();
    expect(readFileSync(path).includes(Buffer.from(BRAVE))).toBe(false);
    expect(JSON.stringify(plaintext())).not.toContain(BRAVE);
    // Everything gone: the file stays, holding no web record.
    expect(inventory.mirror("web-search", () => snapshot(3, {}))).toMatchObject({
      kind: "sealed",
      records: 0,
    });
    expect(inventory.list("web-search")).toEqual([]);
  });

  it("keeps an unchanged record's identity, a changed one's id, and other families alone", () => {
    const inventory = open();
    inventory.put("mcp", { serverId: "s", endpoint: "https://e" }, { token: "t" });
    inventory.mirror("web-search", () => snapshot(1, { brave: BRAVE, exa: EXA }));
    const [brave1, exa1] = ["brave", "exa"].map((provider) =>
      inventory.list("web-search").find((r) => r.selector["provider"] === provider)!,
    );
    inventory.mirror("web-search", () => snapshot(2, { brave: BRAVE, exa: "exa-replaced" }));
    const after = inventory.list("web-search");
    const brave2 = after.find((r) => r.selector["provider"] === "brave")!;
    const exa2 = after.find((r) => r.selector["provider"] === "exa")!;
    expect(brave2).toEqual(brave1);
    expect(exa2.id).toBe(exa1!.id);
    expect(exa2.revision).toBeGreaterThan(exa1!.revision);
    expect(inventory.get("mcp", { serverId: "s", endpoint: "https://e" })?.value).toEqual({
      token: "t",
    });
    // Same contents, new source revision: only the receipt moves.
    const moved = inventory.mirror("web-search", () =>
      snapshot(9, { brave: BRAVE, exa: "exa-replaced" }),
    );
    expect(moved.kind).toBe("sealed");
    expect(inventory.list("web-search")).toEqual(after);
    expect(plaintext().receipts?.["web-search"]).toEqual({ source: SOURCE, revision: 9 });
  });

  it("compares object values by content for families that hold records", () => {
    const inventory = open();
    const entry = (token: string): MirrorSnapshot => ({
      entries: [{ selector: { provider: "p" }, value: { token } }],
      receipt: { source: SOURCE, revision: 1 },
    });
    expect(inventory.mirror("pi-provider", () => entry("a")).kind).toBe("sealed");
    expect(inventory.mirror("pi-provider", () => entry("a")).kind).toBe("current");
    expect(inventory.mirror("pi-provider", () => entry("b")).kind).toBe("sealed");
  });

  it("drops a family's receipt when the family is changed directly", () => {
    const inventory = open();
    inventory.mirror("web-search", () => snapshot(1, { brave: BRAVE }));
    inventory.put("mcp", { serverId: "s", endpoint: "https://e" }, { token: "t" });
    expect(plaintext().receipts).toEqual({ "web-search": { source: SOURCE, revision: 1 } });
    inventory.put("web-search", { provider: "exa" }, EXA);
    expect(plaintext().receipts).toBeUndefined();
    inventory.mirror("web-search", () => snapshot(2, { brave: BRAVE }));
    expect(inventory.remove("web-search", { provider: "brave" })).toBe(true);
    expect(plaintext().receipts).toBeUndefined();
    // A source with the same contents after a direct change is resealed: no receipt matched.
    expect(inventory.mirror("web-search", () => snapshot(2, {})).kind).toBe("sealed");
  });

  it("refuses an invalid source entry and writes nothing", () => {
    const inventory = open();
    expect(() =>
      inventory.mirror("web-search", () => ({
        entries: [{ selector: { provider: "brave" }, value: "" }],
        receipt: { source: SOURCE, revision: 1 },
      })),
    ).toThrow(/^Invalid credential\.$/);
    expect(() =>
      inventory.mirror("web-search", () => ({
        entries: [{ selector: { nope: "x" }, value: "v" }],
        receipt: { source: SOURCE, revision: 1 },
      })),
    ).toThrow(/^Invalid credential\.$/);
    expect(() =>
      inventory.mirror("web-search", () => ({
        entries: [
          { selector: { provider: "brave" }, value: "a" },
          { selector: { provider: "brave" }, value: "b" },
        ],
        receipt: { source: SOURCE, revision: 1 },
      })),
    ).toThrow(/^Invalid credential\.$/);
    for (const receipt of [
      { source: "not-hex", revision: 1 },
      { source: SOURCE, revision: -1 },
    ]) {
      expect(() =>
        inventory.mirror("web-search", () => ({
          entries: [{ selector: { provider: "brave" }, value: "v" }],
          receipt,
        })),
      ).toThrow(/^Invalid credential\.$/);
    }
    expect(() => readFileSync(path)).toThrow();
  });

  it("reads the source under the lock, and a failing read writes nothing", () => {
    const inventory = open();
    const lock = new CredentialLock(join(dir, "host-credentials.lock"));
    let heldWhileReading: boolean | undefined;
    inventory.mirror("web-search", () => {
      try {
        lock.withSync(() => {});
        heldWhileReading = false;
      } catch (error) {
        heldWhileReading = error instanceof CredentialLockBusyError;
      }
      return snapshot(1, { brave: BRAVE });
    });
    expect(heldWhileReading).toBe(true);
    const bytes = readFileSync(path);
    expect(() =>
      inventory.mirror("web-search", () => {
        throw new Error("source unreadable");
      }),
    ).toThrow("source unreadable");
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("never waits: refuses at once while the lock is held, and stays usable", () => {
    const inventory = open();
    const lock = new CredentialLock(join(dir, "host-credentials.lock"));
    lock.withSync(() => {
      expect(() => inventory.mirror("web-search", () => snapshot(1, { brave: BRAVE }))).toThrow(
        CredentialLockBusyError,
      );
    });
    expect(inventory.mirror("web-search", () => snapshot(1, { brave: BRAVE })).kind).toBe("sealed");
  });

  it("is unverified when the file does not read back as the source", () => {
    const inventory = open({
      document: {
        step: (at) => {
          // A writer that ignores the lock replaces the file right after the rename.
          if (at === "directory-synced") {
            const bytes = readFileSync(path);
            const key = fileCredentialKeyring({ path: keyPath });
            const file = JSON.parse(openEnvelope(bytes, key.resolve(envelopeHeader(bytes).keyId)));
            file.receipts["web-search"].revision = 99;
            writeFileSync(path, sealEnvelope("file", key.active(), JSON.stringify(file)));
          }
        },
      },
    });
    expect(() => inventory.mirror("web-search", () => snapshot(1, { brave: BRAVE }))).toThrow(
      SealedFileUnverifiedError,
    );
    // Read again before trusting anything: the next mirror sees the file as it is.
    expect(open().mirror("web-search", () => snapshot(1, { brave: BRAVE })).kind).toBe("sealed");
  });

  it("refuses to seal over a file changed outside the lock", () => {
    const inventory = open();
    inventory.mirror("web-search", () => snapshot(1, { brave: BRAVE }));
    expect(() =>
      inventory.mirror("web-search", () => {
        writeFileSync(path, readFileSync(path).subarray(0, 40));
        return snapshot(2, {});
      }),
    ).toThrow(SealedFileChangedError);
  });

  it("is refused while the inventory is locked, leaving the file byte-identical", () => {
    open().mirror("web-search", () => snapshot(1, { brave: BRAVE }));
    const bytes = readFileSync(path);
    rmSync(keyPath);
    const locked = open();
    let reads = 0;
    expect(() =>
      locked.mirror("web-search", () => {
        reads += 1;
        return snapshot(2, {});
      }),
    ).toThrow(/missing/);
    expect(locked.status()).toMatchObject({ state: "locked", reason: "missing" });
    // Remembered: asked once per unlock.
    expect(() => locked.mirror("web-search", () => snapshot(2, {}))).toThrow(/missing/);
    expect(reads).toBe(0);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("treats a malformed receipt as a corrupt inventory, never as no receipt", () => {
    const inventory = open();
    inventory.mirror("web-search", () => snapshot(1, { brave: BRAVE }));
    const key = fileCredentialKeyring({ path: keyPath });
    const bytes = readFileSync(path);
    const file = JSON.parse(openEnvelope(bytes, key.resolve(envelopeHeader(bytes).keyId)));
    for (const receipts of [
      null,
      [],
      { "web-search": null },
      { "web-search": [] },
      { nope: { source: SOURCE, revision: 1 } },
      { "web-search": { source: "short", revision: 1 } },
      { "web-search": { source: SOURCE, revision: -1 } },
      { "web-search": { source: SOURCE, revision: 1.5 } },
      { "web-search": { source: SOURCE, revision: 1, extra: true } },
    ]) {
      writeFileSync(
        path,
        sealEnvelope("file", key.active(), JSON.stringify({ ...file, receipts })),
      );
      expect(open().status().state, JSON.stringify(receipts)).toBe("corrupt");
    }
    writeFileSync(
      path,
      sealEnvelope("file", key.active(), JSON.stringify({ ...file, receipts: {} })),
    );
    expect(open().status().state).toBe("ready");
  });
});
