/**
 * The facts a support report needs and only main can answer (VC-293):
 * which build is running, which release line it follows, which OS and
 * architecture it runs on, what schema version its database is at, whether
 * the migrations that file ran are the ones this build ships (VC-633), and
 * what the updater's last check said (VC-294), what this launch's boot
 * recovery did (VC-926), where this Mac stands as a runner (VC-895), and
 * the last day's stalls from the perf store (VC-1092).
 *
 * Every one of them lives somewhere the renderer cannot reach — the app
 * version is Electron's, the channel is a row in `app_state`, the schema
 * number is a SQLite pragma — so About used to ship a report that named none
 * of them, and the first question support asks about any report is "which
 * build?".
 *
 * AN ALLOWLIST, NOT A DUMP. The report is text a person pastes into a public
 * issue, so this module is written so that widening it takes an edit here and
 * a new test: it names its fields, reads one pragma, one `app_state` key,
 * the version/fingerprint columns of `migration_history` and the perf store's
 * stall rows (counts, durations, operation names), and imports nothing
 * that could reach the secrets table, the credential store, or the
 * environment. The last update check is handed in from the running updater
 * and only ever leaves here as a redacted one-line summary — never the raw
 * updater text, whose URLs and header dumps stay in the main-process log.
 * `collectSupportInfo` is separate from the handler
 * for that reason — the guarantee is testable without an IPC round trip, and
 * its test asserts the exact statements this module issues.
 *
 * The handler remains available when the database did not open, but it returns
 * an unavailable result instead of presenting a partial report as complete.
 * Copy stays gated until all six required facts can be read; the last update
 * check and boot recovery are not among them ("none recorded" and "not
 * finished" are complete answers).
 */
import type Database from "better-sqlite3";
import { checkMigrationHistory, describeMigrationHistory, SCHEMA_HEAD } from "@volli/host-core/db";

import { perfSummary, type PerfStore, type PerfSummary } from "@volli/host-core/perf";
import type { BootRecoveryReport } from "@volli/host-core/session-runtime";
import {
  summarizeUpdateFailure,
  type ExperimentBuildKind,
  type ThisMacRunnerSnapshot,
} from "@volli/shared";

import type { SupportInfo, UpdateLastCheck } from "../ipc/contract";
import { readUpdateChannel } from "./auto-update";
import { SUPPORT_IPC } from "./ipc-descriptors";
import { registerGuardedIpcHandlers } from "./ipc-registry";

export interface SupportInfoDeps {
  /** `app.getVersion()` — the only build identity this app has. */
  appVersion(): string;
  /** The profile database, or `null` when this launch could not open one. */
  database(): Database.Database | null;
  /**
   * The running build's kind (`runningBuildKind`) — a canary build that never
   * chose a channel reports Canary, the line its updater actually follows.
   */
  buildKind: ExperimentBuildKind;
  /** `process.platform`, passed in so the collector stays a pure function of its deps. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** The running updater's last answered check — `autoUpdate.state().lastCheck`. */
  lastUpdateCheck(): UpdateLastCheck | null;
  /** This launch's boot recovery sweep — `runner.bootRecovery()`; `null` until it finished. */
  bootRecovery(): BootRecoveryReport | null;
  /** This Mac's runner (VC-895); `null` outside a Volli Cloud launch. */
  cloudRunner?(): ThisMacRunnerSnapshot | null;
  /** This machine's perf store (VC-1092); `null` when it did not open. */
  perfStalls?(): Pick<PerfStore, "scanStalls" | "runs"> | null;
  /** The wall clock the stall window ends at; `Date.now` unless a test pins it. */
  now?(): number;
}

/** The support report's stall window: the last day. */
export const SUPPORT_PERF_WINDOW_MS = 24 * 60 * 60 * 1000;

function milliseconds(ms: number): string {
  return `${ms.toLocaleString("en-US")} ms`;
}

/**
 * The report's stall line (VC-1092): over the last day, how long the app ran,
 * then per process the stall count, total and p95, and its three worst
 * operations as `door/operation ×count total`. Counts, durations and
 * code-owned operation names only — never a Session, a path or a message.
 */
export function describePerfStalls(summary: PerfSummary): string {
  const hours = Math.round(summary.observedMs / 360_000) / 10;
  const parts = summary.processes.map((process) => {
    if (process.stalls === 0) return `${process.process} none`;
    const top = process.top
      .map((entry) => `${entry.key} ×${entry.count} ${milliseconds(entry.totalMs)}`)
      .join(", ");
    return `${process.process} ${process.stalls} ${process.stalls === 1 ? "stall" : "stalls"}, ${milliseconds(process.stallMs)}, p95 ${milliseconds(process.p95Ms)} (${top})`;
  });
  return `last 24h, ${hours}h observed: ${parts.join("; ")}`;
}

/**
 * The report's update line: when, and what the check said. A failure appears
 * only as its redacted one-sentence summary.
 */
