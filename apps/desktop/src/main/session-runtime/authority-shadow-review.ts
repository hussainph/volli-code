/** Live app-wide opt-in for paid, behavior-neutral authority classification. */
import type Database from "better-sqlite3";
import { getAppState } from "../db/app-state-repo";
import {
  AUTHORITY_SHADOW_REVIEW_ENABLED_KEY,
  parseAuthorityShadowReviewEnabled,
} from "../../authority-review-preferences";

/** Only the JSON boolean true opts in. Missing or unreadable settings stay off. */
export function readAuthorityShadowReviewEnabled(db: Database.Database): boolean {
  try {
    return parseAuthorityShadowReviewEnabled(getAppState(db, AUTHORITY_SHADOW_REVIEW_ENABLED_KEY));
  } catch {
    return false;
  }
}
