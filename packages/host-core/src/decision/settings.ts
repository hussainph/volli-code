/**
 * Where the decision model setting lives (VC-478), and the one read every
 * consumer resolves it through.
 *
 * Two scopes, on the chat model's own pattern (VC-112): the app-wide setting in
 * `app_state`, and a project's override in `projects.decision_model` (migration
 * 053), `NULL` meaning inherit. Both are re-read through
 * `parseDecisionModelSetting` on every read, so a row written by another build
 * — a cloud model without its opt-in, a local URL off this Mac — reads as no
 * decision model rather than as a call nobody agreed to.
 *
 * Read per decision, not cached: a person who turns the decision model off, or
 * withdraws a cloud opt-in, has stopped every call that was going to happen,
 * including the next one from a Session born while it was on.
 */

import type Database from "better-sqlite3";
import {
  NO_DECISION_MODEL,
  parseDecisionModelSetting,
  resolveDecisionModelSetting,
  type DecisionModelSetting,
} from "@volli/shared";

import { getAppState, setAppState } from "@volli/host-core/db/app-state-repo";
import { prepared } from "@volli/host-core/db/prepared";
import { getProjectById } from "@volli/host-core/db/projects-repo";

/** The app-wide decision model, one JSON setting. Absent reads as none. */
export const DECISION_MODEL_APP_STATE_KEY = "volli:decision-model";

/** The app-wide setting; none when unset or unreadable. */
export function readGlobalDecisionModel(db: Database.Database): DecisionModelSetting {
  const raw = getAppState(db, DECISION_MODEL_APP_STATE_KEY);
  if (raw === undefined) return NO_DECISION_MODEL;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_DECISION_MODEL;
  }
  return parseDecisionModelSetting(parsed) ?? NO_DECISION_MODEL;
}

export function writeGlobalDecisionModel(
  db: Database.Database,
  setting: DecisionModelSetting,
  now: number,
): void {
  setAppState(db, DECISION_MODEL_APP_STATE_KEY, JSON.stringify(setting), now);
}

/** A project's own override, or null when it inherits (or the project is gone). */
export function readProjectDecisionModel(
  db: Database.Database,
  projectId: string,
): DecisionModelSetting | null {
  return getProjectById(db, projectId)?.decisionModel ?? null;
}

/**
 * The setting a scope's decisions use: the project's override when the scope
 * names a project, else the app-wide one. A Session names its project; a call
 * that names neither uses the app-wide setting.
 */
export function resolveScopedDecisionModel(
  db: Database.Database,
  scope: { sessionId: string | null; projectId: string | null },
): DecisionModelSetting {
  const projectId =
    scope.projectId ??
    (scope.sessionId === null
      ? null
      : (prepared<[string], { project_id: string }>(
          db,
          "SELECT project_id FROM sessions WHERE id = ?",
        ).get(scope.sessionId)?.project_id ?? null));
  return resolveDecisionModelSetting(
    readGlobalDecisionModel(db),
    projectId === null ? null : readProjectDecisionModel(db, projectId),
  );
}
