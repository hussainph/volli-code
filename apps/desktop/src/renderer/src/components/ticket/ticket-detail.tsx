import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import {
  baseNameOf,
  displayTicketId,
  errorMessage,
  type FileSource,
  type FileWorkspaceTab,
  type Ticket,
} from "@volli/shared";

import { renameChatSession } from "@renderer/chat/rename";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import {
  planTabClose,
  resolveTabClose,
  shouldDiscardSharedDraft,
  type TabCloseResolution,
} from "@renderer/components/files/close-guard";
import { FileSaveGuardDialog } from "@renderer/components/files/save-guard-dialog";
import { ContentColumn } from "@renderer/components/layout/content-column";
import type { DocumentFileRefs } from "@renderer/components/editor/monaco-document-editor";
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
  nextChatOrdinal,
  parseChatTabId,
  resolveChatRelaunch,
  CHAT_TAB_FALLBACK_LABEL,
} from "@renderer/components/ticket/ticket-chat-tab";
import { TicketBodyPanel } from "@renderer/components/ticket/ticket-body-panel";
import { TicketChangesPanel } from "@renderer/components/ticket/ticket-changes-panel";
import {
  createTicketRecencyWatchOwner,
  EMPTY_TICKET_RECENCY_OWNER_STATE,
  reduceTicketRecencyOwner,
  type TicketRecencyWatchOwner,
} from "@renderer/components/ticket/ticket-change-recency-owner";
import { diffTabId } from "@renderer/components/ticket/ticket-diff-tab";
import { TicketFilesPanel } from "@renderer/components/ticket/ticket-files-panel";
import { TicketRail } from "@renderer/components/ticket/ticket-rail";
import { TicketSessionPlane } from "@renderer/components/ticket/ticket-session-plane";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { TicketTitle } from "@renderer/components/ticket/ticket-title";
import { fileDocumentIdentity, type DocumentIdentity } from "@renderer/editor/document-identity";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { isEscapeExempt } from "@renderer/lib/escape-guard";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { sessionPanes, ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
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
 * by board-page.tsx in place of the board's content when a ticket is open —
 * the global sessions layer and sidebar stay mounted around it (they live
 * higher up the tree, in main-content.tsx/app-shell.tsx). Layout follows the
 * browser-window metaphor: ONE full-width Chrome-style tab row at the very top,
 * spanning above both the main column (title → content plane) and the right
 * rail (icon-mode Sessions/Files/Changes/Properties navigator). Navigation is
 * the chrome bar's ←/→ history plus Escape; there's no breadcrumb. The tab
 * plane hosts the ticket's live terminals; those stay resident (engines outlive
 * the view via the module registry, decision #8) and are positioned by the
 * always-mounted overlay onto the plane's measured box in the main column — so
 * the rail collapsing (which hands the plane the full width) never unmounts a
 * terminal.
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
  const previewTicketFile = useWorkspaceStore((state) => state.previewTicketFile);
  const pinTicketFile = useWorkspaceStore((state) => state.pinTicketFile);
  const markTicketFileEdited = useWorkspaceStore((state) => state.markTicketFileEdited);
  const closeTicketFile = useWorkspaceStore((state) => state.closeTicketFile);
  const openTicketDiff = useWorkspaceStore((state) => state.openTicketDiff);
  const closeTicketDiff = useWorkspaceStore((state) => state.closeTicketDiff);
  const setTicketActiveTab = useWorkspaceStore((state) => state.setTicketActiveTab);
  const setTicketDiffViewState = useWorkspaceStore((state) => state.setTicketDiffViewState);
  const ticketTabsState = useWorkspaceStore(
    (state) => state.byProject[projectId]?.ticketTabs?.[ticket.id],
  );
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
        chatTabStatus(state.sessions[sessionId]?.lifecycle),
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
  const railWidth = useUiStore((state) => state.railWidth);
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const setTerminalFocusTarget = useUiStore((state) => state.setTerminalFocusTarget);
  const clearTerminalFocusUnlessTicket = useUiStore(
    (state) => state.clearTerminalFocusUnlessTicket,
  );
  const closeGuard = useCloseGuard();
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
  const openFile = React.useCallback(
    (relPath: string) => openTicketFile(projectId, ticket.id, relPath),
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
  const tabs: TicketTabDescriptor[] = [
    { id: BODY_TAB_ID, kind: "body", label: displayId },
    ...openFiles.map(
      (tab): TicketTabDescriptor => ({
        id: `file:${tab.relPath}`,
        kind: "file",
        label: baseNameOf(tab.relPath),
        relPath: tab.relPath,
        preview: !tab.pinned,
        badge: fileSources[tab.relPath] === "worktree" ? "worktree" : undefined,
        dirty: dirtyFiles.has(tab.relPath),
      }),
    ),
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
    ...(sessionTabs ?? []).map(
      (tab): TicketTabDescriptor => ({
        id: tab.sessionId,
        kind: "session",
        label: tab.title,
      }),
    ),
    ...openChatIds.map(
      (sessionId, index): TicketTabDescriptor => ({
        id: chatTabId(sessionId),
        kind: "chat",
        label: chatTitles[index] ?? CHAT_TAB_FALLBACK_LABEL,
        status: chatStatuses[index],
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
  const activeChatSessionId = activeTab.kind === "chat" ? parseChatTabId(activeTab.id) : null;
  const terminalFocused =
    terminalFocusTarget?.projectId === projectId &&
    terminalFocusTarget.ticketId === ticket.id &&
    terminalFocusTarget.sessionId === activeTab.id &&
    activeSessionTab !== undefined;

  // Only the active file/diff tab mounts an editor, so its dirty reports are for
  // exactly one path — the one below it in the tab strip. File and diff of the
  // same path share the dirty key.
  const activeEditorRelPath =
    activeTab.kind === "file" || activeTab.kind === "diff" ? (activeTab.relPath ?? null) : null;
  const handleFileDirtyChange = React.useCallback(
    (dirty: boolean) => {
      if (activeEditorRelPath === null) return;
      markFileDirty(activeEditorRelPath, dirty);
      // Decision #56: a dirty File tab is never replaced, so the first edit
      // promotes the preview slot to a persistent tab. Diff tabs are always
      // persistent already — markTicketFileEdited is a no-op when the path
      // isn't an open File preview.
      if (dirty) markTicketFileEdited(projectId, ticket.id, activeEditorRelPath);
    },
    [activeEditorRelPath, markFileDirty, markTicketFileEdited, projectId, ticket.id],
  );

  const handleDiffViewStateChange = React.useCallback(
    (viewState: unknown) => {
      if (activeEditorRelPath === null) return;
      setTicketDiffViewState(projectId, ticket.id, activeEditorRelPath, viewState);
    },
    [activeEditorRelPath, projectId, setTicketDiffViewState, ticket.id],
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

  // Mints one durable chat Session on this ticket and opens its tab, through
  // the same boot guard the terminal path uses: one create per ticket at a
  // time, none at all into a project the renderer has stopped tracking, and the
  // landing below re-checked against fresh state after the await.
  const createChat = React.useCallback(async () => {
    await bootChatSession(ticketScope(projectId, ticket.id), {
      // The terminal path's own convention — the count that exists, plus one.
      title: `Chat ${nextChatOrdinal(durableChatIds?.length ?? 0, openChatIds.length)}`,
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
  }, [durableChatIds?.length, openChatIds.length, projectId, setActiveTab, ticket.id]);

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

  const enterTerminalFocus = React.useCallback(() => {
    if (activeSessionTab === undefined) return;
    setTerminalFocusTarget({
      projectId,
      ticketId: ticket.id,
      sessionId: activeSessionTab.sessionId,
    });
  }, [activeSessionTab, projectId, ticket.id, setTerminalFocusTarget]);

  // Escape closes the detail view and returns to the board — but only when
  // focus isn't inside an input/textarea/contenteditable or an open menu/
  // dialog, the same guard board.tsx's own Escape-deselect uses, so a
  // property dropdown or the label editor's text field can still dismiss
  // itself on Escape without also closing the whole view. Board's own
  // Escape-deselect listener is inert while this view is mounted — board.tsx
  // isn't rendered at all (board-page.tsx swaps the two) — so the two never
  // fire off the same keypress.
  //
  // While terminal-focused, Escape is left entirely alone so it reaches the
  // PTY (Claude Code interrupts on it; vim and friends lean on it). Exit from
  // terminal focus is the chrome-bar button only — no Escape chord — so the
  // PTY never fights the app for the key.
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
            creating={creating || creatingChat}
            onSelectTab={setActiveTab}
            onPinFileTab={(relPath) => pinTicketFile(projectId, ticket.id, relPath)}
            onCloseTab={(tab) => {
              if (tab.kind === "file" && tab.relPath !== undefined) {
                // A file tab with an unsaved draft routes through the Save /
                // Discard / Cancel guard first (CONCEPT #49).
                requestCloseFileTab(tab.relPath);
                return;
              }
              if (tab.kind === "diff" && tab.relPath !== undefined) {
                requestCloseDiffTab(tab.relPath);
                return;
              }
              if (tab.kind === "chat") {
                const chatId = parseChatTabId(tab.id);
                if (chatId === null) return;
                // No busy guard and no confirm: the Session is durable, so
                // closing the view loses nothing — reopening it from the rail
                // adopts the same history. Standing the active tab down first,
                // because the relaunch effect would otherwise read the persisted
                // id, find the Session still on record, and put the tab back.
                if (activeTabId === tab.id) setActiveTab(BODY_TAB_ID);
                useChatSessionsStore.getState().closeChatTab(ticket.id, chatId);
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
            onRenameSessionTab={(tabId, title) => {
              // The tab id says which Session kind this is, and each kind has
              // its own optimistic surface to move before the durable write —
              // a chat tab id must never reach the PTY rename, which would
              // address a terminal that does not exist.
              const chatSessionId = parseChatTabId(tabId);
              if (chatSessionId !== null) {
                void renameChatSession(chatSessionId, title);
                return;
              }
              renameTerminalSession(tabId, title);
            }}
            onNewSession={() => void createSession()}
            onNewChat={() => void createChat()}
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
              activeTab.kind === "body" && "pt-8",
            )}
          >
            {activeTab.kind === "body" && (
              <ContentColumn>
                <TicketTitle ticket={ticket} />
              </ContentColumn>
            )}
            {/* Positioning context for the resident terminal plane: Doc/file tabs
              scroll in-flow; the plane overlays them, shown only for a session tab. */}
            <div
              className={cn(
                "relative flex min-h-0 flex-1 flex-col",
                activeTab.kind === "body" && "mt-3",
              )}
            >
              {activeTab.kind === "body" ? (
                <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                  <TicketBodyPanel ticket={ticket} fileRefs={fileRefs} />
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
                  onLocalSave={reportLocalSave}
                  onLoaded={handleFileLoaded}
                />
              ) : null}
              {activeTab.kind === "diff" && activeTab.relPath !== undefined ? (
                <DiffView
                  key={activeTab.relPath}
                  projectId={projectId}
                  ticket={ticket}
                  relPath={activeTab.relPath}
                  previousPath={activeTab.previousPath ?? diffMeta[activeTab.relPath]?.previousPath}
                  status={diffMeta[activeTab.relPath]?.status}
                  binary={diffMeta[activeTab.relPath]?.binary}
                  onDirtyChange={handleFileDirtyChange}
                  onLocalSave={reportLocalSave}
                  onLoaded={handleFileLoaded}
                  initialViewState={ticketDiffViewStates?.[activeTab.relPath]}
                  onViewStateChange={handleDiffViewStateChange}
                />
              ) : null}
              {/* In flow, not on the resident overlay beside it: that host
                  exists so a GPU-owning terminal is never unmounted, and a chat
                  needs nothing of the sort — its stream, fold and queue live in
                  the registry client, which outlives this view either way. */}
              {activeChatSessionId !== null ? (
                <ChatPlane
                  key={activeChatSessionId}
                  sessionId={activeChatSessionId}
                  onOpenFile={openFile}
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
            // app-wide via the ui store. Icon-mode content lives in TicketRail.
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
                    onPreviewFile={previewFileFromRail}
                    onPinFile={pinFileFromRail}
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
    </>
  );
}
