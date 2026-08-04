/**
 * Per-harness binary override storage: one `app_state` row per harness, keyed
 * `volli:harness-command:<harnessId>` (#29's kv table). Stores the RAW value
 * the user typed, never a resolved path — resolution runs live, at attach
 * time, against whatever `opencode-binary.ts`'s `resolveOpenCodeBinary` finds
 * then, so a later PATH or filesystem change is honored without the user
 * re-entering anything. (`validateHarnessBinary`, in `harness-binary.ts`, is
 * the separate save-time check that refuses a candidate before it is stored.)
 */
import type Database from "better-sqlite3";
import { deleteAppState, setAppState } from "./app-state-repo";
import { prepared } from "./prepared";

function appStateKey(harnessId: string): string {
  return `volli:harness-command:${harnessId}`;
}

/** The stored override for one harness's binary, or null when unset. */
export function storedHarnessCommand(db: Database.Database, harnessId: string): string | null {
  const row = prepared<[string], { value: string }>(
    db,
    "SELECT value FROM app_state WHERE key = ?",
  ).get(appStateKey(harnessId));
  return row?.value ?? null;
}

/** Upserts the raw override — call only after it has been validated to resolve. */
export function setStoredHarnessCommand(
  db: Database.Database,
  harnessId: string,
  command: string,
  now: number,
): void {
  setAppState(db, appStateKey(harnessId), command, now);
}

/** Clears the override, so the harness falls back to default resolution. */
export function clearStoredHarnessCommand(db: Database.Database, harnessId: string): void {
  deleteAppState(db, appStateKey(harnessId));
}
