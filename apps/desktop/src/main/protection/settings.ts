/** One-time backup and cleanup for the default-off Protection page (VC-480). */
import type Database from "better-sqlite3";
import {
  DEFAULT_AUTHORITY_POLICY,
  parseAuthorityPolicyOverride,
  resolveAuthorityPolicy,
  type AuthorityPolicyOverride,
} from "@volli/shared";

import { getAppState, setAppState } from "../db/app-state-repo";
import { prepared } from "../db/prepared";

/** The raw backup's presence also marks completion, including an empty backup. */
export const PROTECTION_POLICY_MIGRATION_KEY = "volli:protection-policy-migration:v1";

/**
 * One startup cleanup of dormant policy. The backup keeps the original
 * column strings (including unknown fields and whitespace), not parsed JSON.
 * Enforcing projects retain their entire document; other projects retain only
 * explicit enforcement and the visible Session-peek departure. Everything else
 * inherits built-in defaults rather than pinning a copy of those defaults.
 *
 * The backup and all row updates commit together. An existing backup is never
 * replaced, so later policy edits cannot rerun cleanup.
 */
export function migrateProtectionPolicies(db: Database.Database, now: number): void {
  db.transaction(() => {
    if (getAppState(db, PROTECTION_POLICY_MIGRATION_KEY) !== undefined) return;
    const rows = prepared<[], { id: string; authority_policy: string }>(
      db,
      "SELECT id, authority_policy FROM projects WHERE authority_policy IS NOT NULL ORDER BY id",
    ).all();
    setAppState(
      db,
      PROTECTION_POLICY_MIGRATION_KEY,
      JSON.stringify({
        completedAt: now,
        policies: rows.map((row) => ({ projectId: row.id, authorityPolicy: row.authority_policy })),
      }),
      now,
    );
    for (const row of rows) {
      let value: unknown;
      try {
        value = JSON.parse(row.authority_policy) as unknown;
      } catch {
        value = undefined;
      }
      const original = parseAuthorityPolicyOverride(value);
      if (resolveAuthorityPolicy(original).enforcement === "enforce") continue;
      const normalized: AuthorityPolicyOverride = {};
      if (original?.enforcement !== undefined) normalized.enforcement = original.enforcement;
      const peek = original?.actors?.session?.peek;
      if (peek !== undefined && peek !== DEFAULT_AUTHORITY_POLICY.actors.session.peek) {
        normalized.actors = { session: { peek } };
      }
      const stored = Object.keys(normalized).length === 0 ? null : JSON.stringify(normalized);
      if (stored === row.authority_policy) continue;
      prepared(
        db,
        `UPDATE projects
            SET authority_policy = ?, row_version = row_version + 1, updated_at = ?
          WHERE id = ?`,
      ).run(stored, now, row.id);
    }
  })();
}
