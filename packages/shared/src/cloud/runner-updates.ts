/**
 * What a runner tells Volli about its own updates (n3 §9.2): one report per
 * outcome, sent by the daemon to `runnerUpdateReports.report`, idempotent by
 * `outcomeId`. The backend records each as a `runnerEvents` row of that
 * `kind` and keeps the newest as the runner's `update` projection.
 *
 * - `update_staged`: `version` is downloaded, verified and probed here.
 * - `update_applied`: the runner restarted on `version`, from `fromVersion`.
 * - `update_failed`: staging or activating `version` failed (`reason`).
 * - `rolled_back`: the runner is back on `version` after `fromVersion`
 *   failed its health check (`reason` is set only if the rollback did not
 *   come online either).
 */
export const RUNNER_UPDATE_OUTCOME_KINDS = [
  "update_staged",
  "update_applied",
  "update_failed",
  "rolled_back",
] as const;
export type RunnerUpdateOutcomeKind = (typeof RUNNER_UPDATE_OUTCOME_KINDS)[number];

/** A reason longer than this is cut, as `reportState`'s is. */
export const RUNNER_UPDATE_REASON_MAX = 200;

export interface RunnerUpdateReport {
  /** The runner's id for the outcome (a UUID); a retry sends the same one. */
  readonly outcomeId: string;
  readonly kind: RunnerUpdateOutcomeKind;
  readonly version: string;
  readonly fromVersion: string | null;
  readonly reason: string | null;
  /** When it happened on the runner, epoch milliseconds. */
  readonly at: number;
}
