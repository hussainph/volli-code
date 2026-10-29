/** One disposable process over the scratch profile. The parent may SIGKILL it. */
import { readFileSync } from "node:fs";
import { readMoveState, patchMoveState } from "./move-state";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { ExactValueByteRedactor } from "@volli/shared";
import { createMoveEngine } from "../cloud-move/engine";
import { createMoveBackupPort } from "../cloud-move/backup";
import { presignedMoveObjects } from "../cloud-move/objects";
import { createMoveSessionHistory } from "../cloud-move/session-history";
import { windowReadCheck } from "../cloud-move/real-paths";
import type { MoveBackend } from "../cloud-move/ports";
import { localProductRow } from "../db/local-product";
import { migrate } from "../db/migrations";
import { exportMigrationSnapshot } from "../migration-export/exporter";
import { createFileTranscriptArtifactStore } from "../session-runtime/transcript-artifacts";
import { rehearsalTarget } from "./move-safety";
import type { RehearsalResult } from "./move-rehearsal";

export interface MoveJob {
  source: string;
  profile: string;
  target: string;
  allowProduction: boolean;
  userId: string;
  runnerId: string;
  workspaceId: string;
  includeRemoved: boolean;
  queueId?: string;
  moveId?: string;
  operation: "run" | "rollback" | "move-again" | "go-back";
  kill?: "upload" | "import";
}

/** Same HTTP protocol as the account client, with the person's token, never admin auth.
 * The token is supplied by the operator; no keychain/account/profile credential reads.
 */
export function moveAuthorization(): string {
  const token = process.env.VOLLI_MOVE_TOKEN_FILE
    ? readFileSync(process.env.VOLLI_MOVE_TOKEN_FILE, "utf8").trim()
    : process.env.VOLLI_MOVE_TOKEN;
  if (!token) throw new Error("staging_person_token_required");
  return `Bearer ${token}`;
}

