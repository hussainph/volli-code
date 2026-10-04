/**
 * The automatic-reaping preference (VC-341), stored where every other app-wide
 * setting lives: one `app_state` row holding a small JSON blob.
 *
 * A corrupt or hand-edited value reads as the DEFAULT, and the default is off.
 * That direction matters more here than it does for a retention window: an
 * unreadable setting that fell back to "on" would be this app deciding to kill
 * processes because it could not read a file.
 */
import type Database from "better-sqlite3";
import { DEFAULT_AUTO_REAP_POLICY, type AutoReapPolicy } from "@volli/shared";

import { getAppState, setAppState } from "../db/app-state-repo";

/** The `app_state` key the automatic-reaping settings JSON lives under. */
export const AUTO_REAP_SETTINGS_KEY = "volli:orphan-processes";
/** An hour is the floor: a threshold below it would reap work still in flight. */
export const MIN_AUTO_REAP_AGE_HOURS = 1;

/** The stored policy, or the default when nothing legible is stored. */
export function getAutoReapPolicy(db: Database.Database): AutoReapPolicy {
  const raw = getAppState(db, AUTO_REAP_SETTINGS_KEY);
  if (raw === undefined) return DEFAULT_AUTO_REAP_POLICY;
  try {
    const parsed = JSON.parse(raw) as Partial<AutoReapPolicy>;
    if (typeof parsed.enabled !== "boolean") return DEFAULT_AUTO_REAP_POLICY;
    return { enabled: parsed.enabled, minimumAgeHours: clampHours(parsed.minimumAgeHours) };
  } catch {
    return DEFAULT_AUTO_REAP_POLICY;
  }
}

/** Persists the policy, clamped, and answers with what was actually stored. */
export function setAutoReapPolicy(
  db: Database.Database,
  policy: AutoReapPolicy,
  now: number,
): AutoReapPolicy {
  const stored: AutoReapPolicy = {
    enabled: policy.enabled,
    minimumAgeHours: clampHours(policy.minimumAgeHours),
  };
  setAppState(db, AUTO_REAP_SETTINGS_KEY, JSON.stringify(stored), now);
  return stored;
}

function clampHours(hours: unknown): number {
  return typeof hours === "number" && Number.isFinite(hours) && hours >= MIN_AUTO_REAP_AGE_HOURS
    ? Math.floor(hours)
    : DEFAULT_AUTO_REAP_POLICY.minimumAgeHours;
}
