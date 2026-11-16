/**
 * Whether a turn a deliberate quit cut short resumes on its own at the next
 * launch (VC-1245), stored where every other host setting lives: one
 * `app_state` row holding a small JSON blob, `{ "autoResume": boolean }`.
 *
 * Off by default, and anything unreadable reads as off: an unattended resume
 * re-prompts the model and spends the chat's prompt cache without the person
 * asking, so only a person's own choice turns it on. The setting governs the
 * deliberate-quit path only; a crash's recovery does not read it.
 *
 * An older build never reads this key, and a row it does not know is left
 * alone by every reader it has, so the setting survives a downgrade unused.
 */
import type Database from "better-sqlite3";

import { getAppState, setAppState } from "../db/app-state-repo";

/** The `app_state` key the setting lives under. */
export const QUIT_RESUME_APP_STATE_KEY = "volli:quit-resume";

/** The stored setting, or off when nothing legible is stored. */
export function readAutoResumeAfterQuit(db: Database.Database): boolean {
  const raw = getAppState(db, QUIT_RESUME_APP_STATE_KEY);
  if (raw === undefined) return false;
  try {
    return (JSON.parse(raw) as { autoResume?: unknown } | null)?.autoResume === true;
  } catch {
    return false;
  }
}

/** Stores the setting and answers with what was stored. */
export function writeAutoResumeAfterQuit(
  db: Database.Database,
  autoResume: boolean,
  now: number,
): boolean {
  setAppState(db, QUIT_RESUME_APP_STATE_KEY, JSON.stringify({ autoResume }), now);
  return autoResume;
}
