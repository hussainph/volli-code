/**
 * The Project Files workbench (CONCEPT #54/#55/#56): the full-repository file
 * surface, rooted EXCLUSIVELY in the selected project's Main checkout. A
 * full-width tab strip over one editor pane, driven by the sidebar file tree.
 *
 * Three things this component is careful about:
 *
 *  - **Main checkout only.** Every `FileView` here is rendered with NO
 *    `ticketId`, so paths resolve against the project's own working copy. These
 *    are ordinary human edits: nothing here touches board/session state, and
 *    no ticket automation can observe them.
 *  - **Lazy restoration.** Only the ACTIVE tab's `FileView` is mounted, so
 *    returning to Files (or relaunching into a restored ten-tab strip) performs
 *    exactly one file read. Inactive tabs hold identity and remembered cursor
 *    state, never contents (decision #55) — nothing is prefetched.
 *  - **No work is lost on close.** A dirty tab routes through a Save / Discard /
 *    Cancel guard whose disposition is decided by the pure `close-guard` helpers,
 *    and a FAILED save aborts the close instead of closing over the failure.
 *
 * The page is conditionally rendered by main-content.tsx (unmounted on nav
 * away), which is exactly why the tab workspace lives in the workspace store
 * rather than here.
 */
import * as React from "react";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { baseNameOf, EMPTY_FILE_WORKSPACE, errorMessage, type Project } from "@volli/shared";

import { FileTabStrip } from "@renderer/components/files/file-tab-strip";
import {
  planCloseOthers,
  planTabClose,
  resolveTabClose,
  type TabCloseResolution,
} from "@renderer/components/files/close-guard";
import { FileView } from "@renderer/components/ticket/file-view";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { fileDocumentIdentity } from "@renderer/editor/document-identity";
import type { DocumentSnapshot } from "@renderer/editor/document-registry";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { toastError } from "@renderer/lib/toast";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** Stable empty map so the store selector doesn't hand back a new object each read. */
const NO_VIEW_STATES: Record<string, unknown> = {};

/** The close guard's queue: the tab being asked about, plus the ones still to come. */
interface PendingClose {
  relPath: string;
  rest: readonly string[];
}

/**
 * The mtime a close-guard save must carry as `expectedMtime`, or `null` when
 * the document's version on disk is unknown.
 *
 * `externalRevision`, NOT `baselineRevision` — the two diverge in exactly the
 * case the guard exists for. `DocumentRegistry.adoptCleanBaseline` advances
 * `baselineRevision` only for a CLEAN document; over a dirty one (disk moved
 * under an unsaved draft — the editor's "Changed on disk" banner) it advances
 * `externalRevision` alone. Guarding on the stale baseline would make main
 * reject every Save-then-close of such a tab while ⌘S in the very same editor
 * succeeds, trapping the draft. `externalRevision` tracks the freshest mtime
 * this renderer has seen, which is what ⌘S carries too (file-view.tsx's
 * `syncedMtimeRef`), so both save paths agree.
 */
export function closeGuardExpectedMtime(snapshot: DocumentSnapshot): number | null {
  return typeof snapshot.externalRevision === "number" ? snapshot.externalRevision : null;
}

export function FilesPage() {
  const project = useSelectedProject();
  // Keyed by project so switching workspaces starts a clean workbench (the tab
  // set itself is per project in the store and restores on the way back).
  return project === null ? null : <FilesWorkbench key={project.id} project={project} />;
}

