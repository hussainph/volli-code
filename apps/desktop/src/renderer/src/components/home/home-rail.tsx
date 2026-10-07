/**
 * Home's right rail — the ticket workspace's Calm Stack one scope up (VC-55).
 *
 * WHY IT EXISTS. The empty chat answers "where does this Session run" only
 * while it is empty, which is exactly as long as it takes to type one message.
 * Everything after that is a transcript, and nothing on the surface said which
 * directory the agent was writing to. This is the mid-session answer, and it is
 * the same ⌥⌘B panel the ticket workspace has — parity rather than a new idea,
 * because Home and a ticket workspace are the same object at two scopes.
 *
 * THREE PAGES, scoped to the Main checkout and the project's own work:
 *
 *  • **Now** — the project's own Board Session roster, and nothing else. One
 *    block: the door back to any Session started on this project, searchable,
 *    with what is over folded under it.
 *  • **Files** — the Main checkout navigator. It opens preview/pinned File tabs
 *    in Home rather than sending the whole app to a separate nav page.
 *  • **Search** — find across the same Main checkout (VC-193). The same page
 *    the ticket rail draws, at this scope: one component, two scopes, exactly
 *    as the two file navigators are one navigator.
 *
 * …AND TWO PINNED FOOTERS UNDER THEM. Cost (Now's alone) and the Main checkout
 * (under every page), each one row whose body folds open above it. This is the
 * Ticket rail's own composition at Home's scope, and the reason is the same:
 * these are the two things on the rail that are GLANCED at rather than worked
 * in, and a glance that scrolls away with the page is a glance you have to go
 * looking for.
 *
 * THE ROSTER USED TO BE A FOURTH PAGE, and losing it is the user-selected
 * change in this revision. Now described the Session in FRONT and the page
 * beside it listed the Sessions there ARE — one question, split across two
 * tabs, so "what is running on this project" was answerable only by someone
 * who already knew which half they wanted. It is the Now page now, exactly as
 * the Ticket rail's roster is the block on its Now, and the pill is three
 * pages at both scopes' resting width.
 *
 * WHAT NOW NO LONGER DRAWS. The Session-identity card — the model, the tier,
 * the effort of whatever chat is in front — and the venue card under it. The
 * identity was a second answer to a question the tab in front and the
 * composer's own pill already answer, and it was the block standing between
 * the page's title and the roster the page exists for. The tree it named is a
 * fact about the whole rail rather than about the Now page, so it is the
 * checkout footer under every page, where Files and Search can see it too.
 *
 * WHAT IS DELIBERATELY NOT HERE. The "Mentioned" block the design calls for —
 * the tickets a transcript wrote `@vc-nn` at — needs the backlink mechanism
 * that is VC-104's, and is absent rather than empty until it lands: a section
 * that can never fill in this build is furniture, and inventing a different
 * relevance rule to fill it would be worse than not having it.
 *
 * Nothing in here collapses the rail — a panel cannot reopen itself, so that
 * control lives outside it, in the tab strip's corner, exactly as the ticket
 * rail's does.
 */
import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { sessionProvenanceHoverLine, type Project } from "@volli/shared";

import { FileSearchPanel } from "@renderer/components/files/search-panel";
import { HomeFilesPanel } from "@renderer/components/home/home-files-panel";
import { HomeCheckoutFooter } from "@renderer/components/home/home-rail-footer";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { RailModeTabs, type RailModeTab } from "@renderer/components/ticket/rail-mode-tabs";
import {
  RAIL_PANEL_INSET,
  RailFold,
  RailFoldBody,
  RailFoldCaret,
  RailFoldTrigger,
  RailHeadingReadStatus,
  RailReadFaultBody,
  RailSectionHeadingRow,
} from "@renderer/components/ticket/rail-panel-parts";
import { HomeUsageRailFooter } from "@renderer/components/usage/usage-rail";
import {
  railReadCanClaimEmpty,
  railReadFeedback,
} from "@renderer/components/ticket/rail-read-feedback";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { splitDragSourceProps } from "@renderer/components/split/split-drag-source";
import type { SplitDragPayload } from "@renderer/components/split/split-drop";
import { ListRow, ListRowSkeleton } from "@renderer/components/ui/list-row";
import { loadingRegionProps } from "@renderer/components/ui/loading-region";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { SessionProvenanceMark } from "@renderer/components/sessions/session-provenance-mark";
import { useSessionProvenance } from "@renderer/hooks/use-session-provenance";
import {
  HOME_RAIL_MODES,
  HOME_RAIL_MODE_LABELS,
  HOME_SESSION_FILTER_THRESHOLD,
  filterHomeSessionRows,
  homeLivePanes,
  homeSessionRows,
  homeTerminalIndex,
  nextHomeSessionStatusChangeAt,
  partitionHomeSessionRows,
  type HomeRailMode,
  type HomeSessionRow,
} from "@renderer/components/home/home-rail-model";
import { delayUntil } from "@renderer/lib/boundary-timer";
import { compactAge } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  listableChats,
  projectSessionListingPending,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { useRemoteSessionsUnavailable } from "@renderer/stores/remote-session-availability";
