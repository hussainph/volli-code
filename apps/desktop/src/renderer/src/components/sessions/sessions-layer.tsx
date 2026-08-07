import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import * as React from "react";
import { useShallow } from "zustand/react/shallow";

import { renameChatSession } from "@renderer/chat/rename";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { NewSessionMenu } from "@renderer/components/sessions/new-session-menu";
import { SessionTabs, type SessionTabDescriptor } from "@renderer/components/sessions/session-tabs";
import { SessionSplitLayout } from "@renderer/components/sessions/session-split-layout";
import { TicketTerminalOverlay } from "@renderer/components/sessions/ticket-terminal-host";
import {
  bootChatSession,
  createTerminalSession,
  createTerminalSplit,
} from "@renderer/components/sessions/session-create";
import {
  chatTabId,
  chatTabStatus,
  nextChatOrdinal,
  parseChatTabId,
  CHAT_TAB_FALLBACK_LABEL,
} from "@renderer/components/ticket/ticket-chat-tab";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  hydrateHarnessCatalog,
  scratchScope,
  sessionPanes,
  subscribeHarnessEvents,
  subscribeSessionHarness,
  useSessionsStore,
  type SessionTab,
  type TerminalSplitDirection,
} from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { subscribeWorktreePhases } from "@renderer/stores/worktree";
import { cn } from "@renderer/lib/utils";
import { useCloseGuard } from "@renderer/terminal/close-guard";
import { getEngine } from "@renderer/terminal/registry";
import { adjacentPaneId, type TerminalFocusDirection } from "@renderer/terminal/pane-navigation";
import {
  closeTerminalPane,
  closeTerminalSession,
  renameTerminalSession,
} from "@renderer/terminal/session-lifecycle";
import type { Project } from "@volli/shared";

const NO_TERMINAL_TABS: readonly SessionTab[] = [];
const NO_OPEN_CHATS: readonly string[] = [];

/**
 * Which merged tab is in front, decided at render rather than stored.
 *
 * The recorded id wins while it still names a tab — it is what the sidebar
 * writes to put a Session in front, and what a project switch comes back to.
 * (Only that: `sessionsActiveTab` is session-only, since the open tabs it
 * points at do not survive a relaunch either.) Failing that, the terminal
 * container's own active session, so closing the chat that was covering a
 * terminal puts that terminal back rather than jumping to the head of the
 * strip. Failing that, the first tab.
 *
 * Deriving beats storing here because both maps behind it are resident: a tab
 * that closes simply stops being named, and the write-back that follows records
 * what was derived instead of repairing what was stored.
 */
function resolveActiveTabId(
  tabIds: readonly string[],
  recorded: string | null,
  containerActive: string | null,
): string | null {
  if (recorded !== null && tabIds.includes(recorded)) return recorded;
  if (containerActive !== null && tabIds.includes(containerActive)) return containerActive;
  return tabIds[0] ?? null;
}

interface SessionsLayerProps {
  /** Sessions is the active page. The layer stays MOUNTED regardless; this only
   *  toggles the SCRATCH surface's visibility. Ticket terminals it also hosts
   *  are shown independently, overlaid on the ticket plane, even while this is
   *  hidden — so no live terminal is ever unmounted incidentally. */
  visible: boolean;
}

/**
 * The always-mounted terminal surface. It owns EVERY live terminal across ALL
 * projects and tickets (each kept alive via the module engine registry), so
 * switching nav, projects, opening a ticket, or opening Settings only flips CSS
 * visibility — no terminal is ever unmounted incidentally (CLAUDE.md).
 *
 * Two regions: the SCRATCH surface (a tab strip + split trees for the selected
 * project's scratch sessions, hidden with `visible`), and the resident
 * {@link TicketTerminalOverlay} (positioned over the ticket detail's plane when
 * a ticket session tab is active). Both read the one unified store.
 */
