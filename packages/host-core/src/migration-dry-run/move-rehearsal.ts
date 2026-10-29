/** The staging rehearsal: clone once, disposable engine processes, verify, clean up. */
import { fork, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import Database from "better-sqlite3";
import { MIGRATION_IMPORT_STREAMS } from "@volli/shared/cloud";
import {
  assertCopyPaths,
  assertProfileIdle,
  assertReportPath,
  rehearsalTarget,
} from "./move-safety";
import {
  moveAuthorization,
  rehearsalBackend,
  rehearsalRedaction,
  type MoveJob,
} from "./move-worker";

interface ProjectResult {
  moveId: string;
  state: string;
  rows: Record<string, number>;
  failureCode: string | null;
  refused: Record<string, number>;
  verified: boolean;
  realPath: boolean;
}
export interface RehearsalResult {
  outcome: string;
  projects: ProjectResult[];
  profileRefused: Record<string, number>;
}

const REFUSAL_CODES = new Set([
  "invalid_id",
  "invalid_field",
  "unstorable",
  "conflict",
  "duplicate_key",
  "schema",
  "foreign_identity",
  "not_personal",
  "invalid_argument",
  "runner_unavailable",
  "already_migrated",
  "github_link",
  "invalid_key",
  "invalid_visibility",
  "missing_reference",
  "not_found",
  "not_moved",
  "outside_project",
  "backend_error",
]);
function reportCounts(
  counts: Record<string, number>,
  allowed: ReadonlySet<string>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || count < 0) continue;
    const name = allowed.has(key) ? key : "other";
    result[name] = (result[name] ?? 0) + count;
  }
  return result;
}

/** Report projection is deliberately explicit: never spread a journal/result. */
export function rehearsalMetrics(result: RehearsalResult, elapsedMs: number) {
  return {
    elapsedMs,
    outcome: result.outcome,
    profileRefused: reportCounts(result.profileRefused, REFUSAL_CODES),
    projects: result.projects.map((project) => ({
      state: project.state,
      rows: reportCounts(project.rows, new Set(MIGRATION_IMPORT_STREAMS)),
      failureCode: project.failureCode,
      refused: reportCounts(project.refused, REFUSAL_CODES),
      verified: project.verified,
      realPath: project.realPath,
    })),
  };
}

