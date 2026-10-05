/**
 * Step E for the web search keys (VC-643): the sealed mirror of `secrets`,
 * reconciled from it. SQLite stays the source; these tests hold the mirror to
 * "an exact copy, or honestly pending", across saves, clears, older-build
 * writes, restores, locked keys, full disks, crashes and other processes.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { migrate } from "../db/migrations";
import { deleteSecret, readSecret, writeSecret } from "../db/secrets-repo";
import { SecretKeyUnavailableError } from "../ports/secret-key";
import { SealedStoreNewerError } from "../secrets/credential-state";
import { CredentialLock, CredentialLockBusyError } from "../secrets/credential-lock";
import {
  SealedFileChangedError,
  SealedFileIndeterminateError,
  type PublishStep,
} from "../secrets/durable-file";
import { fileCredentialKeyring } from "../secrets/file-key";
import { CREDENTIAL_INVENTORY_FILE_NAME, SealedInventory } from "../secrets/inventory";
import { SealedFileUnverifiedError, SealedStoreCorruptError } from "../secrets/sealed-document";
import { runChild, startChild } from "../secrets/test-support/processes";
import { BRAVE_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_SECRET, WebCredentialStore } from "./credential";
import { describeWebSealing, WebCredentialMirror, type WebMirrorResult } from "./credential-mirror";
import { WebAccessSettings } from "./settings";

const faults = {
  write: null as ((fd: number, data: unknown) => void) | null,
  fsync: null as ((fd: number) => void) | null,
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (typeof args[0] === "number") faults.write?.(args[0], args[1]);
      return actual.writeFileSync(...args);
    },
    fsyncSync: (fd: number) => {
      faults.fsync?.(fd);
      return actual.fsyncSync(fd);
    },
  };
});

const CHILD = new URL("./test-support/web-key-child.ts", import.meta.url).pathname;
const values = (tag: string) => Array.from({ length: 8 }, (_, i) => `BSA-${tag}-${i}`);
const BRAVE = "BSA-brave-sentinel-0123456789";
const EXA = "exa-sentinel-9876543210";

let dir: string;
let dbPath: string;
let keyPath: string;
let inventoryPath: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-web-mirror-"));
  dbPath = join(dir, "volli.db");
  keyPath = join(dir, "session-secrets.key");
  inventoryPath = join(dir, CREDENTIAL_INVENTORY_FILE_NAME);
  db = openDb();
});
afterEach(() => {
  faults.write = null;
  faults.fsync = null;
  db.close();
  new CredentialLock(join(dir, "host-credentials.lock")).close();
  rmSync(dir, { recursive: true, force: true });
});

function openDb(path = dbPath): Database.Database {
  const handle = new Database(path);
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  migrate(handle, path);
  return handle;
}

/** One launch's web stack, as `createWebAccess` builds it, over a file keyring. */
function launch(
  options: { keyring?: boolean; results?: WebMirrorResult[]; handle?: Database.Database } = {},
) {
  const handle = options.handle ?? db;
  const stores = {
    brave: new WebCredentialStore({ db: handle, secretName: BRAVE_SEARCH_KEY_SECRET }),
    exa: new WebCredentialStore({ db: handle, secretName: EXA_SEARCH_KEY_SECRET }),
  };
  const mirror = new WebCredentialMirror({
    db: handle,
    inventory:
      options.keyring === false
        ? null
        : new SealedInventory({
            path: inventoryPath,
            keyring: fileCredentialKeyring({ path: keyPath }),
            families: ["web-search"],
          }),
    onResult: (result) => options.results?.push(result),
  });
  const settings = new WebAccessSettings({ db: handle, credentials: stores, mirror });
  return { settings, mirror, stores };
}

/** What the sealed file holds for web search, opened fresh: provider → value. */
function sealed(): Record<string, string> {
  const inventory = new SealedInventory({
    path: inventoryPath,
    keyring: fileCredentialKeyring({ path: keyPath }),
  });
  const held: Record<string, string> = {};
  for (const record of inventory.list("web-search")) {
    const provider = record.selector["provider"]!;
    held[provider] = inventory.get("web-search", { provider })!.value as string;
  }
  return held;
}

