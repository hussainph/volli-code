/** Live app-wide opt-in for paid, behavior-neutral authority classification. */
import type Database from "better-sqlite3";
import { getAppState } from "../db/app-state-repo";

export const AUTHORITY_SHADOW_REVIEW_ENABLED_KEY = "volli:authority-shadow-review-enabled";

/** Only the JSON boolean true opts in. Missing or unreadable settings stay off. */
export function readAuthorityShadowReviewEnabled(db: Database.Database): boolean {
  try {
    const raw = getAppState(db, AUTHORITY_SHADOW_REVIEW_ENABLED_KEY);
    return raw !== undefined && JSON.parse(raw) === true;
  } catch {
    return false;
  }
}
