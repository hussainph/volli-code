/**
 * N-1 compatibility of step E for the web search keys (VC-643;
 * `docs/plans/sealed-credential-store.md` §4, "Downgrade contract and tests").
 *
 * External users run releases cut from main, so the release before this one
 * (N-1) must keep working on a profile this build migrated and mirrored:
 * open it, save, clear and attach with its keys, make a backup bundle and
 * restore one. Then this build must reconcile whatever N-1 left, from
 * `secrets`, and never bring back a key N-1 cleared.
 *
 * N-1 runs as a separate `node` process (`test-support/n1-child.ts`) whose
 * resolve hook (`n1-hooks.mjs`) swaps in main's exact copy of every host-core
 * file this ticket changed (`test-support/n1/`, main at `b1f92b52d`): its
 * migrations (schema head 58), backup decisions, Web Access settings and the
 * secrets module those import. The first test proves the copies are
 * byte-identical to main by git blob id, and that the child loaded no other
 * file this ticket changed, so this is the shipped code, not a
 * re-implementation. (Every other file the child loads was byte-identical to
 * main when this was written; a later change to one of them is that change's
 * own N-1 question.)
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createBackupBundle, readBackupBundle } from "../backup/bundle";
import { restoreBackupBundle } from "../backup/restore";
import { migrate, SCHEMA_HEAD } from "../db/migrations";
import { readMinReaderVersion } from "../db/schema-compatibility";
import { CredentialLock } from "../secrets/credential-lock";
import { CREDENTIAL_INVENTORY_FILE_NAME, SealedInventory } from "../secrets/inventory";
import {
  CREDENTIAL_KEYCHAIN_KEY_FILE_NAME,
  keychainCredentialKeyring,
  type CredentialKeychain,
} from "../secrets/keychain-keyring";
import { BRAVE_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_SECRET, WebCredentialStore } from "./credential";
import { WebCredentialMirror } from "./credential-mirror";
import { WebAccessSettings } from "./settings";

/** main's blob ids at `b1f92b52d`, as `git rev-parse b1f92b52d:packages/host-core/src/<path>` prints them. */
const MAIN_BLOBS: Readonly<Record<string, string>> = {
  "backup/decisions.ts": "3bee0329d2db6e95869d71657fd4f00d25f6724e",
  "db/migrations.ts": "c69d9ccfec7af8b72d79f4ea5a8e89793709a223",
  "secrets/index.ts": "bacebc68ca1d859ee5763f472c8d0b05bae3c3b9",
  "secrets/inventory.ts": "4f69c6f66f3301c0dd75f8a797169f9c599a0211",
  "secrets/sealed-document.ts": "aac9492e633f2e8c04e6be87bb32623f2d20d389",
  "web/settings.ts": "99135b1b759c1e6357e92effe0cb1bef8d4025bc",
};

/** Every host-core source file this ticket adds or changes. None may run unpinned as N-1. */
const CHANGED_BY_VC_643 = new Set([
  ...Object.keys(MAIN_BLOBS),
  "db/web-credential-migration.ts",
  "runtime-services.ts",
  "secrets/keychain-keyring.ts",
  "web/credential-mirror.ts",
]);

const HOOKS = new URL("./test-support/n1-hooks.mjs", import.meta.url).href;
const CHILD = new URL("./test-support/n1-child.ts", import.meta.url).pathname;
const BRAVE = "BSA-n1-brave-sentinel-0123";
const EXA = "exa-n1-sentinel-4567";

function gitBlobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

interface N1Run {
  results: unknown[];
  loaded: string[];
}

/** Runs N-1's steps against `dbPath` in its own process; answers its last line. */
function n1(dbPath: string, steps: unknown[]): Promise<N1Run> {
  return new Promise((settle, refuse) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-transform-types",
        "--import",
        HOOKS,
        CHILD,
        JSON.stringify({ dbPath, steps }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) => {
      if (code !== 0) return refuse(new Error(`N-1 exited ${code}: ${stderr}`));
      const last = stdout.trim().split("\n").at(-1)!;
      settle(JSON.parse(last) as N1Run);
    });
  });
}

/** Electron's safeStorage, as the desktop keyring sees it: a reversible stand-in. */
const keychain: CredentialKeychain = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`wrapped:${value}`),
  decryptString: (value) => value.toString().slice("wrapped:".length),
};

let root: string;
let dbPath: string;
const scratch: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volli-web-n1-"));
  scratch.push(root);
  dbPath = join(root, "volli.db");
});
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    new CredentialLock(join(dir, "host-credentials.lock")).close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function openDb(path = dbPath): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db, path);
  return db;
}

