/**
 * Home: the Board, Project Sessions, Project Files, and Browser Tabs.
 *
 * The shape (VC-54, VC-42 phase 3). The nav row used to hold a "Board" page and
 * a "Sessions" page, and the second was the app's most confusing taxonomy — it
 * held only ticketless Sessions, auto-opened a chat nobody asked for on first
 * visit, and its tabs were easily mistaken for a ticket workspace's. So the
 * Board nav became **Home**, a tabbed environment in exactly the ticket
 * workspace's grammar: a permanent first tab that cannot be closed (the Board,
 * precisely as a ticket's Body tab), with Project Sessions and Files beside it.
 *
 * That arrangement is the product argument, made spatial instead of explained.
 * A Home Session is an ORCHESTRATOR: start from a nebulous idea and leave with
 * a focused set of tickets, or drive those tickets through their whole
 * lifecycle from one chat. A Ticket Session is a scoped executor in a worktree.
 * The board sitting one tab away from the orchestrator chat says that without a
 * word of prose.
 *
 * ── WHAT RENDERS ──────────────────────────────────────────────────────────
 *
 *   active tab | openTicketId | what is on screen
 *   -----------+--------------+-----------------------------------------------
 *   Board      | null         | Home strip + the board
 *   Board      | set          | TicketDetail, full-bleed, NO Home strip
 *   a work tab | either       | Home strip + that Session/File/Browser plane
 *
 * A Home SESSION additionally gets the right rail (VC-55) — the ticket
 * workspace's panel at this scope, on the same ⌥⌘B and the same persisted
 * collapse. The board has none: a rail about where this Session runs, over a
 * board, would be about nothing.
 *
 * A ticket workspace TAKES HOME OVER rather than nesting under its strip. The
 * alternative puts two tab strips on one screen, which is the very confusion
 * this ticket exists to end. What is deliberately given up is the nav item as a
 * route back to a chat: clicking Home while a ticket is open means "show me
 * Home", which is the board. Three ways back into an orchestrator chat already
 * exist and need no fourth — the sidebar's Active/Previous bands, ⌘K, and ⌘T.
 *
 * ── WHY THIS COMPONENT OWNS THE RESOLUTION ────────────────────────────────
 * `homeActiveTab` is a RECORD, not an answer: the tab it names can have closed,
 * or can be a Session that outlived the app and has no tab yet. The live answer
 * is `resolveHomeTabs`, and two consumers need it — this surface, to choose
 * between the board and a Session plane, and {@link SessionsLayer}, to decide
 * which panes are visible. If they read it separately they could disagree for a
 * frame (record says a dead chat, derivation says the board) and the user would
 * be looking at nothing. So it is resolved once, here, and handed down.
 *
 * This component is ALWAYS MOUNTED, for the reason `SessionsLayer` is: it hosts
 * that layer, which owns every live terminal in the app across all projects.
 * Switching nav, switching projects or opening Settings flips visibility, never
 * mounting (CLAUDE.md).
 */
import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { errorMessage, type FileWorkspaceTab, type SkillReference } from "@volli/shared";
import type { BrowserTabState } from "../../../../ipc/contract";

import { renameChatSession } from "@renderer/chat/rename";
import { BrowserPane } from "@renderer/components/browser/browser-pane";
import { HOME_BOARD_TAB, HomeTabStrip, type HomeTabDescriptor } from "./home-tab-strip";
import { HomeRail } from "./home-rail";
import { fileTabLabels } from "@renderer/components/files/file-tab-labels";
import { FileSaveGuardDialog } from "@renderer/components/files/save-guard-dialog";
import { useProjectFileWorkspace } from "@renderer/components/files/use-project-file-workspace";
import {
  HOME_BOARD_TAB_ID,
  browserTabId,
  isHomeBoardTab,
  parseBrowserTabId,
  resolveHomeTabs,
} from "./home-tabs";
import { Board } from "@renderer/components/board/board";
import { BoardBoundary } from "@renderer/components/board/board-boundary";
import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { SessionsLayer } from "@renderer/components/sessions/sessions-layer";
import {
  startProjectChat,
  startProjectTerminal,
} from "@renderer/components/sessions/session-create";
import { RailResizeHandle } from "@renderer/components/ticket/rail-resize-handle";
import { FileView } from "@renderer/components/ticket/file-view";
import { TicketDetail } from "@renderer/components/ticket/ticket-detail";
import {
  chatTabId,
  chatTabStatus,
  CHAT_TAB_FALLBACK_LABEL,
} from "@renderer/components/ticket/ticket-chat-tab";
import { fileTabId, parseFileTabId } from "@renderer/components/ticket/ticket-file-tab";
import { usePromptTemplates } from "@renderer/hooks/use-prompt-templates";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useBoardStore } from "@renderer/stores/board";
import {
  browserTabDisplayTitle,
  hydrateBrowserTabs,
  subscribeBrowserTabs,
  useBrowserTabsStore,
} from "@renderer/stores/browser-tabs";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { sessionPanes, useSessionsStore, type SessionTab } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";
import { useCloseGuard } from "@renderer/terminal/close-guard";
import { closeTerminalSession, renameTerminalSession } from "@renderer/terminal/session-lifecycle";
import { toastError } from "@renderer/lib/toast";

