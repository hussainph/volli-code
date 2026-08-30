import * as React from "react";

import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { SessionSplitLayout } from "@renderer/components/sessions/session-split-layout";
import {
  TerminalViewportBox,
  useTerminalViewports,
} from "@renderer/components/sessions/terminal-viewport-box";
import { TicketTerminalOverlay } from "@renderer/components/sessions/ticket-terminal-host";
import { paneIdForElement } from "@renderer/components/split/split-view-grid";
import { createTerminalSplit } from "@renderer/components/sessions/session-create";
import { useNewSessionShortcut } from "@renderer/hooks/use-new-session-shortcut";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import {
  hydrateHarnessCatalog,
  subscribeHarnessEvents,
  subscribeSessionHarness,
  useSessionsStore,
  type TerminalSplitDirection,
} from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { subscribeProjectSessionActivity } from "@renderer/stores/project-sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { subscribeWorktreePhases } from "@renderer/stores/worktree";
import { cn } from "@renderer/lib/utils";
import { useCloseGuard } from "@renderer/terminal/close-guard";
import { getEngine } from "@renderer/terminal/registry";
import { adjacentPaneId, type TerminalFocusDirection } from "@renderer/terminal/pane-navigation";
import { closeTerminalPane } from "@renderer/terminal/session-lifecycle";

interface SessionsLayerProps {
  /**
   * Home's own plane box is in front — as against a ticket workspace that has
   * taken Home over, or another nav page. The layer stays MOUNTED regardless;
   * this only toggles the box's visibility. Ticket terminals it also hosts are
   * shown independently, overlaid on the ticket's own panes, even while this is
   * hidden — so no live terminal is ever unmounted incidentally.
   *
   * Since VC-202 the Board rides inside Home's plane too (it is the primary
   * pane's permanent tab), so this no longer stands down for it: what the box
   * holds is whatever Home's split grid draws.
   */
  visible: boolean;
  /**
   * The tabs Home is actually SHOWING — one per pane of its split view,
   * resolved once by `home-surface.tsx` and handed down (two surfaces render
   * off the same answer and a frame of disagreement would leave the user
   * looking at nothing; see `home-tabs.ts`).
   *
   * A list rather than the single active tab because a split surface shows
   * several at once, and the one question this layer asks of it — may terminal
   * focus still be held? — means "is that terminal in front in SOME pane".
   */
  visibleTabIds: readonly string[];
  /**
   * Home's right rail, or `null` when it is collapsed (VC-55).
   *
   * A NODE rather than a decision: whether Home shows a rail is Home's call and
   * lives in `home-surface.tsx` with the rest of that composition, but the BOX
   * it stands in is this layer's — the panes are the row's other half, and a
   * rail composed one level up would either wrap this layer (hiding the ticket
   * terminal overlay it also hosts) or float over the panes it is meant to
   * narrow. Same seam the ticket rail's own navigators arrive through.
   */
  rail?: React.ReactNode;
  /**
   * Home's plane: its split grid, with whatever each pane draws inside it
   * (VC-202). Null only while no project is selected.
   *
   * It arrives as a node for the reason {@link SessionsLayerProps.rail} does,
   * and it stands in the SAME column as the terminals this layer hosts — which
   * is the whole point. Rendered one level up it would need a second row of its
   * own, and the rail would then live at two positions in the tree: React
   * reconciles by POSITION, so every Session↔File switch would unmount and
   * remount `HomeRail` and the Files navigator inside it would lose the folder
   * it was standing in. Opening a file from that navigator would reset it to
   * the project root — the click undoing its own browse.
   */
  plane?: React.ReactNode;
}

