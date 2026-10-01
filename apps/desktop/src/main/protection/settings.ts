/**
 * The Protection experiment switch (VC-480).
 *
 * App-wide, main-owned, off by default. With it off nothing about authority
 * changes: the old Configure → Authority page, every stored per-project
 * setting, and a runtime that never learns approvals exist. Switching it on
 * shows the Protection page and lets a protected project's Sessions ask on
 * their first approvable refusal.
 *
 * Stored in `app_state` like the other main-owned settings, read tolerantly:
 * anything that is not `{"enabled": true}` is off.
 */
import type Database from "better-sqlite3";

import { getAppState, setAppState } from "../db/app-state-repo";

export const PROTECTION_EXPERIMENT_KEY = "volli:protection-experiment";

export function protectionExperimentEnabled(db: Database.Database): boolean {
  const raw = getAppState(db, PROTECTION_EXPERIMENT_KEY);
  if (raw === undefined) return false;
  try {
    return (JSON.parse(raw) as { enabled?: unknown } | null)?.enabled === true;
  } catch {
    return false;
  }
}

export function setProtectionExperimentEnabled(
  db: Database.Database,
  enabled: boolean,
  now: number,
): void {
  setAppState(db, PROTECTION_EXPERIMENT_KEY, JSON.stringify({ enabled }), now);
}