/** This build's web stack over `profile`, sealed with the desktop keychain keyring. */
function current(db: Database.Database, profile = root) {
  const mirror = new WebCredentialMirror({
    db,
    inventory: new SealedInventory({
      path: join(profile, CREDENTIAL_INVENTORY_FILE_NAME),
      keyring: keychainCredentialKeyring({
        path: join(profile, CREDENTIAL_KEYCHAIN_KEY_FILE_NAME),
        keychain,
      }),
      families: ["web-search"],
    }),
  });
  const settings = new WebAccessSettings({
    db,
    credentials: {
      brave: new WebCredentialStore({ db, secretName: BRAVE_SEARCH_KEY_SECRET }),
      exa: new WebCredentialStore({ db, secretName: EXA_SEARCH_KEY_SECRET }),
    },
    mirror,
  });
  return { settings, mirror };
}

/** The sealed mirror's web keys, opened fresh: provider → value. */
function sealed(profile = root): Record<string, string> {
  const inventory = new SealedInventory({
    path: join(profile, CREDENTIAL_INVENTORY_FILE_NAME),
    keyring: keychainCredentialKeyring({
      path: join(profile, CREDENTIAL_KEYCHAIN_KEY_FILE_NAME),
      keychain,
    }),
  });
  return Object.fromEntries(
    inventory
      .list("web-search")
      .map((record) => [
        record.selector["provider"],
        inventory.get("web-search", record.selector)!.value as string,
      ]),
  );
}

/** A profile database the app has never opened, as a restore target starts. */
function emptyProfileDb(path: string): void {
  const db = new Database(path);
  db.pragma("user_version = 0");
  db.close();
}

const sourceRevision = (db: Database.Database) =>
  (db.prepare("SELECT revision FROM web_credential_source").get() as { revision: number }).revision;

