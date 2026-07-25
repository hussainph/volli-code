import * as React from "react";
import {
  baseNameOf,
  displayTicketId,
  errorMessage,
  type FileSource,
  type Ticket,
} from "@volli/shared";

import {
  planTabClose,
  resolveTabClose,
  type TabCloseResolution,
} from "@renderer/components/files/close-guard";
import { ContentColumn } from "@renderer/components/layout/content-column";
import type { MarkdownFileRefs } from "@renderer/components/editor/markdown-live-editor";
import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { createTerminalSession } from "@renderer/components/sessions/session-create";
import { FileView } from "@renderer/components/ticket/file-view";
import { RailDrawer } from "@renderer/components/ticket/rail-drawer";
import { RailResizeHandle } from "@renderer/components/ticket/rail-resize-handle";
import { TicketDocTab } from "@renderer/components/ticket/ticket-doc-tab";
import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { TicketSessionPlane } from "@renderer/components/ticket/ticket-session-plane";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { TicketTitle } from "@renderer/components/ticket/ticket-title";
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
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { isEscapeExempt } from "@renderer/lib/escape-guard";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { sessionPanes, ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { useCloseGuard } from "@renderer/terminal/close-guard";
import { closeTicketSession, renameTerminalSession } from "@renderer/terminal/session-lifecycle";
import { getEngine } from "@renderer/terminal/registry";

/** The always-present Doc tab's id — the fallback every persisted/live tab id
 * resets to once it no longer names a renderable tab (doc/file/session). */
const DOC_TAB_ID = "doc";

/**
 * The right rail's bottom "Details" drawer (status/priority/labels/worktree).
 * Sessions dominate the rail; Details is collapsed by default and pinned
 * beneath them (below the sessions panel's own History drawer — the three
 * stack as Sessions / History / Details), its open/closed state persisted
 * app-wide via `useUiStore` (mirrors the `railCollapsed` chrome preference).
 */
function TicketDetailsDrawer({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  const expanded = useUiStore((state) => state.detailsExpanded);
  const setExpanded = useUiStore((state) => state.setDetailsExpanded);
  return (
    <RailDrawer label="Details" open={expanded} onOpenChange={setExpanded}>
      <div className="max-h-80 overflow-y-auto px-4 pb-4">
        <TicketProperties projectId={projectId} ticket={ticket} />
      </div>
    </RailDrawer>
  );
}

/**
 * The full-page ticket detail view (ticket-detail-mvp decision #1), rendered
 * by board-page.tsx in place of the board's content when a ticket is open —
 * the global sessions layer and sidebar stay mounted around it (they live
 * higher up the tree, in main-content.tsx/app-shell.tsx). Layout follows the
 * browser-window metaphor: ONE full-width Chrome-style tab row at the very top,
 * spanning above both the main column (title → content plane) and the right
 * rail (sessions → collapsible Details). Navigation is the chrome bar's ←/→
 * history plus Escape; there's no breadcrumb. The tab plane hosts the ticket's
 * live terminals; those stay resident (engines outlive the view via the module
 * registry, decision #8) and are positioned by the always-mounted overlay onto
 * the plane's measured box in the main column — so the rail collapsing (which
 * hands the plane the full width) never unmounts a terminal.
 */
export function TicketDetail({
  projectId,
  ticketPrefix,
  ticket,
}: {
  projectId: string;
  /** Kept in the props contract for board-page; the PTY cwd now resolves in main. */
  projectPath: string;
  ticketPrefix: string;
  ticket: Ticket;
}) {
  const closeTicket = useWorkspaceStore((state) => state.closeTicket);
  const openTicketFile = useWorkspaceStore((state) => state.openTicketFile);
  const closeTicketFile = useWorkspaceStore((state) => state.closeTicketFile);
  const setTicketActiveTab = useWorkspaceStore((state) => state.setTicketActiveTab);
  const ticketTabsState = useWorkspaceStore(
    (state) => state.byProject[projectId]?.ticketTabs?.[ticket.id],
  );
  const sessionTabs = useSessionsStore((state) => state.byOwner[ticket.id]?.tabs);
  const creating = useSessionsStore((state) => state.starting[ticket.id] ?? false);
  const railCollapsed = useUiStore((state) => state.railCollapsed);
  const railWidth = useUiStore((state) => state.railWidth);
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const setTerminalFocusTarget = useUiStore((state) => state.setTerminalFocusTarget);
  const clearTerminalFocusUnlessTicket = useUiStore(
    (state) => state.clearTerminalFocusUnlessTicket,
  );
  const closeGuard = useCloseGuard();

  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);

  const openFiles = ticketTabsState?.files ?? [];
  const activeTabId = ticketTabsState?.active ?? DOC_TAB_ID;

  // The per-tab worktree badge is driven by each file's resolved source, which
  // only the FileView knows after reading — it reports back via `onSource`.
  const [fileSources, setFileSources] = React.useState<Record<string, FileSource>>({});
  const reportFileSource = React.useCallback((relPath: string, source: FileSource) => {
    setFileSources((prev) => (prev[relPath] === source ? prev : { ...prev, [relPath]: source }));
  }, []);

  /**
   * Which open file tabs hold unsaved work. Repository files (Markdown very
   * much included) reach disk only on ⌘S since CONCEPT #49, so a draft has to
   * be BOTH visible on its tab and defended on close — otherwise closing a tab
   * silently orphans the only copy of that work in the document registry, where
   * no surface can reach it. Fed by the active editor's dirty reports and
   * re-seeded from the registry, because a dirty document deliberately outlives
   * its view: only the active file tab is mounted here, and leaving the ticket
   * unmounts even that while the draft stays parked.
   */
  const [dirtyFiles, setDirtyFiles] = React.useState<ReadonlySet<string>>(() => new Set());
  /** The file tab the Save / Discard / Cancel guard is currently asking about. */
  const [pendingClose, setPendingClose] = React.useState<string | null>(null);

  const markFileDirty = React.useCallback((relPath: string, dirty: boolean) => {
    setDirtyFiles((previous) => {
      if (previous.has(relPath) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(relPath);
      else next.delete(relPath);
      return next;
    });
  }, []);

  /**
   * The registry handles a ticket file tab could be backed by. A repo path
   * opened from a ticket resolves to the ticket's WORKTREE copy or to Main
   * (`.volli/**`, and tickets without a materialized worktree), and the guard
   * runs for tabs whose view may never have mounted this session — so both
   * identities are probed rather than guessed from `fileSources`.
   */
  const peekFileDocuments = React.useCallback(
    (registry: Awaited<ReturnType<typeof loadMonacoRuntime>>["registry"], relPath: string) =>
      (["worktree", "main"] as const).flatMap((source) => {
        const handle = registry.peek(
          fileDocumentIdentity({ projectId, ticketId: ticket.id, relPath, source }),
        );
        return handle === null ? [] : [handle];
      }),
    [projectId, ticket.id],
  );

  /** The handle holding this tab's draft, or any open one, or `null`. */
  const peekFileDocument = React.useCallback(
    async (relPath: string) => {
      const runtime = await loadMonacoRuntime();
      const handles = peekFileDocuments(runtime.registry, relPath);
      return handles.find((handle) => handle.snapshot().dirty) ?? handles[0] ?? null;
    },
    [peekFileDocuments],
  );

  const openFileKey = openFiles.join("\n");
  React.useEffect(() => {
    if (openFileKey === "") return;
    let cancelled = false;
    void loadMonacoRuntime()
      .then((runtime) => {
        if (cancelled) return;
        const parked = openFileKey
          .split("\n")
          .filter((relPath) =>
            peekFileDocuments(runtime.registry, relPath).some((handle) => handle.snapshot().dirty),
          );
        if (parked.length > 0) setDirtyFiles((previous) => new Set([...previous, ...parked]));
      })
      .catch(() => {
        // Monaco failing to load is surfaced by the editor itself; there is
        // simply no registry to reconcile against here.
      });
    return () => {
      cancelled = true;
    };
  }, [openFileKey, peekFileDocuments]);

  /**
   * Writes a tab's draft, conflict-guarded on the FRESHEST revision the
   * document has seen on disk (`externalRevision`, advanced by every re-read) —
   * not the baseline it was last saved at, which an agent touching the file
   * under an open draft would leave stale, wedging every close on a rejected
   * `expectedMtime`. This is the same mtime the editor's own ⌘S carries.
   * `false` means nothing reached disk, so the caller must NOT close the tab.
   */
  const saveFileDocument = React.useCallback(
    async (relPath: string): Promise<boolean> => {
      const name = baseNameOf(relPath);
      try {
        const handle = await peekFileDocument(relPath);
        const model = handle?.model ?? null;
        // No live document (or nothing to write) — closing is safe.
        if (handle === null || model === null || !handle.snapshot().dirty) return true;
        const expectedMtime = handle.snapshot().externalRevision;
        if (typeof expectedMtime !== "number") {
          // A file document's revision IS its mtime, so this shouldn't happen —
          // but writing without the conflict guard is the one failure mode that
          // could silently destroy someone else's newer bytes, so refuse rather
          // than guess. The tab stays open with its draft intact.
          toastError(`Could not save ${name}: its version on disk is unknown.`);
          return false;
        }
        const result = await window.api.files.write({
          projectId,
          ticketId: ticket.id,
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
    [peekFileDocument, projectId, ticket.id],
  );

  const closeFileTab = React.useCallback(
    (relPath: string) => {
      closeTicketFile(projectId, ticket.id, relPath);
      markFileDirty(relPath, false);
      // Otherwise a reopened tab can briefly show the last-known worktree/main
      // badge from before the close, until the new FileView's own read reports
      // back — the record is keyed by relPath only and never pruned on its own.
      setFileSources((prev) => {
        if (!(relPath in prev)) return prev;
        const next = { ...prev };
        delete next[relPath];
        return next;
      });
    },
    [closeTicketFile, markFileDirty, projectId, ticket.id],
  );

  const requestCloseFileTab = React.useCallback(
    (relPath: string) => {
      if (planTabClose({ dirty: dirtyFiles.has(relPath) }) === "close") closeFileTab(relPath);
      else setPendingClose(relPath);
    },
    [closeFileTab, dirtyFiles],
  );

  /**
   * Applies the user's answer. Cancel keeps the tab, and so does a FAILED save
   * — closing over a write that never landed would discard the only copy.
   */
  const resolvePendingClose = React.useCallback(
    async (relPath: string, choice: TabCloseResolution["choice"]) => {
      const resolution: TabCloseResolution =
        choice === "save" ? { choice: "save", saved: await saveFileDocument(relPath) } : { choice };
      if (resolution.choice === "discard") (await peekFileDocument(relPath))?.discard();
      setPendingClose(null);
      if (resolveTabClose(resolution) === "close") closeFileTab(relPath);
    },
    [closeFileTab, peekFileDocument, saveFileDocument],
  );

  const setActiveTab = React.useCallback(
    (tabId: string) => setTicketActiveTab(projectId, ticket.id, tabId),
    [setTicketActiveTab, projectId, ticket.id],
  );

  // The `@file` index + create/open wiring, shared by the Doc body editor and
  // every open markdown file tab so any of them can reference (and create) files.
  const fileIndex = useFileIndex(projectId);
  const openFile = React.useCallback(
    (relPath: string) => openTicketFile(projectId, ticket.id, relPath),
    [openTicketFile, projectId, ticket.id],
  );
  const fileRefs = React.useMemo<MarkdownFileRefs>(
    () => ({
      getIndex: fileIndex.getIndex,
      refreshIndex: fileIndex.refresh,
      indexVersion: fileIndex.version,
      onOpenFile: openFile,
      createArtifact: async (name) => {
        try {
          const result = await window.api.files.createArtifact({ projectId, name });
          // A new artifact must show up in the index so its chip resolves at once.
          if (result.ok) fileIndex.forceRefresh();
          return result;
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
    }),
    [fileIndex, openFile, projectId],
  );

  // Doc (labeled with the ticket id) + one `"file"`-kind descriptor per open
  // `@file` ref + one `"session"`-kind descriptor per live session; routing
  // below is keyed off `kind`, not id, so the plane and content branch
  // generically.
  const tabs: TicketTabDescriptor[] = [
    { id: DOC_TAB_ID, kind: "doc", label: displayId },
    ...openFiles.map(
      (relPath): TicketTabDescriptor => ({
        id: `file:${relPath}`,
        kind: "file",
        label: baseNameOf(relPath),
        relPath,
        badge: fileSources[relPath] === "worktree" ? "worktree" : undefined,
        dirty: dirtyFiles.has(relPath),
      }),
    ),
    ...(sessionTabs ?? []).map(
      (tab): TicketTabDescriptor => ({
        id: tab.sessionId,
        kind: "session",
        label: tab.title,
      }),
    ),
  ];
  // A closed session tab, or a persisted active id with no live tab, falls back to Doc.
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]!;
  const activeTabIsRenderable = activeTab.id === activeTabId;
  const activeSessionTab =
    activeTab.kind === "session"
      ? sessionTabs?.find((candidate) => candidate.sessionId === activeTab.id)
      : undefined;
  const terminalFocused =
    terminalFocusTarget?.projectId === projectId &&
    terminalFocusTarget.ticketId === ticket.id &&
    terminalFocusTarget.sessionId === activeTab.id &&
    activeSessionTab !== undefined;

  // Only the active file tab mounts a FileView, so its dirty reports are for
  // exactly one path — the one below it in the tab strip.
  const activeFileRelPath = activeTab.kind === "file" ? (activeTab.relPath ?? null) : null;
  const handleFileDirtyChange = React.useCallback(
    (dirty: boolean) => {
      if (activeFileRelPath === null) return;
      markFileDirty(activeFileRelPath, dirty);
    },
    [activeFileRelPath, markFileDirty],
  );

  // The fallback above is purely visual — it renders Doc without writing the
  // store, so a persisted `active` naming a session that's since closed (or
  // one restored from a previous launch, which never repopulates: sessions
  // don't survive an app restart) stays wedged in workspace.ts forever
  // (`sanitizeTicketTabs` keeps any record whose `active !== "doc"`). Reset it
  // to Doc for real once we're sure it's actually stale rather than just not
  // hydrated yet — `creating` covers the one in-flight window where a new
  // session tab has been asked for but hasn't landed in the sessions store,
  // so `tabs` doesn't include it yet even though it's about to.
  React.useEffect(() => {
    if (creating || activeTabIsRenderable) return;
    setTicketActiveTab(projectId, ticket.id, DOC_TAB_ID);
  }, [creating, activeTabIsRenderable, setTicketActiveTab, projectId, ticket.id]);

  // A focus target names one concrete ticket-session tab. If tab selection or an
  // explicit close invalidates that identity within this ticket, restore ordinary
  // chrome immediately rather than leaving the app focused around a fallback.
  // (Cross-ticket staleness is handled at the store layer, below and on unmount.)
  React.useEffect(() => {
    if (terminalFocusTarget === null || terminalFocused) return;
    setTerminalFocusTarget(null);
  }, [terminalFocusTarget, terminalFocused, setTerminalFocusTarget]);

  // Store-layer enforcement of "the target must name a tab of the OPEN ticket":
  // whenever the open ticket becomes this one, drop any target left over from a
  // different ticket. Keyed on `ticket.id` so a surface that swaps the open
  // ticket without unmounting this view still re-checks the invariant. On mount
  // for the ticket you just focused, the target already matches, so this no-ops.
  React.useEffect(() => {
    clearTerminalFocusUnlessTicket(ticket.id);
  }, [ticket.id, clearTerminalFocusUnlessTicket]);

  // Leaving this ticket entirely (detail torn down / closed to the board) with no
  // successor view to run the effect above: clear the target the store still holds
  // for it, so app-shell doesn't hide all chrome around a ticket that's gone.
  React.useEffect(
    () => () => {
      useUiStore.getState().clearTerminalFocusForTicket(ticket.id);
    },
    [ticket.id],
  );

  // Toolbar clicks take DOM focus away from the canvas. Refit after either
  // geometry transition, then return focus to the split tab's active pane.
  React.useEffect(() => {
    const paneId = activeSessionTab?.activePaneId;
    if (paneId === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      const engine = getEngine(paneId);
      engine?.fit();
      engine?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [terminalFocused, activeSessionTab?.activePaneId]);

  const handleClose = React.useCallback(() => closeTicket(projectId), [closeTicket, projectId]);

  // Boots a ticket-scoped PTY (env-injected VOLLI_TICKET/VOLLI_ARTIFACTS_DIR in
  // main) as a resident tab, then switches to it. The terminal is hosted by the
  // always-mounted sessions layer, so it survives leaving the detail; only the
  // tab selection is stored here. Shared by the tab strip's "+" and the rail's
  // New-session button so both take the exact same path.
  const createSession = React.useCallback(async () => {
    const sessionId = await createTerminalSession(ticketScope(projectId, ticket.id));
    if (sessionId !== null) setActiveTab(sessionId);
  }, [projectId, ticket.id, setActiveTab]);

  const enterTerminalFocus = React.useCallback(() => {
    if (activeSessionTab === undefined) return;
    setTerminalFocusTarget({
      projectId,
      ticketId: ticket.id,
      sessionId: activeSessionTab.sessionId,
    });
  }, [activeSessionTab, projectId, ticket.id, setTerminalFocusTarget]);

  // ⌘Escape exits terminal focus. Bare Escape is deliberately left alone so it
  // reaches the PTY — Claude Code interrupts on Esc and TUIs (vim, etc.) lean on
  // it constantly, so a blanket Escape capture would break the terminal. ⌘Escape
  // is a chord no terminal app consumes; we capture it (capture phase, before the
  // renderer can forward it) and preventDefault so it never reaches the PTY. The
  // "close ticket detail" listener below early-returns while focused, so it can't
  // also fire off this keypress.
  React.useEffect(() => {
    if (!terminalFocused) return;
    function exitTerminalFocus(event: KeyboardEvent) {
      if (event.key !== "Escape" || !event.metaKey) return;
      if (event.defaultPrevented || isEscapeExempt(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setTerminalFocusTarget(null);
    }
    window.addEventListener("keydown", exitTerminalFocus, true);
    return () => window.removeEventListener("keydown", exitTerminalFocus, true);
  }, [terminalFocused, setTerminalFocusTarget]);

  // Escape closes the detail view and returns to the board — but only when
  // focus isn't inside an input/textarea/contenteditable or an open menu/
  // dialog, the same guard board.tsx's own Escape-deselect uses, so a
  // property dropdown or the label editor's text field can still dismiss
  // itself on Escape without also closing the whole view. Board's own
  // Escape-deselect listener is inert while this view is mounted — board.tsx
  // isn't rendered at all (board-page.tsx swaps the two) — so the two never
  // fire off the same keypress.
  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (terminalFocused) return;
      if (isEscapeExempt(event.target)) return;
      handleClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose, terminalFocused]);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* One full-width tab row above both the main column and the rail (the
          browser-window metaphor). The active tab fuses with the content plane
          in the main column below it. */}
        {terminalFocused ? null : (
          <TicketTabStrip
            tabs={tabs}
            activeTabId={activeTab.id}
            creating={creating}
            onSelectTab={setActiveTab}
            onCloseTab={(tab) => {
              if (tab.kind === "file" && tab.relPath !== undefined) {
                // A file tab with an unsaved draft routes through the Save /
                // Discard / Cancel guard first (CONCEPT #49).
                requestCloseFileTab(tab.relPath);
                return;
              }
              const sessionId = tab.id;
              const sessionTab = sessionTabs?.find(
                (candidate) => candidate.sessionId === sessionId,
              );
              const liveIds = sessionTab
                ? sessionPanes(sessionTab.layout)
                    .filter((pane) => pane.exitCode === null)
                    .map((pane) => pane.sessionId)
                : [sessionId];
              closeGuard.guard(liveIds, () => closeTicketSession(ticket.id, sessionId));
            }}
            onRenameSessionTab={(sessionId, title) => renameTerminalSession(sessionId, title)}
            onNewSession={() => void createSession()}
            canFocusTerminal={activeSessionTab !== undefined}
            onEnterTerminalFocus={enterTerminalFocus}
          />
        )}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* No horizontal padding here: the Doc tab centers its title/body on
            the measure via <ContentColumn>; file views own their edges and pick
            their own tier (markdown reads on the measure, code/binary go fluid);
            terminals get every pixel. Only the Doc tab shows the ticket title +
            top air — file and session tabs are workbench surfaces the tab strip
            already names. */}
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden",
              activeTab.kind === "doc" && "pt-8",
            )}
          >
            {activeTab.kind === "doc" && (
              <ContentColumn>
                <TicketTitle ticket={ticket} />
              </ContentColumn>
            )}
            {/* Positioning context for the resident terminal plane: Doc/file tabs
              scroll in-flow; the plane overlays them, shown only for a session tab. */}
            <div
              className={cn(
                "relative flex min-h-0 flex-1 flex-col",
                activeTab.kind === "doc" && "mt-3",
              )}
            >
              {activeTab.kind === "doc" ? (
                <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                  <TicketDocTab ticket={ticket} fileRefs={fileRefs} />
                </div>
              ) : null}
              {activeTab.kind === "file" && activeTab.relPath !== undefined ? (
                <FileView
                  key={activeTab.relPath}
                  projectId={projectId}
                  ticketId={ticket.id}
                  relPath={activeTab.relPath}
                  fileRefs={fileRefs}
                  onSource={reportFileSource}
                  onDirtyChange={handleFileDirtyChange}
                />
              ) : null}
              <TicketSessionPlane
                ticketId={ticket.id}
                activeSessionId={activeTab.kind === "session" ? activeTab.id : null}
              />
            </div>
          </div>
          {railCollapsed || terminalFocused ? null : (
            // Resizable details rail: a grip on its inner (left) edge widens it
            // leftward, mirroring the left sidebar's outer-edge handle. `relative`
            // makes the aside the grip's positioning context; the width persists
            // app-wide via the ui store.
            <aside
              className="relative flex shrink-0 flex-col border-l border-sidebar-border bg-sidebar"
              style={{ width: railWidth }}
            >
              <RailResizeHandle />
              {/* The panel owns the scrollable working set AND the pinned History
                drawer, so History and Details stack as RailDrawer siblings. */}
              <TicketSessionsPanel
                ticketId={ticket.id}
                creating={creating}
                onNewSession={() => void createSession()}
                onActivateSession={setActiveTab}
              />
              <TicketDetailsDrawer projectId={projectId} ticket={ticket} />
            </aside>
          )}
        </div>
      </div>
      <ConfirmCloseDialog
        pending={closeGuard.pending}
        onConfirm={closeGuard.confirm}
        onCancel={closeGuard.cancel}
      />
      <FileSaveGuardDialog
        relPath={pendingClose}
        onCancel={() => setPendingClose(null)}
        onChoose={(relPath, choice) => void resolvePendingClose(relPath, choice)}
      />
    </>
  );
}

/**
 * The dirty-close guard for file tabs — the same three answers Project Files
 * offers, decided by the same pure `close-guard` helpers, because closing a tab
 * is the one moment an explicit-save draft can be lost for good. Discard is the
 * destructive answer and is styled as such; Save is the default. Dismissing by
 * Esc or the overlay is a Cancel — the answer that changes nothing.
 */
function FileSaveGuardDialog({
  relPath,
  onCancel,
  onChoose,
}: {
  relPath: string | null;
  onCancel(): void;
  onChoose(relPath: string, choice: TabCloseResolution["choice"]): void;
}) {
  const name = relPath === null ? "" : baseNameOf(relPath);
  return (
    <AlertDialog
      open={relPath !== null}
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
              if (relPath !== null) onChoose(relPath, "discard");
            }}
          >
            Discard
          </AlertDialogAction>
          <AlertDialogAction
            data-testid="file-save-guard-save"
            onClick={() => {
              if (relPath !== null) onChoose(relPath, "save");
            }}
          >
            Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
