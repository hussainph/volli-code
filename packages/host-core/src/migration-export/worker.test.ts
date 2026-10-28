/**
 * The export through a real worker thread: the shipped entry module, loaded
 * the way a host loads it, over the real message protocol.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFixtureProfile, type FixtureProfile } from "../backup/test-fixture";
import { profileMaintenanceActive } from "../backup/profile-maintenance";
import { exportMigrationSnapshot, type MigrationExportProgress } from "./exporter";
import { STATE_FILE, stagingDirOf } from "./staging";
import { verifyMigrationExport } from "./verify";
import {
  runMigrationExportInWorker,
  serveMigrationExportWorker,
  type MigrationExportWorkerMessage,
} from "./worker";

// Each test exports a whole profile through real files; a cold shared CI box is slow.
vi.setConfig({ testTimeout: 30_000 });

const ENTRY = new URL("./test-support/worker-under-node.mjs", import.meta.url);
const EXEC_ARGV = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"];

let profile: FixtureProfile;
let work: string;

beforeEach(() => {
  profile = createFixtureProfile();
  profile.db.pragma("journal_mode = WAL");
  work = mkdtempSync(join(tmpdir(), "volli-migration-worker-"));
});
afterEach(() => {
  profile.cleanup();
  rmSync(work, { recursive: true, force: true });
});

function request(name = "export") {
  return { sourcePath: profile.dbPath, outDir: join(work, name), appVersion: "0.3.0-test" };
}

function streamText(
  dir: string,
  manifest: { streams: Array<{ chunks: Array<{ file: string }> }> },
) {
  // The snapshot time is the one field two exports legitimately differ in.
  return manifest.streams.map((stream) =>
    stream.chunks
      .map((chunk) => readFileSync(join(dir, chunk.file), "utf8"))
      .join("")
      .replaceAll(/"reportedAt":\d+/g, '"reportedAt":0'),
  );
}

/** A worker script of our own, for the failure modes the real entry never shows. */
function script(name: string, source: string): URL {
  const path = join(work, name);
  writeFileSync(path, source);
  return pathToFileURL(path);
}

