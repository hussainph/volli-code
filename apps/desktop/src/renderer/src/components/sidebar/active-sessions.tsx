import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { errorMessage, type LatestSessionSignal, type Project, type Ticket } from "@volli/shared";

import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@renderer/components/ui/sidebar";
import { isHomeBoardTab } from "@renderer/components/home/home-tabs";
import {
  buildActiveSessionListing,
  groupPreviousByTicket,
  isProjectSessionRowSelected,
  listingOutputStamps,
  type ActiveSessionRow,
  type PreviousSessionRow,
  type SessionRowKind,
} from "@renderer/components/sidebar/active-session-listing";
import {
  DEFAULT_SESSION_BAND_FILTER,
  SessionBandFilterMenu,
  SessionBandHeader,
  type SessionBandFilter,
} from "@renderer/components/sidebar/session-band-header";
import {
  ActiveBandRow,
  PreviousBandRow,
  sessionGroupPanelId,
  TicketGroupRow,
} from "@renderer/components/sidebar/session-band-row";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { delayUntil } from "@renderer/lib/boundary-timer";
import { nextAgeChangeAt } from "@renderer/lib/relative-time";
import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

const EMPTY_TICKETS: readonly Ticket[] = [];
const EMPTY_TICKET_TABS: Record<string, { files: string[]; active: string }> = {};
const EMPTY_STATUS_ENTERED_AT: ReadonlyMap<string, number> = new Map();
const EMPTY_EXPANDED: readonly string[] = [];

/**
 * The nesting rule under a ticket entry, tightened from `SidebarMenuSub`'s
 * stock `mx-4 px-2` — the same call the sidebar's file tree made before it
 * retired (VC-122), and for the same reason: stock spends ~48px a level, which
 * a session row cannot pay out of a title that already truncates. The hairline
 * itself is the primitive's own `border-sidebar-border-veil`, so a nested
 * session is bracketed by the mark that tree taught this sidebar to mean
 * "inside".
 */
const SESSION_GROUP_NEST = "mx-0 ml-2 gap-1 py-0 pr-0 pl-2";

/** Re-indexes the batched durable Session projection for the pure listing model. */
function indexSignalsByTicket(
  signals: readonly LatestSessionSignal[],
): Record<string, LatestSessionSignal> {
  const byTicket: Record<string, LatestSessionSignal> = {};
  for (const signal of signals) {
    byTicket[signal.ticketId] = signal;
  }
  return byTicket;
}

/**
 * The project's sessions, in two bands.
 *
 * **Active** is what is happening: Sessions waiting on a human first, then work
 * running now, then what has gone quiet recently. **Previous** is everything
 * else, one line each, with its own filter.
 *
 * Which band a Session is in, in what order, and when that changes on its own
 * all belong to `buildActiveSessionListing`. This component owns only the four
 * things that model deliberately refuses: fetching, the clock, where a row
 * navigates to, and which row is the one you are looking at.
 *
 * **Nothing here polls.** There are two clocks and both wait on an instant a
 * pure model named: `listingNow` on `listing.nextBoundaryAt`, `ageNow` on the
 * soonest `nextAgeChangeAt` in the Previous band. They are separate because
 * they buy different things — the listing is this sidebar's most expensive
 * derivation and must not rebuild for a stamp that only reads "3m" instead of
 * "2m", and the Previous band is unbounded and must not re-render for a quiet
 * window closing on some other row. A single one-second interval used to serve
 * both and did the union of their work sixty times a minute, forever, for as
 * long as anything anywhere was live.
 */
