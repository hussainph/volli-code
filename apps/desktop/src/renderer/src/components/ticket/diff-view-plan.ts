/**
 * Pure DiffView planning helpers (CONCEPT #48/#49/#51, issue #109).
 *
 * No React, Monaco, or IPC — load/watch/save live in {@link DiffView}.
 */
import {
  fileSavePolicy,
  type ChangeSetFile,
  type ChangeSetFileStatus,
  type FileSource,
  type WorktreeBaseReadResult,
} from "@volli/shared";

import { classifyExternalChange } from "@renderer/components/editor/monaco-file-editor";
import {
  diffFilePolicy,
  type DiffBaseRead,
  type DiffFilePolicy,
} from "@renderer/components/ticket/diff-file-policy";
import { fileDocumentIdentity, type DocumentIdentity } from "@renderer/editor/document-identity";
import type { DocumentRevision } from "@renderer/editor/document-registry";
import {
  applyLiveDocumentReconciliation,
  type LiveDocumentReconciliationPlan,
  type LiveReconciliationLease,
} from "@renderer/editor/live-document-reconciliation";

/** Live worktree read outcome for the modified side. */
export type DiffLiveRead =
  | { ok: true; text: string; mtime: number; source: FileSource; truncated: boolean }
  | { ok: false; missing: true }
  | { ok: false; error: string };

/** Adapt a Diff live read onto the one File/Diff reconciliation policy. */
export function applyDiffLiveReconciliation(input: {
  lease: LiveReconciliationLease;
  lastWrite: string | null;
  disk: DiffLiveRead;
  unreadableRevision: DocumentRevision;
}): LiveDocumentReconciliationPlan {
  return applyLiveDocumentReconciliation({
    lease: input.lease,
    lastWrite: input.lastWrite,
    disk: input.disk.ok
      ? {
          ok: true,
          text: input.disk.text,
          revision: input.disk.mtime,
          truncated: input.disk.truncated,
        }
      : {
          ok: false,
          error:
            "missing" in input.disk && input.disk.missing
              ? "File was deleted on disk."
              : "error" in input.disk
                ? input.disk.error
                : "File is unreadable.",
          revision: input.unreadableRevision,
        },
  });
}

/**
 * True when `files.read` failed because the path is gone — the strings main's
 * `volli-fs` returns for missing parents / vanished files, plus Node's ENOENT.
 */
export function isMissingFileReadError(error: string): boolean {
  const trimmed = error.trim();
  if (
    trimmed === "File was not found" ||
    trimmed === "File no longer exists on disk" ||
    trimmed === "File does not exist on disk"
  ) {
    return true;
  }
  return /\bENOENT\b/.test(trimmed);
}

/** Map a failed `files.read` onto DiffLiveRead, preserving the missing arm. */
export function mapFilesReadFailure(error: string): DiffLiveRead {
  return isMissingFileReadError(error) ? { ok: false, missing: true } : { ok: false, error };
}

/** Map `api.worktree.baseRead` onto the policy's DiffBaseRead, or an error. */
export function mapBaseReadResult(
  result: WorktreeBaseReadResult,
): DiffBaseRead | { error: string } {
  if (!result.ok) return { error: result.error };
  if (result.missing === true) return { missing: true };
  if (result.binary === true) return { binary: true };
  return {
    content: result.content,
    ...(result.truncated ? { truncated: true } : {}),
  };
}

export type DiffViewPlan =
  | {
      kind: "stub";
      stubReason: string;
      path: string;
      previousPath: string | null;
    }
  | {
      kind: "editor";
      path: string;
      previousPath: string | null;
      /** Path used for the immutable base blob / `diff-base` identity. */
      basePath: string;
      baseRevision: string;
      originalValue: string;
      modifiedValue: string;
      modifiedRevision: DocumentRevision;
      modifiedSource: FileSource;
      modifiedReadOnly: boolean;
      policy: DiffFilePolicy;
    }
  | { kind: "error"; error: string };

/**
 * Decide stub vs editor and seed values from Change Set row + base + live reads.
 * Pure — no React, Monaco, or IPC.
 */
export function planDiffView(input: {
  file: Pick<ChangeSetFile, "status" | "path" | "previousPath" | "binary">;
  base: DiffBaseRead;
  baseRevision: string;
  live: DiffLiveRead;
}): DiffViewPlan {
  const policy = diffFilePolicy({ file: input.file, base: input.base });
  const previousPath = policy.previousPath;
  const basePath = previousPath ?? policy.path;

  if (policy.kind === "binary-stub") {
    return {
      kind: "stub",
      stubReason: policy.stubReason ?? "Unsupported file",
      path: policy.path,
      previousPath,
    };
  }

  if (input.live.ok === false && "error" in input.live) {
    return { kind: "error", error: input.live.error };
  }

  let modifiedValue = "";
  let modifiedRevision: DocumentRevision = null;
  let modifiedSource: FileSource = "worktree";
  let truncated = false;

  if (input.live.ok) {
    modifiedValue = input.live.text;
    modifiedRevision = input.live.mtime;
    modifiedSource = input.live.source;
    truncated = input.live.truncated;
  } else {
    // Deleted / absent live file — empty modified side (policy already marks RO).
    modifiedValue = "";
    modifiedRevision = 0;
    modifiedSource = "worktree";
  }

  // Truncated (and other read-only) live reads must not be saveable — saving a
  // capped prefix would destroy the rest of the file (CONCEPT #49 / FileView).
  const liveSavePolicy = fileSavePolicy({
    relPath: policy.path,
    binary: false,
    truncated,
  });
  const modifiedReadOnly = policy.modified.readOnly || liveSavePolicy === "read-only";

  return {
    kind: "editor",
    path: policy.path,
    previousPath,
    basePath,
    baseRevision: input.baseRevision,
    originalValue: policy.original.value ?? "",
    modifiedValue,
    modifiedRevision,
    modifiedSource,
    modifiedReadOnly,
    policy,
  };
}

