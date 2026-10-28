// Opt-in scale probe, never part of the test suite. Run from the repo root:
// node --experimental-transform-types packages/host-core/scripts/benchmark-automatic-backup.mjs
// Use TMPDIR inside the worktree to keep all synthetic data isolated. No real
// profile is read. Reports whole-process peak RSS (Node reports KiB), plus the
// increase above a fresh worker host; the fixture is removed even on failure.
import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
await import("../src/secrets/test-support/ts-hooks.mjs");
const { createFixtureProfile } = await import("../src/backup/test-fixture.ts");
const { runAutomaticBackupWorker } = await import("../src/backup/automatic-worker.ts");

const rows = Number(process.env.BACKUP_BENCH_ROWS ?? 2_150_000);
if (!Number.isSafeInteger(rows) || rows < 1)
  throw new Error("BACKUP_BENCH_ROWS must be a positive integer");
if (!process.env.TMPDIR || !resolve(process.env.TMPDIR).startsWith(`${process.cwd()}/`))
  throw new Error("Set TMPDIR to a directory inside this worktree.");
const builtWorker = process.env.BACKUP_BENCH_WORKER;
if (builtWorker && !resolve(builtWorker).startsWith(`${process.cwd()}/`))
  throw new Error("BACKUP_BENCH_WORKER must be a built entry inside this worktree.");
mkdirSync(process.env.TMPDIR, { recursive: true });
const fixture = createFixtureProfile();
try {
  fixture.db.pragma("journal_mode = OFF");
  fixture.db.pragma("cache_size = -2048");
  const template = fixture.db
    .prepare("SELECT * FROM session_events WHERE session_id = 'session-root' LIMIT 1")
    .get();
  const columns = Object.keys(template);
  const insert = fixture.db.prepare(
    `INSERT INTO session_events (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  const seedStart = performance.now();
  for (let offset = 0; offset < rows; offset += 5000) {
    fixture.db.transaction(() => {
      for (let index = offset; index < Math.min(rows, offset + 5000); index++) {
        const digest = createHash("sha256").update(`synthetic-${index}`).digest("hex");
        const row = {
          ...template,
          id: `synthetic-event-${index}`,
          sequence: index + 100,
          command_id: null,
          payload: JSON.stringify({ kind: "synthetic.fixture", text: digest.repeat(5) }),
        };
        insert.run(...columns.map((column) => row[column]));
      }
    })();
  }
  fixture.db.close();
  const databaseBytes = statSync(fixture.dbPath).size;
  const baselineRss = process.memoryUsage().rss;
  const baselinePeakKiB = process.resourceUsage().maxRSS;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const started = performance.now();
  const result = await runAutomaticBackupWorker(
    builtWorker
      ? pathToFileURL(resolve(builtWorker))
      : new URL("../src/backup/test-support/worker-under-node.mjs", import.meta.url),
    {
      dataDir: fixture.root,
      dbPath: fixture.dbPath,
      blobsRoot: fixture.blobsRoot,
      transcriptsRoot: fixture.transcriptsRoot,
      appVersion: "benchmark",
      outputPath: join(fixture.root, "backups", "benchmark.tar.gz"),
      now: Date.now(),
    },
    new AbortController().signal,
    (notice) => {
      if (notice) console.error(notice);
    },
    builtWorker ? [] : ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"],
  );
  delay.disable();
  console.log(
    JSON.stringify(
      {
        rows,
        workerEntry: builtWorker ? "packed" : "source",
        databaseBytes,
        seedSeconds: (started - seedStart) / 1000,
        backupSeconds: (performance.now() - started) / 1000,
        bundleBytes: result.sizeBytes,
        baselineRss,
        baselinePeakKiB,
        peakRssKiB: process.resourceUsage().maxRSS,
        extraPeakRssBytes: Math.max(0, process.resourceUsage().maxRSS * 1024 - baselineRss),
        mainEventLoopMaxDelayMs: delay.max / 1e6,
      },
      null,
      2,
    ),
  );
} finally {
  fixture.cleanup();
}
