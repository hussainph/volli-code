import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import * as React from "react";
import { useShallow } from "zustand/react/shallow";

import { renameChatSession } from "@renderer/chat/rename";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { NewSessionControl } from "@renderer/components/sessions/new-session-control";
import { SessionTabs, type SessionTabDescriptor } from "@renderer/components/sessions/session-tabs";
import { SessionSplitLayout } from "@renderer/components/sessions/session-split-layout";
import { TicketTerminalOverlay } from "@renderer/components/sessions/ticket-terminal-host";
import {
  createTerminalSplit,
  startScratchChat,
  startScratchTerminal,
} from "@renderer/components/sessions/session-create";
import {
  chatTabId,
  chatTabStatus,
  parseChatTabId,
  CHAT_TAB_FALLBACK_LABEL,
} from "@renderer/components/ticket/ticket-chat-tab";
import { useNewSessionShortcut } from "@renderer/hooks/use-new-session-shortcut";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  hydrateHarnessCatalog,
  sessionPanes,
  subscribeHarnessEvents,
  subscribeSessionHarness,
  useSessionsStore,
  type SessionTab,
  type TerminalSplitDirection,
} from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { subscribeWorktreePhases } from "@renderer/stores/worktree";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { cn } from "@renderer/lib/utils";
import { useCloseGuard } from "@renderer/terminal/close-guard";
import { getEngine } from "@renderer/terminal/registry";
import { adjacentPaneId, type TerminalFocusDirection } from "@renderer/terminal/pane-navigation";
import {
  closeTerminalPane,
  closeTerminalSession,
  renameTerminalSession,
} from "@renderer/terminal/session-lifecycle";

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

  // Projects that already got their one auto-opened structured chat. Marked at
  // attempt time and never cleared — a failure's retry surface is the empty
  // state's "New chat" control, and a user closing their last tab must be able
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

  // ⌘T / ⌥⌘T. Bound here rather than beside the other accelerators in the app
  // shell because this layer is already the app's one always-mounted component
  // — it owns the terminal, harness and worktree fan-outs for the same reason —
  // and because the two things a press has to reach, the scratch boot paths and
  // this surface's active-tab ledger, are exactly what this module owns. One
  // listener, mounted once: a hook per control would count one chord as four
  // Sessions.
  useNewSessionShortcut();

  const createScratch = React.useCallback((projectId: string) => {
    void startScratchTerminal(projectId);
  }, []);

  /**
   * Mints one durable, ticketless chat Session on `projectId` and puts its tab
   * in front. The whole boot lives in `session-create.ts` so this surface's
   * control, the ⌘T chord and the first-visit auto-open below cannot disagree
   * about what a new chat is; no executor is passed — the plane resolves the
   * project's own runtime preferences when it mounts.
   */
  const createChat = React.useCallback((projectId: string) => {
    void startScratchChat(projectId);
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

  // Terminal focus can now land on THIS surface's terminals too, so this surface
  // owes the same invariant a ticket's detail view owes for its own: the target
  // must keep naming the terminal that is actually in front.
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const scratchFocused =
    terminalFocusTarget !== null &&
    terminalFocusTarget.ticketId === null &&
    terminalFocusTarget.projectId === selectedId &&
    terminalFocusTarget.sessionId === activeTabId;
  // A ticket target is enforced at the store layer (`clearTerminalFocusUnlessTicket`)
  // because no single ticket view outlives every ticket. A ticketless one needs no
  // such twin: this layer IS the app's always-mounted owner of the surface, so it
  // can simply watch. Selecting another tab, closing the focused one, switching
  // project, or navigating off Sessions all land here as "no longer in front" —
  // and app-shell, which hides every piece of chrome while a target is set, must
  // never be left holding one around a terminal nobody can see.
  React.useEffect(() => {
    if (terminalFocusTarget === null || terminalFocusTarget.ticketId !== null) return;
    if (visible && scratchFocused) return;
    useUiStore.getState().setTerminalFocusTarget(null);
  }, [terminalFocusTarget, scratchFocused, visible]);

  // The receipt for what was derived, and the only write of it: a tab that
  // closed under the recorded id is answered by re-deriving, never by repairing
  // what was stored.
  React.useEffect(() => {
    if (selectedId === null || activeTabId === recordedActiveTab) return;
    setSessionsActiveTab(selectedId, activeTabId);
  }, [activeTabId, recordedActiveTab, selectedId, setSessionsActiveTab]);

  // Zero-friction first visit: auto-open a structured chat when Sessions is
  // revealed for a project that has never had a Session here — once per
  // project. A chat and not a terminal, because the chat IS the product's own
  // runtime (a ticketless Session runs as a project-Role Session on the main
  // checkout, `agent-runtime/src/prompt.ts`); a terminal is its manual
  // companion, one caret away on the strip's control, never the landing
  // surface. A terminal counts as one: the surface is not empty, and a chat
  // nobody asked for would be an odd thing to find beside it. A fresh profile
  // with no default model refuses the create exactly as an explicit press
  // would — the toast names the setting, and the empty state keeps the retry.
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
      createChat(selected.id);
    }
  }, [visible, selected, emptySurface, creating, createChat]);

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
        {/* The strip steps aside in zen exactly as the ticket's does: the point
            of terminal focus is that the terminal gets every pixel below the
            band, and a strip that stayed would be this surface disagreeing with
            the other one about what "focus" means. */}
        {selected && !scratchFocused && (
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
            onNewSession={() => createScratch(selected.id)}
            onNewChat={() => createChat(selected.id)}
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
            <div className={cn("absolute inset-0", EMPTY_PAGE, "gap-4")}>
              {/* Chat, not a terminal: the control below starts a chat, and the
                  glyph crowning an empty state has to name the thing the button
                  does. */}
              <ChatCircleIcon className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No open sessions.</p>
              {/* The same control the strip carries, drawn solid: it is the only
                  affordance on screen, so it takes the emphasis and says what it
                  does rather than naming a kind among tabs that no longer exist. */}
              <NewSessionControl
                disabled={creating}
                placement="empty"
                align="start"
                shortcuts
                onNewChat={() => createChat(selected.id)}
                onNewTerminal={() => createScratch(selected.id)}
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
