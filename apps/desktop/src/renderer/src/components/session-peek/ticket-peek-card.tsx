/**
 * VC-30 — the peek a ticket FOLDER opens (D2).
 *
 * A folder is a ticket, so its peek is the ticket: what column it sits in, its
 * title, and its Sessions — each with ONE line on what it did. That line is the
 * whole reason to peek a folder rather than expand it: a folder of three
 * Sessions all titled `Chat` expands into three rows that still say nothing,
 * while three one-line summaries say which of them answered the reviewer.
 *
 * Read-only by construction. Nothing behind a folder can be waiting on anyone (a
 * Session asking for a person is pinned to Active — VC-69), so there is no
 * question to answer here, and a reply typed into a card that lists four
 * Sessions would have no single recipient. Pressing a Session DRILLS into its
 * own peek, inside this card, with the way back at the top; opening the Session
 * is that peek's own button.
 *
 * The frame, width, bridge behaviour and GRID are the Session card's
 * (`session-peek-card.tsx`), so the two read as one surface with two subjects.
 * Ported from `lab/session-peek/ticket-card.tsx`; the lab's pager through a
 * folder's Sessions is gone with the `newest` folder mode it belonged to.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { displayTicketId, TICKET_STATUS_LABELS, type Ticket } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";

import type { PeekPosition } from "./peek-geometry";
import { CARD_HEADER, CARD_HEADER_TEXT, PEEK_FRAME, peekFrameStyle } from "./session-peek-card";

export interface TicketPeekSession {
  readonly rowId: string;
  readonly title: string;
  readonly age: string;
  /** `null` when the fold had nothing readable to show for this Session. */
  readonly summary: string | null;
  /** The row's own `SessionGlyph`, so the list reads as the sidebar in miniature. */
  readonly glyph: React.ReactNode;
}

export interface TicketPeekCardProps {
  ticket: Ticket;
  ticketPrefix: string;
  sessions: readonly TicketPeekSession[];
  position: PeekPosition;
  cardWidth: number;
  onDrill(rowId: string): void;
  onOpenTicket(): void;
  /** The card's half of the row→card bridge. */
  onPointerEnter?(): void;
  onPointerLeave?(): void;
  ref?: React.Ref<HTMLDivElement>;
}

export function TicketPeekCard({
  ticket,
  ticketPrefix,
  sessions,
  position,
  cardWidth,
  onDrill,
  onOpenTicket,
  onPointerEnter,
  onPointerLeave,
  ref,
}: TicketPeekCardProps): React.ReactElement {
  const id = displayTicketId(ticketPrefix, ticket.ticketNumber);
  const count = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
  return (
    <div
      ref={ref}
      role="note"
      aria-label={`Peek at ${id}, ${count}`}
      data-peek-card=""
      data-peek-subject="ticket"
      style={peekFrameStyle(position, cardWidth)}
      className={PEEK_FRAME}
      onPointerEnter={onPointerEnter}
      // The Session card's rule: focus inside holds the card open, so a reader
      // who has pressed into the list is not dropped by a stray pointer.
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) onPointerLeave?.();
      }}
      onFocusCapture={onPointerEnter}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          onPointerLeave?.();
      }}
    >
      <header className={CARD_HEADER}>
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/50">
          <TicketIcon aria-hidden className="size-4 text-muted-foreground" />
        </span>
        <div className={CARD_HEADER_TEXT}>
          <p
            data-peek-ticket-title=""
            className="line-clamp-2 font-semibold text-foreground [overflow-wrap:anywhere]"
            title={ticket.title}
          >
            {ticket.title}
          </p>
          <div className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
            <span className="rounded-sm bg-muted px-1 font-mono text-label tracking-normal">
              {id}
            </span>
            <span>
              {TICKET_STATUS_LABELS[ticket.status]} · {count}
            </span>
          </div>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label={`Open ${id}`} onClick={onOpenTicket}>
          <ArrowSquareOutIcon />
        </Button>
      </header>
      {/* 4px + a row's 8px puts every mark on the 12px inset; 6px + 6px is the 12px rhythm. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-1 py-1.5">
        <ul className="flex flex-col" aria-label={`${id} sessions`}>
          {sessions.map((session) => (
            <li key={session.rowId}>
              <button
                type="button"
                data-peek-drill={session.rowId}
                className="group/drill flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onDrill(session.rowId)}
              >
                {session.glyph}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {session.title}
                    </span>
                    <span className="shrink-0 text-label tabular-nums text-muted-foreground">
                      {session.age}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">
                    {/* Never invented prose: a Session with nothing readable says so. */}
                    {session.summary ?? "No summary yet"}
                  </span>
                </span>
                <CaretRightIcon
                  aria-hidden
                  weight="bold"
                  className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/drill:opacity-100 group-focus-visible/drill:opacity-100 motion-reduce:transition-none"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
