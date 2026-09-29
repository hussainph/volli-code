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
 * DECIDED (owner, 2026-09-29), and still switchable only to compare: a folder
 * peeks its TICKET; a folder row keeps the shipped COUNT; every row leads with
 * the v2 LOGO + BADGE (the badge's icons read as state where a tinted logo
 * blended into its own brand colour); the peek opens after 350 ms at rest,
 * and the next row after 150 ms once one is open.
 *
 * IN MOTION (VC-108 folded in). The sidebar is played forward through a
 * short script (`session-peek/sidebar-live.ts`) — tool calls, finished turns,
 * a question — and rebuilt through the shipped builder on every step, so the
 * rules below can be watched rather than described. DECIDED (owner,
 * 2026-09-30), and still switchable only to compare:
 *
 *   • UNREAD. A turn that ends out of sight leaves its Session unread: a blue
 *     dot and a heavier title, and the clock cannot retire it to Previous
 *     until it is read. A peek NEVER reads it — its card says "Unread", and
 *     only opening the Session, replying to it, viewing its conversation or
 *     marking it (right-click, U) clears the dot.
 *   • A HELD ORDER. Active no longer re-sorts on every tool call. A row moves
 *     only when a new turn starts (or it first appears), and a new QUESTION
 *     FLOATS to the top, above everything. Nothing moves while the pointer is
 *     in a sidebar or a peek is open; the moves land when it leaves.
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
import { compactAge } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

import { project, tickets } from "../fixtures";
import { appApi, seedApp } from "../seed";
import { SessionPeekCard } from "../session-peek/card";
import { PeekConversation } from "../session-peek/conversation";
import { RowMark, type MarkSize, type MarkStyle, type MarkSurface } from "../session-peek/row-mark";
import {
  CORPUS,
  RAIL_TICKET_ID,
  VENDOR_LABEL,
  type CorpusSession,
} from "../session-peek/sidebar-corpus";
import {
  activeMembers,
  applyWorld,
  asActiveRow,
  commitOf,
  frozenOrder,
  heldTarget,
  listingInputOf,
  liveOf,
  sameOrder,
  SCRIPT,
  scriptEvents,
  WORLD_START,
  type HeldOrder,
  type LiveOverlay,
  type QuestionRule,
  type World,
  type WorldEvent,
} from "../session-peek/sidebar-live";
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
import { type PeekTarget, type SendOutcome } from "./session-peek-wireframe-model";

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

/** The decided dwell is 350 ms; its neighbours stay for comparison. */
const DWELL_CHOICES = [300, 350, 400, 500] as const;
type DwellMs = (typeof DWELL_CHOICES)[number];
const DEFAULT_DWELL: DwellMs = 350;

/** How long a peek must be on screen before it counts as reading its Session. */
const PEEK_READ_MS = 1000;
/** How fast the script plays: slow enough to watch one row move. */
const PLAY_STEP_MS = 1600;
const FIRST_IN_FRONT = "chat:chat-a2";

/** When looking at a peek clears its Session's unread dot. Decided: never. */
type PeekReads = "look" | "never" | "open";
type OrderMode = "held" | "live";

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
  "Unread is its own mark: a blue dot and a heavier title. A turn that ends while its Session is not in front leaves it unread; opening it, replying to it, or viewing its conversation reads it. A peek never does — the card says “Unread” instead, so a glance cannot clear what you have not read. Right-click (or U) toggles it.",
  "Unread Sessions stay in Active past the 30-minute window, however old — Previous means seen or nothing to see, never merely old. Marking a Previous Session unread brings it back.",
  "A held Active order: tool calls, finished turns, answers and reads move nothing. A row moves only when a new turn starts or it first appears — to the top — and a new question floats above everything, so what needs you is always first. While the pointer is in a sidebar or a peek is open, even that waits, and lands when you leave.",
  "One mark per row, everywhere: the vendor's logo with v2's state badge, in Active, Previous, inside folders and in the rail.",
  "One two-line row in both sidebars: Active is drawn as the rail's row, the mark centred on the row. The second line says where and when (VLT-14 · 2m ago) and never how — the mark already says it.",
  "A folder peeks its TICKET: status, title, and each Session with one line on what it did. Three Sessions called “Chat” become three different sentences. Pressing one drills into its own peek; ← goes back.",
  "Folder peeks are read-only. Nothing behind a folder can be waiting on you (attention pins a Session to Active), and an answer needs one recipient — so Answer and Send live on Session rows only.",
  "Expanding a folder closes its peek: pressing the caret means “show me inline”, and the rows it reveals peek on their own.",
  "Once a peek is open, the next row opens after 150 ms at rest instead of the full dwell, so scanning a folder's Sessions is one gesture.",
  "Peekable rows lose their native title tooltip — the peek says the full title and the harness, and the tooltip opened on top of it.",
];

