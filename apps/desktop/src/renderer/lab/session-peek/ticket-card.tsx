/**
 * VC-30 — the peek a ticket FOLDER opens (the `ticket` folder mode).
 *
 * A folder is a ticket, so its peek is the ticket: what column it sits in, its
 * title, and its Sessions — each with ONE line on what it did. That line is
 * the whole reason to peek a folder rather than expand it: a folder of three
 * Sessions all titled `Chat` expands into three rows that still say nothing,
 * while three one-line summaries say which of them answered the reviewer.
 *
 * Read-only by construction. Nothing behind a folder can be waiting on anyone
 * (a Session asking for a person is pinned to Active — VC-69), so there is no
 * question to answer here, and a reply typed into a card that lists four
 * Sessions would have no single recipient. Pressing a Session DRILLS into its
 * own peek, inside this card, with the way back at the top; opening the
 * Session is that peek's own button. Hover never swaps the content: the list
 * the reader is scanning must not change under the pointer.
 *
 * The frame, width, bridge behaviour and GRID are the Session card's
 * (`card.tsx`: 12px inset, 24px lead column, 12px rhythm), so the two read as
 * one surface with two subjects — which is also the card a board ticket would
 * open (the brief's "extend this to other surfaces"). The list's rows are the
 * sidebar's two-line rows in miniature: the mark centred in the lead column,
 * the title over the one line that says what the Session did.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { displayTicketId, TICKET_STATUS_LABELS, type Ticket } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import { CARD_HEADER, CARD_HEADER_TEXT } from "./card";
import type { PeekPosition } from "./geometry";

export interface TicketPeekSession {
  readonly rowId: string;
  readonly title: string;
  readonly mark: React.ReactNode;
  readonly age: string;
  readonly summary: string;
}

/** The frame both cards share: fixed, clamped by the controller, one bridge. */
export function peekFrameStyle(position: PeekPosition, width: number): React.CSSProperties {
  return {
    position: "fixed",
    left: position.left,
    top: position.top,
    width: `min(${width}px, calc(100vw - 16px))`,
    maxHeight: position.maxHeight,
    zIndex: 60,
  };
}

export const PEEK_FRAME =
  "flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-ui shadow-overlay outline-none";

export const TicketPeekCard = React.forwardRef<
  HTMLDivElement,
  {
    ticket: Ticket;
    ticketPrefix: string;
    sessions: readonly TicketPeekSession[];
    position: PeekPosition;
    width: number;
    onDrill(rowId: string): void;
    onOpenTicket(): void;
    onPointerEnter(): void;
    onPointerLeave(): void;
  }
>(function TicketPeekCard(
  {
    ticket,
    ticketPrefix,
    sessions,
    position,
    width,
    onDrill,
    onOpenTicket,
    onPointerEnter,
    onPointerLeave,
  },
  ref,
) {
  const id = displayTicketId(ticketPrefix, ticket.ticketNumber);
  const count = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
  return (
    <div
      ref={ref}
      role="note"
      aria-label={`Peek at ${id}, ${count}`}
      data-peek-card=""
      data-peek-subject="ticket"
      style={peekFrameStyle(position, width)}
      className={PEEK_FRAME}
      onPointerEnter={onPointerEnter}
      // The Session card's rule: focus inside holds the card open, so a reader
      // who has pressed into the list is not dropped by a stray pointer.
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) onPointerLeave();
      }}
      onFocusCapture={onPointerEnter}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          onPointerLeave();
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
            <span className="rounded bg-muted px-1 font-mono text-label tracking-normal">{id}</span>
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
                {session.mark}
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
                    {session.summary}
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
});

/**
 * The strip a folder's Session card wears on top: the way back to the ticket
 * (drilled in), or the pager through its Sessions (`newest` mode). It names
 * the folder, so a card reached from a folder never pretends it was reached
 * from a row.
 */
export function FolderStrip({
  ticketLabel,
  back,
  pager,
}: {
  ticketLabel: string;
  back?: () => void;
  pager?: { index: number; count: number; onStep(delta: number): void };
}) {
  // On the card's grid: the crumb's glyph centres on the lead column (the
  // button's own 8px padding, pulled back 2px) and its label starts on the
  // text's 44px edge, whether it is a way back or a plain name.
  const crumb = "-ml-0.5 gap-3.5 px-2";
  return (
    <div
      data-peek-strip=""
      className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-3 py-1 text-muted-foreground"
    >
      {back === undefined ? (
        <span className={cn("inline-flex h-5 items-center", crumb)}>
          <TicketIcon aria-hidden className="size-3" />
          <span className="font-mono text-label tracking-normal">{ticketLabel}</span>
        </span>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Back to ${ticketLabel}`}
          className={crumb}
          onClick={back}
        >
          <CaretLeftIcon />
          <span className="font-mono text-label tracking-normal">{ticketLabel}</span>
        </Button>
      )}
      {pager === undefined ? null : (
        <span className="ml-auto flex items-center gap-1">
          <span className="px-1 text-label tabular-nums" aria-live="polite">
            {pager.index + 1} of {pager.count}
          </span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Newer session"
            disabled={pager.index === 0}
            onClick={() => pager.onStep(-1)}
          >
            <CaretLeftIcon />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Older session"
            disabled={pager.index === pager.count - 1}
            onClick={() => pager.onStep(1)}
          >
            <CaretRightIcon />
          </Button>
        </span>
      )}
    </div>
  );
}
