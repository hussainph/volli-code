/**
 * VC-521: real built-Electron degraded DB recovery, with no live profile/auth.
 *
 * Run after the desktop build:
 *   node apps/desktop/e2e/database-recovery-smoke.mjs
 *
 * All profiles, HOME/worktrees, SQLite fixtures and screenshots stay under a
 * fresh recovery-* directory in the CI report root or ignored <workspace>/.tmp. The actual 750ms restart
 * timer runs, but its relaunch/quit pair is intercepted in Electron main so it
 * cannot spawn a detached process. Cleanup restores the original quit method;
 * a separately tracked fresh launch proves the restored profile boots healthy.
 * Manually run (display required); not part of vp test. Never builds artifacts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  APP_DIR,
  REPO,
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  createDeadline,
  launch,
  waitUntil,
  writeFakeLoginShell,
} from "./lib/smoke-kit.mjs";

import { installShutdownTrace, sampleStalledClose, traceClose } from "./lib/shutdown-trace.mjs";
import { screenshotWithTrace } from "./lib/screenshot-trace.mjs";

const RESTORE_LABEL = "Restore from the last backup that checks clean";
const NO_CLEAN = "No local backup checks clean. Nothing was restored.";
const MANUAL = "Your database and safety copies are preserved for manual recovery.";
const MARKER_KEY = "database-recovery-smoke";
const MARKER_VALUE = "last-clean-saved-marker";
// Cheap CI breadcrumbs are kept only on failure. Native sampling is intrusive
// and stays opt-in, including during unchanged-head validation.
const sampleNative = process.env.VOLLI_RECOVERY_SAMPLE === "1";
const traceShutdown =
  Boolean(process.env.VOLLI_SMOKE_REPORT_DIR) ||
  process.env.VOLLI_RECOVERY_TRACE === "1" ||
  sampleNative;
const runs = new Set();
const checks = [];
const failures = [];
let scratch;

// Clamp every main-process round trip too: locator timeouts alone do not bound
// an unresponsive Electron main. Launch itself has Playwright's 30s deadline.
function bounded(label, operation, timeout = 5000) {
  return createDeadline({ label, expiresAt: Date.now() + timeout }).run(operation);
}

async function check(label, operation) {
  try {
    await operation();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    throw error;
  }
  checks.push(label);
  console.log(`PASS: ${label}`);
}

async function fixture(name) {
  const root = join(scratch, name);
  const userDataDir = join(root, "user-data");
  const home = join(root, "home");
  const worktrees = join(root, "worktrees");
  for (const dir of [userDataDir, home, worktrees]) await fs.mkdir(dir, { recursive: true });
  const shell = await writeFakeLoginShell(join(root, "bin"), process.env.PATH ?? "/usr/bin:/bin");
  return {
    root,
    userDataDir,
    // Recovery is strictly scoped to files adjacent to userData. smoke-kit's
    // makeScratch default puts the DB outside it, so deliberately do not use it.
    dbPath: join(userDataDir, "volli.db"),
    extraEnv: {
      HOME: home,
      ZDOTDIR: home,
      SHELL: shell,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      VOLLI_AGENT_HOME: home,
      VOLLI_WORKTREE_HOME_DIR: worktrees,
      VOLLI_SKIP_AGENT_TOOLS: "1",
      VOLLI_SKIP_CLOSE_CONFIRM: "1",
      VOLLI_SMOKE_BROWSER_HOST: "0",
      VOLLI_BROWSER_PROBE: "0",
    },
  };
}

async function openApp(config, label) {
  const app = await launch(config);
  const run = {
    app,
    child: app.process(),
    label,
    stdout: "",
    stderr: "",
    page: null,
    debuggerWaitTraced: false,
    tracePath: traceShutdown ? join(scratch, `${label.replaceAll(" ", "-")}-shutdown.jsonl`) : null,
  };
  run.child.once("exit", (code, signal) =>
    traceClose(run.tracePath, "child-exit", { code, signal }),
  );
  runs.add(run);
  // Bounded log retention; neither seed nor app gets any real credentials.
  run.child.stdout?.on("data", (chunk) => {
    run.stdout = `${run.stdout}${chunk}`.slice(-24000);
  });
  run.child.stderr?.on("data", (chunk) => {
    run.stderr = `${run.stderr}${chunk}`.slice(-24000);
    if (!run.debuggerWaitTraced && run.stderr.includes("Waiting for the debugger to disconnect")) {
      run.debuggerWaitTraced = true;
      traceClose(run.tracePath, "debugger-disconnect-wait");
    }
  });
  await installShutdownTrace(app, run.tracePath);
  await bounded(`${label}: profile isolation`, () =>
    assertProfileIsolated(app, config.userDataDir),
  );
  assert.equal(
    await bounded(`${label}: isolated HOME`, () => app.evaluate(() => process.env.HOME)),
    config.extraEnv.HOME,
  );
  const page = await app.firstWindow({ timeout: 15000 });
  run.page = page;
  page.setDefaultTimeout(5000);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  assertBuiltRendererLoaded(page);
  return run;
}

async function closeRun(run) {
  // Restore original methods BEFORE closeAppBounded invokes Playwright's quit.
  await bounded(`${run.label}: restore native lifecycle`, () =>
    run.app.evaluate(({ app }) => {
      const state = globalThis.volliDatabaseRecoverySmoke;
      if (state) {
        app.relaunch = state.originalRelaunch;
        app.quit = state.originalQuit;
        delete globalThis.volliDatabaseRecoverySmoke;
      }
    }),
  ).catch((error) => console.error(`cleanup patch restoration: ${error.message}`));
  // The application allows 15s for accepted shutdown work to drain. Do not
  // SIGTERM it at smoke-kit's default 2.5s before that deadline on a busy runner.
  traceClose(run.tracePath, "quit-requested");
  const finishSampling = sampleStalledClose(run.child, sampleNative ? run.tracePath : null);
  let exit;
  try {
    exit = await closeAppBounded(run.app, { closeGraceMs: 20000 });
    traceClose(run.tracePath, "close-result", exit);
  } finally {
    await finishSampling();
    if (
      run.tracePath &&
      (!exit ||
        exit.exit.code !== 0 ||
        !["graceful", "already-exited", "natural-after-close"].includes(exit.kind))
    )
      console.error(
        `SHUTDOWN TRACE: ${run.label}:\n${await fs.readFile(run.tracePath, "utf8").catch((error) => `unavailable: ${error.message}`)}`,
      );
  }
  console.log(`CLEANUP: ${run.label}: ${JSON.stringify(exit)}`);
  // Retain failed runs so the outer handler prints their stdout/stderr.
  assert.equal(exit.exit.code, 0, `${run.label} did not quit cleanly`);
  assert.ok(
    ["graceful", "already-exited", "natural-after-close"].includes(exit.kind),
    "cleanup required a forced signal",
  );
  runs.delete(run);
}

async function snapshot(paths) {
  return new Map(await Promise.all(paths.map(async (path) => [path, await fs.readFile(path)])));
}

async function unchanged(before) {
  for (const [path, bytes] of before)
    assert.deepEqual(await fs.readFile(path), bytes, `changed: ${path}`);
}

async function databaseFiles(config) {
  return (await fs.readdir(config.userDataDir))
    .filter((name) => name.startsWith("volli.db"))
    .toSorted();
}

async function malformedHeader(config) {
  const paths = [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`];
  await Promise.all(
    paths.map((path, index) => fs.writeFile(path, `VC-521 damaged raw evidence ${index}\n`)),
  );
  return snapshot(paths);
}

// Use the immutable production v1/v2 SQL snapshots, not a partial hand-written
// app_state-only database (that can pass quick_check but cannot really migrate).
async function legacySql(version) {
  const source = await fs.readFile(
    join(APP_DIR, "../../packages/host-core/src/db/migrations.ts"),
    "utf8",
  );
  const constant = version === 1 ? "MIGRATION_001_INITIAL_SCHEMA" : "MIGRATION_002_TICKET_ARCHIVAL";
  const match = new RegExp(`const ${constant} = \x60([\\s\\S]*?)\x60;`).exec(source);
  assert.ok(match, `immutable v${version} fixture SQL was not found`);
  assert.ok(!match[1].includes("${"), "fixture SQL must be a literal");
  return match[1];
}

async function seedBackup(config, version, marker, modifiedAt) {
  const sourcePath = join(config.root, `seed-v${version}.db`);
  const backupPath = `${config.dbPath}.backup-v${version}`;
  const db = new Database(sourcePath);
  try {
    assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
    db.exec(await legacySql(1));
    if (version === 2) db.exec(await legacySql(2));
    db.pragma(`user_version = ${version}`);
    db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)").run(
      MARKER_KEY,
      marker,
      1,
    );
    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)");
    assert.ok(checkpoint.every((row) => row.busy === 0));
    // Same checkpoint + standalone file copy used by the migration runner.
    await fs.copyFile(sourcePath, backupPath);
  } finally {
    db.close();
  }
  const bytes = await fs.readFile(backupPath);
  assert.equal(bytes[18], 2, "fixture must retain WAL write header flag");
  assert.equal(bytes[19], 2, "fixture must retain WAL read header flag");
  await fs.utimes(backupPath, modifiedAt, modifiedAt);
  return backupPath;
}

async function listing(run) {
  const result = await bounded(`${run.label}: recovery listing`, () =>
    run.page.evaluate(() => window.api.databaseRecovery.list()),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.backups;
}

async function expectFault(run) {
  await run.page
    .getByRole("heading", { name: "Volli couldn't load its data", exact: true })
    .waitFor();
  const boot = await bounded(`${run.label}: degraded bootstrap`, () =>
    run.page.evaluate(() => window.api.data.bootstrap()),
  );
  assert.equal(boot.ok, false, "damaged profile unexpectedly booted healthy");
}

async function screenshot(run, name) {
  await screenshotWithTrace(
    run,
    { path: join(scratch, `${name}.png`), timeout: 5000 },
    traceShutdown
      ? join(scratch, `${run.label.replaceAll(" ", "-")}-${name}-screenshot.jsonl`)
      : null,
    { sample: sampleNative },
  );
}

// Match the real incident: the SQLite header/schema are intact, but an index
// leaf/root page is zeroed. No original SQLite connection survives seeding.
// A killed child leaves a REAL committed WAL for an unrelated table, so a
// checkpoint must preserve evidence instead of dropping uncheckpointed data.
async function damagedIndexWithWal(config) {
  const db = new Database(config.dbPath);
  let rootpage;
  let pageSize;
  try {
    assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
    db.exec(await legacySql(1));
    db.exec(await legacySql(2));
    db.pragma("user_version = 2");
    db.exec(`
      CREATE TABLE recovery_probe(value TEXT);
      CREATE INDEX recovery_probe_idx ON recovery_probe(value);
      INSERT INTO recovery_probe VALUES ('index evidence');
      CREATE TABLE recovery_unrelated(value TEXT);
    `);
    ({ rootpage } = db
      .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'recovery_probe_idx'")
      .get());
    pageSize = db.pragma("page_size", { simple: true });
    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.ok(db.pragma("wal_checkpoint(TRUNCATE)").every((row) => row.busy === 0));
  } finally {
    db.close();
  }
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import Database from 'better-sqlite3';
       const db = new Database(process.argv[1], { fileMustExist: true });
       db.pragma('wal_autocheckpoint = 0');
       db.pragma('synchronous = FULL');
       db.prepare('INSERT INTO recovery_unrelated VALUES (?)').run('committed WAL evidence');
       process.kill(process.pid, 'SIGKILL');`,
      config.dbPath,
    ],
    { cwd: APP_DIR, env: { ...process.env, ...config.extraEnv }, timeout: 5000 },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: null, signal: "SIGKILL" }, stderr);
  const wal = await fs.readFile(`${config.dbPath}-wal`);
  assert.ok(wal.length > 32, "crashed writer did not leave committed WAL frames");
  assert.ok([0x377f0682, 0x377f0683].includes(wal.readUInt32BE(0)), "not a real SQLite WAL");
  assert.equal(wal.readUInt32BE(8), pageSize);
  assert.equal((wal.length - 32) % (pageSize + 24), 0, "incomplete WAL frame");
  let committed = false;
  for (let offset = 32; offset < wal.length; offset += pageSize + 24) {
    assert.notEqual(wal.readUInt32BE(offset), rootpage, "WAL would mask zeroed index page");
    if (wal.readUInt32BE(offset + 4) > 0) committed = true;
  }
  assert.ok(committed, "fixture WAL must include a commit");
  assert.ok((await fs.stat(`${config.dbPath}-shm`)).size > 0);
  const bytes = await fs.readFile(config.dbPath);
  assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
  assert.equal(bytes[(rootpage - 1) * pageSize], 0x0a, "fixture must damage an index leaf");
  bytes.fill(0, (rootpage - 1) * pageSize, rootpage * pageSize);
  await fs.writeFile(config.dbPath, bytes);
  return snapshot([config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]);
}

function assertDamagedIndex(db) {
  let rows;
  try {
    rows = db.pragma("quick_check");
  } catch (error) {
    assert.equal(error.code, "SQLITE_CORRUPT");
    return;
  }
  // SQLite may report corruption as diagnostic rows rather than an exception.
  assert.ok(rows.length > 0);
  assert.ok(
    rows.some(({ quick_check }) => quick_check !== "ok"),
    JSON.stringify(rows),
  );
}

function durableBytes(raw, config) {
  // SHM is an ephemeral SQLite cache. Read-only preflight may update its lock
  // metadata, but neither the base DB nor committed WAL may change at all.
  return new Map([...raw].filter(([path]) => path !== `${config.dbPath}-shm`));
}

async function installRestartInterception(run) {
  // Only the real timer's lifecycle pair is substituted; no IPC/restore mock.
  await bounded("install recovery restart interception", () =>
    run.app.evaluate(({ app }) => {
      const state = {
        originalRelaunch: app.relaunch,
        originalQuit: app.quit,
        calls: [],
      };
      globalThis.volliDatabaseRecoverySmoke = state;
      app.relaunch = () => {
        state.calls.push({ method: "relaunch", at: Date.now() });
      };
      app.quit = (...args) => {
        if (state.calls.at(-1)?.method === "relaunch") {
          state.calls.push({ method: "quit", at: Date.now() });
          return;
        }
        return state.originalQuit.apply(app, args);
      };
    }),
  );
}

async function preservedRaw(config, raw) {
  const names = await databaseFiles(config);
  const directories = names.filter((name) => name.startsWith("volli.db.damaged-"));
  assert.equal(directories.length, 1);
  assert.equal(
    names.some((name) => name.startsWith("volli.db.restore-")),
    false,
  );
  const preserved = join(config.userDataDir, directories[0]);
  const rawDirectory = join(preserved, "before-checkpoint");
  assert.deepEqual(
    (await fs.readdir(rawDirectory)).toSorted(),
    [...raw.keys()].map((path) => path.slice(config.userDataDir.length + 1)).toSorted(),
  );
  for (const [path, bytes] of raw) {
    const name = path.slice(config.userDataDir.length + 1);
    assert.deepEqual(
      await fs.readFile(join(rawDirectory, name)),
      bytes,
      `raw copy changed: ${name}`,
    );
  }
  return preserved;
}

async function recoveryScenario() {
  const config = await fixture("restore");
  const initialRaw = await damagedIndexWithWal(config);
  const durable = durableBytes(initialRaw, config);
  let actionRaw;
  const older = await seedBackup(config, 1, "older-clean-marker", 1700000000);
  const selected = await seedBackup(config, 2, MARKER_VALUE, 1700000100);
  const damaged = `${config.dbPath}.backup-v3`;
  await fs.writeFile(damaged, "newer damaged migration copy");
  await fs.utimes(damaged, 1700000200, 1700000200);
  const copies = await snapshot([older, selected, damaged]);
  // Boot intentionally creates the stable opening mutex, not recovery data.
  const beforeNames = [...(await databaseFiles(config)), "volli.db.open-lock"].toSorted();
  const first = await openApp(config, "degraded restore launch");

  await check(
    "fault UI + real IPC list newest damaged, latest clean WAL v2, older clean WAL v1",
    async () => {
      await expectFault(first);
      await unchanged(durable);
      const backups = await listing(first);
      assert.deepEqual(
        backups.map(({ name, integrity }) => ({ name, integrity })),
        [
          { name: "volli.db.backup-v3", integrity: "damaged" },
          { name: "volli.db.backup-v2", integrity: "clean" },
          { name: "volli.db.backup-v1", integrity: "clean" },
        ],
      );
      const items = first.page
        .getByRole("list", { name: "Local safety copies", exact: true })
        .getByRole("listitem");
      assert.equal(await items.count(), 3);
      for (let index = 0; index < backups.length; index++) {
        const text = await items.nth(index).innerText();
        assert.ok(text.includes(backups[index].name));
        assert.ok(text.includes(backups[index].integrity));
      }
      assert.equal(
        await first.page.getByRole("button", { name: RESTORE_LABEL, exact: true }).isEnabled(),
        true,
      );
      await unchanged(durable);
      await fs.access(`${config.dbPath}-shm`);
      await unchanged(copies);
      assert.deepEqual(
        await databaseFiles(config),
        beforeNames,
        "listing created/deleted database files",
      );
      await screenshot(first, "degraded-with-clean-backups");
    },
  );

  await installRestartInterception(first);

  await check(
    "exact primary action restores and paints success; real timer calls relaunch then quit",
    async () => {
      // Snapshot ALL evidence at action time, including SHM exactly as SQLite
      // left it during preflight. Never rewrite or normalize any fixture file.
      actionRaw = await snapshot([config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]);
      await unchanged(durable);
      const clickedAt = Date.now();
      await first.page.getByRole("button", { name: RESTORE_LABEL, exact: true }).click();
      await first.page
        .getByText("Backup restored. Volli is restarting…", { exact: true })
        .waitFor();
      assert.equal(
        await first.page.getByRole("button", { name: RESTORE_LABEL, exact: true }).isDisabled(),
        true,
      );
      const calls = await waitUntil(
        "recovery restart timer's relaunch/quit pair",
        async () => {
          const next = await bounded("read restart calls", () =>
            first.app.evaluate(() => globalThis.volliDatabaseRecoverySmoke.calls),
          );
          return next.length >= 2 ? next : null;
        },
        { timeout: 7000, interval: 100 },
      );
      assert.deepEqual(
        calls.map((call) => call.method),
        ["relaunch", "quit"],
      );
      assert.ok(calls[0].at - clickedAt >= 650, "restart happened before success could paint");
      await fs.writeFile(
        join(scratch, "restart-calls.json"),
        `${JSON.stringify(calls, null, 2)}\n`,
      );
      await screenshot(first, "backup-restored-success");
    },
  );

  let preserved;
  await check(
    "restoration preserves raw DB/WAL/SHM evidence and every original backup byte",
    async () => {
      preserved = await preservedRaw(config, actionRaw);
      // The post-checkpoint bundle must retain the unrelated committed WAL row,
      // even though its damaged index still fails quick_check. Inspect a memory
      // image only: never let SQLite alter either preserved bundle's files.
      const image = await fs.readFile(join(preserved, "volli.db"));
      assert.equal(image.subarray(0, 16).toString(), "SQLite format 3\0");
      image[18] = 1;
      image[19] = 1;
      const saved = new Database(image);
      try {
        assert.deepEqual(saved.prepare("SELECT value FROM recovery_unrelated").all(), [
          { value: "committed WAL evidence" },
        ]);
        assertDamagedIndex(saved);
      } finally {
        saved.close();
      }
      await unchanged(copies);
      await assertMissing(`${config.dbPath}.recovery-pending`);
    },
  );
  await closeRun(first);

  const second = await openApp(config, "fresh restored launch");
  await check(
    "fresh launch has healthy real bootstrap and the latest-clean saved marker",
    async () => {
      await waitUntil(
        "healthy restored bootstrap",
        async () => {
          const boot = await bounded("healthy bootstrap", () =>
            second.page.evaluate(() => window.api.data.bootstrap()),
          );
          return boot.ok ? boot : null;
        },
        { timeout: 15000 },
      );
      assert.equal(
        await second.page
          .getByRole("heading", { name: "Volli couldn't load its data", exact: true })
          .count(),
        0,
      );
      const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
      try {
        assert.equal(db.pragma("quick_check", { simple: true }), "ok");
        assert.ok(
          db.pragma("user_version", { simple: true }) > 2,
          "restored backup did not migrate",
        );
        assert.deepEqual(db.prepare("SELECT value FROM app_state WHERE key = ?").get(MARKER_KEY), {
          value: MARKER_VALUE,
        });
      } finally {
        db.close();
      }
      await unchanged(copies);
      assert.equal(await preservedRaw(config, actionRaw), preserved);
      await screenshot(second, "healthy-restored-bootstrap");
    },
  );
  await closeRun(second);
  // Recheck preservation after shutdown, too (SQLite closes can checkpoint).
  await unchanged(copies);
  assert.equal(await preservedRaw(config, actionRaw), preserved);
}

async function assertMissing(path) {
  await assert.rejects(fs.lstat(path), { code: "ENOENT" });
}

async function malformedHeaderScenario() {
  const config = await fixture("malformed-header");
  const raw = await malformedHeader(config);
  const selected = await seedBackup(config, 2, MARKER_VALUE, 1700000100);
  const copies = await snapshot([selected]);
  const beforeNames = [...(await databaseFiles(config)), "volli.db.open-lock"].toSorted();
  const run = await openApp(config, "malformed-header launch");
  await check(
    "malformed header startup/listing preserves DB/WAL/SHM and backup exactly",
    async () => {
      await expectFault(run);
      await unchanged(raw);
      const backups = await listing(run);
      assert.deepEqual(
        backups.map(({ name, integrity }) => ({ name, integrity })),
        [{ name: "volli.db.backup-v2", integrity: "clean" }],
      );
      assert.equal(
        await run.page.getByRole("button", { name: RESTORE_LABEL, exact: true }).isEnabled(),
        true,
      );
      await unchanged(raw);
      await unchanged(copies);
      assert.deepEqual(await databaseFiles(config), beforeNames);
    },
  );
  await installRestartInterception(run);
  await check(
    "malformed header restore refuses unavailable ownership, preserving every original byte",
    async () => {
      const actionRaw = await snapshot([...raw.keys()]);
      await run.page.getByRole("button", { name: RESTORE_LABEL, exact: true }).click();
      await run.page
        .getByText(
          "Restore failed. Your original database and safety copies are preserved for manual recovery.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await run.page.getByText("Backup restored. Volli is restarting…", { exact: true }).count(),
        0,
      );
      await expectFault(run);
      await unchanged(raw);
      await unchanged(copies);
      await preservedRaw(config, actionRaw);
      await assertMissing(`${config.dbPath}.recovery-pending`);
      // A round trip and a >750ms observation window catch any accidental success
      // timer while leaving all production lifecycle/timer logic unmodified.
      await run.page.waitForTimeout(1100);
      const calls = await bounded("failed restore restart calls", () =>
        run.app.evaluate(() => globalThis.volliDatabaseRecoverySmoke.calls),
      );
      assert.deepEqual(calls, [], "failed ownership acquisition scheduled a restart");
      await unchanged(raw);
      await unchanged(copies);
      await screenshot(run, "malformed-header-restore-refused");
    },
  );
  await closeRun(run);
  await unchanged(raw);
  await unchanged(copies);
}

async function interruptedSwitchScenario() {
  const config = await fixture("interrupted-switch");
  const selected = await seedBackup(config, 2, MARKER_VALUE, 1700000100);
  const copies = await snapshot([selected]);
  const preservedDirectory = "volli.db.damaged-interrupted";
  const movedDirectory = join(config.userDataDir, preservedDirectory);
  await fs.mkdir(movedDirectory);
  const moved = join(movedDirectory, "volli.db");
  await fs.writeFile(moved, "original displaced database evidence");
  const movedBytes = await snapshot([moved]);
  const markerPath = `${config.dbPath}.recovery-pending`;
  await fs.writeFile(markerPath, JSON.stringify({ preservedDirectory }), { flag: "wx" });
  const marker = await snapshot([markerPath]);
  const beforeNames = await databaseFiles(config);
  const run = await openApp(config, "interrupted-switch launch");
  await check("interrupted restore marker blocks bootcreating an empty profile", async () => {
    await expectFault(run);
    await assertMissing(config.dbPath);
    assert.deepEqual(
      (await listing(run)).map(({ integrity }) => integrity),
      ["clean"],
    );
    await assertMissing(config.dbPath);
    await unchanged(marker);
    await unchanged(movedBytes);
    await unchanged(copies);
    assert.deepEqual(await databaseFiles(config), beforeNames);
    await screenshot(run, "interrupted-switch-blocked");
  });
  await installRestartInterception(run);
  await check(
    "explicit resume from a clean backup heals missing DB and clears marker",
    async () => {
      await run.page.getByRole("button", { name: RESTORE_LABEL, exact: true }).click();
      await run.page.getByText("Backup restored. Volli is restarting…", { exact: true }).waitFor();
      const calls = await waitUntil(
        "resumed restore restart",
        async () => {
          const next = await bounded("resumed restart calls", () =>
            run.app.evaluate(() => globalThis.volliDatabaseRecoverySmoke.calls),
          );
          return next.length >= 2 ? next : null;
        },
        { timeout: 7000, interval: 100 },
      );
      assert.deepEqual(
        calls.map(({ method }) => method),
        ["relaunch", "quit"],
      );
      await assertMissing(markerPath);
      await unchanged(movedBytes);
      await unchanged(copies);
    },
  );
  await closeRun(run);
  const second = await openApp(config, "resumed fresh launch");
  await check("resumed interrupted restore boots healthy with saved marker", async () => {
    await waitUntil(
      "resumed healthy bootstrap",
      async () => {
        const boot = await bounded("resumed bootstrap", () =>
          second.page.evaluate(() => window.api.data.bootstrap()),
        );
        return boot.ok ? boot : null;
      },
      { timeout: 15000 },
    );
    const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(db.pragma("quick_check", { simple: true }), "ok");
      assert.deepEqual(db.prepare("SELECT value FROM app_state WHERE key = ?").get(MARKER_KEY), {
        value: MARKER_VALUE,
      });
    } finally {
      db.close();
    }
    await unchanged(movedBytes);
    await unchanged(copies);
  });
  await closeRun(second);
  await unchanged(movedBytes);
  await unchanged(copies);
}

async function noCleanScenario(includeDamagedCopy) {
  const config = await fixture(includeDamagedCopy ? "no-clean-damaged" : "no-backups");
  const raw = await malformedHeader(config);
  if (includeDamagedCopy) {
    const path = `${config.dbPath}.backup-v1`;
    await fs.writeFile(path, "damaged backup, preserve me");
    raw.set(path, await fs.readFile(path));
  }
  const names = [...(await databaseFiles(config)), "volli.db.open-lock"].toSorted();
  const run = await openApp(config, includeDamagedCopy ? "no-clean launch" : "no-backups launch");
  await installRestartInterception(run);
  await check(
    `${run.label}: explicit no-clean message, disabled restore, no DB file changes`,
    async () => {
      await expectFault(run);
      await unchanged(raw);
      await run.page.getByText(NO_CLEAN, { exact: true }).waitFor();
      await run.page.getByText(MANUAL, { exact: true }).waitFor();
      assert.equal(
        await run.page.getByRole("button", { name: RESTORE_LABEL, exact: true }).isDisabled(),
        true,
      );
      const backups = await listing(run);
      assert.deepEqual(
        backups.map(({ integrity }) => integrity),
        includeDamagedCopy ? ["damaged"] : [],
      );
      // A direct real IPC request proves fail-closed behavior even if a caller
      // bypasses the disabled UI; still no filesystem mutation or restart.
      const restored = await bounded("no-clean restore refusal", () =>
        run.page.evaluate(() => window.api.databaseRecovery.restore()),
      );
      assert.deepEqual(restored, { ok: false, error: `${NO_CLEAN} ${MANUAL}` });
      await run.page.waitForTimeout(1100);
      assert.deepEqual(
        await bounded("no-clean restart calls", () =>
          run.app.evaluate(() => globalThis.volliDatabaseRecoverySmoke.calls),
        ),
        [],
        "no-clean refusal scheduled a restart",
      );
      assert.deepEqual(await databaseFiles(config), names);
      await unchanged(raw);
      await screenshot(run, includeDamagedCopy ? "no-clean-backup" : "no-backups");
    },
  );
  await closeRun(run);
  await unchanged(raw);
  assert.deepEqual(await databaseFiles(config), names);
}

let code = 1;
try {
  // Refuse ambient packaged-binary overrides: this proof must use this branch's
  // built app, never some installed production application.
  assert.equal(
    process.env.VOLLI_SMOKE_APP_BINARY,
    undefined,
    "unset VOLLI_SMOKE_APP_BINARY for this built-branch smoke",
  );
  for (const path of [join(APP_DIR, "dist-electron/main.cjs"), join(APP_DIR, "dist/index.html")])
    await fs.access(path);
  const evidenceRoot = process.env.VOLLI_SMOKE_REPORT_DIR ?? join(REPO, ".tmp");
  await fs.mkdir(evidenceRoot, { recursive: true });
  scratch = await fs.mkdtemp(join(evidenceRoot, "recovery-"));
  console.log(`Evidence: ${scratch}`);
  await recoveryScenario();
  await malformedHeaderScenario();
  await noCleanScenario(false);
  await noCleanScenario(true);
  await interruptedSwitchScenario();
  code = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error("RECOVERY SMOKE FAILED:", error.stack ?? error);
  if (failures.length === 0) failures.push(error.stack ?? String(error));
  for (const run of runs) {
    console.error(`${run.label} stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    if (run.page) await screenshot(run, "failure").catch(() => undefined);
  }
} finally {
  for (const run of runs) {
    try {
      await closeRun(run);
    } catch (error) {
      console.error("CLEANUP FAILED:", error.stack ?? error);
      failures.push(`cleanup: ${error.message}`);
      code = 1;
    }
  }
  if (scratch) {
    await fs.writeFile(
      join(scratch, "result.json"),
      `${JSON.stringify({ ok: code === 0, checks, failures }, null, 2)}\n`,
    );
    // Keep screenshots/summary for PR evidence, but remove isolated profiles and
    // shadow Electron bundles after success. Failures retain fixtures to debug.
    if (code === 0) {
      for (const name of [
        "restore",
        "malformed-header",
        "no-backups",
        "no-clean-damaged",
        "interrupted-switch",
      ])
        await fs.rm(join(scratch, name), { recursive: true, force: true });
      for (const name of await fs.readdir(scratch))
        if (name.includes("-shutdown.jsonl")) await fs.rm(join(scratch, name), { force: true });
    }
  }
}
console.log(
  `${code === 0 ? "ALL CHECKS PASSED" : "FAILED"}: ${checks.length} completed recovery checks`,
);
process.exitCode = code;