export function describeLastUpdateCheck(check: UpdateLastCheck | null): string {
  if (check === null) return "none recorded";
  const at = new Date(check.at).toISOString();
  switch (check.result) {
    case "up-to-date":
      return `${at}, up to date`;
    case "available":
      return `${at}, found ${check.version ?? "an update"}`;
    case "error":
      return `${at}, check failed: ${summarizeUpdateFailure(check.error ?? "")}`;
    case "download-error":
      return `${at}, download${check.version === null ? "" : ` of ${check.version}`} failed: ${summarizeUpdateFailure(check.error ?? "")}`;
  }
}

/** At most this many distinct failure kinds on the line; the rest are counted. */
const BOOT_RECOVERY_FAILURE_KINDS = 5;

/**
 * The report's boot recovery line (VC-926): counts, then each kind of failed
 * reconcile as `reason→outcome ErrorName[:code]`, repeated kinds counted.
 * Everything here is a count, a fixed reason word or an error class name, so
 * nothing on the line can name a Session, a path or what an error said.
 */
export function describeBootRecovery(report: BootRecoveryReport | null): string {
  if (report === null) return "not finished";
  const at = new Date(report.finishedAt).toISOString();
  const turns = `${report.recovered} lost ${report.recovered === 1 ? "turn" : "turns"} recovered`;
  const closed = `${report.closed} ${report.closed === 1 ? "attachment" : "attachments"} closed`;
  const kinds = new Map<string, number>();
  for (const { reason, outcome, error } of report.failures) {
    const key = `${reason}→${outcome} ${error.name}${error.code === undefined ? "" : `:${error.code}`}`;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  const listed = [...kinds]
    .slice(0, BOOT_RECOVERY_FAILURE_KINDS)
    .map(([key, count]) => (count === 1 ? key : `${key} ×${count}`));
  if (kinds.size > BOOT_RECOVERY_FAILURE_KINDS) {
    listed.push(`${kinds.size - BOOT_RECOVERY_FAILURE_KINDS} more`);
  }
  const sweep =
    report.error === null
      ? ""
      : `; sweep failed: ${report.error.name}${report.error.code === undefined ? "" : `:${report.error.code}`}`;
  return `${at}, ${turns}, ${closed}${listed.length === 0 ? "" : `; failed: ${listed.join(", ")}`}${sweep}`;
}

/** This Mac's runner as the report's one line: state, problem and the waiting count; never an id or a name. */
export function describeCloudRunner(snapshot: ThisMacRunnerSnapshot | null): string | null {
  if (snapshot === null || snapshot.state === "off") return null;
  const state =
    snapshot.problem === null ? snapshot.state : `${snapshot.state} (${snapshot.problem})`;
  const waiting =
    snapshot.waitingFacts === 1 ? "1 update waiting" : `${snapshot.waitingFacts} updates waiting`;
  return `${state} · ${waiting}`;
}

/**
 * SQLite's own migration counter. `pragma` is typed as returning `unknown`, and
 * a value that is not a number is a gap in what we know — reported as one,
 * rather than defaulted to a zero that would read as "unmigrated".
 */
function schemaVersion(db: Database.Database): number {
  const version = db.pragma("user_version", { simple: true });
  if (typeof version !== "number") throw new Error("Database schema version is unavailable");
  return version;
}

/** Assembles the complete allowlist. Every field it may ever contain is written out here. */
export function collectSupportInfo(deps: SupportInfoDeps): SupportInfo {
  const db = deps.database();
  if (db === null) throw new Error("Profile database is unavailable");
  const cloudRunner = describeCloudRunner(deps.cloudRunner?.() ?? null);
  return {
    ...(cloudRunner === null ? {} : { cloudRunner }),
    appVersion: deps.appVersion(),
    channel: readUpdateChannel(db, deps.buildKind),
    platform: deps.platform,
    arch: deps.arch,
    schemaVersion: schemaVersion(db),
    migrationHistory: describeMigrationHistory(checkMigrationHistory(db, SCHEMA_HEAD)),
    lastUpdateCheck: describeLastUpdateCheck(deps.lastUpdateCheck()),
    bootRecovery: describeBootRecovery(deps.bootRecovery()),
  };
}

/**
 * The whole report: the allowlist, and the last day's stall line when the
 * perf store is open. Asynchronous because the store reads its rows a chunk
 * per turn of the event loop, so asking for a report never stalls main.
 */
export async function collectSupportReport(deps: SupportInfoDeps): Promise<SupportInfo> {
  const info = collectSupportInfo(deps);
  const perf = deps.perfStalls?.() ?? null;
  if (perf === null) return info;
  const now = deps.now?.() ?? Date.now();
  const summary = await perfSummary(perf, now - SUPPORT_PERF_WINDOW_MS, now);
  return { ...info, perfStalls: describePerfStalls(summary) };
}

/**
 * Registered outside `dbHandle.ok` on purpose, like the update surface: a
 * profile that will not open is exactly when About must say the report is
 * unavailable rather than losing the channel or presenting a partial report.
 */
export function registerSupportIpcHandlers(deps: SupportInfoDeps): void {
  registerGuardedIpcHandlers(SUPPORT_IPC, {
    "volli:support-info": async () => ({
      ok: true as const,
      info: await collectSupportReport(deps),
    }),
  });
}
