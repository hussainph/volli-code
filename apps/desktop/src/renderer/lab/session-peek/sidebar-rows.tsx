/**
 * VC-30 — the band rows and the rail row, in one row language, for the
 * sidebar-integration scratch.
 *
 * The geometry is the shipped rows' (`sidebar/session-band-row.tsx`,
 * `ticket/ticket-sessions-panel.tsx`, `ui/list-row.tsx`): the same
 * primitives, heights, insets and 3ch age column. What changes, so that a
 * difference on screen is one the design makes:
 *
 *   1. THE LEADING SLOT IS THE MARK (`row-mark.tsx`), in every band and in the
 *      rail. The Active row's 6px dot, the Previous row's kind glyph and the
 *      rail's kind glyph + dot all become one mark that says the vendor and
 *      carries the state.
 *   2. ONE TWO-LINE ROW FOR BOTH SIDEBARS. An Active row is the rail's row —
 *      the shipped two-line `ListRow` (52px) the v2 wireframe drew — so the
 *      mark sits on the row's vertical centre in a 24px slot rather than on
 *      the title's line, and the two sidebars cannot drift apart.
 *   3. THE SECOND LINE SAYS WHERE AND WHEN, NEVER HOW. `VLT-14 · 2m ago`, in
 *      the row's own `text-ui` (v2's line), not the band's tracked label.
 *      The shipped line's state words — "Doing · Working", "Answer a
 *      question" — are gone: the mark carries the state, and a line that
 *      repeats it is noise at a glance. In the rail the ticket is the page
 *      itself, so only the "when" is left.
 *   4. THE FOLDER'S CARET SITS IN THE MARK'S 14px BOX, so a collapsed folder,
 *      an ungrouped Session and a child inside an open folder all share one
 *      left axis — the folder reads as part of the list's system rather than
 *      as a control bolted onto it.
 *   5. NO NATIVE `title` TOOLTIP on a peekable row. The shipped rows use it
 *      for the untruncated title and the harness; the peek now says both, and
 *      a browser tooltip would open on top of it at almost the same instant.
 *
 * Rows are addressed by `data-peek-row` / `data-peek-surface` (see
 * `use-peek-controller.ts`): a Session's `<li>`, a folder's BUTTON. A row
 * drawn with no surface is a specimen — no peek, nothing to open — for the
 * scratch's side-by-side comparison.
 */
import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { displayTicketId, type Ticket } from "@volli/shared";

