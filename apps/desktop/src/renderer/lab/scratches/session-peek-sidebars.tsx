/**
 * VC-30 — the peek, integrated: both sidebars as the app draws them, ticket
 * folders included, in one row language.
 *
 * WHY THIS EXISTS. The v2 wireframe (`#session-peek-wireframe`) settled what
 * a peek says and how it opens, over a flat list of four fixture rows. The
 * sidebar it has to live in is not flat: Previous is grouped into ticket
 * folders (VC-69, shipped), Active is deliberately not, and the in-ticket rail
 * folds its record under its eyebrow (VC-406, shipped). Meanwhile the row
 * language the peek was drawn with — the vendor's mark carrying the state —
 * was decided for the sidebar in VC-402 and never reached main (#568 closed
 * unmerged). This scratch puts the three together, so the design can be judged
 * as ONE system rather than three that grew separately.
 *
 * WHAT IS REAL AND WHAT IS NOT.
 *   • Band membership, order and folder grouping come from the SHIPPED
 *     `buildActiveSessionListing` and `groupPreviousByTicket` over a fixture
 *     corpus (`session-peek/sidebar-corpus.ts`). Nothing here assigns a band.
 *   • The rows are lab rows (`session-peek/sidebar-rows.tsx`) on the shipped
 *     primitives and geometry, differing from the shipped rows only where the
 *     design does — see that file's module comment.
 *   • The peek's controller, card and conversation overlay are the v2 ones
 *     (`use-peek-controller.ts`, `card.tsx`, `conversation.tsx`), unchanged in
 *     behaviour; this adds the ticket card (`ticket-card.tsx`) a folder opens.
 *   • Summaries, sends and Undo are fixtures, as in v2. Opening a Session
 *     changes what is "in front" here and nothing else.
 *
 * THE QUESTIONS IT PUTS, as controls: what hovering a FOLDER shows (the ticket,
 * its newest Session, or nothing); what the folder row carries at rest (the
 * shipped count, or who worked on it); and which mark leads every row (the
 * VC-402 status ink, the v2 logo-and-badge, or today's dot).
 */
import * as React from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { displayTicketId, TICKET_STATUS_LABELS } from "@volli/shared";

