import * as React from "react";
import { baseNameOf, EMPTY_FILE_WORKSPACE, errorMessage } from "@volli/shared";

import {
  planCloseOthers,
  planTabClose,
  resolveTabClose,
  type TabCloseResolution,
} from "@renderer/components/files/close-guard";
import { fileDocumentIdentity } from "@renderer/editor/document-identity";
import type { DocumentSnapshot } from "@renderer/editor/document-registry";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { toastError } from "@renderer/lib/toast";
import { useWorkspaceStore } from "@renderer/stores/workspace";

const NO_VIEW_STATES: Record<string, unknown> = {};
const NO_DIRTY_PATHS: ReadonlySet<string> = new Set();

interface DirtyPathsState {
  projectId: string | null;
  paths: ReadonlySet<string>;
}

/** The close guard's queue: the tab being asked about, plus the ones still to come. */
interface PendingClose {
  projectId: string;
  relPath: string;
  rest: readonly string[];
}

/**
 * The mtime a close-guard save must carry as `expectedMtime`, or `null` when
 * the document's version on disk is unknown.
 *
 * `externalRevision`, not `baselineRevision`: a dirty document can observe a
 * newer disk version without adopting it as its clean baseline. This is the
 * same revision ⌘S carries, so Save-then-close and direct save cannot disagree.
 */
export function closeGuardExpectedMtime(snapshot: DocumentSnapshot): number | null {
  return typeof snapshot.externalRevision === "number" ? snapshot.externalRevision : null;
}

/**
 * Shared controller for a project's Main-checkout File tabs.
 *
 * Both the retiring Files nav page and Home's mixed tab strip use the same
 * persisted FileWorkspaceState and FileView. This hook keeps the less visible
 * half shared too: dirty mirrors, parked-model seeding, conflict-guarded save,
 * queued close confirmation, and per-file Monaco view state.
 */
export function useProjectFileWorkspace(
  projectId: string | null,
  onCloseFile: (relPath: string) => void,
) {
  const files = useWorkspaceStore((state) =>
    projectId === null
      ? EMPTY_FILE_WORKSPACE
      : (state.byProject[projectId]?.projectFiles ?? EMPTY_FILE_WORKSPACE),
  );
  const viewStates = useWorkspaceStore((state) =>
    projectId === null
      ? NO_VIEW_STATES
      : (state.byProject[projectId]?.projectFileViewStates ?? NO_VIEW_STATES),
  );
  const markProjectFileEdited = useWorkspaceStore((state) => state.markProjectFileEdited);
  const setProjectFileViewState = useWorkspaceStore((state) => state.setProjectFileViewState);
  const [dirtyState, setDirtyState] = React.useState<DirtyPathsState>(() => ({
    projectId,
    paths: new Set(),
  }));
  const dirtyPaths = dirtyState.projectId === projectId ? dirtyState.paths : NO_DIRTY_PATHS;
  const [pending, setPending] = React.useState<PendingClose | null>(null);
  const currentPending = pending?.projectId === projectId ? pending : null;
  const activeRelPath = files.activeRelPath;

  const markDirty = React.useCallback(
    (relPath: string, dirty: boolean) => {
      setDirtyState((previous) => {
        const paths = previous.projectId === projectId ? previous.paths : NO_DIRTY_PATHS;
        if (previous.projectId === projectId && paths.has(relPath) === dirty) return previous;
        const next = new Set(paths);
        if (dirty) next.add(relPath);
        else next.delete(relPath);
        return { projectId, paths: next };
      });
    },
    [projectId],
  );

  const tabs = files.tabs;
  React.useEffect(() => {
    if (projectId === null || tabs.length === 0) return;
    let cancelled = false;
    void loadMonacoRuntime()
      .then((runtime) => {
        if (cancelled) return;
        const parked = tabs
          .map((tab) => tab.relPath)
          .filter((relPath) => {
            const snapshot = runtime.registry
              .peek(fileDocumentIdentity({ projectId, relPath, source: "main" }))
              ?.snapshot();
            return snapshot?.dirty === true && snapshot.savePolicy === "explicit";
          });
        if (parked.length > 0) {
          setDirtyState((previous) => ({
            projectId,
            paths: new Set([
              ...(previous.projectId === projectId ? previous.paths : NO_DIRTY_PATHS),
              ...parked,
            ]),
          }));
        }
      })
      .catch(() => {
        // Monaco load failures belong to the mounted editor. There is no
        // registry to reconcile against here until that surface recovers.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, tabs]);

  const peekDocument = React.useCallback(
    async (relPath: string) => {
      if (projectId === null) return null;
      const runtime = await loadMonacoRuntime();
      return runtime.registry.peek(fileDocumentIdentity({ projectId, relPath, source: "main" }));
    },
    [projectId],
  );

  const hasUnsavedWork = React.useCallback(
    async (relPath: string): Promise<boolean> => {
      try {
        return (await peekDocument(relPath))?.snapshot().dirty === true;
      } catch {
        return false;
      }
    },
    [peekDocument],
  );

  const saveDocument = React.useCallback(
    async (relPath: string): Promise<boolean> => {
      if (projectId === null) return false;
      const name = baseNameOf(relPath);
      try {
        const handle = await peekDocument(relPath);
        const model = handle?.model ?? null;
        if (handle === null || model === null || !handle.snapshot().dirty) return true;
        const expectedMtime = closeGuardExpectedMtime(handle.snapshot());
        if (expectedMtime === null) {
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
      onCloseFile(relPath);
      markDirty(relPath, false);
    },
    [markDirty, onCloseFile],
  );

  const confirmNext = React.useCallback(
    (queue: readonly string[]) => {
      const [relPath, ...rest] = queue;
      setPending(relPath === undefined || projectId === null ? null : { projectId, relPath, rest });
    },
    [projectId],
  );

  const requestClose = React.useCallback(
    async (relPath: string) => {
      if (projectId === null) return;
      if (planTabClose({ dirty: await hasUnsavedWork(relPath) }) === "close") closeTab(relPath);
      else setPending({ projectId, relPath, rest: [] });
    },
    [closeTab, hasUnsavedWork, projectId],
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
      if (projectId === null || activeRelPath === null) return;
      markDirty(activeRelPath, dirty);
      if (dirty) markProjectFileEdited(projectId, activeRelPath);
    },
    [activeRelPath, markDirty, markProjectFileEdited, projectId],
  );

  const handleViewStateChange = React.useCallback(
    (viewState: unknown) => {
      if (projectId === null || activeRelPath === null) return;
      setProjectFileViewState(projectId, activeRelPath, viewState);
    },
    [activeRelPath, projectId, setProjectFileViewState],
  );

  const cancelClose = React.useCallback(() => setPending(null), []);
  const chooseClose = React.useCallback(
    (choice: TabCloseResolution["choice"]) => {
      if (currentPending !== null) void resolvePending(currentPending, choice);
    },
    [currentPending, resolvePending],
  );

  // Every callback out of here is stable, so a consumer can depend on ONE of
  // them without the whole controller's identity dragging its memo along.
  // `handleClose` in `home-surface.tsx` is the case that matters: it also holds
  // the terminal close guard, and a callback rebuilt on every render is a memo
  // that never holds.
  return {
    files,
    viewStates,
    dirtyPaths,
    requestClose,
    requestCloseOthers,
    handleDirtyChange,
    handleViewStateChange,
    pendingRelPath: currentPending?.relPath ?? null,
    cancelClose,
    chooseClose,
  };
}
