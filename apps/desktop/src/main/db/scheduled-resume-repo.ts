/**
 * Where a relaunch looks for resumes a person scheduled before it (see
 * `session-control/scheduled-resume.ts`).
 *
 * A candidate list, not an answer: it names every Session that has EVER had a
 * `resume.schedule` command, and the host folds each one to ask
 * `pendingScheduledResume` whether a schedule is still pending. That keeps the
 * one rule about what "pending" means in `@volli/shared` rather than
 * restating it in SQL, and the set it reads is small — a Session appears here
 * only after a person chose to schedule a resume in it. Read once per launch;
 * the activity watch keeps the host's set current after that.
 */
import type Database from "better-sqlite3";

import { prepared } from "./prepared";

export function listScheduledResumeSessionIds(db: Database.Database): string[] {
  return prepared<[], { session_id: string }>(
    db,
    `SELECT DISTINCT session_id
       FROM session_commands
      WHERE json_extract(intent, '$.kind') = 'resume.schedule'`,
  )
    .all()
    .map((row) => row.session_id);
}
