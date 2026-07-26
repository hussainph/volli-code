import type { DocumentExternalUpdate, DocumentRevision, DocumentSeed } from "./document-registry";
import { reconcileText } from "./text-reconciliation";

export type LiveDiskRead =
  | {
      ok: true;
      text: string;
      revision: DocumentRevision;
      truncated: boolean;
    }
  | { ok: false; error: string; revision: DocumentRevision };

export type LiveDocumentReconciliationPlan =
  | {
      kind: "apply";
      outcome: "unchanged" | "adopt" | "keep-local" | "merge" | "save-echo";
      baseline: string;
      value: string;
      revision: DocumentRevision;
    }
  | {
      kind: "conflict";
      reason: "overlap" | "budget";
      local: string;
      disk: string;
      revision: DocumentRevision;
    }
  | {
      kind: "unreadable";
      error: string;
      keepDraft: boolean;
      revision: DocumentRevision;
    };

export interface LiveReconciliationLease {
  readonly model: { getValue(): string };
  snapshot(): { baseline: string };
  applyExternalUpdate(update: DocumentExternalUpdate): void;
  adoptCleanBaseline(seed: DocumentSeed): unknown;
}

/** Pure A/L/D planning shared by File and Diff views. */
export function planLiveDocumentReconciliation(input: {
  baseline: string;
  local: string;
  lastWrite: string | null;
  disk: LiveDiskRead;
}): LiveDocumentReconciliationPlan {
  if (!input.disk.ok) {
    return {
      kind: "unreadable",
      error: input.disk.error,
      keepDraft: input.local !== input.baseline,
      revision: input.disk.revision,
    };
  }
  if (input.disk.truncated) {
    return {
      kind: "unreadable",
      error: "File is too large to reconcile safely.",
      keepDraft: input.local !== input.baseline,
      revision: input.disk.revision,
    };
  }
  if (input.lastWrite !== null && input.disk.text === input.lastWrite) {
    return {
      kind: "apply",
      outcome: "save-echo",
      baseline: input.disk.text,
      value: input.local,
      revision: input.disk.revision,
    };
  }
  const result = reconcileText({
    baseline: input.baseline,
    local: input.local,
    disk: input.disk.text,
  });
  if (result.kind === "conflict") {
    return {
      kind: "conflict",
      reason: result.reason,
      local: result.local,
      disk: result.disk,
      revision: input.disk.revision,
    };
  }
  return {
    kind: "apply",
    outcome: result.kind,
    baseline: result.nextBaseline,
    value: result.value,
    revision: input.disk.revision,
  };
}

/** Plan and apply one disk observation through the registry's shared transaction. */
export function applyLiveDocumentReconciliation(input: {
  lease: LiveReconciliationLease;
  lastWrite: string | null;
  disk: LiveDiskRead;
}): LiveDocumentReconciliationPlan {
  const plan = planLiveDocumentReconciliation({
    baseline: input.lease.snapshot().baseline,
    local: input.lease.model.getValue(),
    lastWrite: input.lastWrite,
    disk: input.disk,
  });
  if (plan.kind === "apply") {
    input.lease.applyExternalUpdate({
      baseline: plan.baseline,
      value: plan.value,
      revision: plan.revision,
    });
  } else if (plan.kind === "conflict") {
    // The dirty lease refuses to replace baseline A, but still records the
    // newest disk revision for the later explicit overwrite guard.
    input.lease.adoptCleanBaseline({ value: plan.disk, revision: plan.revision });
  }
  return plan;
}
