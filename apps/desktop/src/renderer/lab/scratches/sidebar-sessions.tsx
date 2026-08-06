/**
 * The sidebar's two session bands — Active and Previous — as a blueprint for
 * the component that will replace `ActiveSessions`.
 *
 * Every row here comes out of `buildActiveSessionListing`, the real, tested
 * model, driven through its real input. That is the point of the scratch: the
 * bands are a function of ticket status, durable records, chat Sessions, live
 * panes, hook state and the CLOCK, and a mock that placed rows by hand would be
 * showing an opinion of the rules rather than the rules. What is new here is
 * only the drawing — the row, band and filter components below are what wave 3
 * is meant to port, not invent again.
 *
 * The clock is a slider. Almost everything interesting about these bands is a
 * time boundary — a Session going quiet for half an hour and falling out of
 * Active, a Done ticket's linger expiring and taking its Sessions with it — and
 * in the running app you reach those states by waiting for them. `now` is a
 * plain input to a pure function, so scrubbing it forward eight hours is a
 * faithful fast-forward rather than a simulation of one. `nextBoundaryAt` is the
 * model's own answer to "when does this list change on its own", so the scrubber
 * can jump exactly there.
 *
 * Two things worth watching:
 *
 *   • the filter belongs to PREVIOUS. `filter.kinds` is applied to the Previous
 *     band only, so the menu sits in that band's header rather than over the
 *     whole list — unchecking Terminals does not (and per the model, should not)
 *     empty the Active band of terminals;
 *   • an attention row never ages out. `attention !== null` short-circuits the
 *     quiet window, so a Session that asked a question stays pinned to the top
 *     of Active for as long as it is asking, however far the clock is scrubbed.
 */
import * as React from "react";
import { BroomIcon } from "@phosphor-icons/react/dist/csr/Broom";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FunnelSimpleIcon } from "@phosphor-icons/react/dist/csr/FunnelSimple";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { displayTicketId, type SessionActivityState, type Ticket } from "@volli/shared";

import {
  buildActiveSessionListing,
  type ActiveSessionRow,
  type PreviousSessionRow,
  type SessionRowKind,
} from "@renderer/components/sidebar/active-session-listing";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@renderer/components/ui/sidebar";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

import { NOW, project, sessionListingInput } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Sidebar · Session bands";
export const note = "Active + Previous over the real builder, on a scrubbable clock";

export const seed = seedApp;
export const api = appApi;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SCRUB_SPAN_MS = 8 * HOUR;

const ACTIVITY_LABEL: Record<SessionActivityState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  parked: "Parked",
  exited: "Exited",
};

/**
 * The working row's signal, borrowed from the owner's own shell-density probe:
 * in the sidebar a colour chip plus a slow title sweep, with orbs left to
 * chat-grade surfaces. Two opaque layers rather than `background-clip`, so the
 * ellipsis never picks up the bright copy; driven off `--sidebar-foreground` so
 * it survives the sidebar's token remap in either appearance.
 */
const WORKING_TITLE_CSS = `
@keyframes lab-band-title-sweep {
  from { -webkit-mask-position: 0 center; mask-position: 0 center; }
  to {
    -webkit-mask-position: calc(-1 * var(--lab-sweep-period)) center;
    mask-position: calc(-1 * var(--lab-sweep-period)) center;
  }
}
.lab-band-title-sweep {
  --lab-sweep-period: 7.5rem;
  position: relative;
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in oklab, var(--sidebar-foreground) 68%, transparent);
}
.lab-band-title-sweep > .lab-band-title-peak {
  position: absolute;
  inset: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--sidebar-foreground);
  pointer-events: none;
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, transparent 18%, #000 30%, #000 70%, transparent 82%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0%, transparent 18%, #000 30%, #000 70%, transparent 82%, transparent 100%);
  -webkit-mask-size: var(--lab-sweep-period) 100%;
  mask-size: var(--lab-sweep-period) 100%;
  -webkit-mask-repeat: repeat-x;
  mask-repeat: repeat-x;
  animation: lab-band-title-sweep 3.5s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .lab-band-title-sweep > .lab-band-title-peak { animation: none; opacity: 0; }
}
`;

