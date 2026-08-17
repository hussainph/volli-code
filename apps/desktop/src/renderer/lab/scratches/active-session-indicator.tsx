/**
 * The active-session indicator (VC-100), in both the shapes the board draws it.
 *
 * The card's ring and the list row's marks are two answers to one question, and
 * the only way to tell whether they are the SAME answer is to have them on
 * screen together — which is exactly what the real board cannot give you,
 * because it shows one view mode at a time.
 *
 * ── WHAT TO ACTUALLY LOOK AT ──────────────────────────────────────────────
 * The ring is the thing to be sceptical about, and there are three ways it can
 * be wrong that a still screenshot will not show:
 *
 *   • SPEED. 2.6s per lap. Faster reads as a spinner — urgency, "you are
 *     waiting on this" — which is wrong for something that may be lit for ten
 *     minutes. Slower stops reading as motion and starts reading as a
 *     gradient someone forgot to finish.
 *   • LOUDNESS AT REST. Look away, then back. The row of quiet cards below is
 *     here for that: if your eye keeps being pulled to the ring while you are
 *     trying to read a different card's title, it is too bright, and the fix
 *     is the arc's width in the conic gradient rather than its opacity.
 *   • THE CORNERS. Watch one full lap at a corner. The sweep is an oversized
 *     square rotating behind a mask, so a coverage bug shows up as the
 *     highlight thinning or dropping out at 45°, and only there.
 *
 * The two colours are not a preference: `--positive` for working and
 * `--attention` for waiting come from `ui/status-dot.tsx`'s map, which every
 * other Session surface already obeys. The selected card is in the set below
 * because ember was the obvious alternative and this is why it lost — a
 * selected card and an active card two pixels apart in the same colour.
 *
 * Static, and deliberately so: there is no store behind these, because what is
 * under review is the drawing rather than the derivation. The derivation has
 * unit tests (`board-session-activity.test.ts`), which is the right place for
 * it — a lab scratch cannot tell you whether `waiting` outranks `working`.
 */
import type { ReactNode } from "react";

import { TicketRowContent } from "@renderer/components/board/board-list-view";
import { TicketCardContent } from "@renderer/components/board/ticket-card";

import { labels, project, ticketById } from "../fixtures";
import { appApi, seedBoard } from "../seed";

export const title = "Active session indicator";
export const note = "The board's running mark — card ring and list row, side by side";

export const seed = seedBoard;
/** The card's archive-ready badge issues one retention read per branched card. */
export const api = appApi;

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-label uppercase text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

export default function ActiveSessionIndicatorScratch() {
  const working = ticketById("tkt-14");
  const waiting = ticketById("tkt-12");
  const quiet = ticketById("tkt-11");
  const alsoQuiet = ticketById("tkt-9");

  const cardProps = { ticketPrefix: project.ticketPrefix, projectLabels: labels };

  return (
    <div className="flex flex-col gap-8">
      <Group label="Cards — the board's own column width and rhythm">
        {/* A real column body: same width, same `gap-2`, same muted bed. A ring
            judged on a card floating alone is a ring judged against a page
            nobody will ever see — the question is whether it stands out from
            its NEIGHBOURS, so it needs neighbours. */}
        <div className="flex w-72 flex-col gap-2 rounded-lg bg-muted/30 p-2">
          <TicketCardContent {...cardProps} ticket={working} sessionActivity="working" />
          <TicketCardContent {...cardProps} ticket={quiet} />
          <TicketCardContent {...cardProps} ticket={waiting} sessionActivity="waiting" />
          <TicketCardContent {...cardProps} ticket={alsoQuiet} />
          {/* Selected AND running: the one combination where the two border
              treatments have to coexist on the same edge. */}
          <TicketCardContent {...cardProps} ticket={working} selected sessionActivity="working" />
        </div>
      </Group>

      <Group label="List rows — orbs for working, the attention dot for waiting">
        <div className="overflow-hidden rounded-lg border border-border">
          <TicketRowContent {...cardProps} ticket={working} sessionActivity="working" />
          <TicketRowContent {...cardProps} ticket={quiet} />
          <TicketRowContent {...cardProps} ticket={waiting} sessionActivity="waiting" />
          {/* A title long enough to truncate, WITH a mark: the mark is
              `shrink-0` and the title is what gives way, so this is where you
              check the ellipsis lands before the orbs rather than under them. */}
          <TicketRowContent {...cardProps} ticket={alsoQuiet} sessionActivity="working" />
        </div>
      </Group>
    </div>
  );
}
