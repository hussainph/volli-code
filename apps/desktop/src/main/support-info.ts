/**
 * The five facts a support report needs and only main can answer (VC-293):
 * which build is running, which release line it follows, which OS and
 * architecture it runs on, and what schema version its database is at.
 *
 * Every one of them lives somewhere the renderer cannot reach — the app
 * version is Electron's, the channel is a row in `app_state`, the schema
 * number is a SQLite pragma — so About used to ship a report that named none
 * of them, and the first question support asks about any report is "which
 * build?".
 *
 * AN ALLOWLIST, NOT A DUMP. The report is text a person pastes into a public
 * issue, so this module is written so that widening it takes an edit here and
 * a new test: it names five fields, reads one pragma and one `app_state` key,
 * and imports nothing that could reach the secrets table, the credential
 * store, or the environment. `collectSupportInfo` is separate from the handler
 * for that reason — the guarantee is testable without an IPC round trip, and
 * its test asserts the exact statements this module issues.
 *
 * The handler remains available when the database did not open, but it returns
 * an unavailable result instead of presenting a partial report as complete.
 * Copy stays gated until all five required facts can be read.
 */
import type Database from "better-sqlite3";

import type { SupportInfo } from "../ipc/contract";
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
