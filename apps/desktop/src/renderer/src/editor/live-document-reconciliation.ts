import type { DocumentRevision } from "./document-registry";
import { reconcileText } from "./text-reconciliation";

export type LiveDiskRead =
  | {
      ok: true;
      text: string;
      revision: DocumentRevision;
      truncated: boolean;
    }
  | { ok: false; error: string; revision: DocumentRevision };

export type LiveDocumentReconciliationPlan = {
  kind: "apply";
  outcome: "adopt" | "keep-local" | "merge";
  baseline: string;
  value: string;
  revision: DocumentRevision;
};

/** Pure A/L/D planning shared by File and Diff views. */
export function planLiveDocumentReconciliation(input: {
  baseline: string;
  local: string;
  lastWrite: string | null;
  disk: LiveDiskRead;
}): LiveDocumentReconciliationPlan {
  if (!input.disk.ok || input.disk.truncated) {
    throw new Error("Unreadable live reconciliation is not implemented");
  }
  const result = reconcileText({
    baseline: input.baseline,
    local: input.local,
    disk: input.disk.text,
  });
  if (result.kind !== "adopt" && result.kind !== "keep-local" && result.kind !== "merge") {
    throw new Error(`Live reconciliation outcome ${result.kind} is not implemented`);
  }
  return {
    kind: "apply",
    outcome: result.kind,
    baseline: result.nextBaseline,
    value: result.value,
    revision: input.disk.revision,
  };
}