describe("N-1 compatibility of the web keys' step E", { timeout: 120_000 }, () => {
  it("tests against main's exact code", async () => {
    for (const [file, blob] of Object.entries(MAIN_BLOBS)) {
      const bytes = readFileSync(new URL(`./test-support/n1/${file}`, import.meta.url));
      expect(gitBlobId(bytes), file).toBe(blob);
    }
    const db = openDb();
    db.close();
    const run = await n1(dbPath, [{ kind: "open" }]);
    expect(run.results).toEqual([{ head: 58, userVersion: SCHEMA_HEAD, floor: 58 }]);
    // The child did run real host-core code, and none of what this ticket changed.
    expect(run.loaded).toContain("db/database-file.ts");
    expect(run.loaded).toContain("web/credential.ts");
    expect(run.loaded.filter((file) => CHANGED_BY_VC_643.has(file))).toEqual([]);
  });

  it("lets N-1 open, save, clear and attach on a mirrored profile; this build reconciles", async () => {
    let db = openDb();
    current(db).settings.saveKey("brave", BRAVE);
    expect(sealed()).toEqual({ brave: BRAVE });
    const before = sourceRevision(db);
    db.close();

    const run = await n1(dbPath, [
      { kind: "open" },
      { kind: "provider", provider: "brave" },
      { kind: "attach", expect: BRAVE },
      { kind: "save", provider: "exa", value: EXA },
      { kind: "clear", provider: "brave" },
      { kind: "attach", expect: BRAVE },
      { kind: "provider", provider: "exa" },
      { kind: "attach", expect: EXA },
    ]);
    expect(run.results).toEqual([
      // Opens the newer file without migrating it: compatible, floor unchanged.
      { head: 58, userVersion: SCHEMA_HEAD, floor: 58 },
      "brave",
      { configured: true, provider: "brave", carriesExpected: true },
      { brave: "present", exa: "present" },
      { brave: "absent", exa: "present" },
      { configured: false, carriesExpected: false },
      "exa",
      { configured: true, provider: "exa", carriesExpected: true },
    ]);

    db = openDb();
    // user_version never rewinds; the floor never moved; N-1's writes were counted.
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
    expect(readMinReaderVersion(db)).toBe(58);
    expect(sourceRevision(db)).toBeGreaterThan(before);
    const { settings, mirror } = current(db);
    expect(settings.view().sealing).toBe("pending");
    // The stale mirror still holds the key N-1 cleared until this build reconciles.
    expect(sealed()).toEqual({ brave: BRAVE });
    expect(mirror.reconcile()).toMatchObject({ sealing: "sealed", written: true, keys: 1 });
    expect(sealed()).toEqual({ exa: EXA });
    expect(settings.resolve()).toEqual({ configured: true, provider: "exa", apiKey: EXA });
    expect(settings.view()).toMatchObject({
      keys: { brave: "absent", exa: "present" },
      sealing: "sealed",
    });
    db.close();
  });

  it("lets N-1 bundle a mirrored profile without keys or step-E state, and restore it", async () => {
    let db = openDb();
    current(db).settings.saveKey("brave", BRAVE);
    current(db).settings.saveKey("exa", EXA);
    db.close();
    const bundlePath = join(root, "n1.volli-backup");
    const made = await n1(dbPath, [{ kind: "bundle", profileRoot: root, out: bundlePath }]);
    const { schemaVersion, tables } = made.results[0] as {
      schemaVersion: number;
      tables: string[];
    };
    // Stamped with N-1's own head, carrying only its own tables.
    expect(schemaVersion).toBe(58);
    for (const table of ["secrets", "web_credential_source", "web_credential_mirror"]) {
      expect(tables).not.toContain(table);
    }
    const bundle = readFileSync(bundlePath);
    const read = readBackupBundle(bundle);
    expect(read.ok).toBe(true);
    const document = JSON.stringify(read.ok ? read.bundle.document : null);
    expect(document).not.toContain(BRAVE);
    expect(document).not.toContain(EXA);

    // N-1 restores it into a profile whose own stale mirror holds both keys
    // (a restore leaves the profile's credential files where they are).
    const target = mkdtempSync(join(tmpdir(), "volli-web-n1-target-"));
    scratch.push(target);
    for (const name of [CREDENTIAL_INVENTORY_FILE_NAME, CREDENTIAL_KEYCHAIN_KEY_FILE_NAME]) {
      copyFileSync(join(root, name), join(target, name));
    }
    const targetDb = join(target, "volli.db");
    emptyProfileDb(targetDb);
    const restored = await n1(targetDb, [
      { kind: "restore", profileRoot: target, bundle: bundlePath },
      { kind: "open" },
      { kind: "attach", expect: null },
    ]);
    expect(restored.results).toEqual([
      { ok: true },
      { head: 58, userVersion: 58, floor: 58 },
      { configured: false, carriesExpected: false },
    ]);
    expect(sealed(target)).toEqual({ brave: BRAVE, exa: EXA });

    // This build upgrades N-1's restored database straight from pre-E and
    // reconciles: the restored database has no keys, so neither has the
    // mirror, and nothing stale is merged back into `secrets`.
    db = openDb(targetDb);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
    const { settings, mirror } = current(db, target);
    expect(mirror.reconcile()).toMatchObject({ sealing: "none", written: true, keys: 0 });
    expect(sealed(target)).toEqual({});
    expect(settings.view()).toMatchObject({
      keys: { brave: "absent", exa: "absent" },
      sealing: "none",
    });
    db.close();

    // This build restores N-1's bundle too: a fresh lineage, the same outcome.
    const other = mkdtempSync(join(tmpdir(), "volli-web-n1-other-"));
    scratch.push(other);
    for (const name of [CREDENTIAL_INVENTORY_FILE_NAME, CREDENTIAL_KEYCHAIN_KEY_FILE_NAME]) {
      copyFileSync(join(root, name), join(other, name));
    }
    emptyProfileDb(join(other, "volli.db"));
    const ours = await restoreBackupBundle({
      bundle,
      profileRoot: other,
      projectPaths: {},
      now: 1_791_000_000_002,
    });
    expect(ours.ok).toBe(true);
    db = openDb(join(other, "volli.db"));
    expect(sourceRevision(db)).toBe(0);
    expect(current(db, other).mirror.reconcile()).toMatchObject({ sealing: "none", keys: 0 });
    expect(sealed(other)).toEqual({});
    db.close();
  });

  it("refuses, cleanly, a bundle this build made: N-1 knows no schema 59", async () => {
    const db = openDb();
    current(db).settings.saveKey("brave", BRAVE);
    db.close();
    // This is the standing rule for every migration (VC-602), not new here.
    const target = mkdtempSync(join(tmpdir(), "volli-web-n1-refuse-"));
    scratch.push(target);
    const handle = openDb();
    const bytes = createBackupBundle({
      db: handle,
      blobsRoot: join(root, "blobs"),
      transcriptsRoot: join(root, "session-transcripts"),
      appVersion: "n",
      now: 1_791_000_000_003,
    }).bytes;
    handle.close();
    const bundlePath = join(root, "n.volli-backup");
    writeFileSync(bundlePath, bytes);
    const targetDb = join(target, "volli.db");
    emptyProfileDb(targetDb);
    const run = await n1(targetDb, [{ kind: "restore", profileRoot: target, bundle: bundlePath }]);
    expect(run.results[0]).toMatchObject({
      ok: false,
      problems: [{ kind: "unsupported-version" }],
    });
  });
});
