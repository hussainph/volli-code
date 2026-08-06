/**
 * The sidebar's two session bands — Active and Previous — on a scrubbable clock.
 *
 * Every row here comes out of `buildActiveSessionListing`, the real, tested
 * model, driven through its real input. That is the point of the scratch: the
 * bands are a function of ticket status, durable records, chat Sessions, live
 * panes, hook state and the CLOCK, and a mock that placed rows by hand would be
 * showing an opinion of the rules rather than the rules. What is new here is
 * only the drawing.
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
 * The rows, bands and filter are now the SHIPPED components, imported from
 * `components/sidebar/`. They were prototyped here and have since landed; a
 * second copy living on in the lab would only be a slower way to find out that
 * the two had drifted.
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

import {
  buildActiveSessionListing,
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
import {
  Sidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarProvider,
} from "@renderer/components/ui/sidebar";

import { NOW, project, sessionListingInput } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Sidebar · Session bands";
export const note = "Active + Previous over the real builder, on a scrubbable clock";

export const seed = seedApp;
export const api = appApi;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SCRUB_SPAN_MS = 8 * HOUR;

/** "+0m" · "+35m" · "+2h 15m" — the scrub offset, never a wall clock the fixtures don't have. */
function formatOffset(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `+${rest}m` : `+${hours}h ${rest}m`;
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
            {` · ${row.activity}`}
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
  const [filter, setFilter] = React.useState<SessionBandFilter>(DEFAULT_SESSION_BAND_FILTER);
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
              <SessionBandHeader label="Active" count={listing.active.length} />
              {listing.active.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">No active sessions</p>
              ) : (
                <SidebarMenu>
                  {listing.active.map((row) => (
                    <ActiveBandRow
                      key={row.id}
                      row={row}
                      ticketPrefix={project.ticketPrefix}
                      selected={row.id === selectedId}
                      onSelect={() => setSelectedId(row.id)}
                    />
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroup>

            <SidebarGroup className="mt-2 gap-1 py-0">
              <SessionBandHeader label="Previous" count={listing.previous.length}>
                <SessionBandFilterMenu filter={filter} onChange={setFilter} />
              </SessionBandHeader>
              {listing.previous.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">Nothing yet</p>
              ) : (
                <SidebarMenu>
                  {listing.previous.map((row) => (
                    <PreviousBandRow
                      key={row.id}
                      row={row}
                      ticketPrefix={project.ticketPrefix}
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
