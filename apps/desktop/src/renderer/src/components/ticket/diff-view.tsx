/**
 * Diff tab content pane (CONCEPT #48/#49/#51, issue #109).
 *
 * Loads baseRead + live worktree content, runs {@link diffFilePolicy}, stubs
 * binary/conflicted paths, and otherwise mounts MonacoDiffEditor over a
 * read-only `diff-base` original and the shared ticket `file` modified model.
 */
import * as React from "react";
import {
  baseNameOf,
  errorMessage,
  type ChangeSetFile,
  type ChangeSetFileStatus,
  type FileSource,
  type Ticket,
  type WorktreeBaseReadResult,
} from "@volli/shared";

import {
  MonacoDiffEditor,
  releaseDiffLeases,
} from "@renderer/components/editor/monaco-diff-editor";
import {
  classifyExternalChange,
  type MonacoFileSaveResult,
} from "@renderer/components/editor/monaco-file-editor";
import { Button } from "@renderer/components/ui/button";
import {
  diffFilePolicy,
  type DiffBaseRead,
  type DiffFilePolicy,
} from "@renderer/components/ticket/diff-file-policy";
import {
  documentIdentityKey,
  fileDocumentIdentity,
  type DocumentIdentity,
} from "@renderer/editor/document-identity";
import type { DocumentLease, DocumentRevision } from "@renderer/editor/document-registry";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { toastError } from "@renderer/lib/toast";
import { useUiStore, type DiffPresentation } from "@renderer/stores/ui";

import type { editor } from "monaco-editor";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";

/** Live worktree read outcome for the modified side. */
export type DiffLiveRead =
  | { ok: true; text: string; mtime: number; source: FileSource }
  | { ok: false; missing: true }
  | { ok: false; error: string };