function FilesWorkbench({ project }: { project: Project }) {
  const projectId = project.id;
  const files = useWorkspaceStore(
    (state) => state.byProject[projectId]?.projectFiles ?? EMPTY_FILE_WORKSPACE,
  );
  const viewStates = useWorkspaceStore(
    (state) => state.byProject[projectId]?.projectFileViewStates ?? NO_VIEW_STATES,
  );
  const activateProjectFile = useWorkspaceStore((state) => state.activateProjectFile);
  const pinProjectFile = useWorkspaceStore((state) => state.pinProjectFile);
  const closeProjectFile = useWorkspaceStore((state) => state.closeProjectFile);
  const markProjectFileEdited = useWorkspaceStore((state) => state.markProjectFileEdited);
  const setProjectFileViewState = useWorkspaceStore((state) => state.setProjectFileViewState);

  /**
   * Which tabs the STRIP renders a dirty dot for. Fed by the active editor's
   * dirty reports and re-seeded on mount from the document registry, because a
   * dirty document deliberately outlives its view: navigating away from Files
   * and back must not lose the dot.
   *
   * Render mirror only — never the close guard's input. That seeding is
   * asynchronous (Monaco loads lazily), so a × clicked inside the seed window
   * would read an empty set and close a parked draft with no prompt; the guard
   * asks the registry itself instead (see `hasUnsavedWork`).
   */
  const [dirtyPaths, setDirtyPaths] = React.useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = React.useState<PendingClose | null>(null);
  const activeRelPath = files.activeRelPath;

  const markDirty = React.useCallback((relPath: string, dirty: boolean) => {
    setDirtyPaths((previous) => {
      if (previous.has(relPath) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(relPath);
      else next.delete(relPath);
      return next;
    });
  }, []);

  // `tabs` is the pure workspace's own array, returned by identity across
  // no-op transitions — a stable effect dependency. It is iterated directly
  // rather than joined into a delimited key: a relPath may legally contain a
  // newline on macOS, and splitting one back apart would invent two paths that
  // are open in no tab.
  const tabs = files.tabs;
  React.useEffect(() => {
    if (tabs.length === 0) return;
    let cancelled = false;
    void loadMonacoRuntime()
      .then((runtime) => {
        if (cancelled) return;
        const parked = tabs
          .map((tab) => tab.relPath)
          .filter(
            (relPath) =>
              runtime.registry
                .peek(fileDocumentIdentity({ projectId, relPath, source: "main" }))
                ?.snapshot().dirty === true,
          );
        if (parked.length > 0) setDirtyPaths((previous) => new Set([...previous, ...parked]));
      })
      .catch(() => {
        // Monaco failing to load is surfaced by the editor itself; there is
        // simply no registry to reconcile against here.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, tabs]);

  /** The registry handle for one open Main-checkout document, or `null`. */
  const peekDocument = React.useCallback(
    async (relPath: string) => {
      const runtime = await loadMonacoRuntime();
      return runtime.registry.peek(fileDocumentIdentity({ projectId, relPath, source: "main" }));
    },
    [projectId],
  );

  /**
   * Whether `relPath` holds unsaved work RIGHT NOW, asked of the document
   * registry — the same authority the editor reports its own dirty flag from,
   * and the only one that is correct before `dirtyPaths` has been seeded.
   */
  const hasUnsavedWork = React.useCallback(
    async (relPath: string): Promise<boolean> => {
      try {
        return (await peekDocument(relPath))?.snapshot().dirty === true;
      } catch {
        // Monaco never loaded, so no editor ever opened this tab and there is
        // no draft to protect. The failure itself is surfaced by the editor.
        return false;
      }
    },
    [peekDocument],
  );

  /**
   * Writes the tab's draft to the Main checkout, conflict-guarded on the
   * freshest mtime this renderer has seen for the file (see
   * {@link closeGuardExpectedMtime}) — exactly what ⌘S in the editor carries.
   * `false` means nothing reached disk — the caller must NOT close the tab.
   */
  const saveDocument = React.useCallback(
    async (relPath: string): Promise<boolean> => {
      const name = baseNameOf(relPath);
      try {
        const handle = await peekDocument(relPath);
        const model = handle?.model ?? null;
        // No live document (or nothing to write) — closing is safe.
        if (handle === null || model === null || !handle.snapshot().dirty) return true;
        const expectedMtime = closeGuardExpectedMtime(handle.snapshot());
        if (expectedMtime === null) {
          // A file document's revision IS its mtime, so this shouldn't happen —
          // but writing without the conflict guard is the one failure mode that
          // could silently destroy someone else's newer bytes, so refuse rather
          // than guess. The tab stays open with its draft intact.
          toastError(`Could not save ${name}: its version on disk is unknown.`);
          return false;
        }
        const result = await window.api.files.write({
          projectId,
          relPath,
          content: model.getValue(),
          expectedMtime,
        });
        if (!result.ok) {
          toastError(`Could not save ${name}: ${result.error}`);
          return false;
        }
        handle.markSaved(result.mtime);
        return true;
      } catch (error) {
        toastError(`Could not save ${name}: ${errorMessage(error)}`);
        return false;
      }
    },
    [peekDocument, projectId],
  );

  const closeTab = React.useCallback(
    (relPath: string) => {
      closeProjectFile(projectId, relPath);
      markDirty(relPath, false);
    },
    [closeProjectFile, markDirty, projectId],
  );

  /** Opens the guard for the first path that needs it, or clears the queue. */
  const confirmNext = React.useCallback((queue: readonly string[]) => {
    const [relPath, ...rest] = queue;
    setPending(relPath === undefined ? null : { relPath, rest });
  }, []);

  const requestClose = React.useCallback(
    async (relPath: string) => {
      if (planTabClose({ dirty: await hasUnsavedWork(relPath) }) === "close") closeTab(relPath);
      else setPending({ relPath, rest: [] });
    },
    [closeTab, hasUnsavedWork],
  );

  const requestCloseOthers = React.useCallback(
    async (keep: string) => {
      const relPaths = tabs.map((tab) => tab.relPath);
      const dirty = new Set<string>();
      await Promise.all(
        relPaths.map(async (relPath) => {
          if (await hasUnsavedWork(relPath)) dirty.add(relPath);
        }),
      );
      const plan = planCloseOthers({ relPaths, keep, isDirty: (relPath) => dirty.has(relPath) });
      for (const relPath of plan.close) closeTab(relPath);
      confirmNext(plan.confirm);
    },
    [closeTab, confirmNext, hasUnsavedWork, tabs],
  );

  /**
   * Applies the user's answer. Cancel and a failed save both stop the whole run
   * — a queued "Close Others" must not march on past a tab the user just chose
   * to keep.
   */
  const resolvePending = React.useCallback(
    async (target: PendingClose, choice: TabCloseResolution["choice"]) => {
      const resolution: TabCloseResolution =
        choice === "save"
          ? { choice: "save", saved: await saveDocument(target.relPath) }
          : { choice };
      if (resolution.choice === "discard") (await peekDocument(target.relPath))?.discard();
      if (resolveTabClose(resolution) === "keep-open") {
        setPending(null);
        return;
      }
      closeTab(target.relPath);
      confirmNext(target.rest);
    },
    [closeTab, confirmNext, peekDocument, saveDocument],
  );

  const handleDirtyChange = React.useCallback(
    (dirty: boolean) => {
      if (activeRelPath === null) return;
      markDirty(activeRelPath, dirty);
      // Decision #56: a dirty tab is never replaced, so the first edit promotes
      // the preview slot to a persistent tab.
      if (dirty) markProjectFileEdited(projectId, activeRelPath);
    },
    [activeRelPath, markDirty, markProjectFileEdited, projectId],
  );

  const handleViewStateChange = React.useCallback(
    (viewState: unknown) => {
      if (activeRelPath === null) return;
      setProjectFileViewState(projectId, activeRelPath, viewState);
    },
    [activeRelPath, projectId, setProjectFileViewState],
  );

  return (
    <div data-testid="files-workbench" className="flex min-h-0 flex-1 flex-col">
      <FileTabStrip
        tabs={tabs}
        activeRelPath={activeRelPath}
        dirtyPaths={dirtyPaths}
        onSelect={(relPath) => activateProjectFile(projectId, relPath)}
        onPin={(relPath) => pinProjectFile(projectId, relPath)}
        onClose={(relPath) => void requestClose(relPath)}
        onCloseOthers={(keep) => void requestCloseOthers(keep)}
      />

      {activeRelPath === null ? (
        <NoOpenFile />
      ) : (
        // Only the ACTIVE tab reads. `key` remounts the view per file so its
        // load/watch effects restart cleanly, exactly as ticket file tabs do.
        <FileView
          key={activeRelPath}
          projectId={projectId}
          relPath={activeRelPath}
          initialViewState={viewStates[activeRelPath]}
          onViewStateChange={handleViewStateChange}
          onDirtyChange={handleDirtyChange}
        />
      )}

      <SaveGuardDialog
        pending={pending}
        onCancel={() => setPending(null)}
        onChoose={(target, choice) => void resolvePending(target, choice)}
      />
    </div>
  );
}

/** The workbench with nothing open — points at the one thing that opens a tab. */
function NoOpenFile() {
  return (
    <div
      data-testid="files-empty-state"
      className="flex flex-1 flex-col items-center justify-center gap-2 text-center"
    >
      <FoldersIcon weight="fill" className="size-8 text-muted-foreground" />
      <h2 className="text-heading font-semibold">Files</h2>
      <p className="text-sm text-muted-foreground">Select a file in the sidebar to open it here.</p>
    </div>
  );
}

/**
 * The dirty-close guard. Discard is the destructive answer and is styled as
 * such; Save is the default action. Dismissing by Esc or the overlay is a
 * Cancel — the answer that changes nothing.
 */
function SaveGuardDialog({
  pending,
  onCancel,
  onChoose,
}: {
  pending: PendingClose | null;
  onCancel(): void;
  onChoose(target: PendingClose, choice: TabCloseResolution["choice"]): void;
}) {
  const name = pending === null ? "" : baseNameOf(pending.relPath);
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="file-save-guard">
        <AlertDialogHeader>
          <AlertDialogTitle>Save changes to {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {name} has unsaved changes. Closing it without saving discards them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="file-save-guard-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="file-save-guard-discard"
            onClick={() => {
              if (pending !== null) onChoose(pending, "discard");
            }}
          >
            Discard
          </AlertDialogAction>
          <AlertDialogAction
            data-testid="file-save-guard-save"
            onClick={() => {
              if (pending !== null) onChoose(pending, "save");
            }}
          >
            Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