/** "+0m" · "+35m" · "+2h 15m" — the scrub offset, never a wall clock the fixtures don't have. */
function formatOffset(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `+${rest}m` : `+${hours}h ${rest}m`;
}

/** The app's relative-time vocabulary, trimmed for a one-line row: "12m ago" → "12m". */
function compactAge(at: number, now: number): string {
  return relativeTime(at, now).replace(/ ago$/, "");
}

/**
 * Identity, in the one slot both bands give it: the ticket, or a globe for a
 * Session that has none. The globe is not decoration — a ticketless row is the
 * one row with no board card, no ticket rail and no second surface to be
 * reached from, so the list is the only place it exists.
 */
function RowIdentity({ ticket }: { ticket: Ticket | null }) {
  if (ticket === null) {
    return (
      <span className="flex shrink-0 items-center">
        <GlobeIcon weight="fill" aria-label="No ticket" className="size-3" />
      </span>
    );
  }
  return (
    <span className="shrink-0 font-mono">
      {displayTicketId(project.ticketPrefix, ticket.ticketNumber)}
    </span>
  );
}

function KindGlyph({ kind }: { kind: SessionRowKind }) {
  const Glyph = kind === "chat" ? ChatCircleIcon : TerminalWindowIcon;
  return (
    <span className="flex shrink-0 items-center">
      <Glyph weight="fill" aria-label={kind === "chat" ? "Chat" : "Terminal"} className="size-3" />
    </span>
  );
}

/**
 * The Active row's second line: why a human is needed, else what ended, else
 * what is running.
 *
 * The attention branch prints a `waiting` reason where the app's shipped row
 * drops it. Nothing produces one yet — a reason can only reach a row through a
 * `done`/`blocked` CLI signal — but the row that can show one is the one worth
 * prototyping, because the reason is the entire content of an attention row.
 */
function stateLine(row: ActiveSessionRow, now: number): string {
  const attention = row.attention;
  if (attention !== null) {
    const label =
      attention.signal === "done"
        ? "Ready"
        : attention.signal === "blocked"
          ? "Blocked"
          : "Waiting for you";
    return attention.reason === null ? label : `${label} · ${attention.reason}`;
  }
  if (row.lastRun !== null) {
    return row.lastRun.endedAt === null
      ? "Ended"
      : `Ended · ${relativeTime(row.lastRun.endedAt, now)}`;
  }
  if (row.activity === null) return row.source;
  if (row.activitySource === "silent") return `${row.source} · Not reporting`;
  return `${row.source} · ${ACTIVITY_LABEL[row.activity]}`;
}

/**
 * Two lines: what it is, then who it belongs to and what it is doing.
 *
 * The dot carries the three states worth telling apart at a glance — a human is
 * needed, an agent is running, nothing is happening — and the working row's
 * title sweeps rather than growing a second colour, so a band of running work
 * still reads as one list.
 */
