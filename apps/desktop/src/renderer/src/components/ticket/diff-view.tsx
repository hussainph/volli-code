/**
 * Diff tab content pane (CONCEPT #48/#49/#51, issue #109).
 *
 * Loads baseRead + live worktree content, runs {@link diffFilePolicy}, stubs
 * binary/conflicted paths, and otherwise mounts MonacoDiffEditor over a
 * read-only `diff-base` original and the shared ticket `file` modified model.
 *
 * Pure planning lives in `diff-view-plan`; stub / presentation chrome in
 * `diff-stub` and `diff-presentation-toggle`.
 */
import * as React from "react";
import { baseNameOf, errorMessage, type ChangeSetFile, type Ticket } from "@volli/shared";

import {
  MonacoDiffEditor,
  releaseDiffLeases,
} from "@renderer/components/editor/monaco-diff-editor";
import { LiveReconciliationAffordance } from "@renderer/components/editor/live-reconciliation-affordance";
import type { MonacoFileSaveResult } from "@renderer/components/editor/monaco-file-editor";
import { DiffPresentationToggle } from "@renderer/components/ticket/diff-presentation-toggle";
import { DiffStub } from "@renderer/components/ticket/diff-stub";
import {
  applyDiffLiveReconciliation,
  coerceChangeStatus,
  diffViewIdentities,
  isDiffLeaseCurrent,
  mapBaseReadResult,
  mapFilesReadFailure,
  planDiffView,
  presentLiveUnreadable,
  reconcileAcquiredDiffModel,
  type DiffLiveRead,
  type DiffViewPlan,
} from "@renderer/components/ticket/diff-view-plan";
import { documentIdentityKey } from "@renderer/editor/document-identity";
import type { DocumentLease } from "@renderer/editor/document-registry";
import { matchesFileChangeIdentity } from "@renderer/editor/file-change-identity";
import type { LocalWriteReceipt } from "@renderer/editor/live-document-reconciliation";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { rearmWatch } from "@renderer/editor/rearm-watch";
import { toastError } from "@renderer/lib/toast";
import { useUiStore } from "@renderer/stores/ui";

