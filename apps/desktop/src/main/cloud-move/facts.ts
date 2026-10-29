/** Presentation facts, never move safety rules or deadlines. */
import type { CloudMoveCounts, CloudMoveStatus } from "@volli/shared";
import type { MovePlan } from "@volli/host-core/migration-export";

/** Estimate of the engine's 5 min presign + 5 min history upload timeout + 1 min margin. */
export const MOVE_HISTORY_SETTLE_SECONDS = 11 * 60;
export function countsForMove(
  plan: Pick<MovePlan, "exported" | "objects">,
  history: Pick<CloudMoveCounts, "transcriptBytes" | "piLogBytes">,
): CloudMoveCounts {
  return {
    tickets: plan.exported.tickets ?? 0,
    sessions: plan.exported.sessions ?? 0,
    events: plan.exported.sessionEvents ?? 0,
    attachments: plan.exported.blobs ?? 0,
    attachmentBytes: plan.objects
      .filter((item) => item.source === "blob")
      .reduce((sum, item) => sum + item.bytes, 0),
    transcriptBytes: history.transcriptBytes,
    piLogBytes: history.piLogBytes,
  };
}

/** A process-local measured rate. Restart or a pause discards it, never invents a clock. */
export function moveRateEstimator() {
  const samples = new Map<
    string,
    { step: string; unit: string; total: number; at: number; completed: number }
  >();
  return (
    moveId: string,
    step: string,
    progress: CloudMoveStatus["progress"],
    monotonicMs: number,
  ): number | null => {
    if (progress === null) {
      samples.delete(moveId);
      return null;
    }
    const prior = samples.get(moveId);
    if (
      prior === undefined ||
      prior.step !== step ||
      prior.unit !== progress.unit ||
      prior.total !== progress.total ||
      progress.completed < prior.completed
    ) {
      samples.set(moveId, {
        step,
        unit: progress.unit,
        total: progress.total,
        at: monotonicMs,
        completed: progress.completed,
      });
      return null;
    }
    const elapsed = monotonicMs - prior.at;
    const completed = progress.completed - prior.completed;
    if (elapsed < 1000 || completed <= 0) return null;
    const perSecond = completed / (elapsed / 1000);
    return Math.ceil(Math.max(0, progress.total - progress.completed) / perSecond);
  };
}
