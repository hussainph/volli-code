// The large-profile backup -> restore round trip (VC-988): an opt-in rehearsal,
// never part of the unit suite. CI extended runs it at full size; run it from
// the repo root:
//
//   TMPDIR=$PWD/.tmp/rehearsal node --experimental-transform-types \
//     packages/host-core/scripts/rehearse-backup-restore.mjs
//
// It builds a synthetic profile (the backup fixture plus BACKUP_REHEARSAL_ROWS
// Session events, default 2,150,000, sized so data.json is past 1.6 GB and
// past V8's maximum string length), backs it up through the production
// automatic-backup worker, restores the bundle FILE with
// restoreBackupBundleFile into a fresh profile, and proves the round trip:
// every carried table's row count and digest, every blob and transcript, the
// rebuilt usage projection against its events. The backup and the restore
// each run in their own process so each reports its own time and peak RSS.
// No real profile or credential is read; the fixture is removed even on
// failure. Exits non-zero on any mismatch or on a restore whose RSS growth
// exceeds BACKUP_REHEARSAL_MAX_EXTRA_RSS_MIB (default 512).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as bufferConstants } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

await import("../src/secrets/test-support/ts-hooks.mjs");

const SCRIPT = fileURLToPath(import.meta.url);
const NODE_FLAGS = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"];
const NOW = Date.UTC(2026, 9, 29);

