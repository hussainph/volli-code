/**
 * VC-69 — nesting same-ticket sessions under their ticket, flat and nested side
 * by side, over the real listing builder.
 *
 * **The question this exists to answer is density, not markup.** Nesting reads
 * beautifully in a mock of six rows and can be ruinous at the length a real
 * sidebar reaches, so the only useful prototype is one driven by a realistic
 * distribution. The fixture below is not invented: it reproduces the shape
 * measured from this project's own `volli session list` on 2026-01 — 141
 * ticketed sessions over 50 tickets, a sessions-per-ticket histogram of
 * {@link SESSIONS_PER_TICKET}, and the 45% of sessions still titled "Chat".
 * Those three numbers are the whole argument, and a fixture that softened any
 * of them would flatter the design into looking more scannable than the sidebar
 * it has to survive.
 *
 * What the measurement said:
 *
 *   • **Concurrency inside one ticket is rare; accumulation is the norm.** 68%
 *     of tickets end up with more than one session, but only 21 of 50 ever had
 *     two live inside the 30-minute Active window, and the peak was three. So
 *     the Active band is where nesting costs the most and buys the least, and
 *     the Previous band is the reverse: 141 rows sorted flat by global recency,
 *     where a ticket's eight sessions are never adjacent.
 *
 * **DECIDED, after driving this scratch: Active is not grouped at all.**
 * Bracketing an Active cluster made the band messy and put a step between the
 * reader and a session they can currently reach in one click — and Active's
 * whole job is to be the fastest surface in the app. The identity problem it
 * was reaching for ("which of these three is which") is a peeking problem, not
 * a hierarchy problem, and belongs to VC-30's hover-peek. So this scratch now
 * draws one change and only one: **Previous gets real disclosure, collapsed by
 * default** (141 rows → 50). Both columns' Active bands are identical, on
 * purpose — that identity IS the decision, and the Active load switch stays so
 * the flat band can still be judged at the busiest moment the data contains.
 *
 * That decision is also what makes the design cheap. The ticket's "collapsed
 * state still shows attention cues" was the hard half, and it dissolves rather
 * than being solved: an attention row is pinned to Active however old it is, so
 * the Previous band holds no attention to aggregate and no collapsed parent
 * ever has to stand in for one. See {@link TicketGroupRow}.
 *
 * Both columns run the same `buildActiveSessionListing` over the same input and
 * the same clock. Everything that differs between them is drawing. The flat
 * column is the shipped `ActiveBandRow`/`PreviousBandRow` verbatim; the nested
 * column reuses those same two components wherever the proposal does not change
 * a row's internals, so a difference you can see is a difference the design
 * makes and not one this file introduced.
 *
 * {@link Options.parentForSingletons} is off by default and is the most
 * consequential switch left. A parent row over a group of one is pure overhead,
 * and 16 of the 50 tickets are groups of one — turn it on and watch a third of
 * the band grow a row that says what the row beneath it already said.
 *
 * The one place that is not true is {@link Options.hideChildIdentity}, which
 * does change a row's internals and so needs the local variant
 * {@link NestedPreviousRow}. That is deliberate and it is the point of that
 * switch: nesting makes a child's ticket id redundant, and the id lane is about
 * 45px in a row whose titles already truncate. Toggle it to find out whether
 * reclaiming that width is worth a prop on the shipped row.
 */
import * as React from "react";
import type { ChatSessionRecord, Ticket } from "@volli/shared";

