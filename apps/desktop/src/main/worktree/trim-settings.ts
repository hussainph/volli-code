/**
 * The trim settings (VC-340): the preserved-configuration allowlist, and whether
 * a finished ticket trims its own worktree.
 *
 * Both live in the same `app_state` kv the retention TTL uses, and both are read
 * the same defensive way it is read: a corrupt or partly-written blob falls back
 * to the shipped defaults rather than silently disabling the preservation list —
 * an empty allowlist would make `.env` disposable, which is the one outcome this
 * whole feature exists to prevent.
 *
 * `trimOnFinish` is opt-OUT (default on): trimming is a cache eviction that one
 * `pnpm install` (or `cargo build`, or `uv sync`) undoes, so the default that
 * costs a person the least is the one that keeps their machine fast.
 */
import type Database from "better-sqlite3";
import type { WorktreeTrimSettings, WorktreeTrimSettingsInput } from "../../ipc/contract";

import { getAllAppState, setAppState } from "../db/app-state-repo";
import { DEFAULT_TRIM_KEEP_PATTERNS } from "./trim";

/** The `app_state` key the trim settings JSON lives under. */
export const TRIM_SETTINGS_KEY = "volli:worktree-trim";

/** How many patterns the allowlist may hold — a bound, not a policy. */
const MAX_KEEP_PATTERNS = 200;

/** The shipped defaults: every artifact goes, every named piece of config stays. */
export function defaultTrimSettings(): WorktreeTrimSettings {
  return { keepPatterns: [...DEFAULT_TRIM_KEEP_PATTERNS], trimOnFinish: true };
}

/** Trims, drops empties, dedupes, and bounds a user-supplied allowlist. */
function sanitizePatterns(patterns: readonly unknown[]): string[] {
  const cleaned: string[] = [];
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    const pattern = raw.trim();
    if (pattern === "" || cleaned.includes(pattern)) continue;
    cleaned.push(pattern);
    if (cleaned.length >= MAX_KEEP_PATTERNS) break;
  }
  return cleaned;
}

/**
 * The stored trim settings, falling back to {@link defaultTrimSettings} per
 * field. An allowlist that sanitizes down to nothing reads as unset: the user
 * asked to keep no *extra* patterns, not to make their keys disposable.
 */
export function getTrimSettings(db: Database.Database): WorktreeTrimSettings {
  const defaults = defaultTrimSettings();
  const raw = getAllAppState(db)[TRIM_SETTINGS_KEY];
  if (raw === undefined) return defaults;
  let parsed: Partial<WorktreeTrimSettings>;
  try {
    parsed = JSON.parse(raw) as Partial<WorktreeTrimSettings>;
  } catch {
    return defaults;
  }
  const patterns = Array.isArray(parsed.keepPatterns) ? sanitizePatterns(parsed.keepPatterns) : [];
  return {
    keepPatterns: patterns.length > 0 ? patterns : defaults.keepPatterns,
    trimOnFinish: typeof parsed.trimOnFinish === "boolean" ? parsed.trimOnFinish : true,
  };
}

/** Persists a partial update and returns the settings as stored. */
export function setTrimSettings(
  db: Database.Database,
  patch: WorktreeTrimSettingsInput,
  now: number,
): WorktreeTrimSettings {
  const current = getTrimSettings(db);
  const next: WorktreeTrimSettings = {
    keepPatterns:
      patch.keepPatterns === undefined
        ? current.keepPatterns
        : (() => {
            const cleaned = sanitizePatterns(patch.keepPatterns);
            return cleaned.length > 0 ? cleaned : defaultTrimSettings().keepPatterns;
          })(),
    trimOnFinish: patch.trimOnFinish ?? current.trimOnFinish,
  };
  setAppState(db, TRIM_SETTINGS_KEY, JSON.stringify(next), now);
  return next;
}
