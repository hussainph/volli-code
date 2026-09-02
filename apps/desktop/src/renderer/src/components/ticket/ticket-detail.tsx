import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import {
  arrangeTabs,
  baseNameOf,
  displayTicketId,
  EMPTY_TAB_ORDER,
  errorMessage,
  resolveSplitView,
  singlePaneSplitView,
  SPLIT_VIEW_ROOT_PANE_ID,
  type FileSource,
  type FileWorkspaceTab,
  type ResolvedSplitViewPane,
  type Ticket,
} from "@volli/shared";
import { BROWSER_START_URL } from "../../../../browser-start-page";

import { renameChatSession } from "@renderer/chat/rename";
import { BrowserPane } from "@renderer/components/browser/browser-pane";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import {
  planTabClose,
  resolveTabClose,
  shouldDiscardSharedDraft,
  type TabCloseResolution,
} from "@renderer/components/files/close-guard";
import { FileSaveGuardDialog } from "@renderer/components/files/save-guard-dialog";
import { FileSearchPanel } from "@renderer/components/files/search-panel";
import { ContentColumn } from "@renderer/components/layout/content-column";
import type {
  DocumentFileRefs,
  MonacoDocumentEditorHandle,
} from "@renderer/components/editor/monaco-document-editor";
import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import {
  bootChatSession,
  createTerminalSession,
} from "@renderer/components/sessions/session-create";
import { FileView } from "@renderer/components/ticket/file-view";
import { DiffView } from "@renderer/components/ticket/diff-view";
import { RailResizeHandle } from "@renderer/components/ticket/rail-resize-handle";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import {
  chatTabId,
  chatTabStatus,
  parseChatTabId,
  resolveChatRelaunch,
  CHAT_TAB_FALLBACK_LABEL,
} from "@renderer/components/ticket/ticket-chat-tab";
import { fileTabId } from "@renderer/components/ticket/ticket-file-tab";
import { TicketBodyPanel } from "@renderer/components/ticket/ticket-body-panel";
import { TicketChangesPanel } from "@renderer/components/ticket/ticket-changes-panel";
import {
  createTicketRecencyWatchOwner,
  EMPTY_TICKET_RECENCY_OWNER_STATE,
  reduceTicketRecencyOwner,
  type TicketRecencyWatchOwner,
} from "@renderer/components/ticket/ticket-change-recency-owner";
import { diffTabId } from "@renderer/components/ticket/ticket-diff-tab";
import { browserTabId, parseBrowserTabId } from "@renderer/components/home/home-tabs";
import { appendFileRef } from "@renderer/editor/file-refs";
import { fileAttachHandlers } from "@renderer/components/attachments/file-drop";
import { useAttachments } from "@renderer/hooks/use-attachments";
import { TicketFilesPanel } from "@renderer/components/ticket/ticket-files-panel";
import { TicketRail } from "@renderer/components/ticket/ticket-rail";
import { PaneEmptyState } from "@renderer/components/split/pane-empty-state";
import { SplitDnd } from "@renderer/components/split/split-dnd";
import {
  type SplitDragPayload,
  type SplitDropOperation,
  type SplitDropZone,
} from "@renderer/components/split/split-drop";
import {
  nativeDropWrite,
  reorderDropWrite,
  tabDropWrite,
  type SplitSurfaceWrites,
} from "@renderer/components/split/split-surface-drop";
import { SplitDropZones } from "@renderer/components/split/split-drop-zones";
import { paneStripLabel, partitionPaneTabs } from "@renderer/components/split/split-tab-partition";
import { SplitViewGrid } from "@renderer/components/split/split-view-grid";
import { TerminalPaneAnchor } from "@renderer/components/split/terminal-pane-anchor";
import {
  TicketPaneTabStrip,
  TicketTabStrip,
  type TicketTabDescriptor,
} from "@renderer/components/ticket/ticket-tabs";
import { TicketTitle } from "@renderer/components/ticket/ticket-title";
import { fileDocumentIdentity, type DocumentIdentity } from "@renderer/editor/document-identity";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { openQuickOpen } from "@renderer/hooks/use-quick-open-shortcut";
import { useSplitShortcuts } from "@renderer/hooks/use-split-shortcuts";
import { chatWorktreeRefs, resolveChatOpenTarget } from "@renderer/lib/chat-open-target";
import { isEscapeExempt } from "@renderer/lib/escape-guard";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { browserTabDisplayTitle, useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { sessionPanes, ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { useCloseGuard } from "@renderer/terminal/close-guard";
import { closeTicketSession, renameTerminalSession } from "@renderer/terminal/session-lifecycle";
import { getEngine } from "@renderer/terminal/registry";

/** The always-present Ticket Body tab's id — the fallback every persisted/live
 * tab id resets to once it no longer names a renderable tab (body/file/session).
 * Wire value remains `"doc"` (see ticket-body-tab.ts). */
const BODY_TAB_ID = TICKET_BODY_TAB_ID;

/** Stable empty lists, so "no open files/diffs/chats" aren't new arrays every render. */
const NO_OPEN_FILES: readonly FileWorkspaceTab[] = [];
const NO_OPEN_DIFFS: readonly string[] = [];
const NO_OPEN_CHATS: readonly string[] = [];
const NO_DIFF_META: Readonly<Record<string, { previousPath?: string | null; status?: string }>> =
  {};

/**
 * The ticket's durable chat Session ids from the shared listing cache, and the
 * fetch that fills it. `undefined` means the listing has never answered — which
 * is a different fact from a ticket that has no chats, and the only one a
 * relaunch may not act on.
 */
function useChatSessionRecordIds(ticketId: string): readonly string[] | undefined {
  React.useEffect(() => {
    void useTicketSessionRecordsStore.getState().refresh(ticketId);
  }, [ticketId]);
  return useTicketSessionRecordsStore(
    useShallow((state) =>
      state.byTicket[ticketId]?.flatMap((row) =>
        row.kind === "chat" ? [row.record.sessionId] : [],
      ),
    ),
  );
}

/** Whether a ticket File-tab list already holds `relPath` (preview or pinned). */
function ticketFilesInclude(files: readonly FileWorkspaceTab[], relPath: string): boolean {
  return files.some((tab) => tab.relPath === relPath);
}

/**
 * Which checkout a document the registry already holds was resolved from —
 * identity is what main actually read, never the request context, so this is
 * the one trustworthy source for a save's `FileSource` when no view is mounted.
 */
function documentFileSource(identity: DocumentIdentity): FileSource {
  return identity.kind === "file" && identity.checkout.kind === "ticket" ? "worktree" : "main";
}

/**
 * The full-page ticket detail view (ticket-detail-mvp decision #1), rendered
 * by home-surface.tsx in place of the board when a ticket is open —
 * the global sessions layer and sidebar stay mounted around it (they live
 * higher up the tree, in main-content.tsx/app-shell.tsx). Layout follows the
 * browser-window metaphor: ONE full-width Chrome-style tab row at the very top,
 * spanning above both the main column (title → content plane) and the right
 * rail (the Calm Stack's Now/Diffs/Files pages). Navigation is
 * the chrome bar's ←/→ history plus Escape; there's no breadcrumb. The tab
 * plane hosts the ticket's live terminals; those stay resident (engines outlive
 * the view via the module registry, decision #8) and are positioned by the
 * always-mounted overlay onto the measured box each pane publishes — so the
 * rail collapsing (which hands the plane the full width) never unmounts a
 * terminal.
 *
 * SINCE VC-202 the plane is a SPLIT GRID (`split/split-view-grid.tsx`) rather
 * than a single box. Nothing about the paragraph above changes with it: an
 * unsplit workspace resolves to one pane and renders exactly what it did, the
 * full-width strip is the primary pane's strip, and a second pane simply draws
 * its own strip over its own content. What each pane's front tab renders is
 * routed by kind below, once per pane rather than once per surface — which is
 * why the file/diff editors bind their dirty and view-state reports to their
 * own path instead of to "the active tab's".
 */
export function TicketDetail({
  projectId,
  ticketPrefix,
  ticket,
}: {
  projectId: string;
  /** Kept in the props contract for Home; the PTY cwd now resolves in main. */
  projectPath: string;
  ticketPrefix: string;
  ticket: Ticket;
}) {
  const closeTicket = useWorkspaceStore((state) => state.closeTicket);
  const openTicketFile = useWorkspaceStore((state) => state.openTicketFile);
  const previewTicketFile = useWorkspaceStore((state) => state.previewTicketFile);
  const pinTicketFile = useWorkspaceStore((state) => state.pinTicketFile);
  const markTicketFileEdited = useWorkspaceStore((state) => state.markTicketFileEdited);
  const closeTicketFile = useWorkspaceStore((state) => state.closeTicketFile);
  const renameTicketFile = useWorkspaceStore((state) => state.renameTicketFile);
  const openTicketDiff = useWorkspaceStore((state) => state.openTicketDiff);
  const closeTicketDiff = useWorkspaceStore((state) => state.closeTicketDiff);
  const setTicketActiveTab = useWorkspaceStore((state) => state.setTicketActiveTab);
  const moveTicketTab = useWorkspaceStore((state) => state.moveTicketTab);
  // The split view's own writers (VC-202). Every one of them is a no-op while
  // this workspace is unsplit, which is what keeps the unsplit path untouched.
  const moveTicketTabInPane = useWorkspaceStore((state) => state.moveTicketTabInPane);
  const splitTicketPane = useWorkspaceStore((state) => state.splitTicketPane);
  const moveTicketTabToPane = useWorkspaceStore((state) => state.moveTicketTabToPane);
  const focusTicketPane = useWorkspaceStore((state) => state.focusTicketPane);
  const setTicketSplitRatio = useWorkspaceStore((state) => state.setTicketSplitRatio);
  const closeTicketPane = useWorkspaceStore((state) => state.closeTicketPane);
  const removeTicketTabFromSplit = useWorkspaceStore((state) => state.removeTicketTabFromSplit);
  const setTicketDiffViewState = useWorkspaceStore((state) => state.setTicketDiffViewState);
  const ticketTabsState = useWorkspaceStore(
    (state) => state.byProject[projectId]?.ticketTabs?.[ticket.id],
  );
  const browserApi = window.api.browser;
  const browserTabs = useBrowserTabsStore(
    useShallow((state) =>
      Object.values(state.byId).filter(
        (tab) => tab.projectId === projectId && tab.ticketId === ticket.id,
      ),
    ),
  );
  const browserTabsHydrated = useBrowserTabsStore((state) => state.hydratedProjects.has(projectId));
  const ticketDiffViewStates = useWorkspaceStore(
    (state) => state.byProject[projectId]?.ticketDiffViewStates?.[ticket.id],
  );
  const sessionTabs = useSessionsStore((state) => state.byOwner[ticket.id]?.tabs);
  const creating = useSessionsStore((state) => state.starting[ticket.id] ?? false);
  // The chat store's own in-flight flag, ORed with the terminal one wherever a
  // single control mints both kinds: the "+" is disabled while EITHER is
  // starting, because only one of them starts at a time.
  const creatingChat = useChatSessionsStore((state) => state.starting[ticket.id] ?? false);
  /**
   * The ticket's open chat tabs, and the two facts the strip draws for each.
   *
   * Three primitive-valued reads rather than one that builds descriptors: a
   * chat's slice is replaced on every folded frame batch, so a selector whose
   * result is a fresh array of objects would re-render this whole view — the
   * strip, the rail, the content plane — on every streamed token. Shallow
   * equality over strings is what makes a batch that moved neither a title nor a
   * lifecycle cost nothing here.
   */
  const openChatIds = useChatSessionsStore(
    useShallow((state) => state.openTabs[ticket.id] ?? NO_OPEN_CHATS),
  );
  const chatTitles = useChatSessionsStore(
    useShallow((state) =>
      (state.openTabs[ticket.id] ?? NO_OPEN_CHATS).map(
        (sessionId) =>
          state.sessions[sessionId]?.projection?.session.title ?? CHAT_TAB_FALLBACK_LABEL,
      ),
    ),
  );
  const chatStatuses = useChatSessionsStore(
    useShallow((state) =>
      (state.openTabs[ticket.id] ?? NO_OPEN_CHATS).map((sessionId) =>
        chatTabStatus(state.sessions[sessionId]),
      ),
    ),
  );
  /**
   * This ticket's durable chat Session ids, or `undefined` while the listing has
   * never been read. The distinction is what a relaunch turns on — see
   * {@link resolveChatRelaunch}.
   */
  const durableChatIds = useChatSessionRecordIds(ticket.id);
  const railCollapsed = useUiStore((state) => state.railCollapsed);
  const toggleRailCollapsed = useUiStore((state) => state.toggleRailCollapsed);
  const railWidth = useUiStore((state) => state.railWidth);
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const setTerminalFocusTarget = useUiStore((state) => state.setTerminalFocusTarget);
  const clearTerminalFocusUnlessTicket = useUiStore(
    (state) => state.clearTerminalFocusUnlessTicket,
  );
  const closeGuard = useCloseGuard();
  // The checkout a repository file dropped on the Ticket would be named
  // against — same `refRoot` the New-ticket composer attaches with, so a repo
  // file becomes an `@` reference in the body here too rather than a snapshot
  // nobody asked to duplicate (VC-106). Undefined while the project is unknown,
  // which degrades to snapshotting exactly as before.
  const refRoot = useProjectsStore(
    (state) => state.projects.find((project) => project.id === ticket.projectId)?.path,
  );
  // The Body editor's handle, for splicing those `@` refs in. Null whenever
  // the Body tab is not mounted — the fallback below writes the ref through the
  // store instead, which is safe precisely because an unmounted editor has
  // already flushed its draft on the way out.
  const bodyEditorRef = React.useRef<MonacoDocumentEditorHandle>(null);
  const updateTicket = useBoardStore((state) => state.updateTicket);
  /**
   * The Ticket's attachment strip, owned HERE rather than in the Files rail
   * that draws it (VC-106).
   *
   * Two surfaces attach to one Ticket: the rail, and the Body tab a file gets
   * dropped on. Left in the rail, its state would be the only copy, so a drop
   * on the Body would attach a file the rail could not show until it remounted
   * — and the rail unmounts when it is collapsed, which is exactly when a
   * person drops on the Body instead. One owner above both, one list.
   */
  const ticketAttachments = useAttachments({
    owner: { ticketId: ticket.id },
    ...(refRoot === undefined ? {} : { refRoot }),
    onRefInsert: (relPath) => {
      const token = `@${relPath}`;
      if (bodyEditorRef.current?.insertAtCursor(token) === true) return;
      // No editor to splice into (Body tab closed, or Monaco still loading).
      // The body is read FRESH from the store, not from this render's `ticket`:
      // a multi-file drop appends one ref per file, and each append patches the
      // slice synchronously — the render-time body could still be a turn behind
      // and would drop the previous ref, which for a repo document is the whole
      // attachment (a pure ref creates no blob to fall back on).
      const current =
        useBoardStore
          .getState()
          .ticketsByProject[ticket.projectId]?.find((candidate) => candidate.id === ticket.id) ??
        ticket;
      void updateTicket({
        ticketId: ticket.id,
        body: appendFileRef(current.body, token),
      });
    },
    onError: (message) => toastError(message),
  });
  const resetAttachments = ticketAttachments.reset;
  React.useEffect(() => {
    let cancelled = false;
    void window.api.attachments.list({ ticketId: ticket.id }).then((result) => {
      if (!cancelled && result.ok) resetAttachments(result.blobs);
    });
    return () => {
      cancelled = true;
    };
  }, [resetAttachments, ticket.id]);
  const [recencyOwner, dispatchRecencyOwner] = React.useReducer(
    reduceTicketRecencyOwner,
    EMPTY_TICKET_RECENCY_OWNER_STATE,
  );
  /**
   * The ticket-lifetime watch owner is created INSIDE the effect that disposes
   * it, and reached from callbacks through this ref. A `useMemo` cell survives
   * StrictMode's dev double-mount (setup → cleanup → setup on the same fiber)
   * while the cleanup runs its one-way `dispose()`, which would permanently
   * kill recency under `pnpm dev`. `null` only before the mount effect runs —
   * i.e. before any view can have loaded a file — so callbacks no-op on it.
   */
  const recencyWatchOwnerRef = React.useRef<TicketRecencyWatchOwner | null>(null);

  React.useEffect(() => {
    const owner = createTicketRecencyWatchOwner(
      {
        watch: window.api.files.watch,
        unwatch: window.api.files.unwatch,
      },
      {
        onWatchLost: (input) => {
          toastError(
            `Updated awareness for ${baseNameOf(input.relPath)} is off. Reopen the file to retry.`,
          );
        },
      },
    );
    recencyWatchOwnerRef.current = owner;
    const unsubscribe = window.api.files.onChanged((event) => {
      // The owner sees every event first: a `revision: null` one is main's only
      // signal that it tore a watch down (see `noteChangedEvent`).
      owner.noteChangedEvent(event);
      dispatchRecencyOwner({ type: "file-changed", event });
    });
    return () => {
      unsubscribe();
      recencyWatchOwnerRef.current = null;
      owner.dispose();
    };
  }, []);

  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);

  const openFiles = ticketTabsState?.files ?? NO_OPEN_FILES;
  const openDiffs = ticketTabsState?.diffs ?? NO_OPEN_DIFFS;
  const diffMeta = ticketTabsState?.diffMeta ?? NO_DIFF_META;
  // How this ticket's strip is arranged (VC-189) — empty until someone drags.
  const tabOrder = ticketTabsState?.tabOrder ?? EMPTY_TAB_ORDER;
  // How its plane is SPLIT (VC-202) — null until someone splits it, and null
  // again the moment a close leaves one pane.
  const splitView = ticketTabsState?.splitView ?? null;
  const activeTabId = ticketTabsState?.active ?? BODY_TAB_ID;

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
  /** The file/diff tab the Save / Discard / Cancel guard is currently asking about. */
  const [pendingClose, setPendingClose] = React.useState<{
    relPath: string;
    kind: "file" | "diff";
  } | null>(null);

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

  // `openFiles` / `openDiffs` are the persisted tab lists. Paths may legally
  // contain a newline on macOS, so iterate the arrays directly rather than
  // joining into a delimited key. File and diff tabs of the same path share
  // one dirty key (CONCEPT #48/#49).
  React.useEffect(() => {
    const paths = [...new Set([...openFiles.map((tab) => tab.relPath), ...openDiffs])];
    if (paths.length === 0) return;
    let cancelled = false;
    void loadMonacoRuntime()
      .then((runtime) => {
        if (cancelled) return;
        const parked = paths.filter((relPath) =>
          peekFileDocuments(runtime.registry, relPath).some((handle) => {
            const snap = handle.snapshot();
            // Autosave artifacts report dirty through FileView's onDirtyChange
            // and clear it via markSaved after write. Only EXPLICIT-save drafts
            // are re-seeded from a parked registry entry — an autosave dirty
            // left behind by a missed markSaved must not sticky-badge the tab
            // into a Save-on-close that then fails on a null revision.
            return snap.dirty && snap.savePolicy === "explicit";
          }),
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
  }, [openFiles, openDiffs, peekFileDocuments]);

  /**
   * Records a write this app just made, so the watch echo it provokes doesn't
   * badge the Changes row "Updated" against the person who caused it. Declared
   * above {@link saveFileDocument} because the ⌘W save-on-close guard writes
   * without any mounted view to report for it.
   */
  const reportLocalSave = React.useCallback(
    (relPath: string, source: FileSource, revision: number) => {
      dispatchRecencyOwner({
        type: "local-save",
        identity: {
          projectId,
          ticketId: source === "worktree" ? ticket.id : null,
          relPath,
          source,
        },
        revision,
      });
    },
    [projectId, ticket.id],
  );

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
        const snapshot = handle.snapshot();
        const expectedMtime = snapshot.externalRevision;
        if (typeof expectedMtime !== "number") {
          // A file document's revision IS its mtime. Autosave artifacts seed
          // with the load mtime; if we still lack one, writing without the
          // conflict guard is the one failure mode that could silently destroy
          // someone else's newer bytes — refuse rather than guess. The tab
          // stays open with its draft intact.
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
        // Same report the mounted editors make on their own writes: without it
        // the user's own Save-on-close echoes back through the watch and lights
        // the "Updated" badge against bytes they just wrote themselves.
        reportLocalSave(relPath, documentFileSource(snapshot.identity), result.mtime);
        return true;
      } catch (error) {
        toastError(`Could not save ${name}: ${errorMessage(error)}`);
        return false;
      }
    },
    [peekFileDocument, projectId, reportLocalSave, ticket.id],
  );

  const closeFileTab = React.useCallback(
    (relPath: string) => {
      closeTicketFile(projectId, ticket.id, relPath);
      // Diff tab for the same path may still be open — only clear dirty when
      // neither surface remains.
      const diffsStillOpen = (
        useWorkspaceStore.getState().byProject[projectId]?.ticketTabs?.[ticket.id]?.diffs ?? []
      ).includes(relPath);
      if (!diffsStillOpen) markFileDirty(relPath, false);
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

  const closeDiffTab = React.useCallback(
    (relPath: string) => {
      closeTicketDiff(projectId, ticket.id, relPath);
      const filesStillOpen = ticketFilesInclude(
        useWorkspaceStore.getState().byProject[projectId]?.ticketTabs?.[ticket.id]?.files ?? [],
        relPath,
      );
      if (!filesStillOpen) markFileDirty(relPath, false);
    },
    [closeTicketDiff, markFileDirty, projectId, ticket.id],
  );

  const requestCloseFileTab = React.useCallback(
    (relPath: string) => {
      const siblingOpen = (
        useWorkspaceStore.getState().byProject[projectId]?.ticketTabs?.[ticket.id]?.diffs ?? []
      ).includes(relPath);
      if (planTabClose({ dirty: dirtyFiles.has(relPath), siblingOpen }) === "close") {
        closeFileTab(relPath);
      } else {
        setPendingClose({ relPath, kind: "file" });
      }
    },
    [closeFileTab, dirtyFiles, projectId, ticket.id],
  );

  const requestCloseDiffTab = React.useCallback(
    (relPath: string) => {
      const siblingOpen = ticketFilesInclude(
        useWorkspaceStore.getState().byProject[projectId]?.ticketTabs?.[ticket.id]?.files ?? [],
        relPath,
      );
      if (planTabClose({ dirty: dirtyFiles.has(relPath), siblingOpen }) === "close") {
        closeDiffTab(relPath);
      } else {
        setPendingClose({ relPath, kind: "diff" });
      }
    },
    [closeDiffTab, dirtyFiles, projectId, ticket.id],
  );

  /**
   * Applies the user's answer. Cancel keeps the tab, and so does a FAILED save
   * — closing over a write that never landed would discard the only copy.
   * Dirty is shared by relPath across file+diff, but only the tab the user
   * asked to close is removed. Discard never wipes the draft while the other
   * representation is still open (defensive: the request path already skips
   * confirm in that case).
   */
  const resolvePendingClose = React.useCallback(
    async (choice: TabCloseResolution["choice"]) => {
      if (pendingClose === null) return;
      const { relPath, kind } = pendingClose;
      const resolution: TabCloseResolution =
        choice === "save" ? { choice: "save", saved: await saveFileDocument(relPath) } : { choice };
      const tabs = useWorkspaceStore.getState().byProject[projectId]?.ticketTabs?.[ticket.id];
      const siblingOpen =
        kind === "file"
          ? (tabs?.diffs ?? []).includes(relPath)
          : ticketFilesInclude(tabs?.files ?? [], relPath);
      if (resolution.choice === "discard" && shouldDiscardSharedDraft({ siblingOpen })) {
        (await peekFileDocument(relPath))?.discard();
        markFileDirty(relPath, false);
      } else if (resolution.choice === "save" && resolution.saved) {
        markFileDirty(relPath, false);
      }
      setPendingClose(null);
      if (resolveTabClose(resolution) !== "close") return;
      if (kind === "file") closeFileTab(relPath);
      else closeDiffTab(relPath);
    },
    [
      closeDiffTab,
      closeFileTab,
      markFileDirty,
      pendingClose,
      peekFileDocument,
      projectId,
      saveFileDocument,
      ticket.id,
    ],
  );

  const setActiveTab = React.useCallback(
    (tabId: string) => setTicketActiveTab(projectId, ticket.id, tabId),
    [setTicketActiveTab, projectId, ticket.id],
  );

  // The `@file` index + create/open wiring, shared by the Doc body editor and
  // every open markdown file tab so any of them can reference (and create) files.
  // @file chips open persistent tabs (decision #33); Files-panel glances use
  // preview/pin instead (decision #56).
  const fileIndex = useFileIndex(projectId);

  /**
   * Closes the arm gap. The watch is installed AFTER the view's own read, so a
   * write that lands in between is invisible until the next one — the badge
   * would stay dark over content that has already moved. Re-read once the watch
   * is confirmed and, if disk has drifted from what the view mounted, feed the
   * reducer the same shape a watch event would have carried.
   */
  const revalidateSeenRevision = React.useCallback(
    async (relPath: string, seenRevision: number) => {
      // A failure here means the file vanished or turned unreadable between the
      // view's load and the watch install. It is NOT swallowed: the mounted
      // view holds its own watch on the same path and surfaces exactly that,
      // and a second toast from the badge layer would only double-report it.
      const fresh = await window.api.files.read({ projectId, ticketId: ticket.id, relPath });
      if (!fresh.ok || fresh.mtime === seenRevision) return;
      dispatchRecencyOwner({
        type: "file-changed",
        event: {
          projectId,
          ticketId: fresh.source === "worktree" ? ticket.id : null,
          relPath,
          source: fresh.source,
          revision: fresh.mtime,
        },
      });
    },
    [projectId, ticket.id],
  );

  /**
   * The seen revision comes from the bytes a view actually rendered (CONCEPT
   * #52), never from a second read of our own: an independent read races the
   * view's and can record revision R2 while the user is looking at R1, muting
   * the badge for a change they never saw. Opening a tab is therefore not what
   * records an inspection — mounting its content is.
   */
  const handleFileLoaded = React.useCallback(
    (relPath: string, source: FileSource, revision: number) => {
      dispatchRecencyOwner({
        type: "inspect",
        identity: {
          projectId,
          ticketId: source === "worktree" ? ticket.id : null,
          relPath,
          source,
        },
        revision,
      });
      const owner = recencyWatchOwnerRef.current;
      if (owner === null) return;
      void owner.watch({ projectId, ticketId: ticket.id, relPath }).then((result) => {
        if (!result.ok) {
          toastError(
            `Updated awareness for ${baseNameOf(relPath)} is off. Reopen the file to retry.`,
          );
          return;
        }
        void revalidateSeenRevision(relPath, revision).catch(() => {
          // Same rationale as inside `revalidateSeenRevision`: a broken read is
          // the mounted view's story to tell, on its own watch.
        });
      });
    },
    [projectId, revalidateSeenRevision, ticket.id],
  );
  /**
   * Where a file this ticket's chat names opens (VC-120). Chat paths arrive
   * RAW — absolute when a tool spelled them that way — so they are translated
   * first (`resolveChatOpenTarget`): this ticket's worktree (or a repo path
   * spelled absolutely) stays here as a file tab; another ticket's worktree
   * opens THAT ticket's workspace with the tab in place; a path no checkout
   * contains toasts instead of opening a pane whose only content is an error.
   * `@file` chips pass through unchanged (already venue-relative). Worktrees
   * and the project path are read at click time so this callback — handed to
   * every transcript turn — keeps a stable identity.
   */
  const openFile = React.useCallback(
    (path: string) => {
      const projectPath = useProjectsStore
        .getState()
        .projects.find((project) => project.id === projectId)?.path;
      if (projectPath === undefined) {
        // No project record to translate against — keep the old pass-through
        // rather than dropping the click on the floor.
        openTicketFile(projectId, ticket.id, path);
        return;
      }
      const tickets = useBoardStore.getState().ticketsByProject[projectId] ?? [];
      const target = resolveChatOpenTarget({
        path,
        projectPath,
        worktrees: chatWorktreeRefs(tickets),
        scope: { kind: "ticket", ticketId: ticket.id },
      });
      if (target.kind === "outside") {
        toastError(`${path} is outside this project.`);
        return;
      }
      // Ticket scope never yields `project-file`, but the type is handled
      // honestly: the same relPath as this ticket's file tab.
      const targetTicketId = target.kind === "ticket-file" ? target.ticketId : ticket.id;
      openTicketFile(projectId, targetTicketId, target.relPath);
      if (targetTicketId !== ticket.id) {
        useWorkspaceStore.getState().openTicketWorkspace(projectId, targetTicketId);
      }
    },
    [openTicketFile, projectId, ticket.id],
  );
  const previewFileFromRail = React.useCallback(
    (relPath: string) => previewTicketFile(projectId, ticket.id, relPath),
    [previewTicketFile, projectId, ticket.id],
  );
  const pinFileFromRail = React.useCallback(
    (relPath: string) => pinTicketFile(projectId, ticket.id, relPath),
    [pinTicketFile, projectId, ticket.id],
  );
  // A file the navigator just created opens PINNED and focused (VC-191): it was
  // made to be typed in, so it is never the replaceable preview glance.
  const openCreatedFileFromRail = React.useCallback(
    (relPath: string) => openTicketFile(projectId, ticket.id, relPath),
    [openTicketFile, projectId, ticket.id],
  );
  // A renamed file's tab follows it. The rename itself is refused while that
  // document is dirty (`use-navigator-mutations.ts`), so what arrives here is
  // always a clean tab: the strip keeps its slot and the FileView, keyed by
  // relPath, remounts onto the new path and re-reads.
  const renameFileFromRail = React.useCallback(
    (from: string, to: string) => renameTicketFile(projectId, ticket.id, from, to),
    [renameTicketFile, projectId, ticket.id],
  );
  const openDiff = React.useCallback(
    (file: { path: string; previousPath?: string; status: string; binary: boolean }) => {
      openTicketDiff(projectId, ticket.id, file.path, {
        previousPath: file.previousPath ?? null,
        status: file.status,
        binary: file.binary,
      });
    },
    [openTicketDiff, projectId, ticket.id],
  );
  const fileRefs = React.useMemo<DocumentFileRefs>(
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
  // file tab + one `"diff"`-kind descriptor per open Change Set diff + one
  // `"session"`-kind descriptor per live session; routing below is keyed off
  // `kind`, not id, so the plane and content branch generically.
  const composedTabs: TicketTabDescriptor[] = [
    { id: BODY_TAB_ID, kind: "body", label: displayId },
    ...openFiles.map((tab): TicketTabDescriptor => ({
      id: `file:${tab.relPath}`,
      kind: "file",
      label: baseNameOf(tab.relPath),
      relPath: tab.relPath,
      preview: !tab.pinned,
      badge: fileSources[tab.relPath] === "worktree" ? "worktree" : undefined,
      dirty: dirtyFiles.has(tab.relPath),
    })),
    ...openDiffs.map((relPath): TicketTabDescriptor => {
      const meta = diffMeta[relPath];
      return {
        id: diffTabId(relPath),
        kind: "diff",
        label: baseNameOf(relPath),
        relPath,
        previousPath: meta?.previousPath,
        dirty: dirtyFiles.has(relPath),
      };
    }),
    ...(sessionTabs ?? []).map((tab): TicketTabDescriptor => ({
      id: tab.sessionId,
      kind: "session",
      label: tab.title,
    })),
    ...openChatIds.map((sessionId, index): TicketTabDescriptor => ({
      id: chatTabId(sessionId),
      kind: "chat",
      label: chatTitles[index] ?? CHAT_TAB_FALLBACK_LABEL,
      status: chatStatuses[index],
    })),
    ...browserTabs.map((tab): TicketTabDescriptor => ({
      id: browserTabId(tab.tabId),
      kind: "browser",
      label: browserTabDisplayTitle(tab),
      browserTabId: tab.tabId,
      loading: tab.loading,
    })),
  ];
  // Compose by kind first, THEN arrange (VC-189): the drag overlay is the one
  // thing that can interleave a file tab with a chat tab, and the Body tab at
  // index 0 is outside its reach.
  const tabs = arrangeTabs(composedTabs, tabOrder, 1);
  // A closed session tab, or a persisted active id with no live tab, falls back to Doc.
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]!;
  const activeTabIsRenderable = activeTab.id === activeTabId;
  const activeSessionTab =
    activeTab.kind === "session"
      ? sessionTabs?.find((candidate) => candidate.sessionId === activeTab.id)
      : undefined;

  /**
   * The strip, projected onto the panes that draw it (VC-202).
   *
   * An UNSPLIT workspace resolves a single pane holding the whole strip, whose
   * front tab is the one that would have been in front anyway — so the grid
   * below draws today's plane and the split path is never a second rendering
   * path. `activeTab.id` rather than `activeTabId` because the fallback above
   * is exactly what a pane should show when the record names nothing live.
   */
  const split = resolveSplitView(
    splitView ?? singlePaneSplitView([], activeTab.id, SPLIT_VIEW_ROOT_PANE_ID),
    tabs.map((tab) => tab.id),
    BODY_TAB_ID,
  );
  const paneStrips = partitionPaneTabs(split, tabs);

  // ⌘\ / ⇧⌘\ / ⌃⌘arrows, for this workspace. Home mounts the same hook; the
  // chord asks which surface is in front and exactly one of them acts.
  useSplitShortcuts({ projectId, ticketId: ticket.id, orderedTabIds: tabs.map((tab) => tab.id) });

  /**
   * The Session zen mode is holding, or null.
   *
   * "In front" means in front IN SOME PANE: zen is entered from one pane of
   * several and the panes beside it must not clear it. While it holds, that
   * Session takes the whole plane and the grid steps aside — which unpublishes
   * every other pane's anchor and hides those terminals without unmounting one.
   */
  const zenSessionId =
    terminalFocusTarget !== null &&
    terminalFocusTarget.projectId === projectId &&
    terminalFocusTarget.ticketId === ticket.id &&
    split.panes.some((pane) => pane.activeTabId === terminalFocusTarget.sessionId) &&
    sessionTabs?.some((candidate) => candidate.sessionId === terminalFocusTarget.sessionId) === true
      ? terminalFocusTarget.sessionId
      : null;
  const terminalFocused = zenSessionId !== null;

  // A file/diff editor's dirty and view-state reports name their OWN path: with
  // panes there can be two mounted at once, so "the active tab's path" is no
  // longer a description of which editor is talking. Stable callbacks, bound to
  // a path one level down (`TicketPaneFileView`) — `FileView` holds these in
  // effect and callback dependencies, so a fresh closure per render would
  // re-read the file on every render.
  const handleFileDirtyChange = React.useCallback(
    (relPath: string, dirty: boolean) => {
      markFileDirty(relPath, dirty);
      // Decision #56: a dirty File tab is never replaced, so the first edit
      // promotes the preview slot to a persistent tab. Diff tabs are always
      // persistent already — markTicketFileEdited is a no-op when the path
      // isn't an open File preview.
      if (dirty) markTicketFileEdited(projectId, ticket.id, relPath);
    },
    [markFileDirty, markTicketFileEdited, projectId, ticket.id],
  );

  const handleDiffViewStateChange = React.useCallback(
    (relPath: string, viewState: unknown) => {
      setTicketDiffViewState(projectId, ticket.id, relPath, viewState);
    },
    [projectId, setTicketDiffViewState, ticket.id],
  );

  // The fallback above is purely visual — it renders the Ticket Body without
  // writing the store, so a persisted `active` naming a session that's since
  // closed (or one restored from a previous launch, which never repopulates:
  // terminal sessions don't survive an app restart) stays wedged in workspace.ts
  // forever (`sanitizeTicketTabs` keeps any record whose `active` isn't the body
  // tab). Reset it to the Ticket Body for real once we're sure it's actually
  // stale rather than just not hydrated yet — `creating` covers the one
  // in-flight window where a new session tab has been asked for but hasn't
  // landed in the sessions store, so `tabs` doesn't include it yet even though
  // it's about to.
  //
  // A chat Session DOES survive a restart, so a persisted `chat:<id>` is not
  // evidence of anything until the ticket's durable listing has answered: the
  // reset waits, then either adopts the Session (which puts its tab back) or
  // falls back because it is genuinely gone.
  React.useEffect(() => {
    if (creating || activeTabIsRenderable) return;
    if (parseBrowserTabId(activeTabId) !== null && !browserTabsHydrated) return;
    const relaunch = resolveChatRelaunch(activeTabId, durableChatIds);
    if (relaunch.kind === "wait") return;
    if (relaunch.kind === "adopt") {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(relaunch.sessionId);
      chat.openChatTab(ticket.id, relaunch.sessionId);
      return;
    }
    setTicketActiveTab(projectId, ticket.id, BODY_TAB_ID);
  }, [
    activeTabId,
    activeTabIsRenderable,
    browserTabsHydrated,
    creating,
    durableChatIds,
    projectId,
    setTicketActiveTab,
    ticket.id,
  ]);

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
  // geometry transition, then return focus to the split tab's active pane. The
  // zen Session takes precedence: entering and leaving zen is the geometry
  // change this exists for, and while it holds that is the terminal on screen.
  const focusedSessionTab = terminalFocused
    ? sessionTabs?.find((candidate) => candidate.sessionId === zenSessionId)
    : activeSessionTab;
  React.useEffect(() => {
    const paneId = focusedSessionTab?.activePaneId;
    if (paneId === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      const engine = getEngine(paneId);
      engine?.fit();
      engine?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [terminalFocused, focusedSessionTab?.activePaneId]);

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

  // Opens the tab first and asks where to go second — see the note on Home's
  // twin. The `window.prompt` this replaces throws in Electron by definition,
  // and threw from outside the try, so the press was swallowed whole.
  const createBrowser = React.useCallback(async () => {
    try {
      const result = await browserApi.open({
        projectId,
        ticketId: ticket.id,
        url: BROWSER_START_URL,
      });
      if (!result.ok) {
        toastError(`Could not open Browser Tab: ${result.error}`);
        return;
      }
      useBrowserTabsStore.getState().receive(result.tab);
      setActiveTab(browserTabId(result.tab.tabId));
    } catch (reason) {
      toastError(`Could not open Browser Tab: ${errorMessage(reason)}`);
    }
  }, [browserApi, projectId, setActiveTab, ticket.id]);

  // Mints one durable chat Session on this ticket and opens its tab, through
  // the same boot guard the terminal path uses: one create per ticket at a
  // time, none at all into a project the renderer has stopped tracking, and the
  // landing below re-checked against fresh state after the await.
  const createChat = React.useCallback(
    async (chatSkills?: readonly string[]) => {
      await bootChatSession(ticketScope(projectId, ticket.id), {
        skills: chatSkills,
        land: (sessionId) => {
          // The ticket itself may have been deleted while the create was in
          // flight; a tab on a card that no longer exists is unreachable, so let
          // the Session go (its durable row stands — see `bootChatSession`).
          const tickets = useBoardStore.getState().ticketsByProject[projectId] ?? [];
          if (!tickets.some((candidate) => candidate.id === ticket.id)) return false;
          useChatSessionsStore.getState().openChatTab(ticket.id, sessionId);
          setActiveTab(chatTabId(sessionId));
          // So the rail's row for it appears without waiting on a terminal event.
          void useTicketSessionRecordsStore.getState().refresh(ticket.id);
          return true;
        },
      });
    },
    [projectId, setActiveTab, ticket.id],
  );

  // A rail row for a Session with no live client adopts it; one already open
  // just comes to the front. `adoptChatSession` is idempotent, so this is the
  // single path both cases take.
  const activateChat = React.useCallback(
    (sessionId: string) => {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(sessionId);
      chat.openChatTab(ticket.id, sessionId);
      setActiveTab(chatTabId(sessionId));
    },
    [setActiveTab, ticket.id],
  );

  // Escape closes the detail view and returns to the board — but only when
  // focus isn't inside an input/textarea/contenteditable or an open menu/
  // dialog, the same guard board.tsx's own Escape-deselect uses, so a
  // property dropdown or the label editor's text field can still dismiss
  // itself on Escape without also closing the whole view. Board's own
  // Escape-deselect listener is inert while this view is mounted — board.tsx
  // isn't rendered at all (home-surface.tsx swaps the two) — so the two never
  // fire off the same keypress.
  //
  // While terminal-focused, Escape is left entirely alone so it reaches the
  // PTY (Claude Code interrupts on it; vim and friends lean on it). Exit from
  // terminal focus is the chrome band's toggle and its ⌥⌘Return chord — never a
  // bare key — so the PTY never fights the app for one.
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

  /**
   * Close one tab, from whichever pane's strip raised it.
   *
   * The split view's half of a close is only owed by the two kinds this store
   * does not own — chat and terminal Sessions live in the sessions stores, so
   * their pane assignment has to be dropped explicitly. File and diff closes
   * carry it already (`closeTicketFile`/`closeTicketDiff` write through).
   */
  function closeTab(tab: TicketTabDescriptor): void {
    if (tab.kind === "file" && tab.relPath !== undefined) {
      // A file tab with an unsaved draft routes through the Save / Discard /
      // Cancel guard first (CONCEPT #49).
      requestCloseFileTab(tab.relPath);
      return;
    }
    if (tab.kind === "diff" && tab.relPath !== undefined) {
      requestCloseDiffTab(tab.relPath);
      return;
    }
    if (tab.kind === "browser" && tab.browserTabId !== undefined) {
      const opaqueId = tab.browserTabId;
      void browserApi
        .close({ tabId: opaqueId })
        .then((result) => {
          if (!result.ok) {
            toastError(`Could not close Browser Tab: ${result.error}`);
            return;
          }
          useBrowserTabsStore.getState().remove(opaqueId);
          // The split-view half of a close this store does not own — the same
          // statement the chat branch below makes. Unsplit, the reset to the
          // Body applies only when the closed tab was the one in front.
          if (splitView !== null) {
            removeTicketTabFromSplit(projectId, ticket.id, tab.id);
            return;
          }
          const active =
            useWorkspaceStore.getState().byProject[projectId]?.ticketTabs?.[ticket.id]?.active ??
            BODY_TAB_ID;
          if (active === tab.id) setActiveTab(BODY_TAB_ID);
        })
        .catch((reason: unknown) => {
          toastError(`Could not close Browser Tab: ${errorMessage(reason)}`);
        });
      return;
    }
    if (tab.kind === "chat") {
      const chatId = parseChatTabId(tab.id);
      if (chatId === null) return;
      // No busy guard and no confirm: the Session is durable, so closing the
      // view loses nothing — reopening it from the rail adopts the same
      // history. Standing the active tab down first, because the relaunch
      // effect would otherwise read the persisted id, find the Session still on
      // record, and put the tab back. While SPLIT that stand-down is the split
      // view's own: it knows which pane held the tab and what succeeds it
      // there, where a blind reset to the Body would yank the eye into the
      // primary pane.
      if (splitView === null) {
        if (activeTabId === tab.id) setActiveTab(BODY_TAB_ID);
      } else {
        removeTicketTabFromSplit(projectId, ticket.id, tab.id);
      }
      useChatSessionsStore.getState().closeChatTab(ticket.id, chatId);
      return;
    }
    const sessionId = tab.id;
    const sessionTab = sessionTabs?.find((candidate) => candidate.sessionId === sessionId);
    const liveIds = sessionTab
      ? sessionPanes(sessionTab.layout)
          .filter((pane) => pane.exitCode === null)
          .map((pane) => pane.sessionId)
      : [sessionId];
    // Inside the guard, so a close the person CANCELS leaves the panes exactly
    // as they were.
    closeGuard.guard(liveIds, () => {
      removeTicketTabFromSplit(projectId, ticket.id, sessionId);
      closeTicketSession(ticket.id, sessionId);
    });
  }

  /**
   * This workspace's half of the drop-routing seam (`split-surface-drop.ts`):
   * the ticket store twins, and this workspace's own doors for a native
   * payload. The decisions — pane-or-surface reorder, the unsplit centre's
   * activation door, the first split's strip claim — live in the seam, one
   * copy shared with Home.
   */
  const dropWrites: SplitSurfaceWrites = {
    reorderSurface: (movedId, ids) => moveTicketTab(projectId, ticket.id, movedId, ids),
    reorderPane: (paneId, movedId, ids) =>
      moveTicketTabInPane(projectId, ticket.id, paneId, movedId, ids),
    moveTabToPane: (tabId, paneId) => moveTicketTabToPane(projectId, ticket.id, tabId, paneId),
    splitPane: (paneId, edge, tabId, surfaceTabIds) =>
      splitTicketPane(projectId, ticket.id, paneId, edge, { tabId, surfaceTabIds }),
    // The door the strip's own select takes.
    activateTab: (tabId) => setActiveTab(tabId),
    openPayload: openDroppedPayload,
  };
  const dropState = { isSplit: splitView !== null, orderedTabIds: tabs.map((tab) => tab.id) };

  /** A drop on one pane's strip — surface arrangement unsplit, pane order split. */
  function reorderInPane(paneId: string, movedId: string, ids: readonly string[]): void {
    reorderDropWrite(dropState, dropWrites, paneId, movedId, ids);
  }

  /** A tab let go somewhere on this workspace (VC-202 §4) — the seam routes, the twins write. */
  function applySplitDrop(operation: SplitDropOperation): void {
    tabDropWrite(dropState, dropWrites, operation);
  }

  /** A Session or file row dropped on a pane — opened by this workspace's doors, placed by the seam. */
  function handleNativeDrop(payload: SplitDragPayload, paneId: string, zone: SplitDropZone): void {
    nativeDropWrite(dropState, dropWrites, payload, paneId, zone);
  }

  /**
   * Opens what a native payload names, and answers with the tab id it landed
   * in. A chat is adopted and a terminal is not: only an open terminal may be
   * dragged (its tab is what the pane takes), while a chat Session is durable
   * and its tab is minted on arrival.
   */
  function openDroppedPayload(payload: SplitDragPayload): string | null {
    if (payload.type === "file") {
      previewTicketFile(projectId, ticket.id, payload.relPath);
      return fileTabId(payload.relPath);
    }
    if (payload.kind === "chat") {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(payload.sessionId);
      chat.openChatTab(ticket.id, payload.sessionId);
      return chatTabId(payload.sessionId);
    }
    // A terminal row is only draggable while its tab is open; if it closed
    // mid-drag there is nothing to place, and inventing a tab for a PTY that
    // may be gone is worse than the drop doing nothing.
    const open = sessionTabs?.some((candidate) => candidate.sessionId === payload.sessionId);
    return open === true ? payload.sessionId : null;
  }

  /** What one pane's front tab draws — or, for a pane holding nothing, its menu. */
  function paneContent(pane: ResolvedSplitViewPane): React.ReactNode {
    const tab = tabs.find((candidate) => candidate.id === pane.activeTabId);
    if (tab === undefined) {
      return (
        <PaneEmptyState
          onNewChat={() => void createChat()}
          onNewTerminal={() => void createSession()}
          onOpenFile={openQuickOpen}
          onClosePane={() => closeTicketPane(projectId, ticket.id, pane.id)}
        />
      );
    }
    const chatSessionId = tab.kind === "chat" ? parseChatTabId(tab.id) : null;
    const paneBrowserTab =
      tab.kind === "browser" && tab.browserTabId !== undefined
        ? browserTabs.find((candidate) => candidate.tabId === tab.browserTabId)
        : undefined;
    return (
      // No horizontal padding here: the Doc tab centers its title/body on the
      // measure via <ContentColumn>; file views own their edges and pick their
      // own tier (markdown reads on the measure, code/binary go fluid);
      // terminals get every pixel. Only the Doc tab shows the ticket title + top
      // air — file and session tabs are workbench surfaces the strip already
      // names.
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          tab.kind === "body" && "pt-5",
        )}
      >
        {tab.kind === "body" && (
          <ContentColumn>
            <TicketTitle ticket={ticket} />
          </ContentColumn>
        )}
        {/* Positioning context for the resident terminal plane: Doc/file tabs
            scroll in-flow; the anchor overlays them, published only for a
            session tab. */}
        <div className={cn("relative flex min-h-0 flex-1 flex-col", tab.kind === "body" && "mt-4")}>
          {tab.kind === "body" ? (
            <div
              // The Body tab is a drop target: this is where the Ticket is
              // written, so a file dragged onto it attaches to the Ticket.
              // Scoped to this tab rather than the whole detail view on purpose
              // — a capture handler on the root would fire before the embedded
              // chat composer's own and steal drops meant for the conversation.
              {...fileAttachHandlers((picked) => void ticketAttachments.attachFiles(picked))}
              className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
            >
              <TicketBodyPanel ticket={ticket} fileRefs={fileRefs} editorRef={bodyEditorRef} />
            </div>
          ) : null}
          {tab.kind === "file" && tab.relPath !== undefined ? (
            <TicketPaneFileView
              key={tab.relPath}
              projectId={projectId}
              ticketId={ticket.id}
              relPath={tab.relPath}
              fileRefs={fileRefs}
              onSource={reportFileSource}
              onDirtyChange={handleFileDirtyChange}
              onLocalSave={reportLocalSave}
              onLoaded={handleFileLoaded}
            />
          ) : null}
          {tab.kind === "diff" && tab.relPath !== undefined ? (
            <TicketPaneDiffView
              key={tab.relPath}
              ticket={ticket}
              projectId={projectId}
              relPath={tab.relPath}
              previousPath={tab.previousPath ?? diffMeta[tab.relPath]?.previousPath}
              status={diffMeta[tab.relPath]?.status}
              binary={diffMeta[tab.relPath]?.binary}
              onDirtyChange={handleFileDirtyChange}
              onLocalSave={reportLocalSave}
              onLoaded={handleFileLoaded}
              initialViewState={ticketDiffViewStates?.[tab.relPath]}
              onViewStateChange={handleDiffViewStateChange}
            />
          ) : null}
          {/* In flow, not on the resident overlay beside it: that host exists so
              a GPU-owning terminal is never unmounted, and a chat needs nothing
              of the sort — its stream, fold and queue live in the registry
              client, which outlives this view either way. */}
          {chatSessionId !== null ? (
            <ChatPlane
              key={chatSessionId}
              sessionId={chatSessionId}
              projectId={ticket.projectId}
              ticketId={ticket.id}
              onOpenFile={openFile}
            />
          ) : null}
          {paneBrowserTab !== undefined ? (
            // The native view is attached over this cell's own rectangle, and
            // the main-process host shows any number of tabs at once
            // (tab-host), so one browser per pane composes exactly as files
            // and chats do.
            <BrowserPane
              key={paneBrowserTab.tabId}
              tab={paneBrowserTab}
              visible
              api={browserApi}
              onTabState={useBrowserTabsStore.getState().receive}
            />
          ) : null}
          {tab.kind === "session" ? (
            <TerminalPaneAnchor tabId={tab.id} ownerId={ticket.id} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    // ONE drag context for the whole workspace (VC-202 §4): the strips, the
    // panes and their drop zones are one gesture. Nested inside Home's own —
    // this view is rendered by `home-surface.tsx` — and that nesting is what
    // keeps a ticket tab from ever being dropped on Home: the inner context is
    // the only one this subtree's strips register into.
    <SplitDnd
      origin={{ scope: "ticket", projectId, ticketId: ticket.id }}
      panes={split.panes.map((pane) => ({
        paneId: pane.id,
        tabIds: pane.tabIds.filter((id) => id !== BODY_TAB_ID),
      }))}
      onTabDrop={applySplitDrop}
      onNativeDrop={handleNativeDrop}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* One full-width tab row above both the main column and the rail (the
          browser-window metaphor). The active tab fuses with the content plane
          in the main column below it. While split it is the PRIMARY pane's
          strip — the pane that holds the Body tab and never moves. */}
        {terminalFocused ? null : (
          <TicketTabStrip
            projectId={projectId}
            ticketId={ticket.id}
            tabs={paneStrips[0]!.tabs}
            activeTabId={split.panes[0]!.activeTabId ?? activeTab.id}
            creating={creating || creatingChat}
            onSelectTab={setActiveTab}
            onReorderTabs={(movedId, ids) => reorderInPane(split.primaryPaneId, movedId, ids)}
            onPinFileTab={(relPath) => pinTicketFile(projectId, ticket.id, relPath)}
            onCloseTab={closeTab}
            onRenameSessionTab={renameSessionTab}
            onNewSession={() => void createSession()}
            onNewChat={() => void createChat()}
            onNewBrowser={() => void createBrowser()}
            railCollapsed={railCollapsed}
            onToggleRail={toggleRailCollapsed}
          />
        )}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {terminalFocused ? (
            // Zen: the focused Session takes the whole plane. One anchor,
            // spanning everything the strip and the rail have vacated — the
            // grid is not rendered at all, so every other pane's anchor is
            // unpublished and its terminal simply stops being drawn.
            <div className="relative flex min-h-0 flex-1 flex-col">
              <TerminalPaneAnchor tabId={zenSessionId} ownerId={ticket.id} />
            </div>
          ) : (
            <SplitViewGrid
              view={split}
              renderStrip={(pane) =>
                // No strip on the primary pane (the surface's own is its) and
                // none on a pane holding nothing: an empty tablist is a band of
                // chrome about no tabs, and the pane's menu is the whole of
                // what it has to say.
                pane.isPrimary || pane.tabIds.length === 0 ? null : (
                  <TicketPaneTabStrip
                    label={paneStripLabel(pane)}
                    projectId={projectId}
                    ticketId={ticket.id}
                    tabs={paneStrips[pane.index]?.tabs ?? []}
                    activeTabId={pane.activeTabId ?? ""}
                    onSelectTab={setActiveTab}
                    onReorderTabs={(movedId, ids) => reorderInPane(pane.id, movedId, ids)}
                    onPinFileTab={(relPath) => pinTicketFile(projectId, ticket.id, relPath)}
                    onCloseTab={closeTab}
                    onRenameSessionTab={renameSessionTab}
                  />
                )
              }
              renderContent={paneContent}
              renderOverlay={(pane) => <SplitDropZones paneId={pane.id} />}
              onFocusPane={(paneId) => focusTicketPane(projectId, ticket.id, paneId)}
              onResizeSplit={(splitId, ratio) =>
                setTicketSplitRatio(projectId, ticket.id, splitId, ratio)
              }
            />
          )}
          {railCollapsed || terminalFocused ? null : (
            // Resizable details rail: a grip on its inner (left) edge widens it
            // leftward, mirroring the left sidebar's outer-edge handle. `relative`
            // makes the aside the grip's positioning context; the width persists
            // app-wide via the ui store. The rail draws its own header and pages
            // (TicketRail) — this only sizes and frames the column.
            <aside
              className="relative flex shrink-0 flex-col border-l border-sidebar-border bg-sidebar"
              style={{ width: railWidth }}
            >
              <RailResizeHandle />
              <TicketRail
                projectId={projectId}
                ticket={ticket}
                creating={creating || creatingChat}
                onNewSession={() => void createSession()}
                onNewChat={() => void createChat()}
                onNewBrowser={() => void createBrowser()}
                onActivateSession={setActiveTab}
                onActivateChat={activateChat}
                activeTabId={activeTabId}
                changesContent={
                  <TicketChangesPanel
                    ticket={ticket}
                    activeTabId={activeTabId}
                    recency={recencyOwner.recency}
                    onOpenDiff={openDiff}
                  />
                }
                filesContent={
                  <TicketFilesPanel
                    ticket={ticket}
                    handle={ticketAttachments}
                    onPreviewFile={previewFileFromRail}
                    onPinFile={pinFileFromRail}
                    onOpenCreatedFile={openCreatedFileFromRail}
                    onRenameFile={renameFileFromRail}
                  />
                }
                searchContent={
                  // Scoped to THIS ticket, so the search runs in its worktree
                  // through the same seam a read does — and a match opens in
                  // the same preview slot a navigator row opens (VC-193).
                  <FileSearchPanel
                    scope={{ kind: "ticket", projectId, ticketId: ticket.id }}
                    root={ticket.branch ?? ticket.baseBranch ?? "No branch yet"}
                    onOpenMatch={previewFileFromRail}
                  />
                }
              />
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
        relPath={pendingClose?.relPath ?? null}
        onCancel={() => setPendingClose(null)}
        onChoose={(choice) => {
          void resolvePendingClose(choice);
        }}
      />
    </SplitDnd>
  );
}

/**
 * Rename from either strip: the tab id says which Session kind this is.
 *
 * Each kind has its own optimistic surface to move before the durable write —
 * a chat tab id must never reach the PTY rename, which would address a terminal
 * that does not exist.
 */
function renameSessionTab(tabId: string, title: string): void {
  const chatSessionId = parseChatTabId(tabId);
  if (chatSessionId !== null) {
    void renameChatSession(chatSessionId, title);
    return;
  }
  renameTerminalSession(tabId, title);
}

/**
 * One pane's file editor, with its reports bound to ITS path.
 *
 * A component rather than a closure built in the render above, and that is the
 * whole reason it exists: `FileView` holds `onDirtyChange` in effect and
 * callback dependencies, so a handler whose identity changed every render would
 * re-read the file from disk on every render. Bound one level down, the binding
 * changes only when the path does.
 */
function TicketPaneFileView({
  relPath,
  onDirtyChange,
  ...rest
}: Omit<React.ComponentProps<typeof FileView>, "relPath" | "onDirtyChange"> & {
  relPath: string;
  onDirtyChange(relPath: string, dirty: boolean): void;
}) {
  const handleDirtyChange = React.useCallback(
    (dirty: boolean) => onDirtyChange(relPath, dirty),
    [onDirtyChange, relPath],
  );
  return <FileView {...rest} relPath={relPath} onDirtyChange={handleDirtyChange} />;
}

/** {@link TicketPaneFileView} for a diff, which also reports its view state. */
function TicketPaneDiffView({
  relPath,
  onDirtyChange,
  onViewStateChange,
  ...rest
}: Omit<
  React.ComponentProps<typeof DiffView>,
  "relPath" | "onDirtyChange" | "onViewStateChange"
> & {
  relPath: string;
  onDirtyChange(relPath: string, dirty: boolean): void;
  onViewStateChange(relPath: string, viewState: unknown): void;
}) {
  const handleDirtyChange = React.useCallback(
    (dirty: boolean) => onDirtyChange(relPath, dirty),
    [onDirtyChange, relPath],
  );
  const handleViewStateChange = React.useCallback(
    (viewState: unknown) => onViewStateChange(relPath, viewState),
    [onViewStateChange, relPath],
  );
  return (
    <DiffView
      {...rest}
      relPath={relPath}
      onDirtyChange={handleDirtyChange}
      onViewStateChange={handleViewStateChange}
    />
  );
}