const KEYS: readonly string[] = [
  "U on a Session row marks it read or unread (right-click offers the same)",
  "↑/↓ or J/K step every visible row — folders and their open Sessions in one order",
  "→ opens a folder, ← closes it; ← on a Session inside a folder returns to the folder",
  "Space peeks the focused row; Space again pins a Session (to answer) or moves into a folder's card",
  "Esc: drilled card → back to the ticket, then closes; the v2 ladder otherwise",
];

const OPEN: readonly string[] = [
  "Whether a held row's move, when it lands, should animate from where it was — the eye loses a row that teleports",
  "The rest of VC-108's surfaces: tab strips, the board card's unread count, the project rail's aggregate, and the durable read receipt behind all of them",
  "Ticket peek on the BOARD's cards — the same card, so the brief's “other surfaces” is one component",
  "Whether the rail's fold eyebrow (“Sessions ›”) should peek its record while folded",
  "Summary freshness, question identity and send/undo guarantees stay runtime contracts (see the v2 README)",
];

/* ------------------------------------------------------------------ scratch */

type FolderViewState = FolderView & { readonly key: string | null };

export default function SessionPeekSidebarsScratch() {
  const [folderPeek, setFolderPeek] = React.useState<FolderPeek>("ticket");
  const [folderFace, setFolderFace] = React.useState<FolderFace>("count");
  const [markStyle, setMarkStyle] = React.useState<MarkStyle>("badge");
  const [switchMode, setSwitchMode] = React.useState<"warm" | "full">("warm");
  const [dwell, setDwell] = React.useState<DwellMs>(DEFAULT_DWELL);
  const [hoverEnabled, setHoverEnabled] = React.useState(true);
  const [outcome, setOutcome] = React.useState<SendOutcome>("success");
  const [orderMode, setOrderMode] = React.useState<OrderMode>("held");
  const [questions, setQuestions] = React.useState<QuestionRule>("float");
  const [peekReads, setPeekReads] = React.useState<PeekReads>("never");
  const [holdWhilePointing, setHoldWhilePointing] = React.useState(true);

  /* ------------------------------------------------------------ the world */

  const [world, setWorld] = React.useState<World>(WORLD_START);
  const act = React.useCallback(
    (...events: readonly WorldEvent[]) => setWorld((current) => events.reduce(applyWorld, current)),
    [],
  );
  const [scriptAt, setScriptAt] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [lastNote, setLastNote] = React.useState<string | null>(null);
  /** What the held band last committed to (see `sidebar-live.ts`). */
  const [committed, setCommitted] = React.useState<HeldOrder | null>(null);
  /** Whether the pointer is in either sidebar — one of the two things that hold the band still. */
  const [pointing, setPointing] = React.useState(false);

  /** What the person is focused on — what a peek must never take them away from. */
  const [inFront, setInFront] = React.useState<string>(FIRST_IN_FRONT);
  const [railTicketId, setRailTicketId] = React.useState(RAIL_TICKET_ID);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const [recordOpen, setRecordOpen] = React.useState(false);

  // The shipped builder, over this moment of the world: the band membership
  // and the order it would draw.
  const listing = React.useMemo(
    () => buildActiveSessionListing({ ...listingInputOf(world), now: world.now }),
    // The unread map cannot change a listing; only time and the live fields can.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [world.now, world.sessions],
  );
  const members = React.useMemo(
    () => activeMembers(listing, world.unread),
    [listing, world.unread],
  );
  const orderTarget = React.useMemo(
    () =>
      orderMode === "live"
        ? members.map((row) => row.id)
        : heldTarget(committed, members, questions),
    [committed, members, orderMode, questions],
  );

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
    // A row that moves takes its card with it (the live order does that
    // mid-read; the held order never moves a row while a card is open).
    layoutKey: `${folderPeek}|${markStyle}|${folderViewState.drill}|${folderViewState.page}|${orderTarget.join()}|${committed?.order.join() ?? ""}`,
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

  /* ------------------------------------------------------------- the bands */

  /**
   * Held still: the pointer is in a sidebar, or a peek is open — the two
   * moments a person is aiming at a row. The live (shipped) order never holds.
   */
  const frozen = orderMode === "held" && holdWhilePointing && (pointing || shown !== null);
  const displayIds =
    frozen && committed !== null
      ? frozenOrder(
          committed,
          members.map((row) => row.id),
        )
      : orderTarget;
  const waitingMoves = frozen && committed !== null && displayIds.join() !== orderTarget.join();

  // Commit whatever the band may now draw. Live commits every build, so a
  // switch to held starts from the order on screen.
  React.useEffect(() => {
    if (frozen) return;
    const next = commitOf(orderTarget, members);
    setCommitted((current) => (sameOrder(current, next) ? current : next));
  }, [frozen, members, orderTarget]);

  const bands = React.useMemo(() => {
    const byId = new Map<string, ActiveSessionRow>(members.map((row) => [row.id, row]));
    // A frozen band still draws a row the clock or a read has retired: it
    // leaves when the person does, not from under the pointer.
    for (const row of listing.previous) if (!byId.has(row.id)) byId.set(row.id, asActiveRow(row));
    const active = displayIds.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
    const inActive = new Set(active.map((row) => row.id));
    const previous = listing.previous.filter((row) => !inActive.has(row.id));
    const entries = groupPreviousByTicket(previous);
    const folders = folderSessions(entries);
    return {
      active,
      previous,
      entries,
      folders,
      activeById: new Map(active.map((row) => [row.id, row])),
      previousById: new Map(previous.map((row) => [row.id, row])),
      /** The folder each Previous Session sits in, so opening one can reveal it (the shipped rule). */
      folderOf: new Map(
        [...folders].flatMap(([ticketId, rowIds]) =>
          rowIds.map((rowId) => [rowId, ticketId] as const),
        ),
      ),
    };
  }, [displayIds, listing.previous, members]);

  const isUnread = (rowId: string) => world.unread[corpusIdOf(rowId)] !== undefined;
  const toggleUnread = React.useCallback(
    (rowId: string) => {
      const id = corpusIdOf(rowId);
      act({ kind: world.unread[id] === undefined ? "unread" : "read", id });
    },
    [act, world.unread],
  );

  /**
   * Whether this row's answer landed. The world is the truth for the row's
   * state; this only tells the card to stop offering the question — and only
   * while the world agrees, so a Reset that restores the question restores it.
   */
  const delivered = (rowId: string) =>
    state.delivered[rowId] !== undefined &&
    liveOf(world, corpusIdOf(rowId))?.activity !== "waiting";

  const listed = (rowId: string): ListedSession | null => {
    const active = bands.activeById.get(rowId);
    // The world already says what a delivered answer did to the row.
    if (active !== undefined) return listedActive(active, false);
    const previous = bands.previousById.get(rowId);
    return previous === undefined ? null : listedPrevious(previous);
  };

  const mark = (
    rowId: string,
    size: MarkSize = "row",
    surface: MarkSurface = "sidebar",
    style: MarkStyle = markStyle,
  ) => {
    const session = corpusOf(rowId);
    const row = listed(rowId);
    if (session === undefined || row === null) return null;
    return (
      <RowMark
        style={style}
        vendor={session.vendor}
        kind={session.kind}
        state={row.state}
        name={markName(session, row.state)}
        size={size}
        surface={surface}
      />
    );
  };

  /**
   * Opening: the one gesture that changes what is in front, and the plainest
   * way to read a Session. The peek closes behind it.
   */
  const activate = React.useCallback(
    (rowId: string) => {
      setInFront(rowId);
      act({ kind: "read", id: corpusIdOf(rowId) });
      const row = bands.activeById.get(rowId) ?? bands.previousById.get(rowId);
      if (row?.ticket) setRailTicketId(row.ticket.id);
      // The shipped band reveals the folder a newly selected Session sits in.
      const folder = bands.folderOf.get(rowId);
      if (folder !== undefined) setExpanded((current) => new Set(current).add(folder));
      if (state.pinned !== null) dispatch({ type: "unpin" });
      dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
    },
    [act, bands, dispatch, state.pinned],
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
    // U: read or unread, from the keyboard, on any Session row in either sidebar.
    if ((event.key === "u" || event.key === "U") && folderTicketId(target.rowId) === null) {
      event.preventDefault();
      toggleUnread(target.rowId);
      return true;
    }
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

  const subject =
    shown === null ? null : peekSubject(shown.rowId, folderPeek, bands.folders, folderView);

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
                  mark: mark(rowId, "two-line", "popover"),
                  age: row.at > 0 ? compactAge(row.at, world.now) : "",
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
              fixture={sessionFixture(row, session, PREFIX, world.now)}
              unread={isUnread(subject.rowId)}
              state={state}
              position={peek.position}
              width={PEEK_WIDTH}
              summaryState="ready"
              dispatch={dispatch}
              delivered={delivered(subject.rowId)}
              glyph={mark(subject.rowId, "card", "popover")}
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
              onLook={() => {
                // The transcript is the Session itself: looking at it reads it.
                act({ kind: "read", id: corpusIdOf(subject.rowId) });
                peek.look(subject.rowId);
              }}
              onClose={() => dispatch({ type: "escape", now: Date.now() })}
              {...peek.cardProps}
            />
          </div>
        );
      }
    }
  }

  /* --------------------------------------------------- what reads a Session */

  /** The Session whose card is on screen, if the card is about one. */
  const peekedRowId =
    card !== null && subject?.kind === "session" && peek.looking === null ? subject.rowId : null;
  const peekedUnread = peekedRowId !== null && isUnread(peekedRowId);
  React.useEffect(() => {
    if (peekedRowId === null || !peekedUnread || peekReads === "never") return;
    const read = () => act({ kind: "read", id: corpusIdOf(peekedRowId) });
    if (peekReads === "open") {
      read();
      return;
    }
    // A look, not a pass: the card has to stay up long enough to be read.
    const timer = window.setTimeout(read, PEEK_READ_MS);
    return () => window.clearTimeout(timer);
  }, [act, peekReads, peekedRowId, peekedUnread]);

  /**
   * A delivered reply is the world's news too: an answer resumes the turn, a
   * message to a quiet Session starts one, and either way the person has
   * read it. Undo within the window puts the Session back as it was.
   */
  const applied = React.useRef(new Map<string, number>());
  const beforeSend = React.useRef(new Map<string, LiveOverlay | null>());
  React.useEffect(() => {
    for (const [rowId, entry] of Object.entries(state.delivered)) {
      if (applied.current.get(rowId) === entry.at) continue;
      applied.current.set(rowId, entry.at);
      const id = corpusIdOf(rowId);
      beforeSend.current.set(rowId, world.sessions[id] ?? null);
      const activity = liveOf(world, id)?.activity;
      act(
        activity === "waiting"
          ? { kind: "answer", id }
          : activity === "working"
            ? { kind: "tool-call", id }
            : { kind: "turn-start", id },
        { kind: "read", id },
      );
    }
    for (const rowId of applied.current.keys()) {
      if (state.delivered[rowId] !== undefined) continue;
      applied.current.delete(rowId);
      act({
        kind: "restore",
        id: corpusIdOf(rowId),
        overlay: beforeSend.current.get(rowId) ?? null,
      });
    }
    // Only a change in what was delivered is news; the world it reads is current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.delivered]);

  /* ------------------------------------------------------------- playback */

  const stepOnce = React.useCallback(() => {
    const next = SCRIPT[scriptAt];
    if (next === undefined) return;
    act(...scriptEvents(next, corpusIdOf(inFront)));
    setLastNote(next.note);
    setScriptAt(scriptAt + 1);
  }, [act, inFront, scriptAt]);

  React.useEffect(() => {
    if (!playing) return;
    if (scriptAt >= SCRIPT.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(stepOnce, PLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, scriptAt, stepOnce]);

  const reset = () => {
    setPlaying(false);
    // Forget the sends first, so clearing them below is not read as an Undo.
    applied.current.clear();
    beforeSend.current.clear();
    for (const rowId of Object.keys(state.delivered)) dispatch({ type: "undo", rowId });
    dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
    setWorld(WORLD_START);
    setScriptAt(0);
    setLastNote(null);
    setCommitted(null);
    setInFront(FIRST_IN_FRONT);
    setRailTicketId(RAIL_TICKET_ID);
  };

  const lookingRow = peek.looking === null ? null : listed(peek.looking);
  const lookingSession = peek.looking === null ? undefined : corpusOf(peek.looking);
  const lookingFixture =
    lookingRow === null || lookingSession === undefined
      ? null
      : sessionFixture(lookingRow, lookingSession, PREFIX, world.now);

  /* ------------------------------------------------------------ the bands */

  const selectedFolder = bands.folderOf.get(inFront) ?? null;

  const activeBand = (
    <SidebarGroup data-session-band="active" className="gap-1">
      <SessionBandHeader label="Active" count={bands.active.length} />
      <SidebarMenu>
        {bands.active.map((row: ActiveSessionRow) => (
          <ActiveRow
            key={row.id}
            row={row}
            ticketPrefix={PREFIX}
            now={world.now}
            selected={row.id === inFront}
            working={listedActive(row, false).state === "working"}
            unread={isUnread(row.id)}
            mark={mark(row.id, "two-line")}
            onActivate={activate}
            onToggleUnread={toggleUnread}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );

  const previousRow = (row: PreviousSessionRow, showIdentity: boolean) => (
    <PreviousRow
      key={row.id}
      row={row}
      ticketPrefix={PREFIX}
      now={world.now}
      selected={row.id === inFront}
      mark={mark(row.id)}
      showIdentity={showIdentity}
      onActivate={activate}
      onMarkUnread={toggleUnread}
    />
  );

  const previousBand = (
    <SidebarGroup data-session-band="previous" className="gap-1 pt-0">
      <SessionBandHeader label="Previous" count={bands.previous.length} />
      <SidebarMenu>
        {bands.entries.map((entry) =>
          entry.kind === "session" ? (
            previousRow(entry.row, true)
          ) : (
            <SidebarMenuItem key={entry.id} data-peek-folder={entry.id}>
              <FolderRow
                ticket={entry.ticket}
                ticketPrefix={PREFIX}
                count={entry.rows.length}
                newestAt={entry.newestAt}
                now={world.now}
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
  // The rail lists the ticket's Sessions in the band's own order, so a held
  // row holds in both sidebars at once.
  const roster = railRoster(bands, railTicketId);
  const railRow = (rowId: string, rowTitle: string) => {
    const row = listed(rowId);
    return (
      <RailRow
        key={rowId}
        rowId={rowId}
        title={rowTitle}
        mark={mark(rowId, "two-line")}
        at={row === null || row.at <= 0 ? null : row.at}
        now={world.now}
        working={row?.state === "working"}
        unread={isUnread(rowId)}
        selected={rowId === inFront}
        onActivate={activate}
        onToggleUnread={toggleUnread}
      />
    );
  };

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
          onPointerEnter={() => setPointing(true)}
          onPointerLeave={() => setPointing(false)}
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

        <div data-lab-controls="" className="flex max-w-[720px] flex-col gap-4">
          <section
            aria-label="Play the afternoon"
            className="flex flex-col gap-3 rounded-xl border border-border p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-ui font-medium">Play the afternoon</h2>
              <span className="text-ui text-muted-foreground tabular-nums">
                {scriptAt} / {SCRIPT.length} · +{Math.round((world.now - WORLD_START.now) / 1000)}s
              </span>
              <div className="ml-auto flex gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  disabled={scriptAt >= SCRIPT.length}
                  onClick={() => setPlaying((on) => !on)}
                >
                  {playing ? "Pause" : "Play"}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={playing || scriptAt >= SCRIPT.length}
                  onClick={stepOnce}
                >
                  Step
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={reset}>
                  Reset
                </Button>
              </div>
            </div>
            <p className="text-ui text-muted-foreground" aria-live="polite">
              {lastNote ??
                "Two working Sessions trade tool calls, one finishes out of sight, a quiet one starts a turn, one asks a question. Play it once held and once live."}
            </p>
            {waitingMoves ? (
              <p data-waiting-moves="" className="text-ui text-info">
                Held while you point — the band catches up when the pointer leaves the sidebars and
                no peek is open.
              </p>
            ) : null}
          </section>

          <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4">
            <h2 className="text-ui font-medium">Decided — switchable only to compare</h2>
            <Choice<OrderMode>
              label="Active order"
              value={orderMode}
              options={[
                ["held", "Held ✓"],
                ["live", "Live recency (shipped)"],
              ]}
              onChange={setOrderMode}
            />
            <Choice<QuestionRule>
              label="A question"
              value={questions}
              options={[
                ["float", "Floats to the top ✓"],
                ["hold", "Holds its place"],
              ]}
              onChange={setQuestions}
            />
            <Choice<PeekReads>
              label="Peek reads"
              value={peekReads}
              options={[
                ["never", "Never — only opening does ✓"],
                ["look", "After a 1s look"],
                ["open", "As soon as it opens"],
              ]}
              onChange={setPeekReads}
            />
            <Choice<"hold" | "land">
              label="While pointing"
              value={holdWhilePointing ? "hold" : "land"}
              options={[
                ["hold", "Moves wait ✓"],
                ["land", "Moves land at once"],
              ]}
              onChange={(next) => setHoldWhilePointing(next === "hold")}
            />
            <Choice<FolderPeek>
              label="Folder hover"
              value={folderPeek}
              options={[
                ["ticket", "Ticket ✓"],
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
                ["count", "Count ✓"],
                ["marks", "Who worked on it"],
              ]}
              onChange={setFolderFace}
            />
            <Choice<MarkStyle>
              label="Row mark"
              value={markStyle}
              options={[
                ["badge", "Logo + badge ✓"],
                ["ink", "Status ink (VC-402)"],
                ["dot", "Dot (shipped)"],
              ]}
              onChange={setMarkStyle}
            />
            <Choice<`${DwellMs}`>
              label="Dwell"
              value={`${dwell}`}
              options={DWELL_CHOICES.map(
                (ms) => [`${ms}`, ms === DEFAULT_DWELL ? `${ms}ms ✓` : `${ms}ms`] as const,
              )}
              onChange={(next) => setDwell(Number(next) as DwellMs)}
            />
            <Choice<"warm" | "full">
              label="Next row"
              value={switchMode}
              options={[
                ["warm", `Warm · ${WARM_DWELL_MS}ms ✓`],
                ["full", "Full dwell"],
              ]}
              onChange={setSwitchMode}
            />
          </section>

          <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
            <h2 className="text-ui font-medium">Tuning</h2>
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
                onClick={() => setExpanded(new Set(bands.folders.keys()))}
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
          </section>
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
        onPointerEnter={() => setPointing(true)}
        onPointerLeave={() => setPointing(false)}
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