export function rehearsalBackend(
  target: string,
  authorization: string | (() => string),
): MoveBackend {
  const call = async (kind: string, path: string, args: Record<string, unknown>) => {
    const response = await fetch(`${target}/api/${kind}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: typeof authorization === "string" ? authorization : authorization(),
      },
      body: JSON.stringify({ path, format: "convex_encoded_json", args: [args] }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json()) as {
      status: string;
      value?: unknown;
      errorData?: unknown;
    };
    if (body.status !== "success")
      throw Object.assign(new Error("backend_refused"), {
        data: body.errorData ?? { code: "backend_error" },
      });
    return body.value;
  };
  return {
    query: (path, args) => call("query", path, args),
    mutation: (path, args) => call("mutation", path, args),
    action: (path, args) => call("action", path, args),
  };
}

/** Explicit operator-supplied inventory, never discovered in the source profile.
 * Use the same streaming redactor as the runner. Empty is test-loopback only.
 */
export function rehearsalRedaction(target: string) {
  const path = process.env.VOLLI_MOVE_REDACTIONS_FILE;
  if (!path) throw new Error("redaction_inventory_required");
  const values: unknown = JSON.parse(readFileSync(path, "utf8"));
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(target).hostname);
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || value.length === 0) ||
    (!loopback && values.length === 0)
  )
    throw new Error("complete_redaction_inventory_required");
  const redactor = new ExactValueByteRedactor(
    (values as string[]).map((value) => [value, "[REDACTED]"] as const),
  );
  return { step: redactor.step.bind(redactor), complete: () => true };
}

function sampleRss(): void {
  process.send?.({
    rss: Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024),
  });
}

/** Test callers can shorten waits ONLY by composing this function directly; no CLI bypass. */
export async function runMoveJob(
  file: string,
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<RehearsalResult | undefined> {
  const job = readMoveState(file);
  const target = rehearsalTarget(job.target, job.allowProduction);
  const backend = rehearsalBackend(target, moveAuthorization);
  const redaction = rehearsalRedaction(target);
  let armed = true;
  const inFlight = async (point: "upload" | "import") => {
    if (!armed || job.kill !== point) return;
    armed = false;
    process.send?.({ kill: point });
    // The request is in flight. Only SIGKILL from the parent ends this process:
    // no catch/finally, abort controller or graceful engine pause can help it.
    await new Promise<never>(() => {});
  };
  const intercepted: MoveBackend = {
    ...backend,
    async mutation(path, args) {
      const pending = backend.mutation(path, args);
      if (path === "projectImports:importRows") {
        void pending.catch(() => {});
        await inFlight("import");
      }
      return pending;
    },
  };
  const uploadFetch: typeof fetch = async (url, options) => {
    const pending = fetch(url, options);
    if (options?.method === "PUT") {
      void pending.catch(() => {});
      await inFlight("upload");
    }
    return pending;
  };
  const dbPath = join(job.profile, "volli.db");
  const db = new Database(dbPath);
  const timer = setInterval(sampleRss, 1000);
  sampleRss();
  try {
    migrate(db, dbPath);
    db.pragma("foreign_keys = ON");
    // Pi locators are absolute. Rebase ONLY the copy's locators, never open
    // history from the source profile (including locators outside its layout).
    for (const row of db
      .prepare("SELECT id,native_detail FROM session_attachments WHERE native_detail IS NOT NULL")
      .all() as { id: string; native_detail: string }[]) {
      const detail = JSON.parse(row.native_detail) as {
        kind?: string;
        locator?: { sessionFilePath?: string };
      };
      const path = detail.locator?.sessionFilePath;
      if (detail.kind !== "volli.native-binding.v1" || !path) continue;
      const inside = relative(join(job.source, "pi-sessions"), resolve(path));
      if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
        detail.locator!.sessionFilePath = join(job.profile, "pi-sessions", inside);
        db.prepare("UPDATE session_attachments SET native_detail=? WHERE id=?").run(
          JSON.stringify(detail),
          row.id,
        );
      }
    }
    const workRoot = join(job.profile, "cloud-moves");
    const transcripts = join(job.profile, "session-transcripts");
    const engine = createMoveEngine({
      db,
      profilePath: dbPath,
      workRoot,
      stores: {
        blobsDir: join(job.profile, "blobs"),
        transcriptsDir: transcripts,
        piLogsDir: join(job.profile, "pi-sessions"),
      },
      homeDir: homedir(),
      appVersion: "migration-rehearsal",
      backend: intercepted,
      objects: presignedMoveObjects({ backend: intercepted, fetch: uploadFetch }),
      history: createMoveSessionHistory({
        db,
        backend: intercepted,
        artifacts: createFileTranscriptArtifactStore(transcripts),
        piDirectory: join(job.profile, "pi-sessions"),
        redaction,
        fetch: uploadFetch,
        sleep,
      }),
      backup: createMoveBackupPort({
        workerEntry: new URL("../../scripts/move-backup-worker.mjs", import.meta.url),
        workerExecArgv: ["--experimental-transform-types"],
        dataDir: job.profile,
        dbPath,
        blobsRoot: join(job.profile, "blobs"),
        transcriptsRoot: transcripts,
        workRoot,
        appVersion: "migration-rehearsal",
        estimatedExportBytes: (db.prepare("PRAGMA page_count").pluck().get() as number) * 32768,
      }),
      exportProject: exportMigrationSnapshot,
      identity: { current: async () => ({ userId: job.userId, runnerId: job.runnerId }) },
      liveWork: { busySessionIds: () => new Set() },
      realPath: windowReadCheck({
        backend: intercepted,
        sleep: sleep ?? ((ms, signal) => delay(ms, undefined, { signal })),
      }),
      sleep,
    });
    if (job.operation === "rollback") {
      // The explicit rehearsal command discards UI-check changes in this
      // disposable Workspace; normal product rollback still asks the person.
      if (engine.journal.move(job.moveId!)?.workspaceId !== job.workspaceId)
        throw new Error("foreign_move_refused");
      await engine.rollBack(job.moveId!, { confirmChanged: true });
    } else if (job.operation === "go-back") {
      await engine.goBackToLocal(job.moveId!);
    } else {
      if (!job.queueId || job.operation === "move-again") {
        const projects =
          job.operation === "move-again"
            ? [engine.journal.move(job.moveId!)!.projectId]
            : (
                db
                  .prepare(
                    `SELECT p.id FROM projects p WHERE ${localProductRow("p", "project")} ${job.includeRemoved ? "" : "AND p.removed_at IS NULL"}`,
                  )
                  .all() as { id: string }[]
              ).map((row) => row.id);
        const queued = engine.enqueue({
          projectIds: projects,
          target: { userId: job.userId, runnerId: job.runnerId, workspaceId: job.workspaceId },
          includeRemoved: job.includeRemoved,
          stopAtFirstProblem: true,
        });
        job.queueId = queued.queue.queueId;
        patchMoveState(file, { queueId: job.queueId });
      }
      const outcome = await engine.run(job.queueId!);
      const moves = engine.journal.moves(job.queueId!);
      const profileReport = JSON.parse(
        readFileSync(join(workRoot, `profile-${job.queueId}`, "report.json"), "utf8"),
      ) as { refused: Record<string, number> };
      const result: RehearsalResult = {
        outcome: outcome.kind,
        projects: moves.map((move) => ({
          moveId: move.moveId,
          state: move.state,
          rows: move.journal.rows ?? {},
          failureCode: move.failure?.code ?? null,
          refused: (move.failure?.detail?.codes as Record<string, number> | undefined) ?? {},
          verified: (move.report?.verify as { ok?: boolean } | undefined)?.ok === true,
          realPath: move.report?.ok === true,
        })),
        profileRefused: profileReport.refused,
      };
      process.send?.({ result });
      if (
        outcome.kind !== "done" ||
        Object.keys(profileReport.refused).length > 0 ||
        moves.some((m) => m.state !== "checked" || m.report?.ok !== true)
      )
        throw Object.assign(new Error("move_did_not_pass"), { result });
      return result;
    }
  } finally {
    sampleRss();
    clearInterval(timer);
    db.close();
  }
  return undefined;
}
