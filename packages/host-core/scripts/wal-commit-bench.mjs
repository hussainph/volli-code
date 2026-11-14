#!/usr/bin/env node
/**
 * WAL commit latency on a large database (VC-1103).
 *
 * Times the draft save's `app_state` UPSERT and simulated Session appends on
 * one connection, the way Electron main shares one connection, and labels
 * each commit: did an automatic WAL checkpoint run inside it (the `-shm`
 * wal-index's `nBackfill` moved forward), how much of its wall time was this
 * thread's CPU, and how big the WAL grew. A 50 ms lag probe applies the main
 * stall monitor's rule (late ≥ 200 ms; off-CPU when CPU < half).
 *
 * Run it on a COPY: it appends Session Events and writes `app_state`.
 *
 *   cp -c <profile>/volli.db /tmp/wal-bench.db   # an APFS clone, or a bench fixture's volli.db
 *   node packages/host-core/scripts/wal-commit-bench.mjs /tmp/wal-bench.db --seconds 45
 *
 * Arms:
 *   --checkpoint auto     production: `wal_autocheckpoint = 400` on this connection (default)
 *   --checkpoint worker   autocheckpoint off here, a PASSIVE checkpoint every second from a
 *                         second connection on a worker thread (the off-main candidate)
 *   --reader-pin-ms N     a worker holds a read transaction N ms at a time, as the automatic
 *                         backup's one-step copy does
 *   --backup              a worker copies the whole database once, as the automatic backup does
 *   --backup-mode M       how that copy is taken (VC-1201):
 *                           one-step  one `backup()` step, one long read transaction (before VC-1201)
 *                           steps     `backup()` in steps of --step-pages pages, each its own read
 *                                     transaction; reports restarts, and gives up when the run ends
 *                           clone     `copyLiveDatabase` (`src/backup/live-snapshot.ts`), the
 *                                     production copy: clones under a short read transaction
 *                                     while main holds its automatic checkpoint
 *                           clone-nohold  the same without main's hold
 *   --backup-delay-ms N   when the copy starts, after the load does (default 3000)
 *   --catch-up worker     main turns its automatic checkpoint off while the copy runs; when the
 *                         copy is done a one-shot worker connection backfills the WAL in PASSIVE
 *                         passes until under 400 frames remain, then main turns it back on
 *   --backup-checkpoint   after the copy, the worker runs `wal_checkpoint(PASSIVE)` on its own
 *                         read-write connection (VC-1201's option a)
 *
 * The connection mirrors `openVolliDb`'s pragmas (`src/db/database-file.ts`);
 * keep them in step. Payloads are the database's own, sampled and never printed.
 * Prints one JSON summary.
 */
import { closeSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const Database = createRequire(import.meta.url)("better-sqlite3");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const threadCpuMs = () => {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / 1000;
};

/** Nearest-rank percentile, to a tenth of a millisecond. */
function quantile(list, p) {
  if (list.length === 0) return null;
  const sorted = list.toSorted((a, b) => a - b);
  return (
    Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] * 10) /
    10
  );
}