const CHANGE_STATUSES = new Set<ChangeSetFileStatus>([
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
  "conflicted",
]);

/** Coerce persisted/open meta status onto a Change Set status. */
export function coerceChangeStatus(status: string | undefined): ChangeSetFileStatus {
  if (status !== undefined && CHANGE_STATUSES.has(status as ChangeSetFileStatus)) {
    return status as ChangeSetFileStatus;
  }
  return "modified";
}

/**
 * Decide how a DiffView should react when the live worktree file changes under
 * an open Diff tab (including when no FileView is mounted for the same path).
 * Pure — reuses {@link classifyExternalChange} so Diff and File tabs share the
 * same adopt / diverge / write-echo rules.
 */
export type DiffDiskReconcilePlan =
  | { kind: "adopt"; text: string; revision: number; source: FileSource }
  | { kind: "diverged"; text: string; revision: number }
  | { kind: "unreadable"; error: string; keepDraft: boolean }
  | { kind: "missing" };

export function planDiffDiskReconcile(input: {
  dirty: boolean;
  baseline: string;
  lastWrite: string | null;
  disk: DiffLiveRead;
}): DiffDiskReconcilePlan {
  if (input.disk.ok === false) {
    if ("missing" in input.disk && input.disk.missing) {
      return input.dirty
        ? { kind: "unreadable", error: "File was deleted on disk.", keepDraft: true }
        : { kind: "missing" };
    }
    const error = "error" in input.disk ? input.disk.error : "unreadable";
    return { kind: "unreadable", error, keepDraft: input.dirty };
  }

  const decision = classifyExternalChange({
    baseline: input.baseline,
    dirty: input.dirty,
    incoming: input.disk.text,
    lastWrite: input.lastWrite,
  });
  if (decision === "diverged") {
    // Callers MUST still `adoptCleanBaseline({ value: text, revision })` so
    // externalRevision advances (overwrite-save uses the new mtime) while the
    // dirty draft is kept — same as MonacoFileEditor.reconcileExternal.
    return { kind: "diverged", text: input.disk.text, revision: input.disk.mtime };
  }
  // "adopt" and "unchanged" both advance through adoptCleanBaseline so mtime /
  // externalRevision stay current even when the bytes match.
  return {
    kind: "adopt",
    text: input.disk.text,
    revision: input.disk.mtime,
    source: input.disk.source,
  };
}

/**
 * Apply a {@link planDiffDiskReconcile} result to the modified lease.
 * Mirrors MonacoFileEditor: both adopt and diverged call adoptCleanBaseline
 * (diverged advances externalRevision over a dirty draft without rewriting it).
 */
export type DiffDiskReconcileApply =
  | { kind: "clear-conflict" }
  | { kind: "conflict"; conflict: { text: string; mtime: number } }
  | { kind: "toast-unreadable" }
  | { kind: "error"; error: string }
  | { kind: "missing" };

export function applyDiffDiskReconcilePlan(input: {
  plan: DiffDiskReconcilePlan;
  adoptCleanBaseline(seed: { value: string; revision: number }): unknown;
}): DiffDiskReconcileApply {
  const { plan } = input;
  if (plan.kind === "adopt") {
    input.adoptCleanBaseline({ value: plan.text, revision: plan.revision });
    return { kind: "clear-conflict" };
  }
  if (plan.kind === "diverged") {
    input.adoptCleanBaseline({ value: plan.text, revision: plan.revision });
    return { kind: "conflict", conflict: { text: plan.text, mtime: plan.revision } };
  }
  if (plan.kind === "unreadable") {
    return plan.keepDraft ? { kind: "toast-unreadable" } : { kind: "error", error: plan.error };
  }
  return { kind: "missing" };
}

/**
 * After an `await` in DiffView's onChanged reconcile, bail unless the captured
 * leases are still the ones `leasesRef` holds (load effect may have released
 * and replaced them) and the component is still mounted.
 */
export function isDiffLeaseCurrent(input: {
  captured: object | null;
  current: object | null;
  mounted: boolean;
}): boolean {
  return input.mounted && input.captured !== null && input.captured === input.current;
}

/** Immutable-base + live-file identities for one DiffView. */
export function diffViewIdentities(input: {
  projectId: string;
  ticketId: string;
  baseRevision: string;
  basePath: string;
  relPath: string;
  modifiedSource: FileSource;
}): { original: DocumentIdentity; modified: DocumentIdentity } {
  return {
    original: {
      kind: "diff-base",
      projectId: input.projectId,
      ticketId: input.ticketId,
      baseRevision: input.baseRevision,
      relPath: input.basePath,
    },
    modified: fileDocumentIdentity({
      projectId: input.projectId,
      ticketId: input.ticketId,
      relPath: input.relPath,
      source: input.modifiedSource,
    }),
  };
}