import type {
  ActiveSessionRow,
  PreviousSessionRow,
} from "@renderer/components/sidebar/active-session-listing";
import { providerMark } from "@renderer/components/models/model-identity";
import { ListRow } from "@renderer/components/ui/list-row";
import { SidebarMenuButton, SidebarMenuItem } from "@renderer/components/ui/sidebar";
import { compactAge, relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

import { VENDOR_LABEL, type VendorId } from "./sidebar-corpus";
import { folderRowId } from "./sidebar-model";

/** The shipped band's identity lane. */
const ID_LANE = "inline-flex shrink-0 items-center font-mono text-label tracking-normal";

/** The shipped nesting rule under an open folder (`active-sessions.tsx`). */
export const FOLDER_NEST = "mx-0 ml-2 gap-1 py-0 pr-0 pl-2";

/** The id tying a folder to the list it discloses (the shipped `sessionGroupPanelId`). */
export function folderPanelId(ticketId: string): string {
  return `peek-folder-${ticketId}`;
}

function Identity({ ticket, ticketPrefix }: { ticket: Ticket | null; ticketPrefix: string }) {
  if (ticket === null) {
    return (
      <span className={ID_LANE}>
        <GlobeIcon weight="bold" aria-label="No ticket" className="size-3" />
      </span>
    );
  }
  return <span className={ID_LANE}>{displayTicketId(ticketPrefix, ticket.ticketNumber)}</span>;
}

/** Where a Session's peek listens: a sidebar, or nowhere (a specimen). */
export type RowSurface = "nav" | "rail" | null;

/**
 * The two-line Session row both sidebars draw: the shipped `ListRow` at its
 * 52px density, the mark centred in a 24px slot, the title over one quiet
 * line. A working title keeps the shipped band's sweep.
 */
function TwoLineSessionRow({
  rowId,
  surface,
  title,
  subtitle,
  mark,
  working,
  selected,
  onActivate,
}: {
  rowId: string;
  surface: RowSurface;
  title: string;
  subtitle: string;
  mark: React.ReactNode;
  working: boolean;
  selected: boolean;
  onActivate(rowId: string): void;
}) {
  return (
    <li
      data-peek-row={surface === null ? undefined : rowId}
      data-peek-surface={surface ?? undefined}
    >
      <ListRow
        density="two-line"
        selected={selected}
        onActivate={surface === null ? null : () => onActivate(rowId)}
        leading={mark}
        primary={
          working ? (
            <span className="session-title-sweep min-w-0 flex-1 text-ui font-medium">
              {title}
              <span className="session-title-peak" aria-hidden>
                {title}
              </span>
            </span>
          ) : (
            title
          )
        }
        secondary={subtitle}
      />
    </li>
  );
}

/** Where, then when. The ticketless Session says so rather than leaving a hole. */
function activeSubtitle(row: ActiveSessionRow, ticketPrefix: string, now: number): string {
  const where =
    row.ticket === null ? "No ticket" : displayTicketId(ticketPrefix, row.ticket.ticketNumber);
  return row.lastActivityAt === null
    ? where
    : `${where} · ${relativeTime(row.lastActivityAt, now)}`;
}

/** An Active Session: two lines, the mark carrying the state, the line under the title only where and when. */
export const ActiveRow = React.memo(function ActiveRow({
  row,
  ticketPrefix,
  now,
  selected,
  working,
  mark,
  surface = "nav",
  onActivate,
}: {
  row: ActiveSessionRow;
  ticketPrefix: string;
  now: number;
  selected: boolean;
  working: boolean;
  mark: React.ReactNode;
  surface?: RowSurface;
  onActivate(rowId: string): void;
}) {
  return (
    <TwoLineSessionRow
      rowId={row.id}
      surface={surface}
      title={row.title}
      subtitle={activeSubtitle(row, ticketPrefix, now)}
      mark={mark}
      working={working}
      selected={selected}
      onActivate={onActivate}
    />
  );
});

/** One line, quieter on every axis. Under a folder it drops the id the folder already says. */
export const PreviousRow = React.memo(function PreviousRow({
  row,
  ticketPrefix,
  now,
  selected,
  mark,
  showIdentity = true,
  surface = "nav",
  onActivate,
}: {
  row: PreviousSessionRow;
  ticketPrefix: string;
  now: number;
  selected: boolean;
  mark: React.ReactNode;
  showIdentity?: boolean;
  surface?: Exclude<RowSurface, "rail">;
  onActivate(rowId: string): void;
}) {
  return (
    <SidebarMenuItem
      data-peek-row={surface === null ? undefined : row.id}
      data-peek-surface={surface ?? undefined}
    >
      <SidebarMenuButton
        size="sm"
        isActive={selected}
        onClick={surface === null ? undefined : () => onActivate(row.id)}
        className={cn("h-6 gap-1.5 text-ui text-muted-foreground", row.cleaned && "opacity-80")}
      >
        {mark}
        {showIdentity ? <Identity ticket={row.ticket} ticketPrefix={ticketPrefix} /> : null}
        <span className="min-w-0 flex-1 truncate">{row.title}</span>
        {row.endedOrQuietAt > 0 ? (
          <span className="min-w-[3ch] shrink-0 text-right text-label tabular-nums">
            {compactAge(row.endedOrQuietAt, now)}
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});

/** The `marks` face: who worked on this ticket, muted, newest first. Identity only — never state. */
function VendorStack({ vendors }: { vendors: readonly VendorId[] }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground/70">
      <span className="sr-only">{vendors.map((vendor) => VENDOR_LABEL[vendor]).join(", ")}</span>
      {vendors.map((vendor) => {
        const mark = providerMark(vendor);
        return mark === null ? null : (
          <svg key={vendor} aria-hidden viewBox={mark.viewBox} className="size-3">
            {mark.paths.map((path) => (
              <path key={path.slice(0, 24)} d={path} fill="currentColor" />
            ))}
          </svg>
        );
      })}
    </span>
  );
}

/**
 * A ticket, standing for the Previous Sessions filed under it (VC-69), in the
 * mark language: the caret takes the mark's box, so the folder's left edge is
 * every row's left edge. Still no status — nothing behind a folder can be
 * waiting on anyone. The caller supplies the `SidebarMenuItem`, as with the
 * shipped row, because the nested list has to sit in the same `<li>`.
 */
export const FolderRow = React.memo(function FolderRow({
  ticket,
  ticketPrefix,
  count,
  newestAt,
  now,
  open,
  selected,
  vendors,
  onToggle,
}: {
  ticket: Ticket;
  ticketPrefix: string;
  count: number;
  newestAt: number;
  now: number;
  open: boolean;
  selected: boolean;
  /** Drawn when the `marks` face is on; `null` for the shipped count alone. */
  vendors: readonly VendorId[] | null;
  onToggle(ticketId: string): void;
}) {
  return (
    <SidebarMenuButton
      size="sm"
      isActive={selected}
      aria-expanded={open}
      aria-controls={folderPanelId(ticket.id)}
      data-peek-row={folderRowId(ticket.id)}
      data-peek-surface="nav"
      onClick={() => onToggle(ticket.id)}
      className="h-6 gap-1.5 text-ui"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <CaretRightIcon
          weight="bold"
          aria-hidden
          className={cn(
            "size-3 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </span>
      <span className={ID_LANE}>{displayTicketId(ticketPrefix, ticket.ticketNumber)}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{ticket.title}</span>
      {vendors === null ? null : <VendorStack vendors={vendors} />}
      <span className="shrink-0 text-label tabular-nums text-muted-foreground/70">
        {count}
        <span className="sr-only">{count === 1 ? " session" : " sessions"}</span>
      </span>
      {newestAt > 0 ? (
        <span className="min-w-[3ch] shrink-0 text-right text-label tabular-nums text-muted-foreground">
          {compactAge(newestAt, now)}
        </span>
      ) : null}
    </SidebarMenuButton>
  );
});

/**
 * The in-ticket rail's row: the same two-line row as Active. The ticket is
 * the page it sits on, so its second line is only when.
 */
export function RailRow({
  rowId,
  title,
  mark,
  at,
  now,
  working,
  selected,
  onActivate,
}: {
  rowId: string;
  title: string;
  mark: React.ReactNode;
  /** Last activity, or when it ended; `null` for a Session that never spoke. */
  at: number | null;
  now: number;
  working: boolean;
  selected: boolean;
  onActivate(rowId: string): void;
}) {
  return (
    <TwoLineSessionRow
      rowId={rowId}
      surface="rail"
      title={title}
      subtitle={at === null ? "" : relativeTime(at, now)}
      mark={mark}
      working={working}
      selected={selected}
      onActivate={onActivate}
    />
  );
}