const NO_TERMINAL_TABS: readonly SessionTab[] = [];
const NO_OPEN_CHATS: readonly string[] = [];

export function HomeSurface({ visible }: { visible: boolean }) {
  const selected = useSelectedProject();
  const selectedId = selected?.id ?? null;
  const browserApi = window.api.browser;

  // Browser state is main-owned and pushed for every scope. Home is the app's
  // always-mounted workspace owner, so it owns the one subscription too; a
  // Ticket detail can come and go without losing title/loading updates.
  React.useEffect(() => subscribeBrowserTabs(browserApi), [browserApi]);
  React.useEffect(() => {
    if (selectedId === null) return;
    void hydrateBrowserTabs(browserApi, selectedId)
      .then((result) => {
        if (!result.ok) toastError(`Could not load Browser Tabs: ${result.error}`);
      })
      .catch((reason: unknown) => {
        toastError(`Could not load Browser Tabs: ${errorMessage(reason)}`);
      });
  }, [browserApi, selectedId]);
  const browserTabs = useBrowserTabsStore(
    useShallow((state) =>
      selectedId === null
        ? []
        : Object.values(state.byId).filter(
            (tab) => tab.projectId === selectedId && tab.ticketId === null,
          ),
    ),
  );
  const browserTabsHydrated = useBrowserTabsStore((state) =>
    selectedId === null ? true : state.hydratedProjects.has(selectedId),
  );

  // ── The strip's inputs ───────────────────────────────────────────────────
  // Ids only. A chat's slice is replaced on every folded frame batch, and this
  // component hosts the layer that owns every live terminal in the app, so it
  // subscribes to what a tab OPENING or CLOSING changes and nothing else. The
  // title and lifecycle that move per token are read one level down, in
  // {@link HomeTabs}, so a streamed word repaints the strip and no terminal.
  const terminalTabs = useSessionsStore((state) =>
    selectedId === null ? NO_TERMINAL_TABS : (state.byOwner[selectedId]?.tabs ?? NO_TERMINAL_TABS),
  );
  const containerActive = useSessionsStore((state) =>
    selectedId === null ? null : (state.byOwner[selectedId]?.activeSessionId ?? null),
  );
  const openChatIds = useChatSessionsStore(
    useShallow((state) =>
      selectedId === null ? NO_OPEN_CHATS : (state.openTabs[selectedId] ?? NO_OPEN_CHATS),
    ),
  );
  const recordedTab = useWorkspaceStore((state) =>
    selectedId === null
      ? DEFAULT_WORKSPACE_UI.homeActiveTab
      : (state.byProject[selectedId]?.homeActiveTab ?? DEFAULT_WORKSPACE_UI.homeActiveTab),
  );
  const openTicketId = useWorkspaceStore((state) =>
    selectedId === null ? null : (state.byProject[selectedId]?.openTicketId ?? null),
  );

  /**
   * The project's durable TICKETLESS chat Sessions — the listing a persisted
   * `homeActiveTab` is checked against on relaunch.
   *
   * `undefined` until the baseline read lands, and that distinction is the
   * whole point: "not hydrated yet" must never read as "gone". Push-fed and
   * `ensure()`-deduped already (`stores/project-sessions.ts`), so this costs no
   * new fetch — the sidebar's bands are reading the same rows.
   */
  const durableChatIds = useChatSessionsIdsForProject(selectedId);
  const ensureProjectSessions = useProjectSessionsStore((state) => state.ensure);
  React.useEffect(() => {
    if (selectedId === null) return;
    void ensureProjectSessions(selectedId);
  }, [selectedId, ensureProjectSessions]);

  /**
   * Projects whose strip has been resolved once in this app run. Restoration is
   * a boot-time act: after it, a recorded id that names nothing is a tab the
   * user CLOSED, and adopting it back would reopen the tab they just shut.
   * A ref rather than state — nothing renders from it, and the render that
   * consults it is always followed by one the store triggers.
   */
  const hydratedRef = React.useRef(new Set<string>());

  // Session ids first (terminals, then chats), preserving the strip's existing
  // order. File tabs append after them and keep their own reducer order.
  const sessionTabIds = React.useMemo(
    () => [...terminalTabs.map((tab) => tab.sessionId), ...openChatIds.map(chatTabId)],
    [openChatIds, terminalTabs],
  );
  const closeHomeFile = useWorkspaceStore((state) => state.closeHomeFile);
  const closeFileFromHome = React.useCallback(
    (relPath: string) => {
      if (selectedId === null) return;
      // A dirty-close decision can stand open while Session tabs change. Read
      // survivors at the instant Close finally commits so MRU never returns to
      // a Session the user closed while the guard was waiting.
      const sessions = useSessionsStore.getState().byOwner[selectedId]?.tabs ?? [];
      const chats = useChatSessionsStore.getState().openTabs[selectedId] ?? [];
      const browsers = Object.values(useBrowserTabsStore.getState().byId).filter(
        (tab) => tab.projectId === selectedId && tab.ticketId === null,
      );
      closeHomeFile(selectedId, relPath, [
        ...sessions.map((tab) => tab.sessionId),
        ...chats.map(chatTabId),
        ...browsers.map((tab) => browserTabId(tab.tabId)),
      ]);
    },
    [closeHomeFile, selectedId],
  );
  const fileWorkspace = useProjectFileWorkspace(selectedId, closeFileFromHome);
  const { requestClose: requestCloseFile, requestCloseOthers: requestCloseOtherFiles } =
    fileWorkspace;
  const fileTabs = fileWorkspace.files.tabs;
  const tabIds = React.useMemo(
    () => [
      ...sessionTabIds,
      ...fileTabs.map((tab) => fileTabId(tab.relPath)),
      ...browserTabs.map((tab) => browserTabId(tab.tabId)),
    ],
    [browserTabs, fileTabs, sessionTabIds],
  );
  const { active: activeTabId, restore } = resolveHomeTabs({
    tabIds,
    recorded: recordedTab,
    containerActive,
    durableChatIds,
    browserTabsHydrated,
    hydrated: selectedId === null || hydratedRef.current.has(selectedId),
  });
  const restoreKind = restore.kind;
  const adoptSessionId = restore.kind === "adopt" ? restore.sessionId : null;

  /**
   * Put the persisted Session back, or accept that it is gone.
   *
   * Same adopt/wait/fallback discipline `ticket-detail.tsx` runs for a ticket's
   * own persisted tab, and for the same reason: a chat Session survives a
   * relaunch, so a `chat:<id>` that names no open tab is not evidence of
   * anything until the durable listing has answered.
   */
  React.useEffect(() => {
    if (selectedId === null || restoreKind === "pending") return;
    if (adoptSessionId !== null) {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(adoptSessionId);
      chat.openChatTab(selectedId, adoptSessionId);
    }
    hydratedRef.current.add(selectedId);
  }, [selectedId, restoreKind, adoptSessionId]);

  const setHomeActiveTab = useWorkspaceStore((state) => state.setHomeActiveTab);
  // The receipt for what was derived, and the only write of it: a tab that
  // closed under the recorded id is answered by re-deriving, never by repairing
  // what was stored. Held back while a restore is pending or in flight —
  // writing then would overwrite the very id the restore is about to use.
  React.useEffect(() => {
    if (selectedId === null || restoreKind !== "settled" || activeTabId === recordedTab) return;
    setHomeActiveTab(selectedId, activeTabId);
  }, [selectedId, restoreKind, activeTabId, recordedTab, setHomeActiveTab]);

  // ── What is on screen ────────────────────────────────────────────────────
  const boardTabActive = isHomeBoardTab(activeTabId);
  const activeFileRelPath = parseFileTabId(activeTabId);
  const activeBrowserTabId = parseBrowserTabId(activeTabId);
  const activeBrowserTab =
    activeBrowserTabId === null
      ? undefined
      : browserTabs.find((tab) => tab.tabId === activeBrowserTabId);
  const ticket = useBoardStore((state) =>
    selectedId !== null && openTicketId !== null
      ? state.ticketsByProject[selectedId]?.find((candidate) => candidate.id === openTicketId)
      : undefined,
  );
  const closeTicket = useWorkspaceStore((state) => state.closeTicket);
  // A stale `openTicketId` — the ticket was archived or deleted, whether just
  // now or in a previous run before restart restored it — falls back to the
  // plain board rather than rendering a detail view for a ticket that no longer
  // exists. Resolved HERE rather than one level down so exactly one component
  // decides whether the ticket is on screen; the strip's own visibility is the
  // other half of that same answer, and the two must never disagree.
  React.useEffect(() => {
    if (selectedId !== null && openTicketId !== null && ticket === undefined) {
      closeTicket(selectedId);
    }
  }, [selectedId, openTicketId, ticket, closeTicket]);
  const ticketTakesOver = boardTabActive && ticket !== undefined;

  // Terminal focus is an in-app zen mode: one terminal takes the whole canvas
  // and every piece of chrome steps aside, this strip included — exactly as the
  // ticket workspace's does. Any target at all means zen, and a target can only
  // ever name a surface that is itself in front.
  const zen = useUiStore((state) => state.terminalFocusTarget !== null);
  const stripVisible = visible && selected !== null && !ticketTakesOver && !zen;

  // ── The rail ─────────────────────────────────────────────────────────────
  // Home's own details panel (VC-55), on the SAME persisted collapse the ticket
  // workspace's uses — one ⌥⌘B preference, honoured by both, because they are
  // one object at two scopes and a reader who hides one has said what they
  // want. It belongs to Home's working tabs — Sessions and Files — so the Board
  // has none: a repository navigator or Session facts over the board would be
  // about an object that is not in front.
  const railCollapsed = useUiStore((state) => state.railCollapsed);
  const railWidth = useUiStore((state) => state.railWidth);
  const toggleRailCollapsed = useUiStore((state) => state.toggleRailCollapsed);
  const railVisible =
    stripVisible && !boardTabActive && activeBrowserTab === undefined && !railCollapsed;

  // ── Starting a Session ───────────────────────────────────────────────────
  const startingTerminal = useSessionsStore((state) =>
    selectedId === null ? false : (state.starting[selectedId] ?? false),
  );
  const startingChat = useChatSessionsStore((state) =>
    selectedId === null ? false : (state.starting[selectedId] ?? false),
  );
  // One control mints both kinds, so it goes quiet while EITHER is starting —
  // the one place ORing the two flags is the honest reading (session-create.ts).
  const creating = startingTerminal || startingChat;
  // The selected project's skills, for the session-start control's "Chat with
  // skill" submenu.
  const { skills } = usePromptTemplates(selectedId);

  const createBrowser = React.useCallback(async () => {
    if (selectedId === null) return;
    const requested = window.prompt("Open Browser Tab", "http://localhost:3000");
    const url = requested?.trim() ?? "";
    if (url.length === 0) return;
    try {
      const result = await browserApi.open({ projectId: selectedId, url });
      if (!result.ok) {
        toastError(`Could not open Browser Tab: ${result.error}`);
        return;
      }
      useBrowserTabsStore.getState().receive(result.tab);
      setHomeActiveTab(selectedId, browserTabId(result.tab.tabId));
    } catch (reason) {
      toastError(`Could not open Browser Tab: ${errorMessage(reason)}`);
    }
  }, [browserApi, selectedId, setHomeActiveTab]);

  // The guard for closing a TAB. `SessionsLayer` keeps its own for closing a
  // PANE: the two surfaces own different closes now that the strip lives here,
  // and only one of them can have a confirm up at a time anyway.
  const closeGuard = useCloseGuard();
  const openHomeBoard = useWorkspaceStore((state) => state.openHomeBoard);
  const activateHomeFile = useWorkspaceStore((state) => state.activateHomeFile);
  const pinHomeFile = useWorkspaceStore((state) => state.pinHomeFile);
  const closeHomeBrowserTab = useWorkspaceStore((state) => state.closeHomeBrowserTab);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);

  const handleSelect = React.useCallback(
    (descriptor: HomeTabDescriptor) => {
      if (selectedId === null) return;
      if (descriptor.kind === "board") {
        // The one tab that discards state rather than preserving it, which
        // cuts against tab intuition and is the accepted cost of keeping the
        // Board nav item's exact old meaning (VC-54 decision 2). The ticket is
        // one ⌘[ or one card click away.
        openHomeBoard(selectedId);
        return;
      }
      if (descriptor.kind === "file") {
        activateHomeFile(selectedId, descriptor.relPath);
        return;
      }
      setHomeActiveTab(selectedId, descriptor.id);
      // A terminal tab is in front on two ledgers: this surface's (recorded)
      // and the terminal container's own, which is what the keep-alive render
      // and pane focus read. A chat has nothing in the second, and never writes
      // it.
      if (descriptor.kind === "terminal") setActiveSession(selectedId, descriptor.tab.sessionId);
    },
    [activateHomeFile, openHomeBoard, selectedId, setActiveSession, setHomeActiveTab],
  );

  const handleClose = React.useCallback(
    (descriptor: HomeTabDescriptor) => {
      if (selectedId === null || descriptor.kind === "board") return;
      if (descriptor.kind === "browser") {
        void browserApi
          .close({ tabId: descriptor.tabId })
          .then((result) => {
            if (!result.ok) {
              toastError(`Could not close Browser Tab: ${result.error}`);
              return;
            }
            useBrowserTabsStore.getState().remove(descriptor.tabId);
            const sessions = useSessionsStore.getState().byOwner[selectedId]?.tabs ?? [];
            const chats = useChatSessionsStore.getState().openTabs[selectedId] ?? [];
            const workspace = useWorkspaceStore.getState().byProject[selectedId];
            const files = workspace?.projectFiles.tabs ?? [];
            const browsers = Object.values(useBrowserTabsStore.getState().byId).filter(
              (tab) => tab.projectId === selectedId && tab.ticketId === null,
            );
            closeHomeBrowserTab(selectedId, descriptor.id, [
              HOME_BOARD_TAB_ID,
              ...sessions.map((tab) => tab.sessionId),
              ...chats.map(chatTabId),
              ...files.map((tab) => fileTabId(tab.relPath)),
              ...browsers.map((tab) => browserTabId(tab.tabId)),
            ]);
          })
          .catch((reason: unknown) => {
            toastError(`Could not close Browser Tab: ${errorMessage(reason)}`);
          });
        return;
      }
      if (descriptor.kind === "chat") {
        // No busy guard and no confirm: the Session is durable, so closing the
        // view loses nothing — reopening it from the sidebar adopts the same
        // history, and the next render re-derives which tab comes forward.
        useChatSessionsStore.getState().closeChatTab(selectedId, descriptor.sessionId);
        return;
      }
      if (descriptor.kind === "file") {
        void requestCloseFile(descriptor.relPath);
        return;
      }
      const liveIds = sessionPanes(descriptor.tab.layout)
        .filter((pane) => pane.exitCode === null)
        .map((pane) => pane.sessionId);
      closeGuard.guard(liveIds, () => closeTerminalSession(selectedId, descriptor.tab.sessionId));
    },
    // The controller's own callback, not the controller: its object identity
    // moves whenever a tab, a dirty flag or a pending close does, and this memo
    // also holds the terminal close guard.
    [browserApi, closeGuard, closeHomeBrowserTab, requestCloseFile, selectedId],
  );

  const handleRename = React.useCallback((descriptor: HomeTabDescriptor, title: string) => {
    // Each Session kind has its own optimistic surface to move before the
    // durable write. Board and File tabs never raise this callback.
    if (descriptor.kind === "chat") {
      void renameChatSession(descriptor.sessionId, title);
      return;
    }
    if (descriptor.kind === "terminal") renameTerminalSession(descriptor.tab.sessionId, title);
  }, []);

  const rail =
    railVisible && selected !== null ? (
      <aside
        className="relative flex shrink-0 flex-col border-l border-sidebar-border bg-sidebar"
        style={{ width: railWidth }}
      >
        <RailResizeHandle />
        <HomeRail project={selected} activeTabId={activeTabId} />
      </aside>
    ) : null;

  return (
    <>
      {stripVisible && selectedId !== null ? (
        <HomeTabs
          terminalTabs={terminalTabs}
          chatIds={openChatIds}
          fileTabs={fileTabs}
          browserTabs={browserTabs}
          dirtyFilePaths={fileWorkspace.dirtyPaths}
          activeTabId={activeTabId}
          creating={creating}
          skills={skills}
          onSelect={handleSelect}
          onClose={handleClose}
          onRename={handleRename}
          onPinFile={(relPath) => pinHomeFile(selectedId, relPath)}
          onCloseOtherFiles={(relPath) => void requestCloseOtherFiles(relPath)}
          onNewChat={() => void startProjectChat(selectedId)}
          onNewChatWithSkill={(name) => void startProjectChat(selectedId, [name])}
          onNewSession={() => void startProjectTerminal(selectedId)}
          onNewBrowser={() => void createBrowser()}
          railCollapsed={railCollapsed}
          railTogglable={!boardTabActive && activeBrowserTab === undefined}
          onToggleRail={toggleRailCollapsed}
        />
      ) : null}

      {/* Always mounted, panes-only: it owns every live terminal in the app, so
          it is never unmounted for a nav, project or tab change. Visible when a
          Home SESSION, FILE, or BROWSER tab is in front — the board covers the same box.

          Both the rail and the File editor are handed DOWN rather than rendered
          beside this layer, so each keeps ONE position in the tree across the
          whole strip. React reconciles by position: a rail rendered from two
          branches would remount on every Session↔File switch, and the Files
          navigator inside it would lose the folder it was standing in — so
          opening a file would reset the navigator that opened it. */}
      <SessionsLayer
        visible={visible && !boardTabActive}
        activeTabId={activeTabId}
        rail={rail}
        plane={
          activeBrowserTab !== undefined ? (
            <BrowserPane
              key={activeBrowserTab.tabId}
              tab={activeBrowserTab}
              visible={visible}
              api={browserApi}
              onTabState={useBrowserTabsStore.getState().receive}
            />
          ) : selected !== null && activeFileRelPath !== null ? (
            <FileView
              key={`${selected.id}:${activeFileRelPath}`}
              projectId={selected.id}
              relPath={activeFileRelPath}
              initialViewState={fileWorkspace.viewStates[activeFileRelPath]}
              onViewStateChange={fileWorkspace.handleViewStateChange}
              onDirtyChange={fileWorkspace.handleDirtyChange}
            />
          ) : null
        }
      />

      {visible && selected !== null && boardTabActive ? (
        ticket !== undefined ? (
          // Keyed so a ticket→ticket jump (nav history) remounts the detail:
          // pending body/artifact autosaves flush on unmount to the ticket that
          // authored them, never into the next ticket's editors.
          <TicketDetail
            key={ticket.id}
            projectId={selected.id}
            projectPath={selected.path}
            ticketPrefix={selected.ticketPrefix}
            ticket={ticket}
          />
        ) : (
          // Contained: a board that faults mid-render costs the board and a
          // retry, not the whole window. See board-boundary.tsx.
          <BoardBoundary projectId={selected.id}>
            <Board projectId={selected.id} ticketPrefix={selected.ticketPrefix} />
          </BoardBoundary>
        )
      ) : null}

      <ConfirmCloseDialog
        pending={closeGuard.pending}
        onConfirm={closeGuard.confirm}
        onCancel={closeGuard.cancel}
      />
      <FileSaveGuardDialog
        relPath={fileWorkspace.pendingRelPath}
        onCancel={fileWorkspace.cancelClose}
        onChoose={fileWorkspace.chooseClose}
      />
    </>
  );
}