import type { editor } from "monaco-editor";

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
  /** Reports a successful local write so ticket-level recency can ignore its watch echo. */
  onLocalSave?(relPath: string, source: "main" | "worktree", revision: number): void;
  /**
   * The revision of the bytes this view actually MOUNTED — the only honest
   * "seen" revision for stale-awareness (CONCEPT #52). Fired on a successful
   * initial load and on an explicit user-driven reload ("Use disk"), never on a
   * passive live adoption: silently adopting an agent's edit is exactly the case
   * the Changes badge exists to announce.
   */
  onLoaded?(relPath: string, source: "main" | "worktree", revision: number): void;
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
  onLocalSave,
  onLoaded,
  initialViewState,
  onViewStateChange,
}: DiffViewProps) {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [conflict, setConflict] = React.useState<{ text: string; mtime: number } | null>(null);
  const [liveError, setLiveError] = React.useState<string | null>(null);
  const presentation = useUiStore((s) => s.diffPresentation);
  const setDiffPresentation = useUiStore((s) => s.setDiffPresentation);
  const leasesRef = React.useRef<DiffLeases | null>(null);
  /** In-flight guard for the conflict banner's explicit overwrite. */
  const writingRef = React.useRef(false);
  const lastViewStateRef = React.useRef<unknown>(undefined);
  const lastWriteRef = React.useRef<LocalWriteReceipt | null>(null);
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
      setLiveError(null);
      lastWriteRef.current = null;
      // Drop prior editor leases at the start of every load attempt so stub /
      // error / cancelled paths cannot leave a stale leasesRef held (mirrors
      // unmount). Pass last view state so the host can persist it.
      if (leasesRef.current !== null) {
        releaseDiffLeases(leasesRef.current, lastViewStateRef.current);
        leasesRef.current = null;
      }
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
            live = mapFilesReadFailure(read.error);
          } else if (read.content.type !== "text") {
            live = {
              ok: true,
              text: "",
              mtime: read.mtime,
              source: read.source,
              truncated: false,
            };
            fileForPolicy = { ...row, binary: true };
          } else {
            live = {
              ok: true,
              text: read.content.text,
              mtime: read.mtime,
              source: read.source,
              truncated: read.content.truncated,
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

        // A newer load (or unmount) may have started while we acquired — release
        // these fresh leases locally and leave leasesRef alone (it may already
        // belong to the newer attempt).
        if (cancelled || !mountedRef.current) {
          releaseDiffLeases(leases, lastViewStateRef.current);
          return;
        }

        const acquiredPlan = reconcileAcquiredDiffModel({
          lease: modified,
          existing: existingSnap !== null,
          lastWrite: lastWriteRef.current,
          disk: live,
        });
        if (acquiredPlan?.kind === "conflict" && typeof acquiredPlan.revision === "number") {
          setConflict({ text: acquiredPlan.disk, mtime: acquiredPlan.revision });
          setLiveError(null);
        } else if (acquiredPlan?.kind === "unreadable") {
          const presented = presentLiveUnreadable({
            plan: acquiredPlan,
            readable: live.ok,
          });
          if (presented.kind === "pane-error") {
            releaseDiffLeases(leases, lastViewStateRef.current);
            setState({ status: "error", error: presented.error });
            return;
          }
          setLiveError(presented.message);
          setConflict(null);
        } else if (acquiredPlan?.kind === "apply") {
          setConflict(null);
          setLiveError(null);
        }

        leasesRef.current = leases;
        setState({ status: "editor", plan, leases });
        // These are the bytes now on screen; a deleted/absent live side has no
        // revision to have seen.
        if (live.ok) onLoaded?.(relPath, live.source, live.mtime);
      } catch (error) {
        if (cancelled || !mountedRef.current) return;
        // Defensive: start-of-load release should have cleared leasesRef, but
        // never leave an editor lease held under an error pane.
        if (leasesRef.current !== null) {
          releaseDiffLeases(leasesRef.current, lastViewStateRef.current);
          leasesRef.current = null;
        }
        setState({ status: "error", error: errorMessage(error) });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, ticket.id, relPath, previousPath, status, binary, onLoaded]);

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
      const source = state.plan.modifiedSource;
      if (
        !matchesFileChangeIdentity(event, {
          projectId,
          ticketId: source === "worktree" ? ticket.id : null,
          relPath,
          source,
        })
      ) {
        return;
      }
      // Main tore this subscription down (issue #134): hand the stale hold back
      // and re-arm, or say that the pane has stopped following disk.
      if (event.final === true) {
        void rearmWatch(window.api.files, { projectId, ticketId: ticket.id, relPath }).then(
          (result) => {
            if (!result.ok && mountedRef.current) {
              toastError(`Live updates for ${name} are off. Reopen the diff to refresh it.`);
            }
          },
        );
      }
      void (async () => {
        const leases = leasesRef.current;
        if (leases === null || !mountedRef.current) return;

        const read = await window.api.files.read({
          projectId,
          ticketId: ticket.id,
          relPath,
        });
        // Load effect may have released+replaced leases while we awaited.
        if (
          !isDiffLeaseCurrent({
            captured: leases,
            current: leasesRef.current,
            mounted: mountedRef.current,
          })
        ) {
          return;
        }

        let disk: DiffLiveRead;
        if (!read.ok) {
          disk = mapFilesReadFailure(read.error);
        } else if (read.content.type !== "text") {
          // Binary / image under a text Diff tab — treat as unreadable for reconcile.
          disk = { ok: false, error: "File is no longer plain text." };
        } else {
          disk = {
            ok: true,
            text: read.content.text,
            mtime: read.mtime,
            source: read.source,
            truncated: read.content.truncated,
          };
        }

        const plan = applyDiffLiveReconciliation({
          lease: leases.modified,
          lastWrite: lastWriteRef.current,
          disk,
          unreadableRevision: event.revision,
        });

        // Re-check before mutating — adopt/discard must not touch a replaced lease.
        if (
          !isDiffLeaseCurrent({
            captured: leases,
            current: leasesRef.current,
            mounted: mountedRef.current,
          })
        ) {
          return;
        }

        if (plan.kind === "apply") {
          if (mountedRef.current) {
            setConflict(null);
            setLiveError(null);
          }
          return;
        }
        if (plan.kind === "conflict") {
          if (mountedRef.current && typeof plan.revision === "number") {
            setConflict({ text: plan.disk, mtime: plan.revision });
            setLiveError(null);
          }
          return;
        }
        // A file that merely grew past the 1 MiB read cap must NOT tear the
        // pane down just because the tab happens to be clean: it stays up,
        // read-only (the render below ORs `liveError` into `modifiedReadOnly`,
        // and `handleSave` refuses while it is set), with the reason inline.
        // Only a read that actually failed replaces the pane. See
        // {@link presentLiveUnreadable}.
        if (!mountedRef.current) return;
        const presented = presentLiveUnreadable({ plan, readable: disk.ok });
        if (presented.kind === "pane-error") {
          setState({ status: "error", error: presented.error });
          return;
        }
        setLiveError(presented.message);
        setConflict(null);
      })();
    });

    return () => {
      unsubscribe();
      void window.api.files.unwatch({ projectId, ticketId: ticket.id, relPath });
    };
  }, [state, modifiedReadOnly, projectId, ticket.id, relPath, name]);

  const handleSave = React.useCallback(
    async (text: string): Promise<MonacoFileSaveResult> => {
      if (state.status !== "editor" || state.plan.modifiedReadOnly || liveError !== null) {
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
        lastWriteRef.current = { text, revision: result.mtime };
        onLocalSave?.(relPath, state.plan.modifiedSource, result.mtime);
        return { ok: true, revision: result.mtime };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
    [state, liveError, projectId, ticket.id, relPath, onLocalSave],
  );

  const handleViewStateChange = React.useCallback(
    (viewState: unknown) => {
      lastViewStateRef.current = viewState;
      onViewStateChange?.(viewState);
    },
    [onViewStateChange],
  );

  const handleEditorInitFailed = React.useCallback(
    (message: string) => {
      if (!mountedRef.current) return;
      if (leasesRef.current !== null) {
        releaseDiffLeases(leasesRef.current, lastViewStateRef.current);
        leasesRef.current = null;
      }
      setState({
        status: "stub",
        stubReason: message,
        path: relPath,
        previousPath,
      });
    },
    [previousPath, relPath],
  );

  const applyDiskAndDiscardDraft = React.useCallback(() => {
    const leases = leasesRef.current;
    if (leases === null || conflict === null) return;
    leases.modified.applyExternalUpdate({
      baseline: conflict.text,
      value: conflict.text,
      revision: conflict.mtime,
    });
    lastWriteRef.current = null;
    setConflict(null);
    // A deliberate "show me disk" IS an inspection of those bytes: the user
    // asked for them and is now looking at them.
    if (state.status === "editor") onLoaded?.(relPath, state.plan.modifiedSource, conflict.mtime);
  }, [conflict, onLoaded, relPath, state]);

  const overwriteDiskWithDraft = React.useCallback(async () => {
    const leases = leasesRef.current;
    // Mirrors FileView's `writingRef`: a double-click must not fire two writes,
    // where the second would race its own echo through a stale `expectedMtime`.
    if (leases === null || conflict === null || writingRef.current) return;
    writingRef.current = true;
    try {
      const text = leases.modified.model.getValue();
      const result = await handleSave(text);
      if (!result.ok) {
        toastError(`Could not overwrite ${name}: ${result.error}`);
        return;
      }
      if (leases.modified.model.getValue() === text) {
        leases.modified.markSaved(result.revision);
      } else {
        leases.modified.applyExternalUpdate({
          baseline: text,
          value: leases.modified.model.getValue(),
          revision: result.revision,
        });
      }
      setConflict(null);
      setLiveError(null);
    } finally {
      writingRef.current = false;
    }
  }, [conflict, handleSave, name]);

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
      {liveError !== null ? (
        <LiveReconciliationAffordance kind="error" message={liveError} />
      ) : null}
      {conflict !== null ? (
        <LiveReconciliationAffordance
          kind="conflict"
          onUseDisk={applyDiskAndDiscardDraft}
          onOverwriteDisk={() => void overwriteDiskWithDraft()}
        />
      ) : null}
      <MonacoDiffEditor
        originalLease={state.leases.original}
        modifiedLease={state.leases.modified}
        presentation={presentation}
        modifiedReadOnly={state.plan.modifiedReadOnly || liveError !== null}
        ariaLabel={`${baseNameOf(relPath)} diff`}
        onSave={handleSave}
        onDirtyChange={onDirtyChange}
        initialViewState={initialViewState}
        onViewStateChange={handleViewStateChange}
        onInitFailed={handleEditorInitFailed}
      />
    </div>
  );
}
