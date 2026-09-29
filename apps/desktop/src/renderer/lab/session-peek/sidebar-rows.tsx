/**
 * VC-30 — the band rows and the rail row, in one row language, for the
 * sidebar-integration scratch.
 *
 * Every geometry here is the shipped row's (`sidebar/session-band-row.tsx`,
 * `ticket/ticket-sessions-panel.tsx`): the same primitives, heights, insets
 * and the same 3ch age column. What changes is exactly three things, so a
 * difference on screen is one the design makes:
 *
 *   1. THE LEADING SLOT IS THE MARK (`row-mark.tsx`), in every band and in the
 *      rail. The Active row's 6px dot, the Previous row's kind glyph and the
 *      rail's kind glyph + dot all become one mark that says the vendor and
 *      carries the state. The rail's status line drops its dot for the same
 *      reason: one carrier of state per row.
 *   2. THE FOLDER'S CARET SITS IN THE MARK'S 14px BOX, so a collapsed folder,
 *      an ungrouped Session and a child inside an open folder all share one
 *      left axis — the folder reads as part of the list's system rather than
 *      as a control bolted onto it.
 *   3. NO NATIVE `title` TOOLTIP on a peekable row. The shipped rows use it
 *      for the untruncated title and the harness; the peek now says both, and
 *      a browser tooltip would open on top of it at almost the same instant.
 *
 * Rows are addressed by `data-peek-row` / `data-peek-surface` (see
 * `use-peek-controller.ts`): a Session's `<li>`, a folder's BUTTON.
 */
import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import {
  displayTicketId,
  TICKET_STATUS_LABELS,
  type ChatWaitingReason,
  type Ticket,
} from "@volli/shared";

import type {
  ActiveSessionRow,
  PreviousSessionRow,
} from "@renderer/components/sidebar/active-session-listing";
import { providerMark } from "@renderer/components/models/model-identity";
import { ListRow } from "@renderer/components/ui/list-row";
import { SESSION_ACTIVITY_LABEL } from "@renderer/components/ui/session-activity-status";
import { SidebarMenuButton, SidebarMenuItem } from "@renderer/components/ui/sidebar";
import { compactAge } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

import { VENDOR_LABEL, type VendorId } from "./sidebar-corpus";
import { folderRowId } from "./sidebar-model";

/** LAB COPY of `session-band-row.tsx`'s `WAITING_COPY` (module-private there). */
const WAITING_COPY: Record<ChatWaitingReason, string> = {
  question: "Answer a question",
  permission: "Approve a tool call",
  auth: "Sign in needed",
};

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

/** The shipped Active meta line's words: why a human is needed, else where and what. */
function activeStateLine(row: ActiveSessionRow, delivered: boolean): string {
  if (row.attention !== null && !delivered) {
    if (row.attention.signal === "blocked") {
      return row.attention.reason === null ? "Blocked" : `Blocked · ${row.attention.reason}`;
    }
    return row.waitingOn === null ? "Waiting for you" : WAITING_COPY[row.waitingOn];
  }
  const place = row.ticket === null ? row.source : TICKET_STATUS_LABELS[row.ticket.status];
  return `${place} · ${SESSION_ACTIVITY_LABEL[delivered ? "working" : row.activity]}`;
}

/**
 * Two lines: what it is, then where it lives and what it is doing. The mark
 * sits on the title's line, where the dot sat; the working title still sweeps.
 */
export const ActiveRow = React.memo(function ActiveRow({
  row,
  ticketPrefix,
  now,
  selected,
  delivered,
  working,
  mark,
  onActivate,
}: {
  row: ActiveSessionRow;
  ticketPrefix: string;
  now: number;
  selected: boolean;
  delivered: boolean;
  working: boolean;
  mark: React.ReactNode;
  onActivate(rowId: string): void;
}) {
  return (
    <SidebarMenuItem data-peek-row={row.id} data-peek-surface="nav">
      <SidebarMenuButton
        size="lg"
        isActive={selected}
        onClick={() => onActivate(row.id)}
        className="h-auto min-h-9 items-start gap-2 py-1 [&:hover_.session-row-dim]:text-foreground [&[data-active=true]_.session-row-dim]:text-foreground"
      >
        <span className="mt-0.5 flex shrink-0">{mark}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {working ? (
            <span className="session-row-dim session-title-sweep text-ui">
              {row.title}
              <span className="session-title-peak" aria-hidden>
                {row.title}
              </span>
            </span>
          ) : (
            <span className="session-row-dim truncate text-ui text-sidebar-foreground transition-colors">
              {row.title}
            </span>
          )}
          <span className="session-row-dim flex min-w-0 items-center gap-1 text-label text-muted-foreground transition-colors">
            <Identity ticket={row.ticket} ticketPrefix={ticketPrefix} />
            <span aria-hidden>·</span>
            <span className="truncate">{activeStateLine(row, delivered)}</span>
            {row.lastActivityAt !== null ? (
              <span className="shrink-0 text-label tabular-nums">
                {compactAge(row.lastActivityAt, now)}
              </span>
            ) : null}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
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
  onActivate,
}: {
  row: PreviousSessionRow;
  ticketPrefix: string;
  now: number;
  selected: boolean;
  mark: React.ReactNode;
  showIdentity?: boolean;
  onActivate(rowId: string): void;
}) {
  return (
    <SidebarMenuItem data-peek-row={row.id} data-peek-surface="nav">
      <SidebarMenuButton
        size="sm"
        isActive={selected}
        onClick={() => onActivate(row.id)}
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
 * The in-ticket rail's row: the shipped two-line `ListRow`, with the mark in
 * the leading slot and the status line reduced to words and an age.
 */
export function RailRow({
  rowId,
  title,
  mark,
  status,
  selected,
  onActivate,
}: {
  rowId: string;
  title: string;
  mark: React.ReactNode;
  status: string;
  selected: boolean;
  onActivate(rowId: string): void;
}) {
  return (
    <li data-peek-row={rowId} data-peek-surface="rail">
      <ListRow
        density="two-line"
        onActivate={() => onActivate(rowId)}
        className={cn(selected && "bg-muted/60")}
        leading={<span className="flex size-4 shrink-0 items-center justify-center">{mark}</span>}
        primary={<span className="min-w-0 flex-1 truncate text-ui font-medium">{title}</span>}
        secondary={
          <span className="min-w-0 truncate text-label text-muted-foreground">{status}</span>
        }
      />
    </li>
  );
}