export function SessionsLayer({ visible }: SessionsLayerProps) {
  const byOwner = useSessionsStore((state) => state.byOwner);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);
  const setActivePane = useSessionsStore((state) => state.setActivePane);
  const setSplitRatio = useSessionsStore((state) => state.setSplitRatio);
  const markExited = useSessionsStore((state) => state.markExited);
  const selected = useSelectedProject();
  // One guard for both scratch close surfaces (tab close + pane close): a busy
  // terminal interposes a confirm before the actual PTY teardown runs.
  const closeGuard = useCloseGuard();

  // Projects that already got their one auto-opened scratch session. Marked at
  // attempt time and never cleared — a failure's retry surface is the empty
  // state's "New session" button, and a user closing their last tab must be able
  // to hold zero sessions without the effect respawning one.
  const autoOpenedRef = React.useRef(new Set<string>());

  // The single subscription to the shared PTY streams (this layer is always
  // mounted, so it owns the app-wide fan-out for BOTH scratch and ticket
  // sessions): fan output to the matching engine (lookup ONLY — creating here
  // would leak engines for events racing a close), bump the session's activity,
  // record exits, and mirror the warm-park tier's park/wake/pin pushes (decision
  // #31) into the store. Every chunk is acked exactly once here: main's
  // flow-control bookkeeping must not starve.
  React.useEffect(() => {
    const offData = window.api.terminal.onData((event) => {
      getEngine(event.sessionId)?.write(event.data);
      window.api.terminal.ack(event.sessionId, event.data.length);
      useSessionsStore.getState().bumpOutput(event.sessionId, Date.now());
    });
    const offExit = window.api.terminal.onExit((event) => {
      markExited(event.sessionId, event.exitCode);
      // Refresh the ticket's durable session-records cache so the just-ended
      // record's `endedAt` (and therefore its resumability, interrupt/resume
      // issue #78) lands promptly — the rail's History rows and the exited-
      // pane resume overlay both read this one shared cache
      // (stores/ticket-session-records.ts) and neither is guaranteed to be
      // mounted to notice the exit itself. `sessionOwner` resolves ANY pane
      // (root or split leaf) to its owner id; every tab under one owner
      // shares the same scope kind (ownerKey never collides scratch/ticket).
      const state = useSessionsStore.getState();
      const ownerId = state.sessionOwner[event.sessionId];
      const isTicketOwner =
        ownerId !== undefined && state.byOwner[ownerId]?.tabs[0]?.scope.kind === "ticket";
      if (isTicketOwner) void useTicketSessionRecordsStore.getState().refresh(ownerId);
    });
    const offParkState = window.api.terminal.onParkState((event) => {
      useSessionsStore.getState().setParkState(event.sessionId, event.parked, event.keepAwake);
    });
    return () => {
      offData();
      offExit();
      offParkState();
    };
  }, [markExited]);

  // The single subscription to worktree-ensure phase pushes, same reasoning as
  // the terminal fan-out above: this layer is the one component alive for the
  // whole session, so it's the natural home for the app-wide `onPhase` stream
  // (stores/worktree.ts) that the ticket-detail session chip, "starting"
  // affordance, and Details rail's failed-notice/retry all read from.
  React.useEffect(() => subscribeWorktreePhases(), []);

  // The single subscription to the involuntary harness channel, for the same
  // reason again (docs/plans/harness-events.md): the events address live
  // sessions by the same id the PTY streams above carry, and this layer is the
  // only component that outlives every surface reading them — the sidebar's
  // Active band, the ticket rail, the session header.
  React.useEffect(() => subscribeHarnessEvents(), []);

  // The other involuntary channel, mounted here for the same reason: a
  // harness's own launch wrapper announcing that IT is what is now running in a
  // terminal. Separate from the event stream above because it answers a
  // different question — not what the agent is doing, but which agent it is.
  React.useEffect(() => subscribeSessionHarness(), []);

  // And the catalog those events are read against: which harnesses beyond the
  // four this renderer ships main will actually launch. Pulled once here so a
  // launch that never passes through a picker — a ticket dragged to Doing with
  // a harness it remembered from a previous run — still declares the
  // expectation its manifest earns. The composer re-pulls on every open, which
  // is where a mid-session verdict lands.
  React.useEffect(() => {
    void hydrateHarnessCatalog();
  }, []);

  const createScratch = React.useCallback((project: Project) => {
    void createTerminalSession(scratchScope(project.id));
  }, []);

  const selectedId = selected?.id ?? null;
  const scratch = selectedId === null ? undefined : byOwner[selectedId];
  const terminalTabs = scratch?.tabs ?? NO_TERMINAL_TABS;
  /**
   * The selected project's open chat tabs — ids only.
   *
   * A chat's slice is replaced on every folded frame batch, and this layer hosts
   * every live terminal in the app, so it subscribes to what a tab OPENING or
   * CLOSING changes and nothing else. The title and lifecycle that move per
   * token are read one level down, in {@link ScratchTabs}, so a streamed word
   * repaints the strip and no terminal.
   */
  const openChatIds = useChatSessionsStore(
    useShallow((state) =>
      selectedId === null ? NO_OPEN_CHATS : (state.openTabs[selectedId] ?? NO_OPEN_CHATS),
    ),
  );
  const startingTerminal = useSessionsStore((state) =>
    selectedId === null ? false : (state.starting[selectedId] ?? false),
  );
  const startingChat = useChatSessionsStore((state) =>
    selectedId === null ? false : (state.starting[selectedId] ?? false),
  );
  // One control mints both kinds, so it goes quiet while EITHER is starting —
  // the one place ORing the two flags is the honest reading (session-create.ts).
  const creating = startingTerminal || startingChat;

  const recordedActiveTab = useWorkspaceStore((state) =>
    selectedId === null ? null : (state.byProject[selectedId]?.sessionsActiveTab ?? null),
  );
  const setSessionsActiveTab = useWorkspaceStore((state) => state.setSessionsActiveTab);
  const setNav = useWorkspaceStore((state) => state.setNav);
  const previewProjectFile = useWorkspaceStore((state) => state.previewProjectFile);

  // Terminals first, then chats, each in the order it was opened: the strip is
  // stable under everything except opening and closing a tab.
  const tabIds = React.useMemo(
    () => [...terminalTabs.map((tab) => tab.sessionId), ...openChatIds.map(chatTabId)],
    [openChatIds, terminalTabs],
  );
  const activeTabId = resolveActiveTabId(
    tabIds,
    recordedActiveTab,
    scratch?.activeSessionId ?? null,
  );
  // A chat in front covers the plane, so the terminals under it stand down.
  // They stay mounted — only their visibility flips (see the keep-alive below).
  const activeChatSessionId = activeTabId === null ? null : parseChatTabId(activeTabId);

  // The receipt for what was derived, and the only write of it: a tab that
  // closed under the recorded id is answered by re-deriving, never by repairing
  // what was stored.
  React.useEffect(() => {
    if (selectedId === null || activeTabId === recordedActiveTab) return;
    setSessionsActiveTab(selectedId, activeTabId);
  }, [activeTabId, recordedActiveTab, selectedId, setSessionsActiveTab]);

  // Zero-friction first visit: auto-open a scratch terminal when Sessions is
  // revealed for a project that has never had a Session here — once per project.
  // A chat counts as one: the surface is not empty, and a terminal nobody asked
  // for would be an odd thing to find beside it.
  const emptySurface = terminalTabs.length === 0 && openChatIds.length === 0;
  React.useEffect(() => {
    if (
      visible &&
      selected &&
      emptySurface &&
      !autoOpenedRef.current.has(selected.id) &&
      !creating
    ) {
      autoOpenedRef.current.add(selected.id);
      createScratch(selected);
    }
  }, [visible, selected, emptySurface, creating, createScratch]);

  /**
   * Mints one durable, ticketless chat Session on `project` and puts its tab in
   * front, through the same boot guard the terminal path uses: one create per
   * project at a time, none at all into a project the renderer has stopped
   * tracking. No executor is passed — the plane resolves the project's own
   * runtime preferences when it mounts.
   *
   * The ordinal counts only what is open, because that is all this surface has:
   * a project's ticketless chats have no durable listing here the way a
   * ticket's do.
   */
  const createChat = React.useCallback(
    (project: Project, openChats: number) => {
      void bootChatSession(scratchScope(project.id), {
        title: `Chat ${nextChatOrdinal(0, openChats)}`,
        land: (sessionId) => {
          useChatSessionsStore.getState().openChatTab(project.id, sessionId);
          setSessionsActiveTab(project.id, chatTabId(sessionId));
          return true;
        },
      });
    },
    [setSessionsActiveTab],
  );

  /**
   * Where a file a chat names opens. A ticketless chat has no worktree, so
   * there is no ticket workspace to route it to — Project Files reads the same
   * path out of the project's main checkout, which is where this chat is
   * running. Held across renders because {@link ChatPlane} hands it to every
   * turn on screen: a fresh function here re-renders the whole transcript.
   */
  const openProjectFile = React.useCallback(
    (path: string) => {
      if (selectedId === null) return;
      previewProjectFile(selectedId, path);
      setNav(selectedId, "files");
    },
    [previewProjectFile, selectedId, setNav],
  );

  // ⌘D split, ⌘⌥arrow pane nav, ⌘+/-/0 font size — resolved off the focused
  // pane's data-* attributes, so it is surface-agnostic: the same handler drives
  // scratch panes and ticket panes (the overlay wires it too), routing through
  // the tab's own scope.
  const handleTerminalShortcut = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!event.metaKey || event.ctrlKey || event.repeat) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const paneHost = target.closest<HTMLElement>("[data-terminal-pane-id]");
      const paneId = paneHost?.dataset.terminalPaneId;
      const tabId = paneHost?.dataset.terminalTabId;
      const ownerId = paneHost?.dataset.terminalOwnerId;
      if (!paneId || !tabId || !ownerId) return;
      const tab = useSessionsStore
        .getState()
        .byOwner[ownerId]?.tabs.find((candidate) => candidate.sessionId === tabId);
      if (tab === undefined) return;

      const stop = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.altKey) {
        const direction: TerminalFocusDirection | null =
          event.key === "ArrowLeft"
            ? "left"
            : event.key === "ArrowRight"
              ? "right"
              : event.key === "ArrowUp"
                ? "up"
                : event.key === "ArrowDown"
                  ? "down"
                  : null;
        if (direction === null) return;
        stop();
        const nextPaneId = adjacentPaneId(tab.layout, paneId, direction);
        if (nextPaneId !== null) setActivePane(ownerId, tabId, nextPaneId);
        return;
      }
      if (event.code === "KeyD") {
        stop();
        const direction: TerminalSplitDirection = event.shiftKey ? "horizontal" : "vertical";
        void createTerminalSplit(tab.scope, tabId, paneId, direction);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        stop();
        getEngine(paneId)?.adjustFontSize(1);
        return;
      }
      if (event.key === "-") {
        stop();
        getEngine(paneId)?.adjustFontSize(-1);
        return;
      }
      if (event.key === "0") {
        stop();
        getEngine(paneId)?.resetFontSize();
      }
    },
    [setActivePane],
  );

  return (
    <>
      {/* SCRATCH surface — flow layout, hidden (not unmounted) when Sessions
          isn't the active page. */}
      <div className={cn("flex min-h-0 flex-1 flex-col bg-background", !visible && "hidden")}>
        {selected && (
          <ScratchTabs
            terminalTabs={terminalTabs}
            chatIds={openChatIds}
            activeTabId={activeTabId}
            creating={creating}
            onSelect={(descriptor) => {
              setSessionsActiveTab(selected.id, descriptor.id);
              // A terminal tab is in front on two ledgers: this surface's
              // (recorded) and the terminal container's own, which is what the
              // keep-alive render and pane focus read. A chat has nothing in the
              // second, and never writes it.
              if (descriptor.kind === "terminal") {
                setActiveSession(selected.id, descriptor.tab.sessionId);
              }
            }}
            onClose={(descriptor) => {
              if (descriptor.kind === "chat") {
                // No busy guard and no confirm: the Session is durable, so
                // closing the view loses nothing — reopening it from the sidebar
                // adopts the same history, and the next render re-derives which
                // tab comes forward.
                useChatSessionsStore.getState().closeChatTab(selected.id, descriptor.sessionId);
                return;
              }
              const liveIds = sessionPanes(descriptor.tab.layout)
                .filter((pane) => pane.exitCode === null)
                .map((pane) => pane.sessionId);
              closeGuard.guard(liveIds, () =>
                closeTerminalSession(selected.id, descriptor.tab.sessionId),
              );
            }}
            onRename={(descriptor, title) => {
              // Each kind has its own optimistic surface to move before the
              // durable write — a chat must never reach the PTY rename, which
              // would address a terminal that does not exist.
              if (descriptor.kind === "chat") {
                void renameChatSession(descriptor.sessionId, title);
                return;
              }
              renameTerminalSession(descriptor.tab.sessionId, title);
            }}
            onNewSession={() => createScratch(selected)}
            onNewChat={() => createChat(selected, openChatIds.length)}
          />
        )}

        <div className="relative min-h-0 flex-1" onKeyDownCapture={handleTerminalShortcut}>
          {/* Keep-alive: render every project's scratch split tree; only the
              selected project's active tab is visible, the rest stay mounted. */}
          {Object.entries(byOwner).flatMap(([ownerId, container]) =>
            container.tabs
              .filter((tab) => tab.scope.kind === "scratch")
              .map((tab) => (
                <SessionSplitLayout
                  key={tab.sessionId}
                  ownerId={ownerId}
                  tab={tab}
                  visible={
                    visible &&
                    ownerId === selected?.id &&
                    tab.sessionId === container.activeSessionId &&
                    // A chat plane is `absolute inset-0` over this same box, and
                    // so is every split tree — a terminal left visible under one
                    // would paint straight through it.
                    activeChatSessionId === null
                  }
                  onActivate={(sessionId) => setActivePane(ownerId, tab.sessionId, sessionId)}
                  onSplit={(sessionId, direction) =>
                    void createTerminalSplit(tab.scope, tab.sessionId, sessionId, direction)
                  }
                  onClose={(sessionId) =>
                    closeGuard.guard([sessionId], () =>
                      closeTerminalPane(ownerId, tab.sessionId, sessionId),
                    )
                  }
                  onResize={(splitId, ratio) =>
                    setSplitRatio(ownerId, tab.sessionId, splitId, ratio)
                  }
                />
              )),
          )}

          {/* The chat in front, in a column of its own: the box above is
              positioned, not a flex column, so the plane needs one to fill it.
              Keyed by Session — the client, the fold and the queue are resident
              (chat/registry.ts), so a remount costs nothing and carries
              nothing over. */}
          {selected && activeChatSessionId !== null && (
            <div className="absolute inset-0 flex min-h-0 flex-col">
              <ChatPlane
                key={activeChatSessionId}
                sessionId={activeChatSessionId}
                projectId={selected.id}
                onOpenFile={openProjectFile}
              />
            </div>
          )}

          {selected && emptySurface && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
              <TerminalWindowIcon weight="fill" className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No open sessions.</p>
              {/* The same menu the strip carries — the only control on screen,
                  so it is drawn as one rather than as a bare "+". */}
              <NewSessionMenu
                disabled={creating}
                align="start"
                label={creating ? "Starting…" : "New session"}
                onNewSession={() => createScratch(selected)}
                onNewChat={() => createChat(selected, openChatIds.length)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Resident host for ticket-session terminals — positioned over the ticket
          detail's plane, shown independently of the scratch surface's visibility. */}
      <TicketTerminalOverlay byOwner={byOwner} onShortcut={handleTerminalShortcut} />

      <ConfirmCloseDialog
        pending={closeGuard.pending}
        onConfirm={closeGuard.confirm}
        onCancel={closeGuard.cancel}
      />
    </>
  );
}

