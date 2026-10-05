/**
 * VC-602: the built app against a database written by a newer Volli.
 *
 * Run after the desktop build:
 *   node apps/desktop/e2e/database-newer-version-smoke.mjs
 *
 * One healthy launch creates a real profile at this build's schema head. Two
 * copies of it are then stamped the way a newer build would leave them:
 *
 *  - incompatible: `user_version` and `min_reader_version` both above the
 *    head. The app must show the named "newer version of Volli" recovery
 *    screen, offer update / restore an older backup / quit, and leave the
 *    database file and its WAL byte-identical through launch, listing and
 *    quit. `-shm`, an index with no data, may be created or reset by
 *    SQLite's read-only reader, so it is not hashed.
 *  - compatible: `user_version` above the head, `min_reader_version` at the
 *    head. The app must boot normally, run no migration (no safety copy) and
 *    never lower `user_version`.
 *
 * Everything lives under a fresh ignored <workspace>/.tmp/newer-db-* directory.
 * Display required; never builds artifacts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

import { sampleStalledClose, traceClose } from "./lib/shutdown-trace.mjs";

const NEWER_TITLE = "This database was created by a newer version of Volli";
const DAMAGED_TITLE = "Volli couldn't load its data";
const RESTORE_LABEL = "Restore from the last backup that checks clean";
const MIN_READER_KEY = "volli:min-reader-version";
const runs = new Set();
const checks = [];
const failures = [];
let scratch;

/** This build's schema head, derived from the shipped lock (its last entry IS the head). */
async function schemaHead() {
  const lock = JSON.parse(
    await fs.readFile(
      join(APP_DIR, "../../packages/host-core/src/db/migrations.lock.json"),
      "utf8",
    ),
  );
  const head = Math.max(
    ...Object.keys(lock)
      .filter((key) => key !== "format")
      .map(Number),
  );
  assert.ok(Number.isInteger(head) && head > 0, "could not derive the schema head");
  return head;
}

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
    // Inside userData: the recovery screen's safety-copy listing is scoped there.
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
      VOLLI_SHUTDOWN_TRACE_FILE: join(scratch, `${name}-shutdown.jsonl`),
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
    tracePath: config.extraEnv.VOLLI_SHUTDOWN_TRACE_FILE,
  };
  run.child.once("exit", (code, signal) =>
    traceClose(run.tracePath, "child-exit", { code, signal }),
  );
  runs.add(run);
  run.child.stdout?.on("data", (chunk) => {
    run.stdout = `${run.stdout}${chunk}`.slice(-48000);
  });
  run.child.stderr?.on("data", (chunk) => {
    run.stderr = `${run.stderr}${chunk}`.slice(-48000);
    if (run.stderr.includes("Waiting for the debugger to disconnect"))
      traceClose(run.tracePath, "debugger-disconnect-wait");
  });
  await bounded(`${label}: profile isolation`, () =>
    assertProfileIsolated(app, config.userDataDir),
  );
  const page = await app.firstWindow({ timeout: 15000 });
  run.page = page;
  page.setDefaultTimeout(8000);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  assertBuiltRendererLoaded(page);
  return run;
}

async function closeRun(run) {
  // Degraded and healthy apps both get the app's own shutdown drain window.
  traceClose(run.tracePath, "quit-requested");
  const finishSampling = sampleStalledClose(run.child, run.tracePath);
  let exit;
  try {
    exit = await closeAppBounded(run.app, { closeGraceMs: 20000 });
    traceClose(run.tracePath, "close-result", exit);
  } finally {
    await finishSampling();
    console.log(`SHUTDOWN TRACE: ${run.label}:\n${await fs.readFile(run.tracePath, "utf8")}`);
  }
  console.log(`CLEANUP: ${run.label}: ${JSON.stringify(exit)}`);
  assert.equal(exit.exit.code, 0, `${run.label} did not quit cleanly`);
  assert.ok(
    ["graceful", "already-exited", "natural-after-close"].includes(exit.kind),
    "cleanup required a forced signal",
  );
  runs.delete(run);
}

async function bootstrap(run) {
  return bounded(`${run.label}: bootstrap`, () =>
    run.page.evaluate(() => window.api.data.bootstrap()),
  );
}