import {
  buildActiveSessionListing,
  groupPreviousByTicket,
  type ActiveSessionRow,
  type PreviousSessionRow,
} from "@renderer/components/sidebar/active-session-listing";
import { SessionBandHeader } from "@renderer/components/sidebar/session-band-header";
import {
  RAIL_PANEL_INSET,
  RailFold,
  RailFoldBody,
  RailFoldHeadingRow,
} from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { SESSION_ACTIVITY_LABEL } from "@renderer/components/ui/session-activity-status";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarProvider,
} from "@renderer/components/ui/sidebar";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { compactAge, relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

import { NOW, project, tickets } from "../fixtures";
import { appApi, seedApp } from "../seed";
import { SessionPeekCard } from "../session-peek/card";
import { PeekConversation } from "../session-peek/conversation";
import { RowMark, type MarkStyle } from "../session-peek/row-mark";
import {
  CORPUS,
  LISTING_INPUT,
  RAIL_TICKET_ID,
  VENDOR_LABEL,
  type CorpusSession,
} from "../session-peek/sidebar-corpus";
import {
  canPeekRow,
  canPinRow,
  corpusIdOf,
  folderRowId,
  folderSessions,
  folderTicketId,
  folderVendors,
  FOLDER_VIEW_START,
  listedActive,
  listedPrevious,
  peekSubject,
  railRoster,
  sessionFixture,
  type FolderFace,
  type FolderPeek,
  type FolderView,
  type ListedSession,
} from "../session-peek/sidebar-model";
import {
  ActiveRow,
  FolderRow,
  FOLDER_NEST,
  folderPanelId,
  PreviousRow,
  RailRow,
} from "../session-peek/sidebar-rows";
import { FolderStrip, TicketPeekCard } from "../session-peek/ticket-card";
import { usePeekController } from "../session-peek/use-peek-controller";
import {
  DEFAULT_DWELL,
  DWELL_CHOICES,
  type DwellMs,
  type PeekTarget,
  type SendOutcome,
} from "./session-peek-wireframe-model";

export const title = "Session peek · both sidebars, with ticket folders";
export const note =
  "One row language over the shipped bands, folders and rail fold, with the peek on all of it (VC-30)";
export const viewport = "window";
export const seed = seedApp;
export const api = appApi;

const PEEK_WIDTH = 360;
/** Once a peek is open, a neighbour opens after this rest rather than the full dwell. */
const WARM_DWELL_MS = 150;
const PREFIX = project.ticketPrefix;
const TICKETS = new Map(tickets.map((ticket) => [ticket.id, ticket]));

/** The listing never changes here: the corpus is fixed and the clock is frozen. */
const LISTING = buildActiveSessionListing({ ...LISTING_INPUT, now: NOW });
const ENTRIES = groupPreviousByTicket(LISTING.previous);
const FOLDERS = folderSessions(ENTRIES);
const ACTIVE_BY_ID = new Map(LISTING.active.map((row) => [row.id, row]));
const PREVIOUS_BY_ID = new Map(LISTING.previous.map((row) => [row.id, row]));
/** The folder each Previous Session sits in, so opening one can reveal it (the shipped rule). */
const FOLDER_OF = new Map(
  [...FOLDERS].flatMap(([ticketId, rowIds]) => rowIds.map((rowId) => [rowId, ticketId] as const)),
);

function corpusOf(rowId: string): CorpusSession | undefined {
  return CORPUS.get(corpusIdOf(rowId));
}

/** A row's accessible mark name: the vendor, then the state words the band already uses. */
function markName(session: CorpusSession, state: StatusDotState | null): string {
  const who =
    session.kind === "terminal"
      ? `${session.runs.label} (${VENDOR_LABEL[session.vendor]})`
      : VENDOR_LABEL[session.vendor];
  if (state === null) return who;
  const words =
    state === "working"
      ? SESSION_ACTIVITY_LABEL.working
      : state === "waiting"
        ? SESSION_ACTIVITY_LABEL.waiting
        : state === "interrupted"
          ? SESSION_ACTIVITY_LABEL.interrupted
          : SESSION_ACTIVITY_LABEL.idle;
  return `${who} · ${words}`;
}

/* ---------------------------------------------------------------- lab chrome */

/** The lab's own control, drawn so it can never be mistaken for the design. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-label text-muted-foreground uppercase">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map(([key, name]) => (
          <Button
            key={key}
            type="button"
            size="xs"
            variant={key === value ? "secondary" : "ghost"}
            aria-pressed={key === value}
            onClick={() => onChange(key)}
          >
            {name}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Bullets({ heading, items }: { heading: string; items: readonly string[] }) {
  return (
    <section className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border p-3">
      <h2 className="text-ui font-medium text-foreground">{heading}</h2>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5 text-ui text-muted-foreground">
            <span aria-hidden>•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PROPOSED: readonly string[] = [
  "One mark per row, everywhere: the vendor's mark carries the state (VC-402) in Active, Previous, inside folders and in the rail. The rail's status line drops its dot — one carrier of state per row.",
  "A folder peeks its TICKET: status, title, and each Session with one line on what it did. Three Sessions called “Chat” become three different sentences. Pressing one drills into its own peek; ← goes back.",
  "Folder peeks are read-only. Nothing behind a folder can be waiting on you (attention pins a Session to Active), and an answer needs one recipient — so Answer and Send live on Session rows only.",
  "Expanding a folder closes its peek: pressing the caret means “show me inline”, and the rows it reveals peek on their own.",
  "Once a peek is open, the next row opens after 150 ms at rest instead of the full dwell, so scanning a folder's Sessions is one gesture.",
  "Peekable rows lose their native title tooltip — the peek says the full title and the harness, and the tooltip opened on top of it.",
];

const KEYS: readonly string[] = [
  "↑/↓ or J/K step every visible row — folders and their open Sessions in one order",
  "→ opens a folder, ← closes it; ← on a Session inside a folder returns to the folder",
  "Space peeks the focused row; Space again pins a Session (to answer) or moves into a folder's card",
  "Esc: drilled card → back to the ticket, then closes; the v2 ladder otherwise",
];

const OPEN: readonly string[] = [
  "Ticket peek on the BOARD's cards — the same card, so the brief's “other surfaces” is one component",
  "Whether the rail's fold eyebrow (“Sessions ›”) should peek its record while folded",
  "Summary freshness, question identity and send/undo guarantees stay runtime contracts (see the v2 README)",
];

/* ------------------------------------------------------------------ scratch */

type FolderViewState = FolderView & { readonly key: string | null };

export default function SessionPeekSidebarsScratch() {
  const [folderPeek, setFolderPeek] = React.useState<FolderPeek>("ticket");
  const [folderFace, setFolderFace] = React.useState<FolderFace>("count");
  const [markStyle, setMarkStyle] = React.useState<MarkStyle>("ink");
  const [switchMode, setSwitchMode] = React.useState<"warm" | "full">("warm");
  const [dwell, setDwell] = React.useState<DwellMs>(DEFAULT_DWELL);
  const [hoverEnabled, setHoverEnabled] = React.useState(true);
  const [outcome, setOutcome] = React.useState<SendOutcome>("success");

  /** What the person is focused on — what a peek must never take them away from. */
  const [inFront, setInFront] = React.useState<string>("chat:chat-a2");
  const [railTicketId, setRailTicketId] = React.useState(RAIL_TICKET_ID);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const [recordOpen, setRecordOpen] = React.useState(false);

  const canPeek = React.useCallback(
    (target: PeekTarget) => canPeekRow(target.rowId, folderPeek),
    [folderPeek],
  );
  const canPin = React.useCallback((target: PeekTarget) => canPinRow(target.rowId, CORPUS), []);

  /* The folder view belongs to ONE shown target; showing another starts it over. */
  const [folderViewState, setFolderViewState] = React.useState<FolderViewState>({
    key: null,
    ...FOLDER_VIEW_START,
  });
  /** Where focus goes once the card has swapped content — see `drill` and `back`. */
  const pendingFocus = React.useRef<string | null>(null);

  const toggleFolder = React.useCallback((ticketId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(ticketId)) next.delete(ticketId);
      else next.add(ticketId);
      return next;
    });
  }, []);

  /* `onRowKey` needs the controller's state, and the controller needs `onRowKey`. */
  const keyRef = React.useRef<
    (event: React.KeyboardEvent<HTMLElement>, target: PeekTarget) => boolean
  >(() => false);
  const onRowKey = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>, target: PeekTarget) => keyRef.current(event, target),
    [],
  );

  const peek = usePeekController({
    dwell,
    hoverEnabled,
    outcome,
    cardWidth: PEEK_WIDTH,
    canPeek,
    canPin,
    warmDwell: switchMode === "warm" ? WARM_DWELL_MS : null,
    onRowKey,
    // The raw view, not the derived one below: a swap of the card's content
    // (drill, back, page) is what has to re-measure it; a new target already does.
    layoutKey: `${folderPeek}|${markStyle}|${folderViewState.drill}|${folderViewState.page}`,
  });
  const { state, dispatch } = peek;
  const shown = state.shown;
  const shownKey = shown === null ? null : `${shown.surface}:${shown.rowId}`;
  const folderView: FolderView =
    folderViewState.key === shownKey ? folderViewState : FOLDER_VIEW_START;

  const setFolderView = (update: (view: FolderView) => FolderView) =>
    setFolderViewState((current) => {
      const base = current.key === shownKey ? current : { key: shownKey, ...FOLDER_VIEW_START };
      return { ...base, ...update(base), key: shownKey };
    });

  const delivered = (rowId: string) => state.delivered[rowId] !== undefined;

  const listed = (rowId: string): ListedSession | null => {
    const active = ACTIVE_BY_ID.get(rowId);
    if (active !== undefined) return listedActive(active, delivered(rowId));
    const previous = PREVIOUS_BY_ID.get(rowId);
    return previous === undefined ? null : listedPrevious(previous);
  };

  const mark = (rowId: string, size: "row" | "card" = "row") => {
    const session = corpusOf(rowId);
    const row = listed(rowId);
    if (session === undefined || row === null) return null;
    return (
      <RowMark
        style={markStyle}
        vendor={session.vendor}
        kind={session.kind}
        state={row.state}
        name={markName(session, row.state)}
        size={size}
      />
    );
  };

  /** Opening: the one gesture that changes what is in front. The peek closes behind it. */
  const activate = React.useCallback(
    (rowId: string) => {
      setInFront(rowId);
      const row = ACTIVE_BY_ID.get(rowId) ?? PREVIOUS_BY_ID.get(rowId);
      if (row?.ticket) setRailTicketId(row.ticket.id);
      // The shipped band reveals the folder a newly selected Session sits in.
      const folder = FOLDER_OF.get(rowId);
      if (folder !== undefined) setExpanded((current) => new Set(current).add(folder));
      if (state.pinned !== null) dispatch({ type: "unpin" });
      dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
    },
    [dispatch, state.pinned],
  );

  const onToggleFolder = React.useCallback(
    (ticketId: string) => {
      toggleFolder(ticketId);
      // Pressing the caret asks for the rows inline; a card describing them
      // beside the rows themselves would be the same list twice.
      if (shown?.rowId === folderRowId(ticketId))
        dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
    },
    [dispatch, shown, toggleFolder],
  );

  keyRef.current = (event, target) => {
    if (target.surface !== "nav") return false;
    const ticketId = folderTicketId(target.rowId);
    if (ticketId !== null) {
      const open = expanded.has(ticketId);
      if ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open)) {
        event.preventDefault();
        onToggleFolder(ticketId);
        return true;
      }
      // Space on a folder whose card is already up moves INTO the card — the
      // folder's equivalent of pinning, since a folder has nothing to answer.
      if (event.key === " " && shown?.rowId === target.rowId) {
        event.preventDefault();
        peek.cardRef.current?.querySelector<HTMLElement>("button[data-peek-drill]")?.focus();
        return true;
      }
      return false;
    }
    if (event.key === "ArrowLeft") {
      const folder = (event.target as HTMLElement)
        .closest<HTMLElement>("[data-peek-folder]")
        ?.querySelector<HTMLElement>(":scope > button");
      if (folder) {
        event.preventDefault();
        folder.focus();
        return true;
      }
    }
    return false;
  };

  const drill = (rowId: string) => {
    pendingFocus.current = "[data-peek-strip] button";
    setFolderView((view) => ({ ...view, drill: rowId }));
  };
  const back = () => {
    pendingFocus.current = `[data-peek-drill="${folderView.drill ?? ""}"]`;
    setFolderView((view) => ({ ...view, drill: null }));
  };
  const step = (delta: number) =>
    setFolderView((view) => ({ ...view, page: Math.max(0, view.page + delta) }));

  /**
   * A drill swaps the card's element out from under the pointer, and neither
   * pointerenter nor focus follows it there. Put focus where the reader's
   * next press belongs, which also re-enters the card's half of the bridge.
   */
  React.useLayoutEffect(() => {
    const selector = pendingFocus.current;
    if (selector === null) return;
    pendingFocus.current = null;
    const card = peek.cardRef.current;
    (card?.querySelector<HTMLElement>(selector) ?? card)?.focus();
  });

  /* ------------------------------------------------------------- the card */

  const subject = shown === null ? null : peekSubject(shown.rowId, folderPeek, FOLDERS, folderView);

  const onCardKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    // The drilled card's first rung of the Esc ladder is the ticket it came from.
    if (event.key === "Escape" && folderView.drill !== null) {
      event.preventDefault();
      event.stopPropagation();
      back();
    }
  };

  let card: React.ReactNode = null;
  if (shown !== null && subject !== null && peek.position !== null && peek.looking === null) {
    if (subject.kind === "ticket") {
      const ticket = TICKETS.get(subject.ticketId);
      if (ticket !== undefined)
        card = (
          <TicketPeekCard
            ref={peek.cardRef}
            ticket={ticket}
            ticketPrefix={PREFIX}
            position={peek.position}
            width={PEEK_WIDTH}
            sessions={subject.sessionIds.flatMap((rowId) => {
              const row = listed(rowId);
              const session = corpusOf(rowId);
              if (row === null || session === undefined) return [];
              return [
                {
                  rowId,
                  title: row.title,
                  mark: mark(rowId),
                  age: row.at > 0 ? compactAge(row.at, NOW) : "",
                  summary: session.summary,
                },
              ];
            })}
            onDrill={drill}
            onOpenTicket={() => {
              setRailTicketId(ticket.id);
              dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
            }}
            {...peek.cardProps}
          />
        );
    } else {
      const row = listed(subject.rowId);
      const session = corpusOf(subject.rowId);
      if (row !== null && session !== undefined) {
        const via = subject.via;
        const folderTicket = via.kind === "row" ? undefined : TICKETS.get(via.ticketId);
        const ticketLabel =
          folderTicket === undefined ? "" : displayTicketId(PREFIX, folderTicket.ticketNumber);
        card = (
          <div onKeyDown={onCardKeyDown} className="contents">
            <SessionPeekCard
              ref={peek.cardRef}
              fixture={sessionFixture(row, session, PREFIX, NOW)}
              state={state}
              position={peek.position}
              width={PEEK_WIDTH}
              summaryState="ready"
              dispatch={dispatch}
              delivered={delivered(subject.rowId)}
              glyph={mark(subject.rowId, "card")}
              accessory={
                via.kind === "drill" ? (
                  <FolderStrip ticketLabel={ticketLabel} back={back} />
                ) : via.kind === "pager" ? (
                  <FolderStrip
                    ticketLabel={ticketLabel}
                    pager={{ index: via.index, count: via.count, onStep: step }}
                  />
                ) : undefined
              }
              // A folder's card is read-only; a Session row's is answerable
              // when there is someone to answer — never a closed terminal.
              canReply={via.kind === "row" && session.kind === "chat"}
              canViewConversation={session.kind === "chat"}
              // The folder strip already names the ticket; the block would say it twice.
              showTicket={via.kind === "row"}
              onPin={() => peek.pin(shown)}
              onOpen={() => activate(subject.rowId)}
              onLook={() => peek.look(subject.rowId)}
              onClose={() => dispatch({ type: "escape", now: Date.now() })}
              {...peek.cardProps}
            />
          </div>
        );
      }
    }
  }

  const lookingRow = peek.looking === null ? null : listed(peek.looking);
  const lookingSession = peek.looking === null ? undefined : corpusOf(peek.looking);
  const lookingFixture =
    lookingRow === null || lookingSession === undefined
      ? null
      : sessionFixture(lookingRow, lookingSession, PREFIX, NOW);

  /* ------------------------------------------------------------ the bands */

  const selectedFolder = FOLDER_OF.get(inFront) ?? null;

  const activeBand = (
    <SidebarGroup data-session-band="active" className="gap-1">
      <SessionBandHeader label="Active" count={LISTING.active.length} />
      <SidebarMenu>
        {LISTING.active.map((row: ActiveSessionRow) => {
          const listedRow = listedActive(row, delivered(row.id));
          return (
            <ActiveRow
              key={row.id}
              row={row}
              ticketPrefix={PREFIX}
              now={NOW}
              selected={row.id === inFront}
              delivered={delivered(row.id)}
              working={listedRow.state === "working"}
              mark={mark(row.id)}
              onActivate={activate}
            />
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );

  const previousRow = (row: PreviousSessionRow, showIdentity: boolean) => (
    <PreviousRow
      key={row.id}
      row={row}
      ticketPrefix={PREFIX}
      now={NOW}
      selected={row.id === inFront}
      mark={mark(row.id)}
      showIdentity={showIdentity}
      onActivate={activate}
    />
  );

  const previousBand = (
    <SidebarGroup data-session-band="previous" className="gap-1 pt-0">
      <SessionBandHeader label="Previous" count={LISTING.previous.length} />
      <SidebarMenu>
        {ENTRIES.map((entry) =>
          entry.kind === "session" ? (
            previousRow(entry.row, true)
          ) : (
            <SidebarMenuItem key={entry.id} data-peek-folder={entry.id}>
              <FolderRow
                ticket={entry.ticket}
                ticketPrefix={PREFIX}
                count={entry.rows.length}
                newestAt={entry.newestAt}
                now={NOW}
                open={expanded.has(entry.id)}
                selected={entry.id === selectedFolder}
                vendors={
                  folderFace === "marks"
                    ? folderVendors(
                        entry.rows.map((row) => row.id),
                        (rowId) => corpusOf(rowId)?.vendor,
                      )
                    : null
                }
                onToggle={onToggleFolder}
              />
              {expanded.has(entry.id) ? (
                <SidebarMenuSub id={folderPanelId(entry.id)} className={FOLDER_NEST}>
                  {entry.rows.map((row) => previousRow(row, false))}
                </SidebarMenuSub>
              ) : null}
            </SidebarMenuItem>
          ),
        )}
      </SidebarMenu>
    </SidebarGroup>
  );

  /* -------------------------------------------------------------- the rail */

  const railTicket = TICKETS.get(railTicketId);
  const roster = railRoster(LISTING, railTicketId);
  const railStatus = (rowId: string): string => {
    const active = ACTIVE_BY_ID.get(rowId);
    if (active !== undefined) {
      const words =
        active.attention !== null && !delivered(rowId)
          ? SESSION_ACTIVITY_LABEL.waiting
          : SESSION_ACTIVITY_LABEL[delivered(rowId) ? "working" : active.activity];
      return active.lastActivityAt === null
        ? words
        : `${words} · ${relativeTime(active.lastActivityAt, NOW)}`;
    }
    const previous = PREVIOUS_BY_ID.get(rowId);
    if (previous === undefined) return "";
    const age = relativeTime(previous.endedOrQuietAt, NOW);
    return previous.activity === "interrupted" || previous.activity === "stopped"
      ? `${SESSION_ACTIVITY_LABEL[previous.activity]} · ${age}`
      : age;
  };
  const railRow = (rowId: string, rowTitle: string) => (
    <RailRow
      key={rowId}
      rowId={rowId}
      title={rowTitle}
      mark={mark(rowId)}
      status={railStatus(rowId)}
      selected={rowId === inFront}
      onActivate={activate}
    />
  );

  const inFrontRow = listed(inFront);
  const inFrontSession = corpusOf(inFront);

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
      {/* ------------------------------------------------ the left nav sidebar */}
      <SidebarProvider
        className="min-h-0 w-fit shrink-0"
        style={{ "--sidebar-width": "280px" } as React.CSSProperties}
      >
        <Sidebar
          collapsible="none"
          className="h-svh w-(--sidebar-width) border-r border-sidebar-border"
        >
          <SidebarContent
            data-testid="peek-nav"
            onScroll={peek.onListScroll}
            className="gap-0 py-2"
            {...peek.rowProps("nav")}
          >
            {activeBand}
            {previousBand}
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>

      {/* -------------------------------------- the middle: in front, then the lab */}
      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <section
          aria-label="In front"
          className="flex max-w-[720px] flex-col gap-2 rounded-xl border border-border bg-card p-4"
        >
          <p className="text-label text-muted-foreground uppercase">In front · your focused work</p>
          {inFrontRow !== null && inFrontSession !== undefined ? (
            <>
              <div className="flex items-center gap-2">
                {mark(inFront)}
                <h1 className="min-w-0 truncate text-ui font-semibold">{inFrontRow.title}</h1>
                {inFrontRow.ticket === null ? null : (
                  <span className="shrink-0 font-mono text-label tracking-normal text-muted-foreground">
                    {displayTicketId(PREFIX, inFrontRow.ticket.ticketNumber)} ·{" "}
                    {TICKET_STATUS_LABELS[inFrontRow.ticket.status]}
                  </span>
                )}
              </div>
              <p className="text-ui text-muted-foreground">{inFrontSession.summary}</p>
            </>
          ) : null}
        </section>

        <div
          data-lab-controls=""
          className="flex max-w-[720px] flex-col gap-3 rounded-xl border border-border p-4"
        >
          <h2 className="text-ui font-medium">The questions</h2>
          <Choice<FolderPeek>
            label="Folder hover"
            value={folderPeek}
            options={[
              ["ticket", "Ticket (proposed)"],
              ["newest", "Newest session"],
              ["off", "Nothing"],
            ]}
            onChange={(next) => {
              // The card on screen may be one the new mode would not open.
              dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
              setFolderPeek(next);
            }}
          />
          <Choice<FolderFace>
            label="Folder face"
            value={folderFace}
            options={[
              ["count", "Count (shipped)"],
              ["marks", "Who worked on it"],
            ]}
            onChange={setFolderFace}
          />
          <Choice<MarkStyle>
            label="Row mark"
            value={markStyle}
            options={[
              ["ink", "Status ink (VC-402)"],
              ["badge", "Logo + badge (v2)"],
              ["dot", "Dot (shipped)"],
            ]}
            onChange={setMarkStyle}
          />
          <h2 className="pt-2 text-ui font-medium">Tuning</h2>
          <Choice<"warm" | "full">
            label="Next row"
            value={switchMode}
            options={[
              ["warm", `Warm · ${WARM_DWELL_MS}ms`],
              ["full", "Full dwell"],
            ]}
            onChange={setSwitchMode}
          />
          <Choice<`${DwellMs}`>
            label="Dwell"
            value={`${dwell}`}
            options={DWELL_CHOICES.map((ms) => [`${ms}`, `${ms}ms`] as const)}
            onChange={(next) => setDwell(Number(next) as DwellMs)}
          />
          <Choice<"on" | "off">
            label="Hover"
            value={hoverEnabled ? "on" : "off"}
            options={[
              ["on", "on"],
              ["off", "off (keyboard)"],
            ]}
            onChange={(next) => {
              peek.clearDwell();
              setHoverEnabled(next === "on");
              if (next === "off") peek.disableHover();
            }}
          />
          <Choice<SendOutcome>
            label="Send"
            value={outcome}
            options={[
              ["success", "succeeds"],
              ["failure", "fails"],
            ]}
            onChange={setOutcome}
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => setExpanded(new Set(FOLDERS.keys()))}
            >
              Open every folder
            </Button>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => setExpanded(new Set())}
            >
              Close every folder
            </Button>
          </div>
        </div>

        <div className="flex max-w-[720px] flex-col gap-2">
          <Bullets heading="What this proposes" items={PROPOSED} />
          <Bullets heading="Keys" items={KEYS} />
          <Bullets heading="Still open" items={OPEN} />
        </div>
      </main>

      {/* ------------------------------------------------- the in-ticket rail */}
      <aside
        aria-label="Ticket rail"
        className="group/rail flex h-svh w-[300px] shrink-0 flex-col border-l border-sidebar-border bg-sidebar"
        data-narrow="false"
      >
        {railTicket === undefined ? null : (
          <header className={cn("flex flex-col gap-1 pt-4 pb-3", RAIL_PANEL_INSET)}>
            <span className="px-2 font-mono text-label tracking-normal text-muted-foreground">
              {displayTicketId(PREFIX, railTicket.ticketNumber)} ·{" "}
              {TICKET_STATUS_LABELS[railTicket.status]}
            </span>
            <p className="line-clamp-2 px-2 text-ui font-medium">{railTicket.title}</p>
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto" onScroll={peek.onListScroll}>
          <RailFold
            asChild
            open={recordOpen && roster.record.length > 0}
            onOpenChange={() => setRecordOpen((open) => !open)}
          >
            <section className={cn("flex flex-col gap-1", RAIL_PANEL_INSET)} aria-label="Sessions">
              <RailFoldHeadingRow
                label="Sessions"
                open={recordOpen}
                foldable={roster.record.length > 0}
                triggerLabel={
                  recordOpen
                    ? "Hide past sessions"
                    : `Show ${roster.record.length} past session${roster.record.length === 1 ? "" : "s"}`
                }
              />
              <div
                className="flex flex-col gap-1"
                data-testid="peek-rail"
                {...peek.rowProps("rail")}
              >
                <ul className="flex flex-col gap-1">
                  {roster.current.map((row) => railRow(row.id, row.title))}
                </ul>
                {roster.record.length > 0 ? (
                  <RailFoldBody>
                    <ul className="flex flex-col gap-1 pt-1">
                      {roster.record.map((row) => railRow(row.id, row.title))}
                    </ul>
                  </RailFoldBody>
                ) : null}
              </div>
            </section>
          </RailFold>
        </div>
      </aside>

      {card}

      <PeekConversation
        fixture={lookingFixture}
        answer={peek.looking === null ? undefined : state.delivered[peek.looking]?.answer}
        outcome={outcome}
        onClose={peek.closeLook}
        onOpen={() => {
          if (peek.looking === null) return;
          const rowId = peek.looking;
          peek.closeLook();
          activate(rowId);
        }}
        returnFocus={peek.lookReturn}
      />

      {/* Off the peek on purpose, as in v2: the peek closes at ~2s and this
          holds the full Undo window. Nothing was sent, so nothing is recalled. */}
      {peek.receipt === null ? null : (
        // `Notice` is drawn to sit inline and has no fill of its own; floating
        // over content it needs the popover's surface to stay legible.
        <div
          role="status"
          className="fixed right-[316px] bottom-14 z-[70] w-[340px] rounded-xl border border-border bg-popover shadow-overlay"
        >
          <Notice
            tone="neutral"
            icon={CheckCircleIcon}
            layout="stack"
            title={`Sent to ${listed(peek.receipt.rowId)?.title ?? "session"}`}
            detail={`Simulation · ${peek.undoLeft}s to undo`}
            actions={
              <Button type="button" size="sm" variant="secondary" onClick={peek.undo}>
                Undo
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