/** Runs one phase of this script in a fresh process and returns its JSON line. */
function child(phase, input) {
  const inputPath = join(input.workDir, `${phase}-input.json`);
  writeFileSync(inputPath, JSON.stringify(input));
  const run = spawnSync(process.execPath, [...NODE_FLAGS, SCRIPT, phase, inputPath], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`${phase} exited with ${run.status ?? run.signal}`);
  const lines = run.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

/** A phase's own resource report: wall time, RSS before the work, peak RSS. */
async function measured(work) {
  const baselineRss = process.memoryUsage().rss;
  const started = performance.now();
  const result = await work();
  // Node reports maxRSS in KiB on every platform.
  const peakRss = process.resourceUsage().maxRSS * 1024;
  return {
    seconds: (performance.now() - started) / 1000,
    baselineRss,
    peakRss,
    extraPeakRss: Math.max(0, peakRss - baselineRss),
    result,
  };
}

const phases = {
  async backup(input) {
    const { runAutomaticBackupWorker } = await import("../src/backup/automatic-worker.ts");
    return measured(() =>
      runAutomaticBackupWorker(
        new URL("../src/backup/test-support/worker-under-node.mjs", import.meta.url),
        {
          dataDir: input.sourceRoot,
          dbPath: join(input.sourceRoot, "volli.db"),
          blobsRoot: join(input.sourceRoot, "blobs"),
          transcriptsRoot: join(input.sourceRoot, "session-transcripts"),
          appVersion: "rehearsal",
          outputPath: input.bundlePath,
          now: NOW,
        },
        new AbortController().signal,
        (notice) => {
          if (notice) console.error(notice);
        },
        NODE_FLAGS,
      ),
    );
  },

  async restore(input) {
    const { restoreBackupBundleFile } = await import("../src/backup/restore.ts");
    return measured(async () => {
      const result = await restoreBackupBundleFile({
        bundlePath: input.bundlePath,
        profileRoot: input.targetRoot,
        projectPaths: input.projectPaths,
        now: NOW + 1,
      });
      if (!result.ok) return result;
      const { credentials: _credentials, ...report } = result.report;
      return { ok: true, report };
    });
  },

  async digest(input) {
    const { default: Database } = await import("better-sqlite3");
    const { digestProfile } = await import("../src/backup/test-support/profile-digest.ts");
    return measured(async () => {
      const db = new Database(join(input.root, "volli.db"), { readonly: true });
      try {
        db.pragma("cache_size = -8192");
        const digest = await digestProfile(db, {
          blobsRoot: join(input.root, "blobs"),
          transcriptsRoot: join(input.root, "session-transcripts"),
        });
        const usageEvents = db
          .prepare(
            "SELECT COUNT(*) AS n FROM session_events WHERE json_extract(payload, '$.kind') = 'usage.recorded'",
          )
          .get().n;
        const projects = db.prepare("SELECT id, path FROM projects ORDER BY id").all();
        return { digest, usageEvents, projects };
      } finally {
        db.close();
      }
    });
  },

  async manifest(input) {
    const { ArchiveStreamReader } = await import("../src/backup/archive.ts");
    const { readGunzipped } = await import("../src/backup/streaming.ts");
    // The manifest is the first entry a Volli writer emits: read it and stop.
    const reader = new ArchiveStreamReader(readGunzipped(input.bundlePath));
    const entry = await reader.nextEntry();
    if (entry?.path !== "manifest.json") throw new Error("manifest.json is not the first entry");
    const parts = [];
    for (let chunk = await entry.read(); chunk !== null; chunk = await entry.read()) {
      parts.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  },
};

function mib(bytes) {
  return Number((bytes / 1048576).toFixed(1));
}

async function seedSource(rows, textBytes) {
  const { createFixtureProfile } = await import("../src/backup/test-fixture.ts");
  const fixture = createFixtureProfile();
  const started = performance.now();
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
    const repeats = Math.max(1, Math.ceil(textBytes / 64));
    for (let offset = 0; offset < rows; offset += 5000) {
      fixture.db.transaction(() => {
        for (let index = offset; index < Math.min(rows, offset + 5000); index++) {
          const digest = createHash("sha256").update(`synthetic-${index}`).digest("hex");
          const row = {
            ...template,
            id: `synthetic-event-${index}`,
            sequence: index + 100,
            command_id: null,
            payload: JSON.stringify({
              kind: "synthetic.fixture",
              index,
              text: digest.repeat(repeats).slice(0, textBytes),
            }),
          };
          insert.run(...columns.map((column) => row[column]));
        }
      })();
    }
  } finally {
    fixture.db.close();
  }
  return {
    root: fixture.root,
    cleanup: () => rmSync(fixture.root, { recursive: true, force: true }),
    seedSeconds: (performance.now() - started) / 1000,
  };
}

async function main() {
  const rows = Number(process.env.BACKUP_REHEARSAL_ROWS ?? 2_150_000);
  const textBytes = Number(process.env.BACKUP_REHEARSAL_TEXT_BYTES ?? 448);
  const fullSize = rows >= 2_150_000;
  const minDataBytes = Number(
    process.env.BACKUP_REHEARSAL_MIN_DATA_BYTES ?? (fullSize ? 1_600_000_000 : 0),
  );
  const maxExtraRssMiB = Number(process.env.BACKUP_REHEARSAL_MAX_EXTRA_RSS_MIB ?? 512);
  for (const [name, value] of Object.entries({ rows, textBytes, minDataBytes, maxExtraRssMiB })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be an integer`);
  }
  if (!process.env.TMPDIR || !resolve(process.env.TMPDIR).startsWith(`${process.cwd()}/`))
    throw new Error("Set TMPDIR to a directory inside this worktree.");
  mkdirSync(process.env.TMPDIR, { recursive: true });

  const workDir = mkdtempSync(join(process.env.TMPDIR, "volli-rehearsal-"));
  const source = await seedSource(rows, textBytes);
  try {
    const bundlePath = join(workDir, "backups", "rehearsal.tar.gz");
    mkdirSync(join(workDir, "backups"));
    const sourceBytes = statSync(join(source.root, "volli.db")).size;

    const sourceDigest = child("digest", { workDir, root: source.root });
    const backup = child("backup", { workDir, sourceRoot: source.root, bundlePath });
    const manifest = child("manifest", { workDir, bundlePath });
    const dataEntry = manifest.entries.find((entry) => entry.path === "data.json");

    // A fresh profile the app has never opened, with a checkout per project.
    const targetRoot = join(workDir, "target");
    mkdirSync(targetRoot);
    const { default: Database } = await import("better-sqlite3");
    const empty = new Database(join(targetRoot, "volli.db"));
    empty.pragma("user_version = 0");
    empty.close();
    const projectPaths = {};
    for (const { id } of sourceDigest.result.projects) {
      projectPaths[id] = join(workDir, "checkouts", id);
      mkdirSync(projectPaths[id], { recursive: true });
    }

    const restore = child("restore", { workDir, bundlePath, targetRoot, projectPaths });
    const restoredDigest = restore.result.ok
      ? child("digest", { workDir, root: targetRoot })
      : undefined;

    const failures = [];
    if (!restore.result.ok) {
      failures.push(`restore refused: ${JSON.stringify(restore.result.problems)}`);
    }
    if (restoredDigest !== undefined) {
      const before = sourceDigest.result.digest;
      const after = restoredDigest.result.digest;
      for (const table of new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])) {
        if (JSON.stringify(before.tables[table]) !== JSON.stringify(after.tables[table])) {
          failures.push(
            `table ${table}: source ${JSON.stringify(before.tables[table])}, restored ${JSON.stringify(after.tables[table])}`,
          );
        }
      }
      for (const store of ["blobs", "transcripts"]) {
        if (JSON.stringify(before[store]) !== JSON.stringify(after[store])) {
          failures.push(
            `${store}: source ${JSON.stringify(before[store])}, restored ${JSON.stringify(after[store])}`,
          );
        }
      }
      if (after.usage.rows !== restoredDigest.result.usageEvents) {
        failures.push(
          `usage: ${after.usage.rows} rebuilt rows for ${restoredDigest.result.usageEvents} usage events`,
        );
      }
      for (const { id, path } of restoredDigest.result.projects) {
        if (path !== projectPaths[id]) failures.push(`project ${id} restored at ${path}`);
      }
      const counts = restore.result.report.rowCounts;
      for (const [table, digest] of Object.entries(before.tables)) {
        if ((counts[table] ?? 0) !== digest.rows) {
          failures.push(
            `report counts ${counts[table]} ${table} rows; the source has ${digest.rows}`,
          );
        }
      }
    }
    if ((dataEntry?.sizeBytes ?? 0) < minDataBytes) {
      failures.push(`data.json is ${dataEntry?.sizeBytes} bytes, under ${minDataBytes}`);
    }
    if (restore.extraPeakRss > maxExtraRssMiB * 1024 * 1024) {
      failures.push(
        `restore peak RSS grew ${(restore.extraPeakRss / 1048576).toFixed(1)} MiB, over ${maxExtraRssMiB} MiB`,
      );
    }

    const summary = {
      rows,
      sessionEventRows: sourceDigest.result.digest.tables.session_events?.rows,
      sourceDatabaseBytes: sourceBytes,
      dataJsonBytes: dataEntry?.sizeBytes,
      v8MaxStringLength: bufferConstants.MAX_STRING_LENGTH,
      dataJsonExceedsV8String: (dataEntry?.sizeBytes ?? 0) > bufferConstants.MAX_STRING_LENGTH,
      bundleBytes: statSync(bundlePath).size,
      restoredDatabaseBytes: restore.result.ok ? statSync(join(targetRoot, "volli.db")).size : null,
      seedSeconds: Number(source.seedSeconds.toFixed(1)),
      backup: {
        seconds: Number(backup.seconds.toFixed(1)),
        baselineRssMiB: mib(backup.baselineRss),
        peakRssMiB: mib(backup.peakRss),
        extraPeakRssMiB: mib(backup.extraPeakRss),
      },
      restore: {
        seconds: Number(restore.seconds.toFixed(1)),
        baselineRssMiB: mib(restore.baselineRss),
        peakRssMiB: mib(restore.peakRss),
        extraPeakRssMiB: mib(restore.extraPeakRss),
        budgetMiB: maxExtraRssMiB,
      },
      digestSeconds: {
        source: Number(sourceDigest.seconds.toFixed(1)),
        restored: restoredDigest ? Number(restoredDigest.seconds.toFixed(1)) : null,
      },
      tablesCompared: Object.keys(sourceDigest.result.digest.tables).length,
      artifacts: {
        blobs: sourceDigest.result.digest.blobs.rows,
        transcripts: sourceDigest.result.digest.transcripts.rows,
      },
      sessionEventsSha256: restoredDigest?.result.digest.tables.session_events?.sha256,
      ok: failures.length === 0,
      failures,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    source.cleanup();
    rmSync(workDir, { recursive: true, force: true });
  }
}

const [phase, inputPath] = process.argv.slice(2);
if (phase === undefined) {
  await main();
} else {
  const { readFileSync } = await import("node:fs");
  const run = phases[phase];
  if (run === undefined) throw new Error(`unknown phase ${phase}`);
  const output = await run(JSON.parse(readFileSync(inputPath, "utf8")));
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
}
