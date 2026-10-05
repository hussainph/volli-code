/**
 * The N-1 compatibility job (VC-633): a PREVIOUS build, run from its own
 * shipped sources, against a profile this build migrated to its head.
 *
 * `migrations.ts` makes every author classify a migration as compatible
 * (older builds keep reading and writing the file) or breaking (it raises the
 * floor, and an older guarded build refuses the file). This checks that
 * classification against a real older build, whichever way it went:
 *
 *  - compatible (the profile's floor is at or below N-1's head): N-1 opens
 *    the head profile, saves and clears a credential, creates, moves and
 *    comments on a ticket, creates a Session, and makes a backup bundle that
 *    both builds restore. This build then reopens what N-1 left: it must check
 *    clean, read N-1's rows, back it up and restore that, and `user_version`
 *    must never have moved backwards.
 *  - breaking (the floor is above N-1's head): N-1 must refuse the profile
 *    before anything writes, leaving the db file and its WAL byte-identical.
 *
 * The refusal path is also run on every lane, whatever this build's floor:
 * a head profile stamped one schema newer, with the floor above N-1's head,
 * and that stamp committed only to the WAL, uncheckpointed, as a crash leaves
 * it.
 *
 * N-1 is prepared by `scripts/n1/prepare.mjs` (the latest release tag, the
 * latest canary tag, or the pull request's base) and driven by `scripts/n1/child.mjs` in its own `node`
 * process; the manifest it writes comes in as `VOLLI_N1_MANIFEST`. With no
 * manifest the suite skips: it runs in CI's `N-1 compatibility` lanes, not in
 * the package suite. To run it on a dev machine:
 *
 *   node packages/host-core/scripts/n1/prepare.mjs --release --out .scratch/n1
 *   VOLLI_N1_MANIFEST=<printed path> vp test run src/db/n1-compatibility.test.ts
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createSessionEngine } from "@volli/session-engine";
import { createBackupBundle, readBackupBundle } from "../backup/bundle";
import { restoreBackupBundle } from "../backup/restore";
import { blobsRoot } from "../blob-store";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { sessionTranscriptsRoot } from "../session-runtime/transcript-artifacts";
import { createTicketCommand } from "../ticket-commands";
import { openVolliDb } from "./database-file";
import { checkMigrationHistory, describeMigrationHistory } from "./migration-history";
import { MIGRATIONS, SCHEMA_HEAD } from "./migrations";
import { insertProject } from "./projects-repo";
import { MIN_READER_VERSION_KEY, readMinReaderVersion } from "./schema-compatibility";
import { hasSecret, writeSecret } from "./secrets-repo";
import { testProject } from "./test-helpers";
import { listTicketsByProject } from "./tickets-repo";

interface N1Manifest {
  ref: string;
  commit: string;
  tree: string;
  hostSrc: string;
}

const manifestPath = process.env["VOLLI_N1_MANIFEST"];
const manifest: N1Manifest | null = manifestPath
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as N1Manifest)
  : null;

/**
 * What a SHIPPED build is known to get wrong on a head profile. It shipped, so
 * it can never be fixed; it is listed here, by commit, with the exact symptom,
 * so that the lane stays green on the known fault and red on any new one.
 * An entry is asserted, not skipped: if the build does anything else, the
 * test fails.
 */
const KNOWN_HAZARDS: Readonly<Record<string, { release: string; bundle?: string }>> = {
  // v0.2.1 (schema 57) stamps a bundle with the FILE's schema but writes only
  // the tables it knows, so its bundle of a schema-58+ profile omits
  // `workspace_epochs` and neither build can restore it. This is why
  // MIN_READER_VERSION_BASELINE is 58 (VC-550, VC-602); head's bundle stamps
  // `min(file, head)` instead. A person on v0.2.1 keeps their profile; only
  // bundles they make there of a newer profile are unusable.
  f6ec540ca7ff14c6e403a4c8a91e840bba46dd1b: {
    release: "v0.2.1",
    bundle: "Data document is missing table workspace_epochs.",
  },
  // v0.2.1-canary.7 (schema 57) has v0.2.1's database and backup modules
  // byte for byte, so the same fault.
  a3bb337904f389fb7e89a52852f8d764870e125a: {
    release: "v0.2.1-canary.7",
    bundle: "Data document is missing table workspace_epochs.",
  },
};

