/**
 * The facts a support report needs and only main can answer (VC-293):
 * which build is running, which release line it follows, which OS and
 * architecture it runs on, what schema version its database is at, whether
 * the migrations that file ran are the ones this build ships (VC-633), and
 * what the updater's last check said (VC-294).
 *
 * Every one of them lives somewhere the renderer cannot reach — the app
 * version is Electron's, the channel is a row in `app_state`, the schema
 * number is a SQLite pragma — so About used to ship a report that named none
 * of them, and the first question support asks about any report is "which
 * build?".
 *
 * AN ALLOWLIST, NOT A DUMP. The report is text a person pastes into a public
 * issue, so this module is written so that widening it takes an edit here and
 * a new test: it names seven fields, reads one pragma, one `app_state` key and
 * the version/fingerprint columns of `migration_history`, and imports nothing
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
 * check is not one of them ("none recorded" is a complete answer).
 */
import type Database from "better-sqlite3";
import { checkMigrationHistory, describeMigrationHistory, SCHEMA_HEAD } from "@volli/host-core/db";

import { summarizeUpdateFailure } from "@volli/shared";

import type { SupportInfo, UpdateLastCheck } from "../ipc/contract";
import { readUpdateChannel } from "./auto-update";
import { SUPPORT_IPC } from "./ipc-descriptors";
import { registerGuardedIpcHandlers } from "./ipc-registry";

export interface SupportInfoDeps {
  /** `app.getVersion()` — the only build identity this app has. */
  appVersion(): string;
  /** The profile database, or `null` when this launch could not open one. */
  database(): Database.Database | null;
  /** `process.platform`, passed in so the collector stays a pure function of its deps. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** The running updater's last answered check — `autoUpdate.state().lastCheck`. */
  lastUpdateCheck(): UpdateLastCheck | null;
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
  return {
    appVersion: deps.appVersion(),
    channel: readUpdateChannel(db),
    platform: deps.platform,
    arch: deps.arch,
    schemaVersion: schemaVersion(db),
    migrationHistory: describeMigrationHistory(checkMigrationHistory(db, SCHEMA_HEAD)),
    lastUpdateCheck: describeLastUpdateCheck(deps.lastUpdateCheck()),
  };
}

/**
 * Registered outside `dbHandle.ok` on purpose, like the update surface: a
 * profile that will not open is exactly when About must say the report is
 * unavailable rather than losing the channel or presenting a partial report.
 */
export function registerSupportIpcHandlers(deps: SupportInfoDeps): void {
  registerGuardedIpcHandlers(SUPPORT_IPC, {
    "volli:support-info": () => ({ ok: true as const, info: collectSupportInfo(deps) }),
  });
}