/** What `secrets` holds: provider → value. */
function source(handle: Database.Database = db): Record<string, string> {
  const held: Record<string, string> = {};
  for (const [name, provider] of [
    [BRAVE_SEARCH_KEY_SECRET, "brave"],
    [EXA_SEARCH_KEY_SECRET, "exa"],
  ] as const) {
    const value = readSecret(handle, name);
    if (value !== null) held[provider] = value;
  }
  return held;
}

const revision = (handle: Database.Database = db) =>
  (handle.prepare("SELECT revision FROM web_credential_source").get() as { revision: number })
    .revision;

describe("the web keys' sealed mirror (step E)", { timeout: 60_000 }, () => {
  it("seals nothing and makes no key on a profile with no keys", async () => {
    const results: WebMirrorResult[] = [];
    const { settings } = launch({ results });
    expect(settings.view().sealing).toBe("pending");
    expect(await settings.reconcileSealing()).toEqual({
      sealing: "none",
      written: false,
      keys: 0,
      revision: 0,
    });
    expect(results).toHaveLength(1);
    expect(existsSync(inventoryPath)).toBe(false);
    expect(existsSync(keyPath)).toBe(false);
    expect(settings.view().sealing).toBe("none");
    expect(db.prepare("SELECT inventory_id, generation FROM web_credential_mirror").get()).toEqual({
      inventory_id: null,
      generation: null,
    });
  });

  it("commits a save to SQLite first, then seals a verified copy", () => {
    const results: WebMirrorResult[] = [];
    const { settings } = launch({ results });
    settings.setProvider({ provider: "brave", searxngUrl: null });
    const view = settings.saveKey("brave", `  ${BRAVE}\n`);
    expect(view.sealing).toBe("sealed");
    expect(settings.resolve()).toEqual({ configured: true, provider: "brave", apiKey: BRAVE });
    expect(source()).toEqual({ brave: BRAVE });
    expect(sealed()).toEqual({ brave: BRAVE });
    expect(results).toEqual([{ sealing: "sealed", written: true, keys: 1, revision: 1 }]);
    const receipt = db.prepare("SELECT * FROM web_credential_mirror").get() as Record<
      string,
      unknown
    >;
    expect(receipt).toMatchObject({ source_revision: 1, generation: 1 });
    expect(receipt["inventory_id"]).toMatch(/^[0-9a-f-]{36}$/);
    // Sealed: the value is not in the file's bytes.
    expect(readFileSync(inventoryPath).includes(Buffer.from(BRAVE))).toBe(false);
    // Nothing logged names the key.
    expect(results.map(describeWebSealing).join("\n")).not.toContain(BRAVE);
  });

  it("drops a cleared key from the mirror, and keeps the other", () => {
    const { settings } = launch();
    settings.saveKey("brave", BRAVE);
    settings.saveKey("exa", EXA);
    expect(sealed()).toEqual({ brave: BRAVE, exa: EXA });
    expect(settings.clearKey("brave").sealing).toBe("sealed");
    expect(sealed()).toEqual({ exa: EXA });
    expect(settings.clearKey("exa").sealing).toBe("none");
    expect(sealed()).toEqual({});
    expect(readFileSync(inventoryPath).includes(Buffer.from(EXA))).toBe(false);
  });

  it("reports saved; sealing pending when the key is locked, and the save stands", () => {
    const results: WebMirrorResult[] = [];
    launch().settings.saveKey("brave", BRAVE);
    const bytes = readFileSync(inventoryPath);
    renameSync(keyPath, `${keyPath}.away`);
    const { settings } = launch({ results });
    settings.setProvider({ provider: "brave", searxngUrl: null });
    const view = settings.saveKey("brave", "BSA-replacement-key");
    expect(view.sealing).toBe("pending");
    expect(settings.resolve()).toMatchObject({ apiKey: "BSA-replacement-key" });
    expect(results.at(-1)).toEqual({ sealing: "pending", reason: "locked", detail: "missing" });
    expect(describeWebSealing(results.at(-1)!)).toBe(
      "held in the profile database (legacy mode, not encrypted); sealed copy pending (locked: missing)",
    );
    // Never re-keyed, never sealed over: the file is byte-identical.
    expect(readFileSync(inventoryPath)).toEqual(bytes);
    expect(existsSync(keyPath)).toBe(false);
    // The key comes back; the next launch reconciles to the source.
    renameSync(`${keyPath}.away`, keyPath);
    expect(launch().mirror.reconcile()).toMatchObject({ sealing: "sealed", written: true });
    expect(sealed()).toEqual({ brave: "BSA-replacement-key" });
  });

  it("never brings a cleared key back from a stale mirror", () => {
    launch().settings.saveKey("brave", BRAVE);
    // Sealing goes pending (key away) while the key is cleared, here and by
    // an older build's own statement.
    renameSync(keyPath, `${keyPath}.away`);
    const { settings } = launch();
    settings.setProvider({ provider: "brave", searxngUrl: null });
    expect(settings.clearKey("brave").sealing).toBe("pending");
    expect(settings.resolve()).toEqual({ configured: false, reason: "no-key" });
    writeSecret(db, EXA_SEARCH_KEY_SECRET, EXA, 1);
    deleteSecret(db, EXA_SEARCH_KEY_SECRET);
    // The stale mirror still holds the key; nothing ever reads it back.
    renameSync(`${keyPath}.away`, keyPath);
    expect(sealed()).toEqual({ brave: BRAVE });
    expect(launch().settings.resolve()).toEqual({ configured: false, reason: "no-key" });
    expect(source()).toEqual({});
    // The next launch drops it from the mirror.
    expect(launch().mirror.reconcile()).toMatchObject({ sealing: "none", written: true });
    expect(sealed()).toEqual({});
    expect(source()).toEqual({});
  });

  it("notices an older build's saves and clears by revision, and reconciles them", () => {
    const { settings } = launch();
    settings.saveKey("brave", BRAVE);
    // The release before this one writes with its own statements.
    writeSecret(db, EXA_SEARCH_KEY_SECRET, EXA, 2);
    deleteSecret(db, BRAVE_SEARCH_KEY_SECRET);
    expect(settings.view().sealing).toBe("pending");
    expect(launch().mirror.reconcile()).toMatchObject({ sealing: "sealed", written: true });
    expect(sealed()).toEqual({ exa: EXA });
    expect(settings.view().sealing).toBe("sealed");
  });

  it("compares contents, never trusting a receipt alone", () => {
    const { settings, mirror } = launch();
    settings.saveKey("brave", BRAVE);
    const at = revision();
    // A raw copy of this database restored and written once more can reach
    // the same revision with different contents.
    db.prepare("UPDATE secrets SET value = ? WHERE name = ?").run(
      "BSA-other",
      BRAVE_SEARCH_KEY_SECRET,
    );
    db.prepare("UPDATE web_credential_source SET revision = ?").run(at);
    expect(mirror.reconcile()).toMatchObject({ sealing: "sealed", written: true });
    expect(sealed()).toEqual({ brave: "BSA-other" });
  });

  it("restores a backup missing every credential without merging the mirror back", () => {
    const { settings } = launch();
    settings.saveKey("brave", BRAVE);
    settings.saveKey("exa", EXA);
    // A restore migrates a fresh database (bundles carry no keys and no
    // source row): a new lineage at revision 0, in the same profile beside
    // the stale mirror, which the restore leaves where it is.
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    db = openDb();
    const restored = launch();
    expect(restored.settings.view()).toMatchObject({
      keys: { brave: "absent", exa: "absent" },
      sealing: "pending",
    });
    expect(restored.mirror.reconcile()).toMatchObject({ sealing: "none", written: true, keys: 0 });
    expect(sealed()).toEqual({});
    expect(source()).toEqual({});
    expect(restored.settings.view().sealing).toBe("none");
  });

  it("tries the lock once on a save, then retries in the background while it is held", async () => {
    const results: WebMirrorResult[] = [];
    const { settings } = launch({ results });
    const lock = new CredentialLock(join(dir, "host-credentials.lock"));
    let view: ReturnType<WebAccessSettings["saveKey"]> | undefined;
    await lock.with(async () => {
      view = settings.saveKey("brave", BRAVE);
    });
    expect(view!.sealing).toBe("pending");
    expect(results[0]).toEqual({ sealing: "pending", reason: "busy" });
    // The retry the save scheduled; a reconcile now joins it.
    expect(await settings.reconcileSealing()).toMatchObject({ sealing: "sealed" });
    expect(sealed()).toEqual({ brave: BRAVE });
    expect(settings.view().sealing).toBe("sealed");
  });

  it("joins reconciles that arrive while one runs, and gives up busy after its deadline", async () => {
    const results: WebMirrorResult[] = [];
    const { mirror, stores } = launch({ results });
    stores.brave.save(BRAVE);
    const first = mirror.reconcileSoon();
    const second = mirror.reconcileSoon();
    expect(second).toBe(first);
    await first;
    // One run, then one more for the call that arrived while it ran.
    expect(results).toHaveLength(2);
    const lock = new CredentialLock(join(dir, "host-credentials.lock"));
    stores.brave.save("BSA-later");
    await lock.with(async () => {
      expect(await mirror.reconcileSoon(30)).toEqual({ sealing: "pending", reason: "busy" });
    });
    expect(sealed()).toEqual({ brave: BRAVE });
  });

  it("stays pending without a key backend, never claiming a seal", async () => {
    const results: WebMirrorResult[] = [];
    const { settings } = launch({ keyring: false, results });
    expect(settings.saveKey("brave", BRAVE).sealing).toBe("pending");
    expect(await settings.reconcileSealing()).toEqual({ sealing: "pending", reason: "no-keyring" });
    expect(describeWebSealing(results[0]!)).toContain("(no-keyring)");
    expect(existsSync(inventoryPath)).toBe(false);
    const bare = new WebAccessSettings({
      db,
      credentials: launch().stores,
    });
    expect(await bare.reconcileSealing()).toBeNull();
  });

  it("is pending on a database without a source row or that fails to read, never throwing", () => {
    const { mirror, settings } = launch();
    db.exec("DELETE FROM web_credential_source");
    expect(mirror.reconcile()).toEqual({ sealing: "pending", reason: "no-source" });
    expect(settings.view().sealing).toBe("pending");
    const other = openDb(join(dir, "other.db"));
    const broken = launch({ handle: other });
    other.close();
    expect(broken.mirror.reconcile()).toEqual({ sealing: "pending", reason: "failed" });
    expect(broken.mirror.sealing()).toBe("pending");
  });

  it("is pending on a full disk or a failed fsync, leaving the old file, then recovers", () => {
    const { settings, mirror } = launch();
    settings.saveKey("brave", BRAVE);
    const bytes = readFileSync(inventoryPath);
    faults.write = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    expect(settings.saveKey("brave", "BSA-disk-full").sealing).toBe("pending");
    expect(readFileSync(inventoryPath)).toEqual(bytes);
    expect(source()).toEqual({ brave: "BSA-disk-full" });
    faults.write = null;
    let fsyncs = 0;
    faults.fsync = () => {
      fsyncs += 1;
      if (fsyncs === 1) throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    expect(mirror.reconcile()).toEqual({ sealing: "pending", reason: "failed" });
    expect(readFileSync(inventoryPath)).toEqual(bytes);
    faults.fsync = null;
    expect(mirror.reconcile()).toMatchObject({ sealing: "sealed", written: true });
    expect(sealed()).toEqual({ brave: "BSA-disk-full" });
  });

  it("is indeterminate when the directory will not sync, and current on the next read", () => {
    const { settings, mirror } = launch();
    settings.saveKey("brave", BRAVE);
    // The temporary's fsync succeeds; the directory's (the second) fails.
    let fsyncs = 0;
    faults.fsync = () => {
      fsyncs += 1;
      if (fsyncs === 2) throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    expect(settings.saveKey("brave", "BSA-indeterminate").sealing).toBe("pending");
    faults.fsync = null;
    // Renamed in before the failed sync: read again, it is the source, so
    // nothing is written twice and the receipt is recorded.
    expect(mirror.reconcile()).toMatchObject({ sealing: "sealed", written: false });
    expect(sealed()).toEqual({ brave: "BSA-indeterminate" });
  });

  it("leaves a corrupt inventory byte-identical and pending", () => {
    launch().settings.saveKey("brave", BRAVE);
    const bytes = readFileSync(inventoryPath);
    const junk = Buffer.concat([bytes.subarray(0, 21), Buffer.alloc(40, 7)]);
    writeFileSync(inventoryPath, junk);
    const { settings } = launch();
    expect(settings.saveKey("brave", "BSA-after-corrupt").sealing).toBe("pending");
    expect(readFileSync(inventoryPath)).toEqual(junk);
    expect(source()).toEqual({ brave: "BSA-after-corrupt" });
  });

  it("names each failure with a code, never a message", () => {
    const failing = (error: Error) =>
      new WebCredentialMirror({
        db,
        inventory: {
          mirror: () => {
            throw error;
          },
        } as unknown as SealedInventory,
      }).reconcile();
    expect(failing(new CredentialLockBusyError())).toEqual({ sealing: "pending", reason: "busy" });
    expect(failing(new SealedFileChangedError())).toEqual({
      sealing: "pending",
      reason: "changed",
    });
    expect(failing(new SealedFileIndeterminateError())).toEqual({
      sealing: "pending",
      reason: "indeterminate",
    });
    expect(failing(new SealedFileUnverifiedError())).toEqual({
      sealing: "pending",
      reason: "unverified",
    });
    expect(failing(new SecretKeyUnavailableError("too-open", "/k is too open"))).toEqual({
      sealing: "pending",
      reason: "refused",
      detail: "too-open",
    });
    expect(failing(new SealedStoreNewerError())).toEqual({
      sealing: "pending",
      reason: "locked",
      detail: "newer-format",
    });
    expect(failing(new SealedStoreCorruptError())).toEqual({
      sealing: "pending",
      reason: "corrupt",
      detail: null,
    });
    expect(describeWebSealing({ sealing: "pending", reason: "corrupt", detail: null })).toContain(
      "(corrupt)",
    );
    expect(describeWebSealing({ sealing: "sealed", written: false, keys: 2, revision: 4 })).toBe(
      "2 saved in the profile database; sealed copy current (revision 4)",
    );
    expect(describeWebSealing({ sealing: "none", written: true, keys: 0, revision: 5 })).toBe(
      "none saved; sealed copy written and verified (revision 5)",
    );
  });
});

describe("the web keys' sealed mirror across processes", { timeout: 120_000 }, () => {
  const child = { script: CHILD, transformTypes: true };

  it("converges on the last commit when two processes and this one save at once", async () => {
    const [a, b] = await Promise.all([
      runChild({ kind: "churn", dbPath, keyPath, provider: "brave", values: values("a") }, child),
      runChild({ kind: "churn", dbPath, keyPath, provider: "exa", values: values("b") }, child),
      (async () => {
        const { settings } = launch();
        for (const value of values("c")) {
          settings.saveKey("brave", value);
          await new Promise((settle) => setTimeout(settle, 5));
        }
        await settings.reconcileSealing();
      })(),
    ]);
    expect(a).toMatchObject({ saves: 8 });
    expect(b).toMatchObject({ saves: 8 });
    // Every writer reconciled after its own last commit: the mirror is the source.
    expect(sealed()).toEqual(source());
    expect(Object.keys(source()).toSorted()).toEqual(["brave", "exa"]);
    expect(launch().settings.view().sealing).toBe("sealed");
  });

  const steps: Array<PublishStep | "sql-committed"> = [
    "sql-committed",
    "temporary-written",
    "temporary-synced",
    "renamed",
    "directory-synced",
  ];

  it.each(steps)("survives a crash at %s: old or new, never torn, then reconciled", async (at) => {
    launch().settings.saveKey("brave", BRAVE);
    launch().settings.saveKey("exa", EXA);
    for (const value of ["BSA-after-crash", null]) {
      const before = sealed();
      const running = startChild(
        { kind: "crash", dbPath, keyPath, provider: "brave", value, at },
        child,
      );
      expect(await running.exited).toMatchObject({ signal: "SIGKILL" });
      // SQLite committed first; the mirror is either the old copy or the new.
      const expected = value === null ? { exa: EXA } : { brave: value, exa: EXA };
      expect(source()).toEqual(expected);
      const now = sealed();
      expect([JSON.stringify(before), JSON.stringify(expected)]).toContain(JSON.stringify(now));
      // The next launch reconciles from SQLite, whatever the crash left.
      const result = launch().mirror.reconcile();
      expect(result.sealing).toBe("sealed");
      expect(sealed()).toEqual(expected);
      expect(launch().settings.view().sealing).toBe("sealed");
    }
  });
});