/**
 * What unblocks a floor raise that an unguarded N-1 holds back: a newer build
 * of the same channel, carrying the guard, for this lane to run instead.
 */
function releasePolicyRemedy(ref: string): string {
  const channel = /-canary\.\d+$/.test(ref) ? "canary" : "stable";
  return (
    `Cut a ${channel} release containing VC-602 (the downgrade guard) before landing a ` +
    "`raisesMinReader` migration; see VC-644."
  );
}

const HOOKS = new URL("../../scripts/n1/hooks.mjs", import.meta.url).href;
const CHILD = new URL("../../scripts/n1/child.mjs", import.meta.url).pathname;
const NOW = 1_791_100_000_000;
const PROJECT_ID = "proj-n1";
const provenance = { source: { kind: "user", id: "n", detail: null }, venue: null } as const;

type StepResult =
  | { kind: string; ok: true; value: Record<string, unknown> }
  | {
      kind: string;
      ok: false;
      error: { name: string; message: string; minReaderVersion?: number | null };
    };

interface N1Run {
  /** N-1's schema head. */
  head: number;
  /** Whether N-1 has the downgrade guard (VC-602). */
  guarded: boolean;
  results: StepResult[];
}

/** Runs N-1's steps against `dbPath` in its own process. */
function n1(dbPath: string, steps: Record<string, unknown>[]): Promise<N1Run> {
  const { tree, hostSrc } = manifest!;
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
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, VOLLI_N1_TREE: tree, VOLLI_N1_HOST_SRC: hostSrc },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) => {
      if (code !== 0) return refuse(new Error(`N-1 exited ${code}: ${stderr}`));
      settle(JSON.parse(stdout.trim().split("\n").at(-1)!) as N1Run);
    });
  });
}

let probed: Promise<N1Run> | undefined;
/** N-1's head and whether it is guarded, from a run with no steps. */
function probe(): Promise<N1Run> {
  probed ??= n1(join(tmpdir(), "volli-n1-probe-unused.db"), []);
  return probed;
}

function value(run: N1Run, index: number): Record<string, unknown> {
  const result = run.results[index]!;
  if (!result.ok) {
    throw new Error(
      `N-1 step ${result.kind} failed: ${result.error.name}: ${result.error.message}`,
    );
  }
  return result.value;
}

function sha256(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

let root: string;
let dbPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volli-n1-"));
  dbPath = join(root, "volli.db");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function headEngine(db: Database.Database) {
  let next = 0;
  return createSessionEngine({
    ledger: createSqliteSessionLedger(db),
    clock: { now: () => NOW },
    ids: { next: (kind) => `head-${kind}-${++next}` },
  });
}

/** Where the restored project lives: the same checkout, as on the machine that made the bundle. */
function projectPaths(): Record<string, string> {
  return { [PROJECT_ID]: join(root, "repo") };
}

/** A profile this build created and wrote: a project, a ticket, a Session, a credential. */
async function headProfile(): Promise<void> {
  mkdirSync(join(root, "repo"));
  const db = openVolliDb(dbPath);
  try {
    insertProject(db, testProject({ id: PROJECT_ID, path: join(root, "repo") }));
    const ticket = createTicketCommand(
      db,
      { id: "ticket-head", projectId: PROJECT_ID, title: "Written by head", status: "todo" },
      { now: NOW, actor: { kind: "user" } },
    );
    await headEngine(db).createSession({
      commandId: "head-command",
      requestedSessionId: "session-head",
      projectId: PROJECT_ID,
      ticketId: ticket.id,
      role: "ticket",
      parentSessionId: null,
      title: "Head Session",
      provenance,
    });
    writeSecret(db, "n1-probe:kept", "head-value", NOW);
  } finally {
    db.close();
  }
}

/**
 * A copy of the head profile as a crash leaves it: `write` commits into the
 * WAL and the copy is taken before any checkpoint, so the file at `target`
 * is only correct when read through its `-wal`.
 */
function crashImage(target: string, write: (db: Database.Database) => void): void {
  const writer = new Database(dbPath);
  try {
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_checkpoint(TRUNCATE)");
    writer.pragma("wal_autocheckpoint = 0");
    write(writer);
    copyFileSync(dbPath, target);
    copyFileSync(`${dbPath}-wal`, `${target}-wal`);
  } finally {
    writer.close();
  }
  expect(readFileSync(`${target}-wal`).length).toBeGreaterThan(0);
}

/** N-1 opens `path` and must refuse it, writing nothing. */
async function expectRefusal(path: string, floor: number): Promise<void> {
  const before = [sha256(path), sha256(`${path}-wal`)];
  const run = await n1(path, [{ kind: "open" }]);
  expect(run.results[0]).toMatchObject({
    ok: false,
    error: { name: "DatabaseFromNewerVersionError", minReaderVersion: floor },
  });
  // The db file and its WAL are byte-identical; `-shm` is an index SQLite's
  // read-only reader may rebuild.
  expect([sha256(path), sha256(`${path}-wal`)]).toEqual(before);
}

/** This build's checks on a profile N-1 has written to. */
function assertHeadReads(path: string): void {
  const db = openVolliDb(path);
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    // N-1 never touches the applied-migration history (VC-633), so what it
    // left must still agree with this build's lock.
    expect(describeMigrationHistory(checkMigrationHistory(db, SCHEMA_HEAD))).toMatch(/^consistent/);
  } finally {
    db.close();
  }
}