export function ActiveSessions({ project, visible }: { project: Project; visible: boolean }) {
  const tickets = useBoardStore((state) => state.ticketsByProject[project.id]) ?? EMPTY_TICKETS;
  const planningChange = useBoardStore((state) => state.lastPlanningChange);
  const containers = useSessionsStore((state) => state.byOwner);
  const openChatTabs = useChatSessionsStore((state) => state.openTabs);
  const residentChatTitles = useChatSessionsStore(
    useShallow((state) => {
      const titles: Record<string, string> = {};
      for (const [sessionId, slice] of Object.entries(state.sessions)) {
        const title = slice.projection?.session.title;
        if (title !== null && title !== undefined) titles[sessionId] = title;
      }
      return titles;
    }),
  );
  const parkState = useSessionsStore((state) => state.parkState);
  const harness = useSessionsStore((state) => state.harness);
  const nav = useWorkspaceStore((state) => state.byProject[project.id]?.nav ?? "board");
  const openTicketId = useWorkspaceStore(
    (state) => state.byProject[project.id]?.openTicketId ?? null,
  );
  const ticketTabs = useWorkspaceStore(
    (state) => state.byProject[project.id]?.ticketTabs ?? EMPTY_TICKET_TABS,
  );
  const openTicketWorkspace = useWorkspaceStore((state) => state.openTicketWorkspace);
  const openTicketSession = useWorkspaceStore((state) => state.openTicketSession);
  const openHome = useWorkspaceStore((state) => state.openHome);
  const homeActiveTab = useWorkspaceStore(
    (state) => state.byProject[project.id]?.homeActiveTab ?? DEFAULT_WORKSPACE_UI.homeActiveTab,
  );
  const expandedGroups = useWorkspaceStore(
    (state) => state.byProject[project.id]?.expandedSessionGroups ?? EMPTY_EXPANDED,
  );
  const setSessionGroupExpanded = useWorkspaceStore((state) => state.setSessionGroupExpanded);
  // The project's Session rows, shared with the board's active-session
  // indicator and fed by `volli:session-activity` rather than by a timer —
  // see `stores/project-sessions.ts`. This component used to own both the
  // fetch and a ten-second poll on top of it; what it owns now is when the
  // BASELINE is read, which is still its call because it is the surface that
  // knows a project has come on screen.
  const projectRows =
    useProjectSessionsStore((state) => state.byProject[project.id]) ?? EMPTY_PROJECT_SESSION_ROWS;
  const records = projectRows.terminal;
  const chatSessions = projectRows.chat;
  const refreshProjectSessions = useProjectSessionsStore((state) => state.refresh);
  const [signalsByTicket, setSignalsByTicket] = React.useState<Record<string, LatestSessionSignal>>(
    {},
  );
  const [statusEnteredAt, setStatusEnteredAt] =
    React.useState<ReadonlyMap<string, number>>(EMPTY_STATUS_ENTERED_AT);
  // The clock the LISTING is built against. It advances only when the model
  // says its own answer changes — see the boundary effect below — so between
  // boundaries it is deliberately behind the wall clock, and the listing is
  // deliberately not rebuilt for the difference. That is the whole point: no
  // band, no order and no word in this list can move in that gap.
  const [listingNow, setListingNow] = React.useState(() => Date.now());
  // The clock the Previous band's AGE COLUMN is read against, advanced on the
  // next instant one of those ages reads differently. Nothing else on this
  // surface renders a relative stamp, so nothing else is given it.
  const [ageNow, setAgeNow] = React.useState(() => Date.now());
  // Ephemeral by design: which kinds you are currently looking through is a
  // question about this glance, not a preference. It resets with the window,
  // like every other view-local narrowing in the app.
  const [filter, setFilter] = React.useState<SessionBandFilter>(DEFAULT_SESSION_BAND_FILTER);
  // Bumped to force a re-read on the coarse timer below, without pretending
  // anything about the inputs changed.
  const [refreshTick, setRefreshTick] = React.useState(0);

  const projectTicketIds = React.useMemo(
    () => new Set(tickets.map((ticket) => ticket.id)),
    [tickets],
  );
  /**
   * The output stamps THIS project's listing can read, and no others.
   *
   * `state.lastOutputAt` is one flat map for every live session in the app,
   * replaced wholesale on each bump (about once a second per busy session), so
   * subscribing to the map itself made every project's terminal output a
   * rebuild of this project's bands. `listingOutputStamps` projects it down to
   * the keys the build can name and `useShallow` holds the previous object when
   * those keys are unchanged — the raw numbers ride through untouched, so this
   * narrows the SUBSCRIPTION and not the input.
   */
  const lastOutputAt = useSessionsStore(
    useShallow((state) =>
      listingOutputStamps({
        lastOutputAt: state.lastOutputAt,
        containers: state.byOwner,
        ticketIds: projectTicketIds,
        projectOwnerId: project.id,
      }),
    ),
  );
  // The project's OWN container. The store files every container in one
  // flat map keyed by `ownerKey` — a ticketId for Ticket Sessions, the project
  // id for Project Sessions — and the listing model walks the map by ticket, so
  // this one has to be handed over on its own key or its live tabs are invisible.
  const projectContainer = containers[project.id];
  // Which of this project's Sessions are live on this surface — the key the one
  // fetch below re-reads the durable listing on. Both kinds count: a chat has no
  // PTY pane to name, so a signature made of panes alone left a streaming chat
  // out of every refetch, and its row sat stale until something else moved.
  const liveSignature = React.useMemo(
    () =>
      [
        ...Object.values(containers).flatMap((container) =>
          container.tabs
            .filter(
              (tab) =>
                (tab.scope.kind === "project" && tab.scope.projectId === project.id) ||
                (tab.scope.kind === "ticket" &&
                  tab.scope.projectId === project.id &&
                  projectTicketIds.has(tab.scope.ticketId)),
            )
            .flatMap((tab) => sessionPanes(tab.layout).map((pane) => pane.sessionId)),
        ),
        ...Object.entries(openChatTabs)
          .filter(([ownerId]) => ownerId === project.id || projectTicketIds.has(ownerId))
          .flatMap(([, sessionIds]) => sessionIds),
      ].join(","),
    [containers, openChatTabs, project.id, projectTicketIds],
  );
  const needsReviewIds = React.useMemo(
    () => tickets.filter((ticket) => ticket.status === "needs_review").map((ticket) => ticket.id),
    [tickets],
  );

  // The BASELINE read, and only that. A window that has just opened has missed
  // every push that came before it, so the listing is read once per project and
  // `volli:session-activity` carries it from there — which is why this no longer
  // re-fires on `liveSignature`. A Session coming up IS a durable fact, so the
  // channel announces it; refetching on the same trigger would just race the push
  // to say the same thing. `refreshTick` survives for the one thing the channel
  // genuinely cannot see: rows that changed while this project was off screen
  // because its ticket left the board.
  React.useEffect(() => {
    void refreshProjectSessions(project.id);
  }, [project.id, refreshTick, refreshProjectSessions]);

  // Two of the Previous band's cleanup rules need to know when a ticket entered
  // its CURRENT column, and neither guesses without it — a ticket missing here
  // simply keeps its Sessions. Same triggers as the listing fetch: the rules
  // read a column history that only moves when the board does.
  const statusFetch = useLatestAsync();
  React.useEffect(() => {
    const token = statusFetch.claim();
    window.api.tickets
      .statusEntries({ projectId: project.id })
      .then((result) => {
        if (!statusFetch.isCurrent(token)) return;
        if (!result.ok) {
          toastError(`Couldn't load ticket history: ${result.error}`);
          return;
        }
        setStatusEnteredAt(
          new Map(result.entries.map((entry) => [entry.ticketId, entry.enteredAt])),
        );
      })
      .catch((error: unknown) => {
        if (statusFetch.isCurrent(token))
          toastError(`Couldn't load ticket history: ${errorMessage(error)}`);
      });
    return () => statusFetch.invalidate();
  }, [project.id, liveSignature, refreshTick, statusFetch]);
  /* `liveSignature` still keys the ticket-history read above: a Session coming
     up is usually a ticket about to move columns, and that history has no push
     channel of its own. It no longer keys the SESSION listing — that is pushed. */

  const signalsFetch = useLatestAsync();
  const loadAttentionSignals = React.useCallback(() => {
    const token = signalsFetch.claim();
    if (needsReviewIds.length === 0) {
      setSignalsByTicket({});
      return;
    }
    window.api.tickets
      .latestSignals({ projectId: project.id })
      .then((result) => {
        if (!signalsFetch.isCurrent(token)) return;
        if (!result.ok) {
          toastError(`Couldn't load session attention: ${result.error}`);
          return;
        }
        setSignalsByTicket(indexSignalsByTicket(result.signals));
      })
      .catch((error: unknown) => {
        if (signalsFetch.isCurrent(token))
          toastError(`Couldn't load session attention: ${errorMessage(error)}`);
      });
  }, [needsReviewIds, project.id, signalsFetch]);

  // Two triggers, deduped to at most one fetch per render:
  //   • the needs-review SET changed (a ticket entered/left the column) → always
  //     reload, since the set of tickets whose signals we show is different now;
  //   • a planning refresh whose scope is untargeted OR names a ticket we're
  //     already showing → reload; a refresh for any OTHER ticket can't touch our
  //     attention rows, so skip it.
  // Tracking both previous values (rather than two effects) stops a refresh that
  // ALSO moved the set from firing the reload twice. The ids ref starts `null` so
  // the first run always loads (mount), whatever the initial version.
  const seenNeedsReviewIds = React.useRef<readonly string[] | null>(null);
  const seenPlanningVersion = React.useRef(planningChange.version);
  React.useEffect(() => {
    const idsChanged = seenNeedsReviewIds.current !== needsReviewIds;
    const versionChanged = seenPlanningVersion.current !== planningChange.version;
    seenNeedsReviewIds.current = needsReviewIds;
    seenPlanningVersion.current = planningChange.version;
    if (idsChanged) {
      loadAttentionSignals();
      return;
    }
    if (!versionChanged) return;
    if (planningChange.ticketId !== null && !needsReviewIds.includes(planningChange.ticketId)) {
      return;
    }
    loadAttentionSignals();
  }, [needsReviewIds, planningChange, loadAttentionSignals]);

  // There is no poll here any more — `volli:session-activity` pushes a Session's
  // row the moment its history moves, whether this section is on screen or not,
  // so nothing goes stale behind another page and nothing has to be caught up on
  // return. What survives is ONE re-read when the section comes back into view,
  // for the facts the Session channel genuinely cannot announce: the two Previous
  // cleanup rules read a ticket's column history, which moves on the board rather
  // than in the ledger. The ref starts true so the mount fetch is not doubled.
  const syncListingClocks = React.useCallback(() => {
    const now = Date.now();
    setListingNow(now);
    setAgeNow(now);
  }, []);
  const wasVisible = React.useRef(true);
  React.useEffect(() => {
    if (!visible) {
      wasVisible.current = false;
      return;
    }
    if (!wasVisible.current) {
      // A hidden Electron window may throttle or suspend timers. Refreshing the
      // durable rows on return without also refreshing the listing clock can
      // leave an idle chat in Active until some unrelated state change lands.
      syncListingClocks();
      setRefreshTick((tick) => tick + 1);
    }
    wasVisible.current = true;
  }, [syncListingClocks, visible]);
  // Window activation is a second return path: the nav can remain on the same
  // page while macOS suspends the renderer behind another window or a sleep.
  React.useEffect(() => {
    window.addEventListener("focus", syncListingClocks);
    return () => window.removeEventListener("focus", syncListingClocks);
  }, [syncListingClocks]);

  // The sidebar's durable read catches chats started outside this renderer.
  // A resident title overlays it immediately, so the first exchange does not
  // leave this surface behind the tab until its next activity refresh.
  const titledChatSessions = React.useMemo(
    () =>
      chatSessions.map((record) => ({
        ...record,
        title: residentChatTitles[record.sessionId] ?? record.title,
      })),
    [chatSessions, residentChatTitles],
  );

  const listing = React.useMemo(
    () =>
      buildActiveSessionListing({
        tickets,
        containers,
        projectContainer,
        signalsByTicket,
        records,
        chatSessions: titledChatSessions,
        lastOutputAt,
        parkState,
        harness,
        statusEnteredAt,
        filter: {
          kinds: new Set(
            (["chat", "terminal"] as const).filter((kind) => filter.kinds[kind]),
          ) satisfies ReadonlySet<SessionRowKind>,
          showCleaned: filter.showCleaned,
        },
        now: listingNow,
      }),
    [
      tickets,
      containers,
      projectContainer,
      signalsByTicket,
      records,
      titledChatSessions,
      lastOutputAt,
      parkState,
      harness,
      statusEnteredAt,
      filter,
      listingNow,
    ],
  );

  /**
   * The Previous band as it is DRAWN: one entry per ticket, plus the ticketless
   * sessions that have no ticket to sit under. Purely a rearrangement of
   * `listing.previous` — which rows survive and what order they are in was
   * settled by the builder above and cannot be changed here (VC-69).
   */
  const previousEntries = React.useMemo(
    () => groupPreviousByTicket(listing.previous),
    [listing.previous],
  );

  /**
   * The model's own answer to "when does this list change with no new input" —
   * a row ageing out of Active, a cleanup rule newly firing, a working row
   * going quiet, a hooked launch running out of grace. It is the ONLY thing
   * that advances `listingNow`, which is what makes the expensive derivation
   * event-driven rather than polled: between two boundaries nothing about the
   * answer can move, so nothing recomputes it.
   *
   * Re-armed on every rebuild; if the boundary does not move after firing, the
   * dependency does not change and the timer does not re-arm, which is what
   * keeps this from spinning.
   */
  const nextBoundaryAt = listing.nextBoundaryAt;
  React.useEffect(() => {
    if (nextBoundaryAt === null) return;
    const timer = window.setTimeout(() => setListingNow(Date.now()), delayUntil(nextBoundaryAt));
    return () => window.clearTimeout(timer);
  }, [nextBoundaryAt]);

  /**
   * The same trick for every visible age column. Active rows now carry their
   * own last-activity age; the listing itself still does not depend on this
   * clock, so a minute tick refreshes labels without rebuilding its ordering.
   *
   * A band whose newest row is minutes old wakes about once a minute; one whose
   * rows are all days old wakes about once a day. An interval could not tell
   * those apart, so it would have had to run at the finest step anything might
   * be showing — and the reason the band is worth this care is that its length
   * is unbounded by design.
   */
  const nextAgeChange = React.useMemo(() => {
    let soonest: number | null = null;
    for (const row of listing.previous) {
      // 0 is the model's "nothing durable can date this" sentinel; those rows
      // draw no age, so they have no boundary. Matches `PreviousBandRow`.
      if (row.endedOrQuietAt <= 0) continue;
      const at = nextAgeChangeAt(row.endedOrQuietAt, ageNow);
      if (soonest === null || at < soonest) soonest = at;
    }
    for (const row of listing.active) {
      if (row.lastActivityAt === null || row.lastActivityAt <= 0) continue;
      const at = nextAgeChangeAt(row.lastActivityAt, ageNow);
      if (soonest === null || at < soonest) soonest = at;
    }
    return soonest;
  }, [listing.active, listing.previous, ageNow]);
  // `ageNow` is a dependency as well as an input, which the listing's boundary
  // above deliberately is not. That one can never be clamped (its furthest
  // instant is seven days out), so a wake it does not move is a wake nothing
  // needed. This one can: a wake at `boundary-timer.ts`'s clamp lands with the
  // same boundary still ahead of it, and keying the effect on the boundary alone
  // would then re-render, recompute the same instant, and quietly arm nothing.
  React.useEffect(() => {
    if (nextAgeChange === null) return;
    const timer = window.setTimeout(() => setAgeNow(Date.now()), delayUntil(nextAgeChange));
    return () => window.clearTimeout(timer);
  }, [nextAgeChange, ageNow]);

  // Which ticket the main view is actually SHOWING. Ticket detail renders only
  // from Home's BOARD TAB, and leaving for Files, Configure or one of Home's own
  // Session tabs deliberately keeps `openTicketId` set so returning lands where
  // you were — so a remembered ticket is not a ticket on screen, and only one of
  // those can light a row.
  const shownTicketId = nav === "home" && isHomeBoardTab(homeActiveTab) ? openTicketId : null;
  const activeTabId =
    shownTicketId === null ? null : (ticketTabs[shownTicketId]?.active ?? TICKET_BODY_TAB_ID);

  /**
   * Selected means one thing: this row's Session is the tab in front of you.
   *
   * Not "its ticket is open". That was the rule, via a fallback for rows with
   * no tab to name, and it lit every row a ticket had at once — open a ticket
   * with three past Sessions and all three claimed to be where you are, which
   * is worse than no highlight at all. A row with no target is a Session whose
   * tab is gone; it is never the tab in front of you.
   */
  const isSelected = (row: ActiveSessionRow | PreviousSessionRow): boolean =>
    isProjectSessionRowSelected(row, nav === "home", projectContainer, homeActiveTab) ||
    (row.ticket !== null &&
      shownTicketId === row.ticket.id &&
      row.target !== null &&
      activeTabId === row.target.tabId);

  /**
   * The ticket entry holding the Session in front of you, when the Previous
   * band is where that Session ended up.
   *
   * Asks {@link isSelected} rather than restating what makes a row current: a
   * second copy of that predicate is how the group's mark and the row's own
   * highlight would come to disagree about the same tab.
   */
  let selectedGroupId: string | null = null;
  for (const entry of previousEntries) {
    if (entry.kind !== "ticket" || !entry.rows.some(isSelected)) continue;
    selectedGroupId = entry.id;
    break;
  }

  /**
   * Open that group. Rows arrive in this band ON THEIR OWN — a Session ages out
   * of Active once its quiet window runs out, with nobody touching it — and
   * `openTicketId`/`ticketTabs` are persisted while `expandedSessionGroups`
   * deliberately is not. So without this, the tab you are looking at slides
   * behind a closed disclosure half an hour after you last typed in it, and is
   * behind one again on the first frame after every relaunch, with nothing in
   * the sidebar marking where you are. Collapsed by default is the band's
   * steady state; it was never meant to hide the thing in front of you.
   *
   * Keyed on the group id alone, so it fires when the selection MOVES rather
   * than on every rebuild of the band — which is what lets a reader close the
   * revealed group by hand and have it stay closed until they go somewhere else
   * and come back.
   */
  React.useEffect(() => {
    if (selectedGroupId === null) return;
    setSessionGroupExpanded(project.id, selectedGroupId, true);
  }, [selectedGroupId, project.id, setSessionGroupExpanded]);

  /**
   * Where a row goes. A ticketed row reopens its exact session, or failing that
   * its ticket workspace.
   *
   * A TICKETLESS row has no ticket workspace to open — both terminal and chat
   * targets land on HOME instead, through `openHome`, which switches the page
   * and names the tab in one write. That seam deliberately leaves `openTicketId`
   * alone: a Home Session tab is its own place and keeps the ticket remembered
   * behind it (VC-54 decision 1), so reaching a chat from here never costs you
   * the ticket you were in. A ticketless chat is additionally adopted and given
   * a tab under the project's owner key, the same two calls the ticketed chat
   * case below makes — the tab has to exist before the strip can put it in
   * front.
   *
   * Stable across renders, and handed to every row AS IS rather than wrapped in
   * a per-row closure: both band rows are memoised, and a fresh handler per row
   * per render is exactly the prop that would make that memo do nothing. Its
   * dependencies are store actions and one id, none of which move.
   */
  /**
   * Opens or closes one ticket's group. Stable, and handed to every entry AS IS
   * for the same reason `activate` is: `TicketGroupRow` is memoised, and a
   * fresh `() => toggle(id)` per entry per render is exactly the prop that
   * would make that memo do nothing — so the row hands its own ticket id back.
   */
  const toggleGroup = React.useCallback(
    (ticketId: string) => {
      const open = useWorkspaceStore
        .getState()
        .byProject[project.id]?.expandedSessionGroups.includes(ticketId);
      setSessionGroupExpanded(project.id, ticketId, open !== true);
    },
    [project.id, setSessionGroupExpanded],
  );

  const activate = React.useCallback(
    (row: ActiveSessionRow | PreviousSessionRow) => {
      const ticket = row.ticket;
      if (ticket === null) {
        const target = row.target;
        if (target?.kind === "terminal") {
          const sessions = useSessionsStore.getState();
          sessions.setActiveSession(project.id, target.tabId);
          sessions.setActivePane(project.id, target.tabId, target.paneId);
          openHome(project.id, target.tabId);
        } else if (target?.kind === "chat") {
          const chat = useChatSessionsStore.getState();
          chat.adoptChatSession(target.sessionId);
          chat.openChatTab(project.id, target.sessionId);
          openHome(project.id, target.tabId);
        } else {
          // No target at all — a Session whose tab is gone. Home is still where
          // it would live, so go there and leave the strip as it was.
          openHome(project.id);
        }
        return;
      }
      const target = row.target;
      if (target === null) {
        openTicketWorkspace(project.id, ticket.id);
        return;
      }
      if (target.kind === "chat") {
        // The two store calls the ticket rail's own chat row makes, for the same
        // reason: a chat the strip has no tab for is not reachable by activating
        // its id — the activation falls back to the Ticket Body. `adoptChatSession`
        // is idempotent, so a chat already in front takes this path too.
        const chat = useChatSessionsStore.getState();
        chat.adoptChatSession(target.sessionId);
        chat.openChatTab(ticket.id, target.sessionId);
        openTicketWorkspace(project.id, ticket.id, { tabId: target.tabId });
        return;
      }
      openTicketSession(project.id, ticket.id, target.tabId, target.paneId);
    },
    [project.id, openHome, openTicketSession, openTicketWorkspace],
  );

  return (
    <>
      <SidebarGroup data-session-band="active" className="gap-1">
        <SessionBandHeader label="Active" count={listing.active.length} />
        {listing.active.length === 0 ? (
          <p className={EMPTY_INLINE}>No active sessions</p>
        ) : (
          <SidebarMenu>
            {listing.active.map((row) => (
              <ActiveBandRow
                key={row.id}
                row={row}
                ticketPrefix={project.ticketPrefix}
                now={ageNow}
                selected={isSelected(row)}
                onSelect={activate}
              />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroup>

      <SidebarGroup data-session-band="previous" className="gap-1 pt-0">
        {/* The count stays the number of SESSIONS, not of entries. It is the
            band's answer to "how much is back there", and collapsing the rows
            under their tickets must not make that number shrink. */}
        <SessionBandHeader label="Previous" count={listing.previous.length}>
          <SessionBandFilterMenu filter={filter} onChange={setFilter} />
        </SessionBandHeader>
        {previousEntries.length === 0 ? (
          <p className={EMPTY_INLINE}>Nothing yet</p>
        ) : (
          <SidebarMenu>
            {previousEntries.map((entry) =>
              entry.kind === "session" ? (
                <PreviousBandRow
                  key={entry.id}
                  row={entry.row}
                  ticketPrefix={project.ticketPrefix}
                  now={ageNow}
                  selected={isSelected(entry.row)}
                  onSelect={activate}
                />
              ) : (
                <SidebarMenuItem key={entry.id}>
                  <TicketGroupRow
                    ticket={entry.ticket}
                    ticketPrefix={project.ticketPrefix}
                    count={entry.rows.length}
                    newestAt={entry.newestAt}
                    now={ageNow}
                    open={expandedGroups.includes(entry.id)}
                    selected={entry.id === selectedGroupId}
                    onToggle={toggleGroup}
                  />
                  {expandedGroups.includes(entry.id) ? (
                    <SidebarMenuSub
                      id={sessionGroupPanelId(entry.id)}
                      className={SESSION_GROUP_NEST}
                    >
                      {entry.rows.map((row) => (
                        <PreviousBandRow
                          key={row.id}
                          row={row}
                          ticketPrefix={project.ticketPrefix}
                          now={ageNow}
                          selected={isSelected(row)}
                          onSelect={activate}
                          // The id is what the reader just expanded; repeating
                          // it on every child costs ink and ~45px of title.
                          showIdentity={false}
                        />
                      ))}
                    </SidebarMenuSub>
                  ) : null}
                </SidebarMenuItem>
              ),
            )}
          </SidebarMenu>
        )}
      </SidebarGroup>
    </>
  );
}