function ActiveBandRow({
  row,
  now,
  selected,
  onSelect,
}: {
  row: ActiveSessionRow;
  now: number;
  selected: boolean;
  onSelect(): void;
}) {
  const needsYou = row.attention !== null;
  const working = !needsYou && row.activity === "working";
  const concluded = row.lastRun !== null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={selected}
        onClick={onSelect}
        // Two lines at the tighter padding shell-density settled on: the row
        // keeps long titles readable, and the band stops out-massing the board.
        className="h-auto min-h-9 items-start gap-2 py-1 [&:hover_.band-row-dim]:text-sidebar-accent-foreground [&[data-active=true]_.band-row-dim]:text-sidebar-accent-foreground"
      >
        <span
          aria-hidden
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            needsYou
              ? "bg-amber-500"
              : working
                ? "bg-emerald-500"
                : concluded
                  ? "bg-muted-foreground/25"
                  : "bg-muted-foreground/40",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {working ? (
            <span className="lab-band-title-sweep text-ui">
              {row.title}
              <span className="lab-band-title-peak" aria-hidden>
                {row.title}
              </span>
            </span>
          ) : (
            <span
              className={cn(
                "band-row-dim truncate text-ui transition-colors",
                concluded ? "text-muted-foreground" : "text-sidebar-foreground",
              )}
            >
              {row.title}
            </span>
          )}
          <span className="band-row-dim flex min-w-0 items-center gap-1 text-label text-muted-foreground transition-colors">
            <RowIdentity ticket={row.ticket} />
            <span aria-hidden>·</span>
            <span className="truncate">{stateLine(row, now)}</span>
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * One line, and quieter than Active on every axis at once — smaller type, muted
 * ink, no dot. Previous is where you go looking for something you remember;
 * Active is where you look without being asked, and only one of them can win
 * that competition.
 *
 * A cleaned row is one the rules decided was concluded business, showing only
 * because the filter asked for it back — ghosted, and marked with the broom
 * rather than a sentence explaining itself.
 */
function PreviousBandRow({
  row,
  now,
  selected,
  onSelect,
}: {
  row: PreviousSessionRow;
  now: number;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        isActive={selected}
        onClick={onSelect}
        className={cn(
          "h-6 gap-1.5 px-2 text-xs text-muted-foreground",
          row.cleaned && "opacity-45",
        )}
      >
        <span className="text-label">
          <RowIdentity ticket={row.ticket} />
        </span>
        <span className="min-w-0 flex-1 truncate">{row.title}</span>
        {row.cleaned ? (
          <span className="flex shrink-0 items-center">
            <BroomIcon weight="fill" aria-label="Cleaned up" className="size-3" />
          </span>
        ) : null}
        <KindGlyph kind={row.kind} />
        <span className="shrink-0 text-label tabular-nums">
          {compactAge(row.endedOrQuietAt, now)}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function BandHeader({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-6 items-center gap-2 px-2">
      <span className="text-label font-medium uppercase text-muted-foreground">{label}</span>
      <span className="text-label tabular-nums text-muted-foreground/70">{count}</span>
      <span className="ml-auto flex items-center">{children}</span>
    </div>
  );
}

export interface BandFilter {
  kinds: Record<SessionRowKind, boolean>;
  showCleaned: boolean;
}

const DEFAULT_BAND_FILTER: BandFilter = {
  kinds: { chat: true, terminal: true },
  showCleaned: false,
};

/**
 * The Previous band's own menu — kinds, and whether cleanup's decisions come
 * back into view. A menu rather than a standing row of pills because this is a
 * question asked once a week: the sidebar's steady state should be the list,
 * not the controls for it.
 */
function BandFilterMenu({
  filter,
  onChange,
}: {
  filter: BandFilter;
  onChange(next: BandFilter): void;
}) {
  const narrowed = !filter.kinds.chat || !filter.kinds.terminal || filter.showCleaned;
  const toggleKind = (kind: SessionRowKind): void =>
    onChange({ ...filter, kinds: { ...filter.kinds, [kind]: !filter.kinds[kind] } });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Filter"
          className={cn(
            "flex size-5 items-center justify-center rounded-sm ring-sidebar-ring outline-hidden transition-colors hover:bg-sidebar-accent-veil hover:text-sidebar-accent-foreground focus-visible:ring-2",
            narrowed ? "text-sidebar-accent-foreground" : "text-muted-foreground",
          )}
        >
          <FunnelSimpleIcon weight="fill" className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuCheckboxItem
          checked={filter.kinds.chat}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleKind("chat")}
        >
          <ChatCircleIcon weight="fill" />
          Chats
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filter.kinds.terminal}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleKind("terminal")}
        >
          <TerminalWindowIcon weight="fill" />
          Terminals
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={filter.showCleaned}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => onChange({ ...filter, showCleaned: !filter.showCleaned })}
        >
          <BroomIcon weight="fill" />
          Cleaned up
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The lab's own strip: the clock, and the model's answer to when it next matters. */
function ClockStrip({
  offset,
  onOffset,
  active,
  previous,
  nextBoundaryAt,
  now,
}: {
  offset: number;
  onOffset(next: number): void;
  active: number;
  previous: number;
  nextBoundaryAt: number | null;
  now: number;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="shrink-0 font-mono text-label uppercase text-muted-foreground">Now</span>
        <input
          type="range"
          aria-label="Simulated clock"
          min={0}
          max={SCRUB_SPAN_MS}
          step={MINUTE}
          value={offset}
          onChange={(event) => onOffset(Number(event.target.value))}
          className="h-1 min-w-0 flex-1 accent-primary"
        />
        <span className="w-20 shrink-0 text-right font-mono text-label tabular-nums text-foreground">
          {formatOffset(offset)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-label text-muted-foreground">
        <span className="tabular-nums">
          {active} active · {previous} previous
        </span>
        {nextBoundaryAt === null ? (
          <span>boundary —</span>
        ) : (
          <button
            type="button"
            onClick={() => onOffset(nextBoundaryAt - NOW)}
            className="rounded-full border border-border px-2 py-0.5 tabular-nums transition-colors hover:border-border-strong hover:text-foreground"
          >
            boundary {formatOffset(nextBoundaryAt - now)}
          </button>
        )}
        <button
          type="button"
          onClick={() => onOffset(0)}
          className="rounded-full border border-border px-2 py-0.5 transition-colors hover:border-border-strong hover:text-foreground"
        >
          reset
        </button>
      </div>
    </div>
  );
}

/** What the builder returned, in the order it returned it — the lab's receipt that this is its output. */
function ListingReadout({
  active,
  previous,
}: {
  active: readonly ActiveSessionRow[];
  previous: readonly PreviousSessionRow[];
}) {
  return (
    <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-label text-muted-foreground/80">
      {active.map((row) => (
        <React.Fragment key={row.id}>
          <dt className="text-muted-foreground">active</dt>
          <dd className="truncate">
            {row.id}
            {row.attention === null ? "" : " · attention"}
            {row.lastRun === null ? "" : " · board"}
          </dd>
        </React.Fragment>
      ))}
      {previous.map((row) => (
        <React.Fragment key={row.id}>
          <dt className="text-muted-foreground/60">prev</dt>
          <dd className="truncate">
            {row.id}
            {row.cleaned ? " · cleaned" : ""}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export default function SidebarSessionsScratch() {
  const [offset, setOffset] = React.useState(0);
  const [filter, setFilter] = React.useState<BandFilter>(DEFAULT_BAND_FILTER);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const now = NOW + offset;

  const listing = React.useMemo(
    () =>
      buildActiveSessionListing({
        ...sessionListingInput,
        filter: {
          kinds: new Set(
            (["chat", "terminal"] as const).filter((kind) => filter.kinds[kind]),
          ) satisfies ReadonlySet<SessionRowKind>,
          showCleaned: filter.showCleaned,
        },
        now,
      }),
    [filter, now],
  );

  return (
    <div className="flex flex-col gap-4">
      <style>{WORKING_TITLE_CSS}</style>
      <ClockStrip
        offset={offset}
        onOffset={setOffset}
        active={listing.active.length}
        previous={listing.previous.length}
        nextBoundaryAt={listing.nextBoundaryAt}
        now={now}
      />

      <div className="flex flex-wrap items-start gap-6">
        {/* The sidebar primitives read `useSidebar()` and size against
            `--sidebar-width`, so they need a provider and a width to exist in.
            This is the minimum framing that gets there. */}
        <SidebarProvider
          className="min-h-0 w-fit"
          style={{ "--sidebar-width": "260px" } as React.CSSProperties}
        >
          <Sidebar
            collapsible="none"
            className="w-(--sidebar-width) rounded-xl border border-border py-2"
          >
            <SidebarGroup className="gap-1 py-0">
              <BandHeader label="Active" count={listing.active.length} />
              {listing.active.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">No active sessions</p>
              ) : (
                <SidebarMenu>
                  {listing.active.map((row) => (
                    <ActiveBandRow
                      key={row.id}
                      row={row}
                      now={now}
                      selected={row.id === selectedId}
                      onSelect={() => setSelectedId(row.id)}
                    />
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroup>

            <SidebarGroup className="mt-2 gap-1 py-0">
              <BandHeader label="Previous" count={listing.previous.length}>
                <BandFilterMenu filter={filter} onChange={setFilter} />
              </BandHeader>
              {listing.previous.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">Nothing yet</p>
              ) : (
                <SidebarMenu>
                  {listing.previous.map((row) => (
                    <PreviousBandRow
                      key={row.id}
                      row={row}
                      now={now}
                      selected={row.id === selectedId}
                      onSelect={() => setSelectedId(row.id)}
                    />
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroup>
          </Sidebar>
        </SidebarProvider>

        <ListingReadout active={listing.active} previous={listing.previous} />
      </div>
    </div>
  );
}