/**
 * The project's durable ticketless chat Session ids, or `undefined` while that
 * listing has never been read.
 *
 * `useShallow` over the ids rather than over the rows: the push channel
 * re-publishes a row on every turn boundary, and this surface only cares
 * whether the SET of Sessions changed — otherwise a streaming chat would
 * re-render Home (and the board under it) once a second.
 */
function useChatSessionsIdsForProject(projectId: string | null): readonly string[] | undefined {
  return useProjectSessionsStore(
    useShallow((state) => {
      if (projectId === null) return undefined;
      const rows = state.byProject[projectId];
      if (rows === undefined) return undefined;
      return rows.chat
        .filter((record) => record.ticketId === null)
        .map((record) => record.sessionId);
    }),
  );
}

/**
 * The strip, and the only place the per-token chat reads live.
 *
 * {@link HomeSurface} hosts every live terminal in the app and must not
 * re-render on a streamed word; a chat's title and lifecycle move on exactly
 * that. So they are subscribed here, as two primitive-valued reads rather than
 * one that builds descriptors — the same split `ticket-detail.tsx` makes, for
 * the same reason: a selector returning a fresh array of objects re-renders on
 * every folded batch, while shallow equality over strings costs nothing when
 * neither moved.
 */
function HomeTabs({
  terminalTabs,
  chatIds,
  fileTabs,
  browserTabs,
  dirtyFilePaths,
  activeTabId,
  creating,
  skills,
  onSelect,
  onClose,
  onRename,
  onPinFile,
  onCloseOtherFiles,
  onNewSession,
  onNewChat,
  onNewChatWithSkill,
  onNewBrowser,
  railCollapsed,
  railTogglable,
  onToggleRail,
}: {
  terminalTabs: readonly SessionTab[];
  chatIds: readonly string[];
  fileTabs: readonly FileWorkspaceTab[];
  browserTabs: readonly BrowserTabState[];
  dirtyFilePaths: ReadonlySet<string>;
  activeTabId: string;
  creating: boolean;
  skills?: readonly SkillReference[];
  onSelect(tab: HomeTabDescriptor): void;
  onClose(tab: HomeTabDescriptor): void;
  onRename(tab: HomeTabDescriptor, title: string): void;
  onPinFile(relPath: string): void;
  onCloseOtherFiles(relPath: string): void;
  onNewSession(): void;
  onNewChat(): void;
  onNewChatWithSkill(name: string): void;
  onNewBrowser(): void;
  /** The rail's collapse state and its corner control — see `home-rail.tsx`. */
  railCollapsed: boolean;
  railTogglable: boolean;
  onToggleRail(): void;
}) {
  const chatTitles = useChatSessionsStore(
    useShallow((state) =>
      chatIds.map(
        (sessionId) =>
          state.sessions[sessionId]?.projection?.session.title ?? CHAT_TAB_FALLBACK_LABEL,
      ),
    ),
  );
  const chatStatuses = useChatSessionsStore(
    useShallow((state) => chatIds.map((sessionId) => chatTabStatus(state.sessions[sessionId]))),
  );
  const fileLabels = fileTabLabels(fileTabs.map((tab) => tab.relPath));
  const tabs: HomeTabDescriptor[] = [
    HOME_BOARD_TAB,
    ...terminalTabs.map((tab): HomeTabDescriptor => ({ kind: "terminal", id: tab.sessionId, tab })),
    ...chatIds.map(
      (sessionId, index): HomeTabDescriptor => ({
        kind: "chat",
        id: chatTabId(sessionId),
        sessionId,
        title: chatTitles[index] ?? CHAT_TAB_FALLBACK_LABEL,
        status: chatStatuses[index] ?? "idle",
      }),
    ),
    ...fileTabs.map((tab, index): HomeTabDescriptor => {
      const label = fileLabels[index] ?? { name: tab.relPath, hint: null };
      return {
        kind: "file",
        id: fileTabId(tab.relPath),
        relPath: tab.relPath,
        title: label.name,
        hint: label.hint,
        preview: !tab.pinned,
        dirty: dirtyFilePaths.has(tab.relPath),
      };
    }),
    ...browserTabs.map(
      (tab): HomeTabDescriptor => ({
        kind: "browser",
        id: browserTabId(tab.tabId),
        tabId: tab.tabId,
        title: browserTabDisplayTitle(tab),
        loading: tab.loading,
      }),
    ),
  ];

  return (
    <HomeTabStrip
      tabs={tabs}
      activeTabId={activeTabId}
      creating={creating}
      skills={skills}
      onSelect={onSelect}
      onClose={onClose}
      onRename={onRename}
      onPinFile={onPinFile}
      onCloseOtherFiles={onCloseOtherFiles}
      onNewSession={onNewSession}
      onNewChat={onNewChat}
      onNewChatWithSkill={onNewChatWithSkill}
      onNewBrowser={onNewBrowser}
      railCollapsed={railCollapsed}
      railTogglable={railTogglable}
      onToggleRail={onToggleRail}
    />
  );
}