/**
 * The strip, and the only place the per-token chat reads live.
 *
 * {@link SessionsLayer} hosts every live terminal in the app and must not
 * re-render on a streamed word; a chat's title and lifecycle move on exactly
 * that. So they are subscribed here, as two primitive-valued reads rather than
 * one that builds descriptors — the same split `ticket-detail.tsx` makes, for
 * the same reason: a selector returning a fresh array of objects re-renders on
 * every folded batch, while shallow equality over strings costs nothing when
 * neither moved.
 */
function ScratchTabs({
  terminalTabs,
  chatIds,
  activeTabId,
  creating,
  onSelect,
  onClose,
  onRename,
  onNewSession,
  onNewChat,
}: {
  terminalTabs: readonly SessionTab[];
  chatIds: readonly string[];
  activeTabId: string | null;
  creating: boolean;
  onSelect(tab: SessionTabDescriptor): void;
  onClose(tab: SessionTabDescriptor): void;
  onRename(tab: SessionTabDescriptor, title: string): void;
  onNewSession(): void;
  onNewChat(): void;
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
    useShallow((state) =>
      chatIds.map((sessionId) => chatTabStatus(state.sessions[sessionId]?.lifecycle)),
    ),
  );
  const tabs: SessionTabDescriptor[] = [
    ...terminalTabs.map(
      (tab): SessionTabDescriptor => ({ kind: "terminal", id: tab.sessionId, tab }),
    ),
    ...chatIds.map(
      (sessionId, index): SessionTabDescriptor => ({
        kind: "chat",
        id: chatTabId(sessionId),
        sessionId,
        title: chatTitles[index] ?? CHAT_TAB_FALLBACK_LABEL,
        status: chatStatuses[index] ?? "idle",
      }),
    ),
  ];

  return (
    <SessionTabs
      tabs={tabs}
      activeTabId={activeTabId}
      creating={creating}
      onSelect={onSelect}
      onClose={onClose}
      onRename={onRename}
      onNewSession={onNewSession}
      onNewChat={onNewChat}
    />
  );
}
