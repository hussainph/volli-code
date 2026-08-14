import * as React from "react";
import {
  errorMessage,
  type ChatSessionRecord,
  type LatestSessionSignal,
  type Project,
  type SessionRecord,
  type Ticket,
} from "@volli/shared";

import { SidebarGroup, SidebarMenu } from "@renderer/components/ui/sidebar";
import {
  buildActiveSessionListing,
  isScratchRowSelected,
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
import { ActiveBandRow, PreviousBandRow } from "@renderer/components/sidebar/session-band-row";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";

const EMPTY_TICKETS: readonly Ticket[] = [];
const EMPTY_TICKET_TABS: Record<string, { files: string[]; active: string }> = {};
const EMPTY_STATUS_ENTERED_AT: ReadonlyMap<string, number> = new Map();

/**
 * How often the durable listing is re-read while this section is on screen.
 *
 * Chat activity changes in MAIN — a turn starting, a question being asked —
 * and there is no push channel for it: `onHarnessChange` announces a terminal's
 * harness and nothing else, and the fetch below is keyed on which Sessions are
 * live, which does not move when a live chat merely changes what it is doing.
 * So a chat row's word would sit stale until something else happened to
 * refetch. Ten seconds is chosen against the reader, not the data: it is
 * roughly how long a glance at the sidebar can be wrong before the wrongness
 * is what you notice. Replace it with a subscription the moment main grows one.
 */
const CHAT_ACTIVITY_REFRESH_MS = 10_000;

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
 */
export function ActiveSessions({ project, visible }: { project: Project; visible: boolean }) {
  const tickets = useBoardStore((state) => state.ticketsByProject[project.id]) ?? EMPTY_TICKETS;
  const planningChange = useBoardStore((state) => state.lastPlanningChange);
  const containers = useSessionsStore((state) => state.byOwner);
  const openChatTabs = useChatSessionsStore((state) => state.openTabs);
  const lastOutputAt = useSessionsStore((state) => state.lastOutputAt);
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
  const setNav = useWorkspaceStore((state) => state.setNav);
  const setSessionsActiveTab = useWorkspaceStore((state) => state.setSessionsActiveTab);
  const sessionsActiveTab = useWorkspaceStore(
    (state) => state.byProject[project.id]?.sessionsActiveTab ?? null,
  );
  const [records, setRecords] = React.useState<SessionRecord[]>([]);
  const [chatSessions, setChatSessions] = React.useState<ChatSessionRecord[]>([]);
  const [signalsByTicket, setSignalsByTicket] = React.useState<Record<string, LatestSessionSignal>>(
    {},
  );
  const [statusEnteredAt, setStatusEnteredAt] =
    React.useState<ReadonlyMap<string, number>>(EMPTY_STATUS_ENTERED_AT);
  const [now, setNow] = React.useState(() => Date.now());
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
  // The project's SCRATCH container. The store files every container in one
  // flat map keyed by `ownerKey` — a ticketId for ticket Sessions, the project
  // id for scratch ones — and the listing model walks the map by ticket, so
  // this one has to be handed over on its own key or its live tabs are invisible.
  const scratchContainer = containers[project.id];
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
                (tab.scope.kind === "scratch" && tab.scope.projectId === project.id) ||
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

  const sessionsFetch = useLatestAsync();
  React.useEffect(() => {
    const token = sessionsFetch.claim();
    window.api.sessions
      .list({ projectId: project.id })
      .then((result) => {
        if (!sessionsFetch.isCurrent(token)) return;
        if (!result.ok) {
          toastError(`Couldn't load active sessions: ${result.error}`);
          return;
        }
        setRecords(result.sessions.flatMap((row) => (row.kind === "terminal" ? [row.record] : [])));
        setChatSessions(
          result.sessions.flatMap((row) => (row.kind === "chat" ? [row.record] : [])),
        );
      })
      .catch((error: unknown) => {
        if (sessionsFetch.isCurrent(token))
          toastError(`Couldn't load active sessions: ${errorMessage(error)}`);
      });
    return () => sessionsFetch.invalidate();
  }, [project.id, liveSignature, refreshTick, sessionsFetch]);

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

  // A session's harness can change without its PTYs changing at all — quitting
  // opencode and starting claude in the same shell is one terminal, one live
  // pane, one signature. The refetch above is keyed on `liveSignature`, so it
  // never fires for that switch; patch the record the announce names instead,
  // or the row keeps naming the harness the session was launched with.
  React.useEffect(
    () =>
      window.api.sessions.onHarnessChange((notice) => {
        setRecords((current) =>
          current.map((record) =>
            record.id === notice.sessionId
              ? { ...record, activeHarnessId: notice.harnessId }
              : record,
          ),
        );
      }),
    [],
  );

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

  // The relative stamps on live rows ("Working", "2m"), which only move while
  // something is live. Nothing live, no interval.
  React.useEffect(() => {
    if (liveSignature === "") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [liveSignature]);

  // See CHAT_ACTIVITY_REFRESH_MS: main has no push channel for chat activity,
  // and this section is render-hidden rather than unmounted across nav
  // switches, so `visible` is what stops it polling behind another page — and
  // what triggers an immediate re-read on return, so coming back from Files
  // never shows minutes-stale activity for up to another poll interval. The ref
  // starts true so the mount fetch is not doubled.
  const wasVisible = React.useRef(true);
  React.useEffect(() => {
    if (!visible) {
      wasVisible.current = false;
      return;
    }
    if (!wasVisible.current) setRefreshTick((tick) => tick + 1);
    wasVisible.current = true;
    const timer = window.setInterval(
      () => setRefreshTick((tick) => tick + 1),
      CHAT_ACTIVITY_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [visible]);

  const listing = React.useMemo(
    () =>
      buildActiveSessionListing({
        tickets,
        containers,
        scratchContainer,
        signalsByTicket,
        records,
        chatSessions,
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
        now,
      }),
    [
      tickets,
      containers,
      scratchContainer,
      signalsByTicket,
      records,
      chatSessions,
      lastOutputAt,
      parkState,
      harness,
      statusEnteredAt,
      filter,
      now,
    ],
  );

  // The model's own answer to "when does this list change with no new input" —
  // a row ageing out of Active, a cleanup rule newly firing. The one-second
  // interval above is gated on something being live, so without this a band
  // boundary in a quiet project would never arrive. Re-armed on every rebuild;
  // if the boundary does not move after firing, the dependency does not change
  // and the timer does not re-arm, which is what keeps this from spinning.
  const nextBoundaryAt = listing.nextBoundaryAt;
  React.useEffect(() => {
    if (nextBoundaryAt === null) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, nextBoundaryAt - Date.now()) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [nextBoundaryAt]);

  // Which ticket the main view is actually SHOWING. Ticket detail renders only
  // under the Board nav, and leaving for Sessions or Files deliberately keeps
  // `openTicketId` set so returning lands where you were — so a remembered
  // ticket is not a ticket on screen, and only one of those can light a row.
  const shownTicketId = nav === "board" ? openTicketId : null;
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
    isScratchRowSelected(row, nav === "sessions", scratchContainer, sessionsActiveTab) ||
    (row.ticket !== null &&
      shownTicketId === row.ticket.id &&
      row.target !== null &&
      activeTabId === row.target.tabId);

  /**
   * Where a row goes. A ticketed row reopens its exact session, or failing that
   * its ticket workspace.
   *
   * A TICKETLESS row has no ticket workspace to open — both terminal and chat
   * targets land on the project's Sessions page instead, naming their tab in
   * `sessionsActiveTab` (workspace.ts), which that page's strip reads to bring
   * it forward. A ticketless chat is additionally adopted and given a tab under
   * the project's owner key, the same two calls the ticketed chat case below
   * makes — the tab has to exist before the strip can put it in front.
   */
  const activate = (row: ActiveSessionRow | PreviousSessionRow) => {
    const ticket = row.ticket;
    if (ticket === null) {
      const target = row.target;
      if (target?.kind === "terminal") {
        const sessions = useSessionsStore.getState();
        sessions.setActiveSession(project.id, target.tabId);
        sessions.setActivePane(project.id, target.tabId, target.paneId);
        setSessionsActiveTab(project.id, target.tabId);
      } else if (target?.kind === "chat") {
        const chat = useChatSessionsStore.getState();
        chat.adoptChatSession(target.sessionId);
        chat.openChatTab(project.id, target.sessionId);
        setSessionsActiveTab(project.id, target.tabId);
      }
      setNav(project.id, "sessions");
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
  };

  return (
    <>
      <SidebarGroup data-session-band="active" className="gap-1">
        <SessionBandHeader label="Active" count={listing.active.length} />
        {listing.active.length === 0 ? (
          <p className="px-2 py-1 text-ui text-muted-foreground">No active sessions</p>
        ) : (
          <SidebarMenu>
            {listing.active.map((row) => (
              <ActiveBandRow
                key={row.id}
                row={row}
                ticketPrefix={project.ticketPrefix}
                selected={isSelected(row)}
                onSelect={() => activate(row)}
              />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroup>

      <SidebarGroup data-session-band="previous" className="gap-1 pt-0">
        <SessionBandHeader label="Previous" count={listing.previous.length}>
          <SessionBandFilterMenu filter={filter} onChange={setFilter} />
        </SessionBandHeader>
        {listing.previous.length === 0 ? (
          <p className="px-2 py-1 text-ui text-muted-foreground">Nothing yet</p>
        ) : (
          <SidebarMenu>
            {listing.previous.map((row) => (
              <PreviousBandRow
                key={row.id}
                row={row}
                ticketPrefix={project.ticketPrefix}
                now={now}
                selected={isSelected(row)}
                onSelect={() => activate(row)}
              />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroup>
    </>
  );
}