/** Map `api.worktree.baseRead` onto the policy's DiffBaseRead, or an error. */
export function mapBaseReadResult(
  result: WorktreeBaseReadResult,
): DiffBaseRead | { error: string } {
  if (!result.ok) return { error: result.error };
  if (result.missing === true) return { missing: true };
  if (result.binary === true) return { binary: true };
  return { content: result.content };
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

  const modifiedReadOnly = policy.modified.readOnly;
  let modifiedValue = "";
  let modifiedRevision: DocumentRevision = null;
  let modifiedSource: FileSource = "worktree";

  if (input.live.ok) {
    modifiedValue = input.live.text;
    modifiedRevision = input.live.mtime;
    modifiedSource = input.live.source;
  } else {
    // Deleted / absent live file — empty modified side (policy already marks RO).
    modifiedValue = "";
    modifiedRevision = 0;
    modifiedSource = "worktree";
  }

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

/** Binary / conflicted stub — never mounts Monaco. */
export function DiffStub({
  path,
  previousPath,
  stubReason,
}: {
  path: string;
  previousPath: string | null;
  stubReason: string;
}) {
  return (
    <div
      data-testid="ticket-diff-stub"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-gutter py-8 text-center"
    >
      <p className="text-ui font-medium text-foreground">{stubReason}</p>
      <p className="text-xs text-muted-foreground">{baseNameOf(path)}</p>
      {previousPath !== null ? (
        <p className="text-xs text-muted-foreground/70">← {previousPath}</p>
      ) : null}
    </div>
  );
}

type MonacoLease = DocumentLease<editor.ITextModel, editor.ICodeEditorViewState>;

interface DiffLeases {
  key: string;
  original: MonacoLease;
  modified: MonacoLease;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "stub"; stubReason: string; path: string; previousPath: string | null }
  | {
      status: "editor";
      plan: Extract<DiffViewPlan, { kind: "editor" }>;
      leases: DiffLeases;
    };

export interface DiffViewProps {
  projectId: string;
  ticket: Ticket;
  relPath: string;
  previousPath?: string | null;
  status?: string;
  /** Change Set binary flag when known from the row that opened the tab. */
  binary?: boolean;
  onDirtyChange?(dirty: boolean): void;
  /**
   * Host-persisted Monaco view state for the modified side — restored lazily
   * when this DiffView mounts (issue #109). Opaque; never inspected here.
   */
  initialViewState?: unknown;
  /** Emitted when the DiffEditor releases so the host can persist view state. */
  onViewStateChange?(viewState: unknown): void;
}

/**
 * One Change Set diff tab. Mount with `key={relPath}` so path switches remount.
 * Does not steal focus on open (decision #48) — never calls editor.focus().
 */
export function DiffView({
  projectId,
  ticket,
  relPath,
  previousPath = null,
  status,
  binary = false,
  onDirtyChange,
  initialViewState,
  onViewStateChange,
}: DiffViewProps) {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [conflict, setConflict] = React.useState<{ text: string; mtime: number } | null>(null);
  const presentation = useUiStore((s) => s.diffPresentation);
  const setDiffPresentation = useUiStore((s) => s.setDiffPresentation);
  const leasesRef = React.useRef<DiffLeases | null>(null);
  const lastViewStateRef = React.useRef<unknown>(undefined);
  const lastWriteRef = React.useRef<string | null>(null);
  const mountedRef = React.useRef(true);
  const name = baseNameOf(relPath);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (leasesRef.current !== null) {
        releaseDiffLeases(leasesRef.current, lastViewStateRef.current);
        leasesRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      setState({ status: "loading" });
      setConflict(null);
      lastWriteRef.current = null;
      try {
        const fileStatus = coerceChangeStatus(status);
        const changeSet = await window.api.worktree.changeSet(ticket.id);
        if (cancelled || !mountedRef.current) return;
        if (!changeSet.ok) {
          setState({ status: "error", error: changeSet.error });
          return;
        }

        const snapshotRow = changeSet.changeSet.files.find((entry) => entry.path === relPath);
        const row: ChangeSetFile = snapshotRow ?? {
          path: relPath,
          ...(previousPath ? { previousPath } : {}),
          status: fileStatus,
          insertions: null,
          deletions: null,
          binary,
        };

        const basePath = row.previousPath ?? row.path;
        const baseResult = await window.api.worktree.baseRead(
          ticket.id,
          basePath,
          changeSet.changeSet.baseRevision,
        );
        if (cancelled || !mountedRef.current) return;
        const mapped = mapBaseReadResult(baseResult);
        if ("error" in mapped) {
          setState({ status: "error", error: mapped.error });
          return;
        }

        let live: DiffLiveRead;
        let fileForPolicy: ChangeSetFile = row;
        if (row.status === "deleted") {
          live = { ok: false, missing: true };
        } else {
          const read = await window.api.files.read({
            projectId,
            ticketId: ticket.id,
            relPath,
          });
          if (cancelled || !mountedRef.current) return;
          if (!read.ok) {
            live = { ok: false, error: read.error };
          } else if (read.content.type !== "text") {
            live = {
              ok: true,
              text: "",
              mtime: read.mtime,
              source: read.source,
            };
            fileForPolicy = { ...row, binary: true };
          } else {
            live = {
              ok: true,
              text: read.content.text,
              mtime: read.mtime,
              source: read.source,
            };
          }
        }

        const plan = planDiffView({
          file: fileForPolicy,
          base: mapped,
          baseRevision: changeSet.changeSet.baseRevision,
          live,
        });

        if (plan.kind === "error") {
          setState({ status: "error", error: plan.error });
          return;
        }
        if (plan.kind === "stub") {
          setState({
            status: "stub",
            stubReason: plan.stubReason,
            path: plan.path,
            previousPath: plan.previousPath,
          });
          return;
        }

        const identities = diffViewIdentities({
          projectId,
          ticketId: ticket.id,
          baseRevision: plan.baseRevision,
          basePath: plan.basePath,
          relPath: plan.path,
          modifiedSource: plan.modifiedSource,
        });

        const runtime = await loadMonacoRuntime();
        if (cancelled || !mountedRef.current) return;

        // Drop any prior leases before acquiring replacements (path/meta change).
        if (leasesRef.current !== null) {
          releaseDiffLeases(leasesRef.current);
          leasesRef.current = null;
        }

        const original = runtime.registry.acquire({
          identity: identities.original,
          viewId: "diff-original",
          seed: { value: plan.originalValue, revision: plan.baseRevision },
          savePolicy: "read-only",
        });

        // Modified side MUST share the file-tab model. If a lease already exists,
        // acquire with that entry's baseline seed — a fresh disk seed would throw
        // "different seed" while the file tab still holds a reference.
        const existingModified = runtime.registry.peek(identities.modified);
        const existingSnap = existingModified?.snapshot() ?? null;
        const modifiedSeed =
          existingSnap !== null
            ? { value: existingSnap.baseline, revision: existingSnap.baselineRevision }
            : { value: plan.modifiedValue, revision: plan.modifiedRevision };
        const modifiedPolicy =
          existingSnap !== null
            ? existingSnap.savePolicy
            : plan.modifiedReadOnly
              ? ("read-only" as const)
              : ("explicit" as const);

        const modified = runtime.registry.acquire({
          identity: identities.modified,
          // Distinct from FileView's `:source` viewId so each view keeps its own
          // cursor/scroll while sharing one model (CONCEPT #48).
          viewId: "diff",
          seed: modifiedSeed,
          savePolicy: modifiedPolicy,
        });

        const leases: DiffLeases = {
          key: `${documentIdentityKey(identities.original)}|${documentIdentityKey(identities.modified)}`,
          original,
          modified,
        };
        leasesRef.current = leases;
        setState({ status: "editor", plan, leases });
      } catch (error) {
        if (cancelled || !mountedRef.current) return;
        setState({ status: "error", error: errorMessage(error) });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, ticket.id, relPath, previousPath, status, binary]);

  const modifiedReadOnly = state.status === "editor" ? state.plan.modifiedReadOnly : true;

  // Live disk reconcile for this Diff tab's lifetime — needed when only the
  // Diff tab (not a FileView) is mounted, so agent edits aren't invisible until
  // a file tab opens (issue #109).
  React.useEffect(() => {
    if (state.status !== "editor" || modifiedReadOnly) return;

    void window.api.files.watch({ projectId, ticketId: ticket.id, relPath }).then((result) => {
      if (!result.ok) {
        toastError(`Live updates for ${name} are off. Reopen the diff to refresh it.`);
      }
    });

    const unsubscribe = window.api.files.onChanged((event) => {
      if (event.projectId !== projectId || event.relPath !== relPath) return;
      void (async () => {
        const leases = leasesRef.current;
        if (leases === null || !mountedRef.current) return;

        const read = await window.api.files.read({
          projectId,
          ticketId: ticket.id,
          relPath,
        });
        if (!mountedRef.current) return;

        let disk: DiffLiveRead;
        if (!read.ok) {
          disk = { ok: false, error: read.error };
        } else if (read.content.type !== "text") {
          // Binary / image under a text Diff tab — treat as unreadable for reconcile.
          disk = { ok: false, error: "File is no longer plain text." };
        } else {
          disk = {
            ok: true,
            text: read.content.text,
            mtime: read.mtime,
            source: read.source,
          };
        }

        const snap = leases.modified.snapshot();
        const plan = planDiffDiskReconcile({
          dirty: snap.dirty,
          baseline: snap.baseline,
          lastWrite: lastWriteRef.current,
          disk,
        });

        if (plan.kind === "adopt") {
          leases.modified.adoptCleanBaseline({
            value: plan.text,
            revision: plan.revision,
          });
          if (mountedRef.current) setConflict(null);
          return;
        }
        if (plan.kind === "diverged") {
          if (mountedRef.current) setConflict({ text: plan.text, mtime: plan.revision });
          return;
        }
        if (plan.kind === "unreadable") {
          if (plan.keepDraft) {
            toastError(
              `${name} changed on disk and is now unreadable. Your unsaved edits were kept.`,
            );
          } else if (mountedRef.current) {
            setState({ status: "error", error: plan.error });
          }
          return;
        }
        // missing while clean — surface the deletion instead of stale content.
        if (mountedRef.current) {
          setState({ status: "error", error: "File was deleted on disk." });
        }
      })();
    });

    return () => {
      unsubscribe();
      void window.api.files.unwatch({ projectId, ticketId: ticket.id, relPath });
    };
  }, [state.status, modifiedReadOnly, projectId, ticket.id, relPath, name]);

  const handleSave = React.useCallback(
    async (text: string): Promise<MonacoFileSaveResult> => {
      if (state.status !== "editor" || state.plan.modifiedReadOnly) {
        return { ok: false, error: "This side is read-only." };
      }
      try {
        const snapshot = state.leases.modified.snapshot();
        const expectedMtime = snapshot.externalRevision;
        if (typeof expectedMtime !== "number") {
          return { ok: false, error: "its version on disk is unknown." };
        }
        const result = await window.api.files.write({
          projectId,
          ticketId: ticket.id,
          relPath,
          content: text,
          expectedMtime,
        });
        if (!result.ok) return { ok: false, error: result.error };
        lastWriteRef.current = text;
        return { ok: true, revision: result.mtime };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
    [state, projectId, ticket.id, relPath],
  );

  const handleViewStateChange = React.useCallback(
    (viewState: unknown) => {
      lastViewStateRef.current = viewState;
      onViewStateChange?.(viewState);
    },
    [onViewStateChange],
  );

  const reloadFromDisk = React.useCallback(() => {
    const leases = leasesRef.current;
    if (leases === null || conflict === null) return;
    leases.modified.discard();
    leases.modified.adoptCleanBaseline({
      value: conflict.text,
      revision: conflict.mtime,
    });
    lastWriteRef.current = null;
    setConflict(null);
  }, [conflict]);

  if (state.status === "loading") {
    return <p className="px-gutter py-4 text-xs text-muted-foreground">Loading diff…</p>;
  }
  if (state.status === "error") {
    return <p className="px-gutter py-4 text-xs text-destructive">{state.error}</p>;
  }
  if (state.status === "stub") {
    return (
      <DiffStub path={state.path} previousPath={state.previousPath} stubReason={state.stubReason} />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DiffPresentationToggle presentation={presentation} onChange={setDiffPresentation} />
      {conflict !== null ? (
        <div className="mx-gutter mt-2 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span>
            Changed on disk — your unsaved edits were kept. Saving now overwrites the newer version
            on disk.
          </span>
          <Button size="sm" variant="secondary" onClick={reloadFromDisk}>
            <ArrowClockwiseIcon />
            Reload
          </Button>
        </div>
      ) : null}
      <MonacoDiffEditor
        originalLease={state.leases.original}
        modifiedLease={state.leases.modified}
        presentation={presentation}
        modifiedReadOnly={state.plan.modifiedReadOnly}
        ariaLabel={`${baseNameOf(relPath)} diff`}
        onSave={handleSave}
        onDirtyChange={onDirtyChange}
        initialViewState={initialViewState}
        onViewStateChange={handleViewStateChange}
      />
    </div>
  );
}

function DiffPresentationToggle({
  presentation,
  onChange,
}: {
  presentation: DiffPresentation;
  onChange(next: DiffPresentation): void;
}) {
  return (
    <div
      data-testid="ticket-diff-presentation"
      className="flex shrink-0 items-center gap-1 border-b border-border px-gutter py-1.5"
    >
      <Button
        size="sm"
        variant={presentation === "inline" ? "secondary" : "ghost"}
        aria-pressed={presentation === "inline"}
        onClick={() => onChange("inline")}
      >
        Inline
      </Button>
      <Button
        size="sm"
        variant={presentation === "side-by-side" ? "secondary" : "ghost"}
        aria-pressed={presentation === "side-by-side"}
        onClick={() => onChange("side-by-side")}
      >
        Side by side
      </Button>
    </div>
  );
}
