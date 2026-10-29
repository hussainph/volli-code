/** Cloud project rows satisfy local FKs; only the checkout registry owns folders. */
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { prepared } from "./prepared";
import { withTransaction } from "./transaction-gate";

export function cloudShadowPath(
  db: Database.Database,
  ownerUserId: string,
  projectId: string,
  root?: string,
): string {
  return join(
    resolve(root ?? join(dirname(db.name), "cloud-identities")),
    createHash("sha256").update(`${ownerUserId}\0${projectId}`).digest("hex"),
  );
}

/**
 * Heal canary shadows on EVERY open, including a local-first upgrade with no
 * account restored. Otherwise findProjectByPath can reattach a hidden Cloud
 * identity instead of adding the person's local folder. Only marked shadows
 * change; their registry paths and every frozen local row remain untouched.
 * No migration: an older canary can write the old pointer again after upgrade.
 */
export function normalizeCloudShadowPaths(
  db: Database.Database,
  root?: string,
  ownerUserId?: string,
): void {
  withTransaction(db, () => {
    const shadows = prepared<[], { id: string; path: string; owner_user_id: string }>(
      db,
      `SELECT p.id, p.path, s.owner_user_id FROM projects p JOIN cloud_shadow_rows s
       ON s.kind='project' AND s.id=p.id`,
    ).all();
    for (const shadow of shadows) {
      if (ownerUserId !== undefined && shadow.owner_user_id !== ownerUserId) continue;
      const path = cloudShadowPath(db, shadow.owner_user_id, shadow.id, root);
      if (path !== shadow.path)
        prepared(db, "UPDATE projects SET path=? WHERE id=?").run(path, shadow.id);
    }
  });
}