async function waitHealthy(run) {
  await waitUntil(
    `${run.label}: healthy bootstrap`,
    async () => {
      const boot = await bootstrap(run);
      return boot.ok ? boot : null;
    },
    { timeout: 15000 },
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Every durable database file: the base and any WAL with frames. `-shm` is an
 * index with no data that SQLite's read-only reader may create or reset.
 */
async function durableHashes(config) {
  const hashes = new Map();
  for (const suffix of ["", "-wal"]) {
    const path = `${config.dbPath}${suffix}`;
    try {
      const bytes = await fs.readFile(path);
      // An empty WAL holds no frames; read-only verification may create one.
      if (suffix === "-wal" && bytes.length === 0) continue;
      hashes.set(path, sha256(bytes));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return hashes;
}

async function databaseNames(config) {
  return (await fs.readdir(config.userDataDir)).filter((name) => name.startsWith("volli.db"));
}

function readOnly(path, read) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** A real profile at this build's head: the app's own first boot, checkpointed into one file. */
async function seedHeadProfile(head) {
  const config = await fixture("seed");
  const run = await openApp(config, "seed launch");
  await check("a fresh profile boots healthy at the schema head", async () => {
    await waitHealthy(run);
  });
  await closeRun(run);
  const db = new Database(config.dbPath);
  try {
    assert.equal(db.pragma("user_version", { simple: true }), head);
    assert.ok(db.pragma("wal_checkpoint(TRUNCATE)").every((row) => row.busy === 0));
  } finally {
    db.close();
  }
  return config.dbPath;
}

/** Copies the seed into a scenario profile and stamps it as a newer build would leave it. */
async function newerProfile(name, seedPath, { schemaVersion, floor }) {
  const config = await fixture(name);
  await fs.copyFile(seedPath, config.dbPath);
  const db = new Database(config.dbPath);
  try {
    // An additive change the newer build made, which this build has never heard of.
    db.exec("CREATE TABLE vc602_future_feature (id TEXT PRIMARY KEY)");
    db.pragma(`user_version = ${schemaVersion}`);
    db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)").run(
      MIN_READER_KEY,
      String(floor),
    );
    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.ok(db.pragma("wal_checkpoint(TRUNCATE)").every((row) => row.busy === 0));
  } finally {
    db.close();
  }
  return config;
}

async function incompatibleScenario(seedPath, head, future) {
  const config = await newerProfile("incompatible", seedPath, {
    schemaVersion: future,
    floor: future,
  });
  // The pre-upgrade safety copy a newer build's migration would have left: an
  // older backup this build can restore.
  const olderBackup = `${config.dbPath}.backup-v${head}`;
  await fs.copyFile(seedPath, olderBackup);
  const backupHash = sha256(await fs.readFile(olderBackup));
  const before = await durableHashes(config);
  assert.ok(before.has(config.dbPath));
  const namesBefore = await databaseNames(config);

  const run = await openApp(config, "incompatible launch");
  await check("a newer, incompatible database shows the named refusal screen", async () => {
    await run.page.getByRole("heading", { name: NEWER_TITLE, exact: true }).waitFor();
    assert.equal(await run.page.getByRole("heading", { name: DAMAGED_TITLE }).count(), 0);
    await run.page
      .getByText(
        "This version can't open it, so nothing was changed. Update Volli, or restore an older backup.",
        { exact: true },
      )
      .waitFor();
    const boot = await bootstrap(run);
    assert.equal(boot.ok, false, "a refused database must not boot");
    // A built-but-unpackaged app is a dev audience, so it hears the versions;
    // a packaged one hears only the plain sentence (db-open-failure.test.ts).
    assert.match(boot.error, /is newer than this build's schema \d+.*Nothing was changed\./);
    const fault = await bounded("fault", () =>
      run.page.evaluate(() => window.api.databaseRecovery.fault()),
    );
    assert.deepEqual(fault, { ok: true, fault: "newer-version" });
  });

  await check("the refusal offers update, an older backup and quit", async () => {
    // The built smoke app is unpackaged, so it has no updater: the download page stands in.
    const download = run.page.getByRole("link", { name: "Open the download page", exact: true });
    assert.equal(await download.getAttribute("href"), "https://volli.app/download/");
    const listing = await bounded("recovery listing", () =>
      run.page.evaluate(() => window.api.databaseRecovery.list()),
    );
    assert.equal(listing.ok, true, JSON.stringify(listing));
    assert.deepEqual(
      listing.backups.map(({ name, integrity }) => ({ name, integrity })),
      [{ name: `volli.db.backup-v${head}`, integrity: "clean" }],
    );
    assert.equal(
      await run.page.getByRole("button", { name: RESTORE_LABEL, exact: true }).isEnabled(),
      true,
    );
    assert.equal(
      await run.page.getByRole("button", { name: "Quit Volli", exact: true }).isEnabled(),
      true,
    );
    await run.page.screenshot({ path: join(scratch, "newer-version-refusal.png"), timeout: 5000 });
  });

  await check("the refused database file is byte-identical while the app runs", async () => {
    assert.deepEqual(await durableHashes(config), before);
    assert.equal(sha256(await fs.readFile(olderBackup)), backupHash);
    const created = (await databaseNames(config)).filter((name) => !namesBefore.includes(name));
    for (const name of created) {
      assert.ok(
        ["volli.db-shm", "volli.db-wal", "volli.db.open-lock"].includes(name),
        `refusal created ${name}`,
      );
    }
  });

  await check("Quit Volli asks Electron main to quit", async () => {
    // Playwright holds a debugger on main, and a self-initiated quit waits for
    // it to disconnect, so the real exit cannot be awaited here. Record the
    // call the button makes instead, then quit through the bounded close.
    await bounded("intercept app.quit", () =>
      run.app.evaluate(({ app }) => {
        globalThis.vc602QuitCalls = 0;
        globalThis.vc602OriginalQuit = app.quit;
        app.quit = () => {
          globalThis.vc602QuitCalls += 1;
        };
      }),
    );
    await run.page.getByRole("button", { name: "Quit Volli", exact: true }).click();
    await waitUntil(
      "quit requested from the refusal screen",
      () =>
        bounded("read quit calls", () => run.app.evaluate(() => globalThis.vc602QuitCalls === 1)),
      { timeout: 5000, interval: 100 },
    );
    await bounded("restore app.quit", () =>
      run.app.evaluate(({ app }) => {
        app.quit = globalThis.vc602OriginalQuit;
      }),
    );
    await closeRun(run);
  });

  await check("the refused database file is byte-identical after quit", async () => {
    assert.deepEqual(await durableHashes(config), before);
    readOnly(config.dbPath, (db) => {
      assert.equal(db.pragma("user_version", { simple: true }), future);
      assert.deepEqual(
        db.prepare("SELECT value FROM app_state WHERE key = ?").get(MIN_READER_KEY),
        { value: String(future) },
      );
    });
  });
}

async function compatibleScenario(seedPath, head, future) {
  const config = await newerProfile("compatible", seedPath, {
    schemaVersion: future,
    floor: head,
  });
  const run = await openApp(config, "compatible launch");
  await check("a newer, compatible database boots normally", async () => {
    await waitHealthy(run);
    assert.equal(await run.page.getByRole("heading", { name: NEWER_TITLE }).count(), 0);
    assert.equal(await run.page.getByRole("heading", { name: DAMAGED_TITLE }).count(), 0);
    await run.page.screenshot({ path: join(scratch, "newer-compatible-boot.png"), timeout: 5000 });
  });
  await closeRun(run);

  // The once-per-open log line is held by host-core's schema-compatibility
  // test: main logs it before Playwright attaches to the child's output.
  await check("it ran no migration and kept the newer user_version and floor", async () => {
    assert.deepEqual(
      (await databaseNames(config)).filter((name) => name.includes(".backup-v")),
      [],
      "a migration safety copy means a migration ran",
    );
    readOnly(config.dbPath, (db) => {
      assert.equal(db.pragma("user_version", { simple: true }), future);
      assert.deepEqual(
        db.prepare("SELECT value FROM app_state WHERE key = ?").get(MIN_READER_KEY),
        { value: String(head) },
      );
      assert.ok(
        db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'vc602_future_feature'").get(),
        "the newer build's table must survive",
      );
    });
  });
}

let code = 1;
try {
  assert.equal(
    process.env.VOLLI_SMOKE_APP_BINARY,
    undefined,
    "unset VOLLI_SMOKE_APP_BINARY for this built-branch smoke",
  );
  for (const path of [join(APP_DIR, "dist-electron/main.cjs"), join(APP_DIR, "dist/index.html")])
    await fs.access(path);
  const evidenceRoot = process.env.VOLLI_SMOKE_REPORT_DIR ?? join(REPO, ".tmp");
  await fs.mkdir(evidenceRoot, { recursive: true });
  scratch = await fs.mkdtemp(join(evidenceRoot, "newer-db-"));
  console.log(`Evidence: ${scratch}`);
  const head = await schemaHead();
  // Derived, never pinned: always above whatever head this build has.
  const future = Math.max(99, head + 1);
  const seedPath = await seedHeadProfile(head);
  await incompatibleScenario(seedPath, head, future);
  await compatibleScenario(seedPath, head, future);
  code = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error("NEWER-DATABASE SMOKE FAILED:", error.stack ?? error);
  if (failures.length === 0) failures.push(error.stack ?? String(error));
  for (const run of runs) {
    console.error(`${run.label} stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    if (run.page)
      await run.page
        .screenshot({ path: join(scratch, `${run.label.replaceAll(" ", "-")}-failure.png`) })
        .catch(() => undefined);
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
    if (code === 0)
      for (const name of ["seed", "incompatible", "compatible"])
        await fs.rm(join(scratch, name), { recursive: true, force: true });
  }
}
console.log(`${code === 0 ? "ALL CHECKS PASSED" : "FAILED"}: ${checks.length} completed checks`);
process.exitCode = code;