import { useSessionsStore } from "@renderer/stores/sessions";
import { RAIL_NARROW_MAX_WIDTH, useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * Every rail block is the same shape at the same inset — one seam, spelled
 * once, and it is the TICKET rail's seam (`ticket-sessions-panel.tsx`,
 * `ticket-rail-automations.tsx`, `ticket-properties.tsx`: `gap-1` at
 * `RAIL_PANEL_INSET`) rather than a second version of it.
 *
 * No top padding of its own. The pill above already pays the page's top inset
 * (`RailModeTabs`' `pb-4`), so a `pt-4` here put Home's eyebrow 16px lower than
 * the Ticket's for no reason a reader could see — and the two rails are
 * supposed to be one language at two scopes. `gap-2` was the second half of the
 * same drift: 8px between an eyebrow and its rows where every block on the
 * Ticket's Now page sets 4px.
 */
const SECTION = cn("flex flex-col gap-1", RAIL_PANEL_INSET);

export function HomeRail({
  project,
  activeTabId,
}: {
  project: Project;
  /**
   * Which Home tab is in front, resolved once by `home-surface.tsx`. Read here
   * only to say which Session the Now page is about — never re-derived: two
   * answers to that question is the disagreement VC-54 removed.
   */
  activeTabId: string;
}) {
  const mode = useUiStore((state) => state.homeRailMode);
  const setMode = useUiStore((state) => state.setHomeRailMode);
  // The same threshold the Ticket rail reads, from the store that owns the
  // width (`RAIL_NARROW_MAX_WIDTH`). This was pinned to "false" for one
  // revision, which left Home at 16px gutters on a column the reader had
  // dragged to its 240px floor — and its pinned checkout footer 4px out of line
  // with the page above it, since that footer insets from the same group
  // attribute every block reads.
  const narrow = useUiStore((state) => state.railWidth <= RAIL_NARROW_MAX_WIDTH);

  return (
    // The flag travels ONE way, as the Ticket rail's does: a group attribute on
    // the column, read by every block through `RAIL_PANEL_INSET`.
    //
    // `data-volli-rail` is the CSS hook globals.css hides rail scrollbars by
    // (see its rail block, and `ticket-rail.tsx` for the same marker at the
    // other scope). A marker of its own rather than the test id or the Tailwind
    // group class: a stylesheet keyed to `data-testid` makes a test attribute
    // load-bearing at runtime, and the group class is a utility the compiler
    // owns.
    <div
      className="group/rail flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="home-rail"
      data-volli-rail="home"
      data-narrow={narrow ? "true" : "false"}
    >
      <RailModeTabs
        modes={HOME_MODE_TABS}
        active={mode}
        label="Home rail pages"
        idPrefix="home-rail"
        onSelect={setMode}
      />
      {/* No overflow of its own: each page owns its scroll container, exactly as
          the ticket rail's panel does. The navigator scrolls its own list under
          a header that must not move, and Now scrolls as one column — a rule
          here could only be one of those two, with the other spelled as an
          exception to it. */}
      <section
        id={`home-rail-page-${mode}`}
        role="tabpanel"
        aria-labelledby={`home-rail-tab-${mode}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {mode === "now" ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-8">
              <BoardSessionsBlock projectId={project.id} />
            </div>
            {/* What this project cost (VC-87), pinned under the scroller and
                folding open above its row. Absent — not empty — when cost is
                turned off or nothing was metered. Now's alone: the other pages
                are navigators, and a spend figure under a folder listing is a
                fact about neither the folder nor the file. */}
            <HomeUsageRailFooter projectId={project.id} sessionId={parseHomeChatTab(activeTabId)} />
          </>
        ) : null}
        {mode === "files" ? (
          <HomeFilesPanel
            project={project}
            onPreviewFile={(relPath) =>
              useWorkspaceStore.getState().previewHomeFile(project.id, relPath)
            }
            onPinFile={(relPath) => useWorkspaceStore.getState().pinHomeFile(project.id, relPath)}
          />
        ) : null}
        {mode === "search" ? (
          // A match opens in the same replaceable preview slot a navigator row
          // does (decision #56) — the line it lands on is the search panel's
          // own business, through `editor/reveal-line.ts`.
          <FileSearchPanel
            scope={{ kind: "home", projectId: project.id }}
            root={project.name}
            onOpenMatch={(relPath) =>
              useWorkspaceStore.getState().previewHomeFile(project.id, relPath)
            }
          />
        ) : null}
      </section>
      {/* The Main checkout, under EVERY page (VC-406): the branch, and the one
          fact about the tree a reader would act on next, with the reading
          folded above it. Outside the tabpanel because it is not a page's
          content — it is true of the project whichever page is up, and Files
          and Search are the pages where "which tree is this" is asked most. */}
      <HomeCheckoutFooter projectId={project.id} />
    </div>
  );
}

/**
 * Home's pages, in pill order, as {@link RailModeTabs} takes them. Built once
 * at module scope: the set is fixed, so rebuilding it per render would hand
 * the pill a fresh array on every keystroke elsewhere in the app.
 */
const HOME_MODE_TABS: readonly RailModeTab<HomeRailMode>[] = HOME_RAIL_MODES.map((key) => ({
  key,
  label: HOME_RAIL_MODE_LABELS[key],
  icon: {
    now: ChatCircleDotsIcon,
    files: FoldersIcon,
    search: MagnifyingGlassIcon,
  }[key],
}));

/** The chat Session a Home tab id names, or `null` for the Board and terminals. */
function parseHomeChatTab(activeTabId: string): string | null {
  const prefix = chatTabId("");
  return activeTabId.startsWith(prefix) && activeTabId.length > prefix.length
    ? activeTabId.slice(prefix.length)
    : null;
}

/**
 * Board Sessions: the project's own, and only those — the block that used to be
 * a page of its own beside Now (VC-406).
 *
 * Rendered off the durable per-project listing VC-54 shipped
 * (`stores/project-sessions.ts`) rather than re-indexed here — the sidebar's
 * bands and ⌘K read the same rows, and a second index of them would be a second
 * answer to "what has this project been doing".
 *
 * WHAT IS LIVE STAYS ON THE PAGE. The split is `partitionHomeSessionRows`'s,
 * and it is a lifecycle question answered from the record rather than from
 * whether a tab is open: a Board Session whose tab you closed this morning is
 * still a Session to go back to, and one that is BLOCKED on you is the first
 * row here. Only what is over — a Session someone ended, a terminal whose PTY
 * is gone — folds into Earlier.
 *
 * A TERMINAL SAYS WHAT IT IS DOING, not merely that it is open. Its state is
 * `sessionActivityState`'s — output recency, the warm-park tier, and the
 * harness's own declaration — fed from this project's narrowed slice of
 * `stores/sessions.ts`, which is the same selector and the same five facts the
 * Ticket rail's roster uses. This surface used to answer "Open" for every
 * attached pane, so the one row on the page blocked on a person was
 * indistinguishable from a build log and sorted by its record's age.
 *
 * THE FILTER SEARCHES BOTH HALVES, and while it has a query the record does
 * not hide its matches behind the fold: a roster that answered "no matching
 * sessions" while holding one is the search failing at the only thing it is
 * for. It appears past four rows, counted over the whole roster.
 */
function BoardSessionsBlock({ projectId }: { projectId: string }) {
  const ensure = useProjectSessionsStore((state) => state.ensure);
  React.useEffect(() => {
    void ensure(projectId);
  }, [projectId, ensure]);
  // Whether the project's listing has ever answered (VC-383). Before it has,
  // the rows below are empty because nothing has been READ, not because there
  // is nothing — and "No sessions yet" about a project mid-turn is a false
  // sentence for the length of the read. The store already keeps this bit;
  // this block is one of the surfaces that used to leave it unread.
  const listingState = useProjectSessionsStore((state) => state.listingState[projectId]);
  const sessionsUnavailable = useRemoteSessionsUnavailable(projectId);
  // Rows survive a failed refresh in the store, so "has this ever landed" is a
  // question about the CACHE, not about the state word: a refresh that failed
  // leaves last-good rows, and those rows keep their place with the heading
  // carrying the caveat.
  const hasData = useProjectSessionsStore((state) => state.byProject[projectId] !== undefined);
  const feedback = railReadFeedback(
    {
      hasData,
      pending: projectSessionListingPending(listingState),
      failed: listingState === "failed",
    },
    "Sessions",
  );
  const canClaimEmpty = railReadCanClaimEmpty({
    hasData,
    pending: projectSessionListingPending(listingState),
    failed: listingState === "failed",
  });
  // `refresh`, not `ensure`: `ensure` no-ops once the cache holds anything, so
  // a retry routed through it would do nothing on exactly the surface that
  // offers it.
  const retry = React.useCallback(
    () => void useProjectSessionsStore.getState().refresh(projectId),
    [projectId],
  );

  // `listableChats` rather than `.chat`: this block draws rows, so it takes the
  // narrowed read at the door — see the store's own comment for which
  // consumers take the whole cache instead, and why.
  const chats = useProjectSessionsStore(
    useShallow((state) =>
      listableChats(state.byProject[projectId]).filter((row) => row.ticketId === null),
    ),
  );
  const terminals = useProjectSessionsStore(
    useShallow((state) =>
      (state.byProject[projectId]?.terminal ?? []).filter((row) => row.ticketId === null),
    ),
  );
  const openChatIds = useChatSessionsStore(
    useShallow((state) => state.openTabs[projectId] ?? EMPTY_IDS),
  );
  // THIS PROJECT'S TABS, and every PANE inside them (VC-406). The root ids
  // alone were the sessions store's index of tabs, not of Sessions: a split's
  // second pane has its own durable record, so it matched no root id and drew
  // as an inert "Exited" row while its PTY was printing.
  const liveTabs = useSessionsStore((state) => state.byOwner[projectId]?.tabs);
  // The three per-session maps a terminal's canonical state is derived from,
  // each narrowed to the records THIS project's listing holds. The store keeps
  // one flat map per fact for every live session in the app and replaces it
  // wholesale on each bump, so subscribing to `state.lastOutputAt` itself would
  // re-render Home whenever any session on any ticket in any project printed a
  // line. Shallow-compared through `homeTerminalIndex`, an irrelevant bump
  // yields an equal object and nothing here moves.
  const lastOutputAt = useSessionsStore(
    useShallow((state) => homeTerminalIndex(state.lastOutputAt, terminals)),
  );
  const parkState = useSessionsStore(
    useShallow((state) => homeTerminalIndex(state.parkState, terminals)),
  );
  // The same map the sidebar's bands and the Ticket rail read for their own
  // attention rows: it is what keeps the three surfaces from answering "is the
  // agent blocked on me?" differently about one Session at one instant.
  const harness = useSessionsStore(
    useShallow((state) => homeTerminalIndex(state.harness, terminals)),
  );
  // The clock the roster's STATE column is read against, advanced only on the
  // instant a state can change on its own (the working→idle window closing).
  // Between boundaries it is deliberately behind the wall clock, and no row is
  // re-derived for the difference, because no row can move in that gap.
  const [activityNow, setActivityNow] = React.useState(() => Date.now());

  const panes = React.useMemo(() => homeLivePanes(liveTabs ?? EMPTY_TABS), [liveTabs]);
  const pulse = React.useMemo(
    () => ({ panes, lastOutputAt, parkState, harness, now: activityNow }),
    [panes, lastOutputAt, parkState, harness, activityNow],
  );
  const rows = React.useMemo(
    () => homeSessionRows(chats, terminals, openChatIds, pulse),
    [chats, terminals, openChatIds, pulse],
  );
  // One timer on the one instant a word can change by itself, rather than an
  // interval re-deriving the roster sixty times a minute against the chance
  // that it has (`lib/boundary-timer.ts`, and the Ticket roster's own pattern).
  const statusBoundaryAt = nextHomeSessionStatusChangeAt(terminals, pulse);
  React.useEffect(() => {
    if (statusBoundaryAt === null) return;
    const timer = window.setTimeout(() => setActivityNow(Date.now()), delayUntil(statusBoundaryAt));
    return () => window.clearTimeout(timer);
  }, [statusBoundaryAt]);
  const [query, setQuery] = React.useState("");
  const searching = query.trim() !== "";
  const { live, earlier } = React.useMemo(
    () => partitionHomeSessionRows(filterHomeSessionRows(rows, query)),
    [rows, query],
  );
  // The record's fold is the rail's one fold preference, shared with the Ticket
  // rail's: Home and a Ticket are the same panel at two scopes, and a reader
  // who wants the record open wants it open at both.
  const foldOpen = useUiStore((state) => state.railFolds.sessionsRecord);
  const filterable = rows.length > HOME_SESSION_FILTER_THRESHOLD || searching;

  return (
    <div className={SECTION}>
      <RailSectionHeadingRow
        label="Board sessions"
        status={
          <RailHeadingReadStatus
            feedback={feedback}
            onRetry={retry}
            testId="home-sessions-read-status"
          />
        }
      />
      {filterable ? (
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Find a session"
          placeholder="Find a session…"
          className="h-8 text-ui md:text-ui"
        />
      ) : null}
      {!hasData && feedback?.kind === "reading" ? (
        <div
          className="flex flex-col"
          {...loadingRegionProps("sessions")}
          data-testid="home-sessions-loading"
        >
          {(["w-3/5", "w-2/5"] as const).map((width) => (
            <ListRowSkeleton key={width} mark primaryWidth={width} trailingWidth="w-10" />
          ))}
        </div>
      ) : null}
      {/* A refused baseline knows nothing about this Project's durable
          Sessions. The toast has the bridge detail; this line keeps the rail
          from claiming that a failed read proved the list empty, and carries
          the one action that can change it. */}
      {/* A host that grants this window no Session features (VC-713): said in
          its name, never as a failure with a Retry that cannot change it. */}
      {sessionsUnavailable !== null ? (
        <p className={EMPTY_INLINE} data-testid="home-sessions-unavailable">
          {sessionsUnavailable}
        </p>
      ) : (
        <RailReadFaultBody feedback={feedback} onRetry={retry} testId="home-sessions-error" />
      )}
      {sessionsUnavailable === null &&
      live.length === 0 &&
      earlier.length === 0 &&
      canClaimEmpty ? (
        <p className={EMPTY_INLINE}>{searching ? "No matching sessions" : "No sessions yet"}</p>
      ) : null}
      {live.length > 0 ? (
        <ul className="flex flex-col" data-testid="home-sessions-live">
          {live.map((row) => (
            <BoardSessionRow key={row.id} projectId={projectId} row={row} />
          ))}
        </ul>
      ) : null}
      {earlier.length === 0 ? null : searching ? (
        // A search spans the record, so its matches are rows on the page — not
        // rows behind a caret the reader would have to guess was hiding them.
        <ul className="flex flex-col" data-testid="home-sessions-earlier">
          {earlier.map((row) => (
            <BoardSessionRow key={row.id} projectId={projectId} row={row} />
          ))}
        </ul>
      ) : (
        <RailFold
          open={foldOpen}
          onOpenChange={() => useUiStore.getState().toggleRailFold("sessionsRecord")}
        >
          <RailFoldTrigger asChild>
            <button
              type="button"
              data-testid="home-sessions-fold"
              aria-label={
                foldOpen
                  ? "Hide earlier sessions"
                  : `Show ${earlier.length} earlier session${earlier.length === 1 ? "" : "s"}`
              }
              className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-label text-muted-foreground outline-none transition-colors duration-150 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
              Earlier · {earlier.length}
              <RailFoldCaret open={foldOpen} placement="eyebrow" />
            </button>
          </RailFoldTrigger>
          <RailFoldBody>
            <ul className="flex flex-col" data-testid="home-sessions-earlier">
              {earlier.map((row) => (
                <BoardSessionRow key={row.id} projectId={projectId} row={row} />
              ))}
            </ul>
          </RailFoldBody>
        </RailFold>
      )}
    </div>
  );
}

/**
 * One roster row, at the two-line geometry the reviewed design settled on: the
 * title gets its own line at the app's `text-ui` (13/20) and the state and age
 * ride a quieter `text-label` (11/16) line under it, inside `ListRow`'s 52px
 * `two-line` density.
 *
 * It was one line, with the title competing against a right-edge word for the
 * same horizontal space — so at the rail's width a real Session title read
 * `Investigate the session li…` beside `Open`. Two lines cost 16px a row and
 * give the title the whole width; the state is where the eye goes second
 * anyway. There is no "Chat"/"Terminal" word: the leading glyph says the kind,
 * and spending the quiet line on a word the mark already carries is what left
 * no room for the state.
 */
function BoardSessionRow({ projectId, row }: { projectId: string; row: HomeSessionRow }) {
  const provenance = useSessionProvenance(projectId, row.id);
  const provenanceLine = sessionProvenanceHoverLine(provenance);
  const Glyph = row.kind === "chat" ? ChatCircleIcon : TerminalWindowIcon;
  return (
    <li>
      <ListRow
        density="two-line"
        data-testid="home-session-row"
        leading={
          <Glyph
            weight="bold"
            aria-label={row.kind === "chat" ? "Chat" : "Terminal"}
            className="size-4 shrink-0 text-muted-foreground"
          />
        }
        primary={row.title}
        primaryTrailing={<SessionProvenanceMark provenance={provenance} />}
        title={provenanceLine === null ? undefined : `${row.title}\n${provenanceLine}`}
        secondary={
          <span className="flex min-w-0 items-center gap-1 text-label text-muted-foreground">
            <StatusDot state={row.state} />
            <span className="truncate">{row.stateLabel}</span>
            <span className="shrink-0">· {compactAge(row.at)}</span>
          </span>
        }
        className={row.live ? undefined : "text-muted-foreground"}
        onActivate={row.reopenable ? () => openSession(projectId, row) : null}
        // Draggable onto a pane (VC-202 §4): the same door, opened somewhere
        // specific.
        {...splitDragSourceProps(homeSessionDragPayload(projectId, row))}
      />
    </li>
  );
}

const EMPTY_IDS: readonly string[] = [];
/** Stable empty tab list, so the pane walk's memo does not re-run for a project with no tabs. */
const EMPTY_TABS: readonly [] = [];

/**
 * What one of these rows would open if it were dropped on a pane, or `null` for
 * a row that is not a door.
 *
 * A chat drags whether or not a tab holds it — the Session is durable, so the
 * drop adopts it and mints one, exactly as clicking would. A terminal drags
 * only while a live pane holds it, and it drags that pane's TAB: a payload's
 * `sessionId` "for a TERMINAL is also its tab id" (`split-drop.ts`), so a split
 * pane's own record id would name nothing a pane could hold.
 */
function homeSessionDragPayload(projectId: string, row: HomeSessionRow): SplitDragPayload | null {
  if (!row.reopenable) return null;
  const sessionId = row.kind === "terminal" ? row.tabId : row.id;
  if (sessionId === null) return null;
  return {
    type: "session",
    scope: "project",
    projectId,
    ticketId: null,
    kind: row.kind,
    sessionId,
  };
}

/**
 * Put a Session back in front.
 *
 * Both kinds route through `openHome`, the same seam the sidebar's bands and
 * ⌘K use — a chat is adopted and given a tab first, because the strip cannot
 * bring forward a tab that does not exist yet. Reopening a CLOSED chat is the
 * case this page exists for: a Board Session outlives its tab, and until now
 * the only way back to one was the sidebar.
 *
 * Only ever called for a row that IS a door — `HomeSessionRow.reopenable`, which
 * is where a dead terminal is turned away, and it is turned away by not being a
 * target at all rather than by being one that lands nowhere.
 */
function openSession(projectId: string, row: HomeSessionRow): void {
  const workspace = useWorkspaceStore.getState();
  if (row.kind === "chat") {
    const chat = useChatSessionsStore.getState();
    chat.adoptChatSession(row.id);
    chat.openChatTab(projectId, row.id);
    workspace.openHome(projectId, chatTabId(row.id));
    return;
  }
  // The TAB the pane belongs to, then the pane inside it: a durable terminal
  // record is a pane, and a split's second pane is not a tab the workspace
  // could bring forward. Same two steps the Ticket roster's rows take.
  const tabId = row.tabId ?? row.id;
  const sessions = useSessionsStore.getState();
  sessions.setActiveSession(projectId, tabId);
  sessions.setActivePane(projectId, tabId, row.id);
  workspace.openHome(projectId, tabId);
}