/**
 * The always-mounted terminal surface — panes only.
 *
 * It owns EVERY live terminal across ALL projects and tickets (each kept alive
 * via the module engine registry), so switching nav, projects, opening a
 * ticket, or opening Settings only flips CSS visibility — no terminal is ever
 * unmounted incidentally (CLAUDE.md). It is also the app's one component that
 * outlives every surface, which is why the PTY fan-out, both harness channels,
 * the worktree-phase stream, the Session-activity stream, the harness catalog
 * and the ⌘T binding are all mounted here and nowhere else.
 *
 * Two regions: Home's plane — its split grid, handed down as `plane`, with this
 * project's live terminals positioned over whichever pane anchors each of them
 * (VC-202) — beside Home's own rail when the composition one level up hands one
 * down, and the resident {@link TicketTerminalOverlay}, which does the same for
 * a ticket workspace's panes. Both read the one unified store, and both position
 * through the one viewport registry.
 *
 * THE CHAT PLANE used to live here too, `absolute inset-0` over the same box.
 * It moved into Home's pane cells with VC-202, because "the chat covers the
 * plane" stopped being true the moment a surface had more than one: a chat is
 * now one pane's content among several. Its state is registry-resident
 * (@volli/session-presentation), so a remount costs nothing — which is why the
 * chat could move and a terminal could not.
 *
 * THE TAB STRIP used to live inside this file's `hidden` wrapper. It moved to
 * `home-surface.tsx` in VC-54 for one reason: Home's strip has to stay on
 * screen while the BOARD tab is in front, and nothing inside a box that is
 * hidden whenever the panes are can do that. The keep-alive seam itself did not
 * change — every always-mounted subscription below is exactly where it was.
 *
 * THE FIRST-VISIT AUTO-OPEN is gone with it, and that is a decision rather than
 * a casualty: no Session is ever created that nobody asked for. Its Model
 * Access first-run block was not deleted but REHOMED, onto the board's own
 * empty state (`board/board-empty.tsx`) — removing the Sessions page removed
 * the app's only proactive auth surface, and VC-52 shipped deliberately silent.
 */