if (isMainThread) await main();
else await worker();

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      seconds: { type: "string", default: "45" },
      sessions: { type: "string", default: "4" },
      "event-ms": { type: "string", default: "50" },
      "draft-ms": { type: "string", default: "200" },
      "draft-bytes": { type: "string", default: "3000" },
      checkpoint: { type: "string", default: "auto" },
      "reader-pin-ms": { type: "string", default: "0" },
      backup: { type: "boolean", default: false },
      "backup-mode": { type: "string", default: "one-step" },
      "step-pages": { type: "string", default: "1000" },
      "backup-checkpoint": { type: "boolean", default: false },
      "backup-delay-ms": { type: "string", default: "3000" },
      "catch-up": { type: "string", default: "main" },
    },
  });
  const dbPath = positionals[0];
  if (dbPath === undefined)
    throw new Error("usage: wal-commit-bench.mjs <copy-of-volli.db> [options]");
  const seconds = Number(values.seconds);
  const eventMs = Number(values["event-ms"]);
  const draftMs = Number(values["draft-ms"]);
  const draftBytes = Number(values["draft-bytes"]);
  const readerPinMs = Number(values["reader-pin-ms"]);
  const mode = values.checkpoint;
  if (mode !== "auto" && mode !== "worker") throw new Error("--checkpoint is auto or worker");
  const backupMode = values["backup-mode"];
  if (!["one-step", "steps", "clone", "clone-nohold"].includes(backupMode))
    throw new Error("--backup-mode is one-step, steps, clone or clone-nohold");

  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000");
  db.pragma("mmap_size = 268435456");
  db.pragma("temp_store = MEMORY");
  db.pragma(mode === "auto" ? "wal_autocheckpoint = 400" : "wal_autocheckpoint = 0");

  // The wal-index header: mxFrame at byte 16, then WalCkptInfo.nBackfill at 96 (native order).
  const shm = openSync(`${dbPath}-shm`, "r");
  const header = Buffer.alloc(100);
  const walState = () => {
    readSync(shm, header, 0, 100, 0);
    return { mxFrame: header.readUInt32LE(16), nBackfill: header.readUInt32LE(96) };
  };
  const walBytes = () => statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0;

  const sessions = db
    .prepare(
      `SELECT session_id, MAX(sequence) AS sequence, MIN(provenance_id) AS provenance
         FROM session_events GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT ?`,
    )
    .all(Number(values.sessions));
  const payloads = db
    .prepare(
      `SELECT payload FROM session_events WHERE rowid IN
         (SELECT rowid FROM session_events ORDER BY random() LIMIT 400)`,
    )
    .all()
    .map((row) => row.payload);
  if (sessions.length === 0 || payloads.length === 0) throw new Error("no Session Events to copy");
  const insertEvent = db.prepare(
    `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at, provenance_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const appendEvent = db.transaction((session) => {
    session.sequence += 1;
    const now = Date.now();
    const payload = payloads[Math.floor(Math.random() * payloads.length)];
    insertEvent.run(
      randomUUID(),
      session.session_id,
      session.sequence,
      now,
      now,
      session.provenance,
      payload,
    );
  });
  // The `volli:app-state-set` handler: read the previous value, then upsert.
  const readState = db.prepare("SELECT * FROM app_state WHERE key = ?");
  const upsertState = db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  const timed = (kind, write) => {
    const before = walState();
    const cpu = threadCpuMs();
    const started = performance.now();
    write();
    const wall = performance.now() - started;
    const after = walState();
    // A restart (mxFrame back to the start) is the cheap reset after a finished
    // checkpoint; a checkpoint is nBackfill moving forward inside this commit.
    const restarted = after.mxFrame < before.mxFrame;
    const backfilled = after.nBackfill - (restarted ? 0 : before.nBackfill);
    return {
      kind,
      at: Date.now() - startedAt,
      wall,
      cpu: threadCpuMs() - cpu,
      checkpointed: backfilled > 0,
      backfilled,
      walFrames: after.mxFrame,
    };
  };

  // Times below (`at`) count from here, when the load starts.
  const startedAt = Date.now();
  const drafts = [];
  const events = [];
  const ticks = [];
  let walMax = 0;
  let draftNumber = 0;
  const timers = [
    setInterval(() => {
      draftNumber += 1;
      const value = JSON.stringify({
        draft: "x".repeat(Math.max(0, draftBytes - 24)),
        n: draftNumber,
      });
      drafts.push(
        timed("draft", () => {
          readState.get("volli:chat-drafts");
          upsertState.run("volli:chat-drafts", value, Date.now());
        }),
      );
    }, draftMs),
    ...sessions.map((session) =>
      setInterval(() => events.push(timed("event", () => appendEvent(session))), eventMs),
    ),
  ];
  let lastTick = performance.now();
  let lastCpu = threadCpuMs();
  timers.push(
    setInterval(() => {
      const at = performance.now();
      const cpu = threadCpuMs();
      ticks.push({ late: Math.max(0, at - lastTick - 50), cpu: cpu - lastCpu });
      lastTick = at;
      lastCpu = cpu;
      walMax = Math.max(walMax, walBytes());
    }, 50),
  );

  const helpers = [];
  const helper = (job) => {
    const thread = new Worker(new URL(import.meta.url), {
      workerData: { dbPath, startedAt, ...job },
    });
    const done = new Promise((resolve) => thread.once("exit", resolve));
    thread.on("message", (message) => {
      // The WAL the copy left behind, read the moment the copy reports done.
      if (message.kind === "backup-done") message.walBytesAtDone = walBytes();
      // `holdAutocheckpoint` (src/db/autocheckpoint.ts), as main runs it for the copy.
      if (message.kind === "hold") {
        db.pragma("wal_autocheckpoint = 0");
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        thread.postMessage("held");
        return;
      }
      if (message.kind === "release") {
        db.pragma(mode === "auto" ? "wal_autocheckpoint = 400" : "wal_autocheckpoint = 0");
        return;
      }
      helperMessages.push(message);
      if (values["catch-up"] !== "worker") return;
      if (message.kind === "backup-start") db.pragma("wal_autocheckpoint = 0");
      if (message.kind === "backup-done") {
        helper({ job: "catch-up" });
        helpers
          .at(-1)
          .done.then(() =>
            db.pragma(mode === "auto" ? "wal_autocheckpoint = 400" : "wal_autocheckpoint = 0"),
          );
      }
    });
    helpers.push({ thread, done });
  };
  const helperMessages = [];
  if (mode === "worker") helper({ job: "checkpoint" });
  if (readerPinMs > 0) helper({ job: "pin", readerPinMs });
  if (values.backup)
    helper({
      job: "backup",
      backupMode,
      stepPages: Number(values["step-pages"]),
      backupCheckpoint: values["backup-checkpoint"],
      backupDelayMs: Number(values["backup-delay-ms"]),
    });

  await sleep(seconds * 1000);
  for (const timer of timers) clearInterval(timer);
  // A worker thread, not a window: there is no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  for (const { thread } of helpers) thread.postMessage("stop");
  await Promise.all(helpers.map(({ done }) => done));

  const commits = (records) => {
    const walls = records.map((record) => record.wall);
    const checkpoints = records.filter((record) => record.checkpointed);
    return {
      count: records.length,
      wallMs: {
        p50: quantile(walls, 50),
        p95: quantile(walls, 95),
        p99: quantile(walls, 99),
        max: quantile(walls, 100),
      },
      atLeast200Ms: records.filter((record) => record.wall >= 200).length,
      withCheckpoint: {
        count: checkpoints.length,
        wallMs: {
          p50: quantile(
            checkpoints.map((r) => r.wall),
            50,
          ),
          max: quantile(
            checkpoints.map((r) => r.wall),
            100,
          ),
        },
        offCpuMsMax: quantile(
          checkpoints.map((r) => r.wall - r.cpu),
          100,
        ),
        framesMax: Math.max(0, ...checkpoints.map((r) => r.backfilled)),
      },
      withoutCheckpointMaxMs: quantile(
        records.filter((r) => !r.checkpointed).map((r) => r.wall),
        100,
      ),
    };
  };
  const stalls = ticks.filter((tick) => tick.late >= 200);
  // Around the copy: commits while it ran, the first checkpoint after it, and the rest.
  const backupStart = helperMessages.find((m) => m.kind === "backup-start")?.at;
  const backupDone = helperMessages.find((m) => m.kind === "backup-done")?.at;
  const phases = (() => {
    if (backupStart === undefined) return undefined;
    const all = [...drafts, ...events].toSorted((a, b) => a.at - b.at);
    const end = backupDone ?? Infinity;
    const during = all.filter((r) => r.at >= backupStart && r.at <= end);
    const catchUp = all.find((r) => r.at > end && r.checkpointed);
    const later = all.filter((r) => r.at > end && r !== catchUp);
    const shape = (list) => ({
      commits: list.length,
      maxMs: quantile(
        list.map((r) => r.wall),
        100,
      ),
      checkpointMaxMs: quantile(
        list.filter((r) => r.checkpointed).map((r) => r.wall),
        100,
      ),
      checkpointP50Ms: quantile(
        list.filter((r) => r.checkpointed).map((r) => r.wall),
        50,
      ),
      withoutCheckpointMaxMs: quantile(
        list.filter((r) => !r.checkpointed).map((r) => r.wall),
        100,
      ),
      atLeast200Ms: list.filter((r) => r.wall >= 200).length,
    });
    return {
      before: shape(all.filter((r) => r.at < backupStart)),
      during: shape(during),
      catchUp:
        catchUp === undefined
          ? null
          : {
              at: catchUp.at,
              wallMs: Math.round(catchUp.wall * 10) / 10,
              cpuMs: Math.round(catchUp.cpu * 10) / 10,
              backfilled: catchUp.backfilled,
            },
      after: shape(later),
    };
  })();
  const checkpointMessages = helperMessages.filter((message) => message.kind === "checkpoint");
  console.log(
    JSON.stringify(
      {
        arm: {
          checkpoint: mode,
          readerPinMs,
          backup: values.backup,
          ...(values.backup
            ? {
                backupMode,
                backupCheckpoint: values["backup-checkpoint"],
                catchUp: values["catch-up"],
              }
            : {}),
        },
        load: { seconds, sessions: sessions.length, eventMs, draftMs, draftBytes },
        appStateSet: commits(drafts),
        sessionAppend: commits(events),
        loop: {
          lateP95Ms: quantile(
            ticks.map((tick) => tick.late),
            95,
          ),
          lateMaxMs: quantile(
            ticks.map((tick) => tick.late),
            100,
          ),
          stalls: stalls.length,
          offCpuStalls: stalls.filter((tick) => tick.cpu < tick.late / 2).length,
        },
        wal: { maxBytes: walMax, endBytes: walBytes() },
        phases,
        // The slowest commits of either kind, with when they ran (ms from start).
        worst: [...drafts, ...events]
          .toSorted((a, b) => b.wall - a.wall)
          .slice(0, 4)
          .map((r) => ({
            kind: r.kind,
            at: r.at,
            wallMs: Math.round(r.wall * 10) / 10,
            cpuMs: Math.round(r.cpu * 10) / 10,
            backfilled: r.backfilled,
            walFrames: r.walFrames,
          })),
        helper:
          helperMessages.length === 0
            ? undefined
            : {
                checkpoints: checkpointMessages.length,
                checkpointMsMax: quantile(
                  checkpointMessages.map((m) => m.ms),
                  100,
                ),
                busy: checkpointMessages.filter((m) => m.busy).length,
                other: helperMessages.filter((message) => message.kind !== "checkpoint"),
              },
      },
      null,
      1,
    ),
  );
  closeSync(shm);
  db.close();
}

/** Hands a helper's result to the main thread. */
function report(message) {
  // A worker thread's port, not a window: there is no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort.postMessage(message);
}

async function worker() {
  const {
    dbPath,
    job,
    readerPinMs,
    startedAt,
    backupMode,
    stepPages,
    backupCheckpoint,
    backupDelayMs,
  } = workerData;
  const state = { stopped: false, held: undefined };
  parentPort.on("message", (message) => {
    if (message === "stop") state.stopped = true;
    if (message === "held") state.held?.();
  });
  if (job === "checkpoint") {
    const db = new Database(dbPath, { timeout: 0 });
    db.pragma("wal_autocheckpoint = 0");
    while (!state.stopped) {
      await sleep(1000);
      const started = performance.now();
      const [row] = db.pragma("wal_checkpoint(PASSIVE)");
      report({
        kind: "checkpoint",
        ms: performance.now() - started,
        busy: row.busy !== 0,
      });
    }
    db.close();
  } else if (job === "catch-up") {
    // One shot, right after the copy: PASSIVE passes until main's own threshold.
    const db = new Database(dbPath, { timeout: 0 });
    db.pragma("wal_autocheckpoint = 0");
    const passes = [];
    for (let pass = 0; pass < 20; pass += 1) {
      const began = performance.now();
      const cpu = threadCpuMs();
      const [row] = db.pragma("wal_checkpoint(PASSIVE)");
      passes.push({
        ms: Math.round(performance.now() - began),
        cpuMs: Math.round(threadCpuMs() - cpu),
        busy: row.busy,
        log: row.log,
        checkpointed: row.checkpointed,
      });
      if (row.busy === 0 && row.log - row.checkpointed < 400) break;
    }
    report({ kind: "catch-up", at: Date.now() - startedAt, passes });
    db.close();
  } else if (job === "pin") {
    const db = new Database(dbPath, { readonly: true });
    await sleep(3000);
    while (!state.stopped) {
      db.exec("BEGIN");
      db.prepare("SELECT count(*) FROM app_state").get();
      const started = performance.now();
      while (!state.stopped && performance.now() - started < readerPinMs) await sleep(100);
      db.exec("COMMIT");
      report({
        kind: "reader-released",
        at: Date.now() - startedAt,
        heldMs: Math.round(performance.now() - started),
      });
      await sleep(2000);
    }
    db.close();
  } else if (job === "backup") {
    await sleep(backupDelayMs);
    report({ kind: "backup-start", at: Date.now() - startedAt });
    const source = new Database(dbPath, { readonly: true });
    source.pragma("cache_size = -2048");
    const target = `${dbPath}.wal-bench-copy`;
    const started = performance.now();
    const done = { kind: "backup-done", backupMode };
    if (backupMode === "one-step") {
      // The automatic backup's call before VC-1201: one step, one read transaction.
      await source.backup(target, { progress: () => 0x7fff_ffff });
    } else if (backupMode === "steps") {
      // Each step is its own read transaction; another connection's write restarts the copy.
      let restarts = 0;
      let lastRemaining = Infinity;
      try {
        await source.backup(target, {
          progress: ({ remainingPages }) => {
            if (state.stopped) throw new Error("run ended");
            if (remainingPages > lastRemaining) restarts += 1;
            lastRemaining = remainingPages;
            return stepPages;
          },
        });
      } catch (error) {
        done.unfinished = error instanceof Error ? error.message : String(error);
      }
      Object.assign(done, { stepPages, restarts, remainingPages: lastRemaining });
    } else {
      const { copyLiveDatabase } = await import("../src/backup/live-snapshot.ts");
      const { cloneOrCopyFile } = await import("../src/db/file-clone.ts");
      const result = await copyLiveDatabase(source, dbPath, target, {
        clone: (from, to) => cloneOrCopyFile(from, to),
        holdCheckpoints: async () => {
          if (backupMode === "clone-nohold") return () => {};
          const held = new Promise((resolve) => (state.held = resolve));
          report({ kind: "hold" });
          await held;
          return () => report({ kind: "release" });
        },
      });
      done.readTransactionMs = Math.round(result.readTransactionMs * 10) / 10;
      done.holdMs = Math.round(result.holdMs * 10) / 10;
      done.method = result.method;
      done.copiedWalBytes = result.walBytes;
    }
    done.ms = Math.round(performance.now() - started);
    done.at = Date.now() - startedAt;
    report(done);
    source.close();
    if (backupCheckpoint) {
      // Option a: the worker backfills on its own connection before main's next threshold.
      const writer = new Database(dbPath, { timeout: 0 });
      writer.pragma("wal_autocheckpoint = 0");
      const began = performance.now();
      const cpu = threadCpuMs();
      const [row] = writer.pragma("wal_checkpoint(PASSIVE)");
      report({
        kind: "worker-checkpoint",
        at: Date.now() - startedAt,
        ms: Math.round(performance.now() - began),
        cpuMs: Math.round(threadCpuMs() - cpu),
        busy: row.busy,
        log: row.log,
        checkpointed: row.checkpointed,
      });
      writer.close();
    }
    // Kept until the run ends, as the backup keeps its copy while it writes the bundle:
    // a clone shares the live file's blocks until then.
    while (!state.stopped) await sleep(100);
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      rmSync(`${target}${suffix}`, { force: true });
  }
  // Ends this thread only; its message listener would otherwise keep it alive.
  process.exit(0);
}