/** The floor of a profile this build writes: what an older build is held to. */
function headFloor(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return readMinReaderVersion(db) ?? Number.POSITIVE_INFINITY;
  } finally {
    db.close();
  }
}

describe.skipIf(manifest === null)(
  `N-1 compatibility: ${manifest?.ref ?? "no N-1 prepared"} against schema ${SCHEMA_HEAD}`,
  { timeout: 120_000 },
  () => {
    const hazards = KNOWN_HAZARDS[manifest?.commit ?? ""] ?? {};

    it("holds the release policy: no floor raise ships ahead of a guarded release", async () => {
      const { head, guarded } = await probe();
      expect(head).toBeLessThanOrEqual(SCHEMA_HEAD);
      if (guarded) return;
      // A build from before the downgrade guard opens anything, so the only
      // protection its users have is that no floor raise ships while it is the
      // release (or canary) they would drop back to. Cut one from a main that
      // has `schema-compatibility.ts` (VC-602) first; then this lane runs it,
      // and the refusal tests below hold it to the floor.
      const raises = MIGRATIONS.filter(
        (migration) => migration.raisesMinReader === true && migration.version > head,
      ).map((migration) => migration.version);
      expect(
        raises,
        `${manifest!.ref} predates the downgrade guard and cannot refuse these floor raises. ` +
          releasePolicyRemedy(manifest!.ref),
      ).toEqual([]);
    });

    it("keeps the author rule: N-1 writes a compatible head profile, or refuses a breaking one", async () => {
      await headProfile();
      const floor = headFloor();
      const { head, guarded } = await probe();
      if (guarded && floor > head) {
        // Breaking: this build's floor is above N-1's head, so N-1 must keep out.
        const image = join(root, "breaking.db");
        crashImage(image, (db) =>
          db
            .prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
            .run("n1:wal-probe", "1", NOW),
        );
        await expectRefusal(image, floor);
        return;
      }

      const run = await n1(dbPath, [
        { kind: "open" },
        { kind: "secrets", name: "n1-probe:saved", value: "n1-value", clear: false },
        { kind: "secrets", name: "n1-probe:kept", value: "n1-replaced", clear: true },
        { kind: "ticket", projectId: PROJECT_ID, ticketId: "ticket-n1" },
        { kind: "session", projectId: PROJECT_ID, ticketId: "ticket-n1", sessionId: "session-n1" },
        { kind: "open" },
      ]);
      // Compatible, or a build too old to refuse (the policy test above holds
      // those to the baseline floor alone): either way N-1 writes here, and
      // this build must heal what it leaves.
      // Opened without migrating: N-1 never rewrites a newer file's version.
      expect(value(run, 0)).toMatchObject({ userVersion: SCHEMA_HEAD });
      expect(value(run, 1)).toEqual({ saved: true, present: true });
      expect(value(run, 2)).toEqual({ saved: true, present: false });
      expect(value(run, 3)).toEqual({ ticketNumber: 2 });
      expect(value(run, 4)).toEqual({ sessionId: "session-n1", readBack: "session-n1" });
      expect(value(run, 5)).toMatchObject({ userVersion: SCHEMA_HEAD });

      // This build takes over what N-1 left and reads every row of it.
      assertHeadReads(dbPath);
      const db = openVolliDb(dbPath);
      try {
        expect(hasSecret(db, "n1-probe:saved")).toBe(true);
        expect(hasSecret(db, "n1-probe:kept")).toBe(false);
        const tickets = listTicketsByProject(db, PROJECT_ID);
        expect(tickets.map((ticket) => [ticket.id, ticket.status]).toSorted()).toEqual([
          ["ticket-head", "todo"],
          ["ticket-n1", "doing"],
        ]);
        const session = await headEngine(db).getSession({ sessionId: "session-n1" });
        expect(session?.session).toMatchObject({ id: "session-n1", ticketId: "ticket-n1" });

        // And backs it up: a profile N-1 wrote to round-trips through this
        // build's own bundle and restore.
        const bundle = createBackupBundle({
          db,
          blobsRoot: blobsRoot(root),
          transcriptsRoot: sessionTranscriptsRoot(root),
          appVersion: "head",
          now: NOW,
        });
        const target = join(root, "head-roundtrip");
        mkdirSync(target);
        const restored = await restoreBackupBundle({
          bundle: bundle.bytes,
          profileRoot: target,
          projectPaths: projectPaths(),
          now: NOW,
        });
        expect(restored.ok ? restored.report.schemaVersion : restored.problems).toBe(SCHEMA_HEAD);
        assertHeadReads(join(target, "volli.db"));
      } finally {
        db.close();
      }
    });

    it("makes a backup bundle of a head profile that both builds restore", async () => {
      await headProfile();
      const { head, guarded } = await probe();
      if (guarded && headFloor() > head) return; // N-1 refuses the profile.
      const bundlePath = join(root, "n1.volli-backup");
      const run = await n1(dbPath, [{ kind: "bundle", profileRoot: root, out: bundlePath }]);
      value(run, 0);
      const read = readBackupBundle(readFileSync(bundlePath));
      if (hazards.bundle !== undefined) {
        expect(read.ok ? "readable" : read.problems.map((problem) => problem.message)).toEqual([
          hazards.bundle,
        ]);
        return;
      }
      expect(read.ok ? "readable" : read.problems).toBe("readable");
      // Stamped with the schema its tables describe: never above N-1's head.
      expect(value(run, 0)).toEqual({ schemaVersion: head });

      // N-1 restores its own bundle into an empty profile.
      const n1Target = join(root, "n1-target");
      mkdirSync(n1Target);
      const restored = await n1(join(n1Target, "volli.db"), [
        {
          kind: "restore",
          profileRoot: n1Target,
          bundle: bundlePath,
          projectPaths: projectPaths(),
        },
      ]);
      expect(value(restored, 0)).toMatchObject({ restored: true });

      // So does this build, migrating it up to head on the way in.
      const headTarget = join(root, "head-target");
      mkdirSync(headTarget);
      const ours = await restoreBackupBundle({
        bundle: readFileSync(bundlePath),
        profileRoot: headTarget,
        projectPaths: projectPaths(),
        now: NOW,
      });
      expect(ours.ok ? ours.report.schemaVersion : ours.problems).toBe(SCHEMA_HEAD);
      assertHeadReads(join(headTarget, "volli.db"));
    });

    it("refuses a profile whose floor is above its head, leaving db and WAL byte-identical", async () => {
      await headProfile();
      const { head, guarded } = await probe();
      // The release policy test owns the unguarded case.
      if (!guarded) return;
      // A future migration that raises the floor above N-1, committed to the
      // WAL and never checkpointed.
      const newer = Math.max(SCHEMA_HEAD, head) + 1;
      const image = join(root, "raised.db");
      crashImage(image, (db) => {
        db.prepare(
          `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(MIN_READER_VERSION_KEY, String(newer), NOW);
        db.pragma(`user_version = ${newer}`);
      });
      await expectRefusal(image, newer);
      const check = new Database(image, { readonly: true });
      try {
        expect(check.pragma("user_version", { simple: true })).toBe(newer);
        expect(readMinReaderVersion(check)).toBe(newer);
      } finally {
        check.close();
      }
    });
  },
);