function rehearsalImports(job: MoveJob): string[] {
  if (!existsSync(join(job.profile, "volli.db"))) return [];
  const db = new Database(join(job.profile, "volli.db"), { readonly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_moves'").get())
      return [];
    return (
      db.prepare("SELECT move_id FROM cloud_moves WHERE workspace_id=?").all(job.workspaceId) as {
        move_id: string;
      }[]
    ).map((row) => row.move_id);
  } finally {
    db.close();
  }
}

/** Recovery after a killed parent or an expired token. State is private, not a report. */
export async function cleanupRehearsalState(
  file: string,
  waitPurged = waitForPurge,
): Promise<void> {
  const job = JSON.parse(readFileSync(file, "utf8")) as MoveJob & { cleanupMoves?: string[] };
  const target = rehearsalTarget(job.target, job.allowProduction);
  if (
    (!process.env.VOLLI_MOVE_TOKEN && !process.env.VOLLI_MOVE_TOKEN_FILE) ||
    !process.env.VOLLI_MOVE_ADMIN_KEY
  )
    throw new Error("rehearsal_credentials_required");
  const backend = rehearsalBackend(target, moveAuthorization);
  const admin = rehearsalBackend(target, `Convex ${process.env.VOLLI_MOVE_ADMIN_KEY}`);
  const moves = [...new Set([...(job.cleanupMoves ?? []), ...rehearsalImports(job)])];
  // Persist reservations BEFORE any I/O that can fail (including expired auth).
  writeFileSync(file, JSON.stringify({ ...job, cleanupMoves: moves }), { mode: 0o600 });
  await admin.mutation("migration:cleanupRehearsal", {
    workspaceId: job.workspaceId,
    userId: job.userId,
    checkOnly: true,
  });
  const pending: string[] = [];
  for (const moveId of moves) {
    try {
      const status = (await backend.query("projectImports:status", { moveId })) as {
        status: string;
        workspaceId: string;
      };
      if (status.workspaceId !== job.workspaceId) throw new Error("foreign_import_cleanup_refused");
      if (status.status === "committed")
        await backend.mutation("projectImports:uncommit", { moveId, confirmChanged: true });
      if (status.status !== "purged") await backend.mutation("projectImports:abort", { moveId });
      pending.push(moveId);
    } catch (error) {
      if ((error as { data?: { code?: string } }).data?.code !== "not_found") throw error;
    }
  }
  // All expiry clocks run together, not N projects × the 30-minute floor.
  const purges = await Promise.allSettled(pending.map((moveId) => waitPurged(backend, moveId)));
  if (purges.some((result) => result.status === "rejected")) throw new Error("purge_incomplete");
  while (
    !(
      (await admin.mutation("migration:cleanupRehearsal", {
        workspaceId: job.workspaceId,
        userId: job.userId,
      })) as { done: boolean }
    ).done
  ) {
    /* bounded pages */
  }
}

async function waitForPurge(
  backend: ReturnType<typeof rehearsalBackend>,
  moveId: string,
): Promise<void> {
  const until = Date.now() + 45 * 60_000;
  let restarts = 0;
  while (Date.now() < until) {
    const status = (await backend.query("projectImports:status", { moveId })) as {
      status: string;
      purge?: { error?: string | null };
    };
    if (status.status === "purged") return;
    if (status.purge?.error?.startsWith("stopped:"))
      throw new Error("purge_stopped_operator_inspection_required");
    if (status.purge?.error && restarts < 2) {
      restarts += 1;
      await backend.mutation("projectImports:abort", { moveId });
    }
    await delay(10_000);
  }
  throw new Error("purge_timeout");
}
export interface RehearsalOptions {
  target: string;
  source: string;
  profile: string;
  report: string;
  runnerId: string;
  allowProduction: boolean;
  includeRemoved: boolean;
  killUpload: boolean;
  killImport: boolean;
  rollback: boolean;
  goBack: boolean;
  hold: boolean;
}

/** No symlink in an input store may turn a copy into reads/writes of live data. */
async function assertStoreTree(path: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new Error("profile_store_symlink_refused");
  if (entry.isDirectory())
    for (const name of await readdir(path)) await assertStoreTree(join(path, name));
}

/** Run one child, recording only metrics and fixed result shapes, never child logs. */
export async function runRehearsalChild(
  file: string,
  onRss: (rss: number) => void,
): Promise<{ killed: boolean; result?: RehearsalResult }> {
  return new Promise((done, reject) => {
    const child = fork(
      fileURLToPath(new URL("../../scripts/move-rehearsal-worker.mjs", import.meta.url)),
      [file],
      {
        execArgv: ["--experimental-transform-types"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let result: RehearsalResult | undefined;
    let requestedKill = false;
    const stop = () => {
      child.kill("SIGKILL");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    child.on("message", (message: { rss?: number; kill?: string; result?: RehearsalResult }) => {
      if (message.rss !== undefined) onRss(message.rss);
      if (message.result) result = message.result;
      if (message.kill) {
        requestedKill = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
        process.removeListener(name, stop);
      if (requestedKill && signal === "SIGKILL") done({ killed: true });
      else if (code === 0) done({ killed: false, result });
      else reject(Object.assign(new Error("engine_child_failed"), { result }));
    });
  });
}

interface RehearsalRuntime {
  /** Platform edges, injectable for the cross-platform pinned-backend fixture;
   * no CLI flag/environment bypass exists. All safety checks still run.
   */
  cloneProfile?: (source: string, destination: string) => Promise<void>;
  runChild?: typeof runRehearsalChild;
  waitPurged?: typeof waitForPurge;
}

export async function runMoveRehearsal(
  options: RehearsalOptions,
  runtime: RehearsalRuntime = {},
): Promise<boolean> {
  const target = rehearsalTarget(options.target, options.allowProduction);
  assertCopyPaths(options.source, options.profile);
  assertReportPath(options.source, options.profile, options.report);
  assertProfileIdle(options.source);
  if (!runtime.cloneProfile && process.platform !== "darwin")
    throw new Error("apfs_clone_requires_macos");
  const adminKey = process.env.VOLLI_MOVE_ADMIN_KEY;
  if ((!process.env.VOLLI_MOVE_TOKEN && !process.env.VOLLI_MOVE_TOKEN_FILE) || !adminKey)
    throw new Error("staging_person_token_and_admin_key_required");
  rehearsalRedaction(target); // refuse before copying/uploading if no complete inventory
  const backend = rehearsalBackend(target, moveAuthorization);
  const admin = rehearsalBackend(target, `Convex ${adminKey}`);
  const viewer = (await backend.query("accounts:viewer", {})) as { userId: string } | null;
  if (!viewer) throw new Error("sign_in_to_the_target_first");
  const workspaceId = randomUUID();
  const cleanupArgs = { workspaceId, userId: viewer.userId };
  // Check the deployment's opt-in BEFORE creating anything or uploading data.
  await admin.mutation("migration:cleanupRehearsal", { ...cleanupArgs, checkOnly: true });
  const source = resolve(options.source);
  const profile = resolve(options.profile);
  const stateFile = `${profile}.rehearsal.json`;
  if (existsSync(stateFile)) throw new Error("rehearsal_state_already_exists");
  const job: MoveJob = {
    source,
    profile,
    target,
    allowProduction: options.allowProduction,
    userId: viewer.userId,
    runnerId: options.runnerId,
    workspaceId,
    includeRemoved: options.includeRemoved,
    operation: "run",
  };
  writeFileSync(stateFile, JSON.stringify(job), { mode: 0o600, flag: "wx" });
  const report: {
    ok: boolean;
    elapsedMs: number;
    peakRssBytes: number;
    kills: string[];
    runs: object[];
    failures: string[];
    cleanup: { profile: boolean; workspace: boolean };
  } = {
    ok: false,
    elapsedMs: 0,
    peakRssBytes: 0,
    kills: [],
    runs: [],
    failures: [],
    cleanup: { profile: false, workspace: false },
  };
  const started = Date.now();
  let cloned = false;
  const reportFd = openSync(options.report, "wx", 0o600);
  const save = () => writeFileSync(reportFd, `${JSON.stringify(report, null, 2)}\n`);
  const run = async (operation: MoveJob["operation"], kill?: MoveJob["kill"], moveId?: string) => {
    const current = JSON.parse(readFileSync(stateFile, "utf8")) as MoveJob;
    writeFileSync(stateFile, JSON.stringify({ ...current, operation, kill, moveId }), {
      mode: 0o600,
    });
    const start = Date.now();
    let peakRssBytes = 0;
    let result: RehearsalResult | undefined;
    let killed = false;
    let failed = false;
    try {
      const answer = await (runtime.runChild ?? runRehearsalChild)(stateFile, (rss) => {
        peakRssBytes = Math.max(peakRssBytes, rss);
        report.peakRssBytes = Math.max(report.peakRssBytes, rss);
      });
      result = answer.result;
      killed = answer.killed;
      return answer;
    } catch (error) {
      failed = true;
      result = (error as { result?: RehearsalResult }).result;
      throw error;
    } finally {
      report.runs.push({
        operation,
        kill: kill ?? null,
        killed,
        failed,
        peakRssBytes,
        ...(result
          ? rehearsalMetrics(result, Date.now() - start)
          : { elapsedMs: Date.now() - start }),
      });
    }
  };
  try {
    await backend.mutation("workspaces:create", {
      workspaceId,
      name: `migration-rehearsal-${workspaceId}`,
    });
    // cp -c is APFS copy-on-write, NOT hard links or a best-effort full copy.
    // Fail rather than silently change the copy's safety/space contract.
    await mkdir(profile, { mode: 0o700 });
    cloned = true;
    if (runtime.cloneProfile) await runtime.cloneProfile(source, profile);
    else execFileSync("cp", ["-cR", `${source}/.`, profile], { stdio: "pipe" });
    assertProfileIdle(source);
    assertProfileIdle(profile);
    for (const path of [
      "volli.db",
      "volli.db-wal",
      "volli.db-shm",
      "blobs",
      "session-transcripts",
      "pi-sessions",
      "cloud-moves",
      "backups",
    ])
      await assertStoreTree(join(profile, path));
    for (const kill of [
      options.killUpload ? "upload" : null,
      options.killImport ? "import" : null,
    ] as const) {
      if (!kill) continue;
      const attempt = await run("run", kill);
      if (!attempt.killed) throw new Error("requested_kill_point_not_reached");
      report.kills.push(kill);
    }
    let moved = (await run("run")).result!;
    // A second launch must be a no-op, with the same successful verification.
    const again = (await run("run")).result!;
    if (JSON.stringify(again) !== JSON.stringify(moved)) throw new Error("resume_changed_result");
    if (options.hold) {
      writeFileSync(
        stateFile,
        JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), uiReady: true }),
        { mode: 0o600 },
      );
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        await terminal.question(
          "Rehearsal verified. Run the dev UI check on the scratch profile, quit it, then press Enter to continue and DELETE the rehearsal Workspace: ",
        );
      } finally {
        terminal.close();
        writeFileSync(
          stateFile,
          JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), uiReady: false }),
          { mode: 0o600 },
        );
      }
      assertProfileIdle(profile);
    }
    const first = moved.projects[0]!.moveId;
    if (options.rollback) {
      await run("rollback", undefined, first);
      await (runtime.waitPurged ?? waitForPurge)(backend, first);
      moved = (await run("move-again", undefined, first)).result!;
    }
    if (options.goBack) await run("go-back", undefined, moved.projects[0]!.moveId);
    report.ok = true;
  } catch (error) {
    const safe = new Set([
      "purge_timeout",
      "purge_stopped_operator_inspection_required",
      "requested_kill_point_not_reached",
      "resume_changed_result",
      "engine_child_failed",
      "profile_store_symlink_refused",
      "profile_has_an_app_marker_quit_the_app_first",
      "profile_database_is_open_quit_the_app_first",
    ]);
    report.failures.push(
      error instanceof Error && safe.has(error.message) ? error.message : "rehearsal_failed",
    );
  } finally {
    // Read every reservation, including one whose child was killed before replying.
    try {
      await cleanupRehearsalState(stateFile, runtime.waitPurged);
      report.cleanup.workspace = true;
    } catch {
      report.failures.push("workspace_cleanup_incomplete_use_rehearsal_state");
    }
    // On a failed cp, a partial directory is also ours. Never delete a caller's existing profile.
    try {
      if (cloned) {
        assertProfileIdle(profile);
        await rm(profile, { recursive: true, force: true });
      }
      report.cleanup.profile = true;
    } catch {
      report.failures.push("scratch_cleanup_incomplete_quit_app_first");
    }
    report.ok &&= report.failures.length === 0;
    report.elapsedMs = Date.now() - started;
    try {
      save();
    } finally {
      closeSync(reportFd);
    }
    if (report.cleanup.workspace && report.cleanup.profile) await rm(stateFile, { force: true });
  }
  return report.ok;
}