export function SessionsLayer({ visible, visibleTabIds, rail, plane = null }: SessionsLayerProps) {
  const byOwner = useSessionsStore((state) => state.byOwner);
  const setActivePane = useSessionsStore((state) => state.setActivePane);
  const setSplitRatio = useSessionsStore((state) => state.setSplitRatio);
  const markExited = useSessionsStore((state) => state.markExited);
  const selectedId = useSelectedProject()?.id ?? null;
  // The guard for closing a PANE. Closing a TAB is `home-surface.tsx`'s, which
  // owns the strip; both interpose a confirm before a busy PTY's teardown runs,
  // and only one of them can have a confirm up at a time.
  const closeGuard = useCloseGuard();

  // The single subscription to the shared PTY streams (this layer is always
  // mounted, so it owns the app-wide fan-out for BOTH Project and ticket
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
      // shares the same scope kind (ownerKey never collides project/ticket).
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

  // Structured Session state, pushed. Mounted here for the reason the three
  // above are — but it is worth naming what it replaced: every Session listing
  // used to re-read the whole project on a ten-second timer, because a chat
  // turn opening in main had no way to reach a window. This is that channel
  // (`stores/project-sessions.ts`), and the sidebar's Active band and the
  // board's active-session ring both read what it feeds.
  React.useEffect(() => subscribeProjectSessionActivity(), []);

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
  // and because the two things a press has to reach, the Project-Session boot
  // paths and the surfaces they land on, are exactly what this half of Home
  // owns. One
  // listener, mounted once: a hook per control would count one chord as four
  // Sessions.
  useNewSessionShortcut();

  // Which terminals have a pane to be drawn in, and where. One map for both
  // surfaces (`split/terminal-viewport-registry.ts`); this layer draws the
  // entries its own scope owns and the ticket overlay draws the rest.
  const viewports = useTerminalViewports();

  // Terminal focus can land on THIS surface's terminals too, so this surface
  // owes the same invariant a ticket's detail view owes for its own: the target
  // must keep naming a terminal that is actually in front. With panes, "in
  // front" means in front IN SOME PANE — zen mode is entered from one pane of
  // several and must not be cleared by the pane beside it.
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const projectSessionFocused =
    terminalFocusTarget !== null &&
    terminalFocusTarget.ticketId === null &&
    terminalFocusTarget.projectId === selectedId &&
    visibleTabIds.includes(terminalFocusTarget.sessionId);
  // A ticket target is enforced at the store layer (`clearTerminalFocusUnlessTicket`)
  // because no single ticket view outlives every ticket. A ticketless one needs no
  // such twin: this layer IS the app's always-mounted owner of the surface, so it
  // can simply watch. Selecting another Home tab (the Board included), closing the
  // focused one, switching project, or navigating off Home all land here as "no
  // longer in front" — and app-shell, which hides every piece of chrome while a
  // target is set, must never be left holding one around a terminal nobody can see.
  React.useEffect(() => {
    if (terminalFocusTarget === null || terminalFocusTarget.ticketId !== null) return;
    if (visible && projectSessionFocused) return;
    useUiStore.getState().setTerminalFocusTarget(null);
  }, [terminalFocusTarget, projectSessionFocused, visible]);

  // ⌘D split, ⌘⌥arrow pane nav, ⌘+/-/0 font size — resolved off the focused
  // pane's data-* attributes, so it is surface-agnostic: the same handler drives
  // Project Session panes and ticket panes (the overlay wires it too), routing
  // through the tab's own scope.
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
      {/* Home's plane and, beside it, Home's rail. Flow layout, hidden (not
          unmounted) when a ticket workspace has taken Home over or another page
          is in front. The row is the outer box so the rail narrows what is in
          the column rather than covering it, and it is the ONE place the rail is
          rendered from: see `plane` on the props for what a second position
          would cost. */}
      <div className={cn("flex min-h-0 flex-1", !visible && "hidden")}>
        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background"
          onKeyDownCapture={handleTerminalShortcut}
        >
          {/* Keep-alive: render every project's Project-Session split tree, and
              position each over the pane that published an anchor for it. A tab
              no pane is showing keeps its box hidden and its engine alive —
              which is the same statement `visible` makes to the tree inside. */}
          {Object.entries(byOwner).flatMap(([ownerId, container]) =>
            container.tabs
              .filter((tab) => tab.scope.kind === "project")
              .map((tab) => {
                const published = viewports.get(tab.sessionId);
                const anchor = published?.ownerId === ownerId ? published.anchor : null;
                return (
                  <TerminalViewportBox
                    key={tab.sessionId}
                    anchor={anchor}
                    // The pane-focus half of a click into this terminal: the box
                    // is a positioned sibling of Home's grid, so the cell's own
                    // capture never sees it (validation V1). The climb starts
                    // from the ANCHOR, which lives inside the pane's cell; a
                    // hidden box has no anchor and cannot be clicked, and while
                    // unsplit the action is an identity write — so firing
                    // unconditionally is safe.
                    onPointerDownCapture={() => {
                      const paneId = paneIdForElement(anchor);
                      if (paneId !== null) {
                        useWorkspaceStore.getState().focusHomePane(ownerId, paneId);
                      }
                    }}
                  >
                    <SessionSplitLayout
                      ownerId={ownerId}
                      tab={tab}
                      visible={anchor !== null}
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
                  </TerminalViewportBox>
                );
              }),
          )}

          {/* In flow under the terminal boxes, which are positioned over the
              anchors this grid publishes rather than covering the whole column. */}
          {plane}
        </div>
        {rail}
      </div>

      {/* Resident host for ticket-session terminals — positioned over the ticket
          detail's plane, shown independently of the panes' own visibility. */}
      <TicketTerminalOverlay byOwner={byOwner} onShortcut={handleTerminalShortcut} />

      <ConfirmCloseDialog
        pending={closeGuard.pending}
        onConfirm={closeGuard.confirm}
        onCancel={closeGuard.cancel}
      />
    </>
  );
}