describe("runMigrationExportInWorker", () => {
  it("exports in a worker thread with progress, matching the in-thread export", async () => {
    const progress: MigrationExportProgress[] = [];
    const result = await runMigrationExportInWorker(ENTRY, request(), {
      execArgv: EXEC_ARGV,
      onProgress: (report) => progress.push(report),
    });
    await verifyMigrationExport(result.outDir);
    expect(progress[0]!.phase).toBe("snapshot");
    expect(progress.at(-1)!.phase).toBe("done");

    const inThread = await exportMigrationSnapshot(request("in-thread"));
    expect(streamText(result.outDir, result.manifest)).toEqual(
      streamText(inThread.outDir, inThread.manifest),
    );
  });

  it("carries project selection across the worker boundary", async () => {
    const result = await runMigrationExportInWorker(
      ENTRY,
      { ...request(), projectIds: ["proj-beta"], includeRemovedProjects: true },
      { execArgv: EXEC_ARGV },
    );
    expect(result.manifest.projectIds).toEqual(["proj-beta"]);
    expect(result.manifest.profileStep).toBe(false);
    await verifyMigrationExport(result.outDir);
  });

  it("cancels into a resumable staging area", async () => {
    const controller = new AbortController();
    const target = request();
    await expect(
      runMigrationExportInWorker(
        ENTRY,
        { ...target, chunkMaxRecords: 1 },
        {
          execArgv: EXEC_ARGV,
          signal: controller.signal,
          onProgress: (report) => {
            if (report.phase === "exporting" && report.bytesWritten > 0) controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(existsSync(target.outDir)).toBe(false);
    expect(existsSync(join(stagingDirOf(target.outDir), STATE_FILE))).toBe(true);
    expect(await profileMaintenanceActive(profile.root)).toBe(false);

    const resumed = await runMigrationExportInWorker(ENTRY, target, { execArgv: EXEC_ARGV });
    expect(resumed.resumed).toBe(true);
    await verifyMigrationExport(target.outDir);
  });

  it("refuses at once when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runMigrationExportInWorker(ENTRY, request(), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("carries the export's own failure code across the thread", async () => {
    await expect(
      runMigrationExportInWorker(
        ENTRY,
        { ...request(), sourcePath: join(work, "missing.db") },
        { execArgv: EXEC_ARGV },
      ),
    ).rejects.toMatchObject({ code: "source_unreadable" });
  });

  it("reports a worker that crashes, exits silently or answers nonsense", async () => {
    await expect(
      runMigrationExportInWorker(script("crash.mjs", 'throw new Error("boom");'), request()),
    ).rejects.toMatchObject({ code: "worker_failed" });
    await expect(
      runMigrationExportInWorker(script("exit.mjs", "process.exit(3);"), request()),
    ).rejects.toMatchObject({ code: "worker_failed", message: expect.stringContaining("(3)") });
    await expect(
      runMigrationExportInWorker(
        script(
          "odd.mjs",
          `import { parentPort } from "node:worker_threads";
           parentPort.postMessage({ type: "failed", code: "weird", message: "odd" });`,
        ),
        request(),
      ),
    ).rejects.toMatchObject({ code: "worker_failed", message: "odd" });
  });

  it("terminates a worker that does not stop within the grace period", async () => {
    const stubborn = script(
      "stubborn.mjs",
      `import { parentPort } from "node:worker_threads";
       parentPort.on("message", () => {});
       parentPort.postMessage({ type: "progress", progress: { phase: "snapshot" } });
       setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    await expect(
      runMigrationExportInWorker(stubborn, request(), {
        signal: controller.signal,
        cancelGraceMs: 50,
        onProgress: () => {
          controller.abort();
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(await profileMaintenanceActive(profile.root)).toBe(false);
  });

  it("refuses to serve outside a worker thread", () => {
    expect(() => serveMigrationExportWorker(null)).toThrow(/inside a worker thread/);
  });
});

/** Serves one request over an in-thread channel and collects what it answers. */
async function serve(data: unknown, before?: (port: MessagePort) => void) {
  const { port1, port2 } = new MessageChannel();
  const messages: MigrationExportWorkerMessage[] = [];
  const final = new Promise<MigrationExportWorkerMessage>((resolve) =>
    port2.on("message", (message: MigrationExportWorkerMessage) => {
      messages.push(message);
      if (message.type !== "progress") resolve(message);
    }),
  );
  before?.(port2);
  serveMigrationExportWorker(port1, data);
  const answer = await final;
  port2.close();
  return { answer, messages };
}

describe("serveMigrationExportWorker", () => {
  it("reports progress and then the result", async () => {
    const { answer, messages } = await serve(request());
    expect(answer.type).toBe("done");
    expect(messages[0]!.type).toBe("progress");
  });

  it("stops when asked to cancel", async () => {
    const { answer } = await serve(request(), (port) => {
      port.postMessage({ type: "something-else" });
      port.postMessage({ type: "cancel" });
    });
    expect(answer).toMatchObject({ type: "failed", code: "cancelled" });
  });

  it("answers a failure with the code the exporter classified it under", async () => {
    mkdirSync(join(stagingDirOf(join(work, "export")), STATE_FILE), { recursive: true });
    const { answer } = await serve(request());
    expect(answer).toMatchObject({ type: "failed", code: "io_failed" });
  });
});

describe("responsiveness", () => {
  it("keeps the calling thread's event loop free while a sizeable profile exports", async () => {
    // ~12 MB of Session history: big enough that an in-thread export would hold
    // the loop for seconds, small enough for a unit test.
    const insert = profile.db.prepare(
      `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at,
                                   provenance_id, attachment_id, command_id, payload)
       VALUES (?, 'session-child', ?, ?, ?, 3, NULL, NULL, ?)`,
    );
    const filler = "x".repeat(2_000);
    profile.db.transaction(() => {
      for (let sequence = 2; sequence < 6_002; sequence += 1) {
        insert.run(
          `bulk-${sequence}`,
          sequence,
          sequence,
          sequence,
          JSON.stringify({ kind: "session.retitled", title: `${filler}${sequence}` }),
        );
      }
    })();

    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const result = await runMigrationExportInWorker(ENTRY, request(), { execArgv: EXEC_ARGV });
    delay.disable();

    expect(result.manifest.streams.find((stream) => stream.name === "sessionEvents")!.records).toBe(
      6_005,
    );
    // The worker did the work: the loop here never stalled for long.
    expect(delay.max / 1e6).toBeLessThan(250);
  });
});