import {
  buildActiveSessionListing,
  groupPreviousByTicket,
  type ActiveSessionRow,
  type BuildActiveSessionListingInput,
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
import {
  Sidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarProvider,
} from "@renderer/components/ui/sidebar";
import { cn } from "@renderer/lib/utils";

import { NOW, project } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Sidebar · Ticket nesting (VC-69)";
export const note = "Flat vs nested over a measured 141-session distribution";

export const seed = seedApp;
export const api = appApi;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Fixture — the measured distribution, generated deterministically.
// ---------------------------------------------------------------------------

/**
 * Sessions-per-ticket, as counted from this project's real listing: 16 tickets
 * with one session, 12 with two, and a tail out to a single ticket with eight.
 * 50 tickets, 141 sessions, mean 2.82.
 *
 * The tail is the part that matters. A histogram truncated at three would make
 * disclosure look like a rounding error; the ticket with eight is the one whose
 * sessions are scattered the width of the whole band today.
 */
const SESSIONS_PER_TICKET: readonly (readonly [count: number, tickets: number])[] = [
  [1, 16],
  [2, 12],
  [3, 5],
  [4, 8],
  [5, 4],
  [6, 2],
  [7, 2],
  [8, 1],
];

/**
 * Realistic ticket titles, because the sidebar truncates and a fixture of
 * `Ticket 31` would never show where. Lengths are deliberately uneven — the
 * shortest fits, the longest cannot, and both cases have to look composed.
 */
const TICKET_TITLES: readonly string[] = [
  "Inline diff gutter drops decorations on rapid scroll",
  "Warm-park sessions after 10 minutes idle",
  "Restore split-pane focus after a device-loss recovery",
  "Ghostty config adapter: honor `window-padding-balance`",
  "Board card hover state loses the priority indicator",
  "Persist the harness picker's last choice per project",
  "Command palette: fuzzy-match ticket titles",
  "Archive worktrees on TTL instead of prompting",
  "Stream transcripts straight to the event log",
  "Per-project accent tint derived from the rail tile color",
  "Sweep orphaned worktrees left by a hard crash",
  "Notification when a session blocks on input",
  "Move ticket ordering into the shared state machine",
  "Collapse the adapter registry into one injected port",
  "Resume semantics: separate recreation from history",
  "Context window pill overflows at four digits",
  "Scroll anchoring in the transcript view",
  "Composer loses draft text on project switch",
  "Auto-title sessions from the first exchange",
  "Rename worktree branches on ticket retitle",
  "Diff view: collapse unchanged hunks by default",
  "Settings search across every section",
  "Quit confirmation when a turn is in flight",
  "Terminal bell routes to a system notification",
  "Attachment upload retries on transient failure",
  "Model picker remembers reasoning level per project",
  "Skills index refuses to load past one bad entry",
  "Keyboard map for pane focus without the mouse",
  "SQLite WAL checkpoint on idle rather than on quit",
  "Board drag lands the card in the wrong order slot",
  "Ticket rail history search matches harness names",
  "Deep link into a session from an external URL",
  "Theme canvas editor: undo the last stop move",
  "Traffic lights overlap the chrome bar at 1024px",
  "Worktree removal blocks on an open editor handle",
  "Session events tolerate an unknown kind on read",
  "Prompt baseline drifts from the shipped template",
  "Update check backs off after three failures",
  "Chat feed line heights collapse in dense mode",
  "Permission prompts queue instead of racing",
  "Empty states for a project with no tickets",
  "Ticket labels: inline create from the picker",
  "Export a transcript as portable markdown",
  "Split pane ratio persists per tab",
  "Crash reporter strips worktree paths",
  "Board columns remember their scroll offset",
  "Harness trust hash mismatch surfaces a recovery",
  "Reduced-motion path for the sweep animation",
  "CLI socket reconnects after a main-process restart",
  "First-run canvas explains the import step",
];

/**
 * Session titles a reader can tell apart, and the fallback they mostly cannot.
 *
 * `"Chat"` is not filler here — it is 45% of the real corpus, and 17 tickets
 * have two or more sessions where every one of them is called `"Chat"`. It is
 * the reason nesting alone does not answer "which chat is this", and a fixture
 * that named every row would hide that.
 */
const NAMED_SESSION_TITLES: readonly string[] = [
  "Scope and plan",
  "Implementation",
  "Code review",
  "Review fixes",
  "Merge conflict fix",
  "Re-review after rebase",
  "Trace the regression",
  "Validate the fix",
  "Second pass on the model",
  "Smoke failure recheck",
  "Spike: does this even work",
  "Follow-up cleanup",
];

/** Fraction of generated sessions left on the neutral `"Chat"` fallback. See above. */
const GENERIC_TITLE_SHARE = 0.45;

/** Deterministic PRNG, so both columns and every reload see the same corpus. */
function mulberry32(seedValue: number): () => number {
  let a = seedValue;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ticketOf(index: number): Ticket {
  // Statuses spread across the three columns a live sidebar draws from, and
  // never `done` — a Done ticket's sessions are on a one-hour linger, which is
  // a cleanup question and not this scratch's.
  const status = index % 5 === 0 ? "needs_review" : index % 3 === 0 ? "doing" : "todo";
  return {
    id: `tkt-${index}`,
    projectId: project.id,
    ticketNumber: index,
    title: TICKET_TITLES[index % TICKET_TITLES.length] ?? "Untitled",
    body: "",
    status,
    priority: index % 4 === 0 ? "high" : index % 3 === 0 ? "low" : "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: index,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - HOUR,
  };
}

/** The 50-ticket board every load draws from. Numbered from 1 so the ids read like ids. */
const TICKETS: readonly Ticket[] = Array.from({ length: 50 }, (_, index) => ticketOf(index + 1));

function chatRecord(
  overrides: Partial<ChatSessionRecord> &
    Pick<ChatSessionRecord, "sessionId" | "ticketId" | "title" | "lastActivityAt">,
): ChatSessionRecord {
  return {
    projectId: project.id,
    createdAt: overrides.lastActivityAt - 40 * MINUTE,
    adapterId: "claude-code",
    live: false,
    activity: "idle",
    waitingOn: null,
    bornTicketless: overrides.ticketId === null,
    ...overrides,
  };
}

/**
 * The Active band at the typical moment, taken from the real reading: four
 * chats inside eleven minutes, on four different tickets, one of them asking a
 * question.
 *
 * This is the load that decides whether nesting Active is worth anything. Every
 * cluster here is a group of one, so the honest answer for this shape is that
 * grouping has nothing to group — which is exactly why the proposal's Active
 * treatment is adjacency (free) rather than disclosure (a row per cluster).
 */
const ACTIVE_TYPICAL: readonly ChatSessionRecord[] = [
  chatRecord({
    sessionId: "act-1",
    ticketId: "tkt-7",
    title: "Sidebar nesting exploration",
    activity: "working",
    live: true,
    lastActivityAt: NOW - 10 * 1000,
  }),
  chatRecord({
    sessionId: "act-2",
    ticketId: "tkt-19",
    title: "Auto-title v2 implementation",
    activity: "waiting",
    waitingOn: "question",
    live: true,
    lastActivityAt: NOW - 3 * MINUTE,
  }),
  chatRecord({
    sessionId: "act-3",
    ticketId: "tkt-31",
    title: "Squiggly line bug CR",
    live: true,
    lastActivityAt: NOW - 9 * MINUTE,
  }),
  chatRecord({
    sessionId: "act-4",
    ticketId: "tkt-44",
    title: "Post-ticket worktree PR review",
    lastActivityAt: NOW - 11 * MINUTE,
  }),
];

/**
 * The Active band at the busiest moment the measurement found: fourteen rows
 * across eight tickets, six of those tickets holding two or three at once.
 *
 * The load nesting is FOR. Read the flat column here and the same ticket id
 * appears three times without ever being adjacent to itself; that is the
 * complaint VC-69 was filed about, at the one moment it is genuinely true of
 * the Active band.
 */
const ACTIVE_PEAK: readonly ChatSessionRecord[] = (() => {
  const spread: readonly (readonly [ticket: string, count: number])[] = [
    ["tkt-12", 3],
    ["tkt-11", 3],
    ["tkt-16", 2],
    ["tkt-7", 2],
    ["tkt-3", 2],
    ["tkt-31", 1],
    ["tkt-44", 1],
  ];
  const random = mulberry32(99);
  const rows: ChatSessionRecord[] = [];
  let index = 0;
  for (const [ticketId, count] of spread) {
    for (let n = 0; n < count; n += 1) {
      index += 1;
      // Ages scattered across the window rather than blocked per ticket, so the
      // flat column interleaves them the way the recency sort really does.
      const at = NOW - Math.round(random() * 28 * MINUTE);
      const waiting = index === 2 || index === 9;
      rows.push(
        chatRecord({
          sessionId: `peak-${index}`,
          ticketId,
          title:
            random() < GENERIC_TITLE_SHARE
              ? "Chat"
              : (NAMED_SESSION_TITLES[index % NAMED_SESSION_TITLES.length] ?? "Chat"),
          live: true,
          activity: waiting ? "waiting" : index % 3 === 0 ? "working" : "idle",
          waitingOn: waiting ? (index === 2 ? "question" : "permission") : null,
          lastActivityAt: at,
        }),
      );
    }
  }
  return rows;
})();

/**
 * Everything past the quiet window, generated from {@link SESSIONS_PER_TICKET}.
 *
 * Ages run from 40 minutes to just inside {@link PREVIOUS_MAX_AGE_MS}, which is
 * what makes the band its real length. No ticket here is given a
 * `statusEnteredAt` entry, so the two cleanup rules that need column history
 * stay silent by design and every generated row survives to be counted — the
 * band's length is the thing under test, and a cleanup rule quietly halving it
 * would answer a different question.
 */
const PREVIOUS_ALL: readonly ChatSessionRecord[] = (() => {
  const random = mulberry32(7);
  const rows: ChatSessionRecord[] = [];
  let ticketIndex = 0;
  let sessionIndex = 0;
  for (const [count, ticketCount] of SESSIONS_PER_TICKET) {
    for (let t = 0; t < ticketCount; t += 1) {
      const ticket = TICKETS[ticketIndex % TICKETS.length];
      ticketIndex += 1;
      if (ticket === undefined) continue;
      for (let n = 0; n < count; n += 1) {
        sessionIndex += 1;
        // Skewed toward recent: a real corpus is denser near now, which is what
        // makes the top of the band the crowded part.
        const age = 40 * MINUTE + Math.pow(random(), 1.7) * (6.5 * DAY);
        rows.push(
          chatRecord({
            sessionId: `prev-${sessionIndex}`,
            ticketId: ticket.id,
            title:
              random() < GENERIC_TITLE_SHARE
                ? "Chat"
                : (NAMED_SESSION_TITLES[sessionIndex % NAMED_SESSION_TITLES.length] ?? "Chat"),
            lastActivityAt: NOW - Math.round(age),
          }),
        );
      }
    }
  }
  // Three ticketless (project) sessions, which VC-54 keeps top-level under Home
  // and which nesting must therefore leave alone. They are the raggedness test:
  // a band where some rows sit at depth 0 and some at depth 1.
  rows.push(
    chatRecord({
      sessionId: "prev-scratch-1",
      ticketId: null,
      title: "v0.1.0 launch tickets",
      lastActivityAt: NOW - 5 * HOUR,
    }),
    chatRecord({
      sessionId: "prev-scratch-2",
      ticketId: null,
      title: "Chat",
      lastActivityAt: NOW - 26 * HOUR,
    }),
    chatRecord({
      sessionId: "prev-scratch-3",
      ticketId: null,
      title: "Backlog scan and progress",
      lastActivityAt: NOW - 3 * DAY,
    }),
  );
  return rows;
})();

type ActiveLoad = "typical" | "peak";
type PreviousDepth = "days" | "week";

/** Everything the builder reads except the clock and the filter, for one load. */
function loadInput(
  activeLoad: ActiveLoad,
  depth: PreviousDepth,
): Omit<BuildActiveSessionListingInput, "now" | "filter"> {
  const cutoff = depth === "days" ? 2 * DAY : 7 * DAY;
  return {
    tickets: TICKETS,
    containers: {},
    signalsByTicket: {},
    records: [],
    chatSessions: [
      ...(activeLoad === "peak" ? ACTIVE_PEAK : ACTIVE_TYPICAL),
      ...PREVIOUS_ALL.filter((row) => NOW - row.lastActivityAt <= cutoff),
    ],
    lastOutputAt: {},
    parkState: {},
    harness: {},
    statusEnteredAt: new Map(),
  };
}

// ---------------------------------------------------------------------------
// The bands. Both columns draw SHIPPED components over the SHIPPED model.
// ---------------------------------------------------------------------------

/**
 * The nesting rule under a ticket entry — the same string `active-sessions.tsx`
 * uses, kept in sync by being read for the same reason rather than copied for a
 * different one. See that module for why stock `SidebarMenuSub` spacing is too
 * wide for a row whose title already truncates.
 */
const NEST_RULE = "mx-0 ml-2 gap-1 py-0 pr-0 pl-2";

/**
 * The Active band — flat in both columns, which is the decision rather than an
 * omission. See the module doc: bracketing Active clusters cost a click into
 * the app's fastest surface and bought clutter, and "which of these three is
 * which" is VC-30's hover-peek.
 */
function ActiveBand({
  rows,
  selectedId,
  onSelect,
}: {
  rows: readonly ActiveSessionRow[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const select = (row: ActiveSessionRow): void => onSelect(row.id);
  return (
    <SidebarMenu>
      {rows.map((row) => (
        <ActiveBandRow
          key={row.id}
          row={row}
          ticketPrefix={project.ticketPrefix}
          selected={row.id === selectedId}
          onSelect={select}
        />
      ))}
    </SidebarMenu>
  );
}

/**
 * The Previous band, flat or grouped.
 *
 * The grouped arm is now the SHIPPED arrangement: `groupPreviousByTicket` from
 * the listing model and `TicketGroupRow` from the band rows, drawn exactly as
 * `active-sessions.tsx` draws them. Nothing about the design lives in this file
 * any more — the scratch's remaining job is the one thing the app cannot show
 * you on demand, which is both arrangements side by side at a realistic length.
 */
function PreviousBand({
  rows,
  nested,
  now,
  openIds,
  onToggle,
  selectedId,
  onSelect,
}: {
  rows: readonly PreviousSessionRow[];
  nested: boolean;
  now: number;
  openIds: ReadonlySet<string>;
  onToggle(id: string): void;
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const select = (row: PreviousSessionRow): void => onSelect(row.id);
  const row = (previous: PreviousSessionRow, showIdentity: boolean) => (
    <PreviousBandRow
      key={previous.id}
      row={previous}
      ticketPrefix={project.ticketPrefix}
      now={now}
      selected={previous.id === selectedId}
      onSelect={select}
      showIdentity={showIdentity}
    />
  );

  if (!nested) {
    return <SidebarMenu>{rows.map((previous) => row(previous, true))}</SidebarMenu>;
  }

  return (
    <SidebarMenu>
      {groupPreviousByTicket(rows).map((entry) =>
        entry.kind === "session" ? (
          row(entry.row, true)
        ) : (
          <SidebarMenuItem key={entry.id}>
            <TicketGroupRow
              ticket={entry.ticket}
              ticketPrefix={project.ticketPrefix}
              count={entry.rows.length}
              newestAt={entry.newestAt}
              now={now}
              open={openIds.has(entry.id)}
              // The app reveals the selected row's group as well as marking it
              // (`active-sessions.tsx`); here the mark stands alone, which is
              // the state you get in the app by collapsing a group by hand.
              selected={entry.rows.some((previous) => previous.id === selectedId)}
              onToggle={onToggle}
            />
            {openIds.has(entry.id) ? (
              <SidebarMenuSub id={sessionGroupPanelId(entry.id)} className={NEST_RULE}>
                {entry.rows.map((previous) => row(previous, false))}
              </SidebarMenuSub>
            ) : null}
          </SidebarMenuItem>
        ),
      )}
    </SidebarMenu>
  );
}

/** One sidebar, in one presentation. Both columns are live and both are drivable. */
function SidebarColumn({
  heading,
  subheading,
  nested,
  listing,
  filter,
  onFilter,
  now,
  openIds,
  onToggle,
  selectedId,
  onSelect,
}: {
  heading: string;
  subheading: string;
  nested: boolean;
  listing: ReturnType<typeof buildActiveSessionListing>;
  filter: SessionBandFilter;
  onFilter(next: SessionBandFilter): void;
  now: number;
  openIds: ReadonlySet<string>;
  onToggle(id: string): void;
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="px-1">
        <div className="text-ui font-medium text-foreground">{heading}</div>
        <div className="font-mono text-label text-muted-foreground">{subheading}</div>
      </div>
      <SidebarProvider
        className="min-h-0 w-fit"
        style={{ "--sidebar-width": "264px" } as React.CSSProperties}
      >
        <Sidebar
          collapsible="none"
          className="max-h-[70vh] w-(--sidebar-width) overflow-y-auto rounded-xl border border-border py-2"
        >
          <SidebarGroup className="gap-1 py-0">
            <SessionBandHeader label="Active" count={listing.active.length} />
            {listing.active.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No active sessions</p>
            ) : (
              <ActiveBand rows={listing.active} selectedId={selectedId} onSelect={onSelect} />
            )}
          </SidebarGroup>

          <SidebarGroup className="mt-2 gap-1 py-0">
            <SessionBandHeader label="Previous" count={listing.previous.length}>
              <SessionBandFilterMenu filter={filter} onChange={onFilter} />
            </SessionBandHeader>
            {listing.previous.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">Nothing yet</p>
            ) : (
              <PreviousBand
                rows={listing.previous}
                nested={nested}
                now={now}
                openIds={openIds}
                onToggle={onToggle}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            )}
          </SidebarGroup>
        </Sidebar>
      </SidebarProvider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls and the row-count readout.
// ---------------------------------------------------------------------------

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(next: T): void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={key === value}
          onClick={() => onChange(key)}
          className={cn(
            "rounded-sm px-2 py-0.5 text-label transition-colors",
            key === value
              ? "bg-sidebar-accent-veil text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * What the two columns actually cost, counted the way a reader pays: rendered
 * rows, not sessions.
 *
 * This is the scratch's verdict line. A parent row is a row; a collapsed
 * cluster is one row standing for many. The percentage is the only honest
 * summary of whether nesting is adding or removing work for the eye.
 */
function DensityReadout({
  flatActive,
  flatPrevious,
  nestedActive,
  nestedPrevious,
}: {
  flatActive: number;
  flatPrevious: number;
  nestedActive: number;
  nestedPrevious: number;
}) {
  const flat = flatActive + flatPrevious;
  const nested = nestedActive + nestedPrevious;
  const delta = flat === 0 ? 0 : Math.round((100 * nested) / flat - 100);
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5 font-mono text-label text-muted-foreground">
      <dt>flat</dt>
      <dd className="tabular-nums">
        {flatActive} active · {flatPrevious} previous · {flat} rows
      </dd>
      <dt>nested</dt>
      <dd className="tabular-nums">
        {nestedActive} active · {nestedPrevious} previous · {nested} rows
      </dd>
      <dt className="text-foreground">delta</dt>
      <dd
        className={cn(
          "tabular-nums",
          delta > 0 ? "text-destructive" : delta < 0 ? "text-foreground" : "",
        )}
      >
        {delta > 0 ? "+" : ""}
        {delta}% rows {delta > 0 ? "added" : delta < 0 ? "removed" : "unchanged"}
      </dd>
    </dl>
  );
}

/** Rendered rows in the Previous band under one presentation — what the readout reports. */
function countPreviousRows(
  rows: readonly PreviousSessionRow[],
  openIds: ReadonlySet<string>,
): number {
  let total = 0;
  for (const entry of groupPreviousByTicket(rows)) {
    if (entry.kind === "session") {
      total += 1;
      continue;
    }
    total += 1;
    if (openIds.has(entry.id)) total += entry.rows.length;
  }
  return total;
}

export default function SidebarNestingScratch() {
  const [activeLoad, setActiveLoad] = React.useState<ActiveLoad>("typical");
  const [depth, setDepth] = React.useState<PreviousDepth>("week");
  const [filter, setFilter] = React.useState<SessionBandFilter>(DEFAULT_SESSION_BAND_FILTER);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  // Ticket ids whose group is open. The app keeps the same set per project in
  // `workspace.ts` (`expandedSessionGroups`); local state here because a
  // scratch has no workspace to belong to.
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(new Set());

  const now = NOW;
  const listing = React.useMemo(
    () =>
      buildActiveSessionListing({
        ...loadInput(activeLoad, depth),
        filter: {
          kinds: new Set(
            (["chat", "terminal"] as const).filter((kind) => filter.kinds[kind]),
          ) satisfies ReadonlySet<SessionRowKind>,
          showCleaned: filter.showCleaned,
        },
        now,
      }),
    [activeLoad, depth, filter, now],
  );

  const toggle = React.useCallback((id: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border/70 px-3 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-ui text-muted-foreground">
            Active load
            <Segmented<ActiveLoad>
              value={activeLoad}
              onChange={setActiveLoad}
              options={[
                ["typical", "Typical · 4 rows"],
                ["peak", "Peak · 14 rows"],
              ]}
            />
          </label>
          <label className="flex items-center gap-2 text-ui text-muted-foreground">
            Previous depth
            <Segmented<PreviousDepth>
              value={depth}
              onChange={setDepth}
              options={[
                ["days", "2 days"],
                ["week", "Full week"],
              ]}
            />
          </label>
          <button
            type="button"
            onClick={() => setOpenIds(new Set())}
            className="rounded-full border border-border px-2 py-0.5 font-mono text-label text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
          >
            collapse all
          </button>
        </div>

        <DensityReadout
          flatActive={listing.active.length}
          flatPrevious={listing.previous.length}
          nestedActive={listing.active.length}
          nestedPrevious={countPreviousRows(listing.previous, openIds)}
        />
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <SidebarColumn
          heading="Today"
          subheading="flat · every row a session"
          nested={false}
          listing={listing}
          filter={filter}
          onFilter={setFilter}
          now={now}
          openIds={openIds}
          onToggle={toggle}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <SidebarColumn
          heading="Shipped"
          subheading="active unchanged · previous grouped by ticket"
          nested
          listing={listing}
          filter={filter}
          onFilter={setFilter}
          now={now}
          openIds={openIds}
          onToggle={toggle}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
    </div>
  );
}
