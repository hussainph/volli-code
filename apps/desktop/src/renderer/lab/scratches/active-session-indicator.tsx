/**
 * The active-session indicator (VC-100), in both the shapes the board draws it.
 *
 * The card's ring and the list row's marks are two answers to one question, and
 * the only way to tell whether they are the SAME answer is to have them on
 * screen together — which is exactly what the real board cannot give you,
 * because it shows one view mode at a time.
 *
 * ── THE TWO STATES DIFFER BY MOTION, NOT ONLY HUE ─────────────────────────
 * `working` travels; `waiting` is the same ring standing still. Something
 * moves on the card exactly when something is moving in the Session, so the
 * pair is legible in peripheral vision before the eye has resolved a colour —
 * and a board with four blocked agents on it holds still instead of crawling
 * in four places at once. The hues (`--positive`, `--attention`) come from
 * `ui/status-dot.tsx`'s map, which every other Session surface already obeys;
 * the selected card is in the set below because ember was the obvious
 * alternative and this is why it lost — a selected card and an active card two
 * pixels apart in the same colour.
 *
 * ── WHAT TO ACTUALLY LOOK AT ──────────────────────────────────────────────
 * Three ways this can be wrong that a still screenshot will not show:
 *
 *   • SPEED. 2.6s per lap. Faster reads as a spinner — urgency, "you are
 *     waiting on this" — which is wrong for something that may be lit for ten
 *     minutes. Slower stops reading as motion and starts reading as a
 *     gradient someone forgot to finish.
 *   • LOUDNESS AT REST. Look away, then back. The quiet cards between the lit
 *     ones are here for that: if your eye keeps being pulled to the ring while
 *     you are trying to read a different card's title, it is too bright, and
 *     the fix is the arc's width in the conic gradient rather than its opacity.
 *   • THE CORNERS. The waiting card is the one to check, because its ring is
 *     lit the whole way round and holds still — so its curve can be compared
 *     against the card's own border directly. They must be concentric with no
 *     dark line between them. (They were not: `inset: 0` on an absolutely
 *     positioned box lands on the PADDING box, one pixel inside the border,
 *     while `border-radius: inherit` still described the border box. A 1px
 *     offset invisible along an edge, obvious at a corner.)
 *
 * ── LIGHT IS A DIFFERENT COLOUR, NOT THE SAME ONE DIMMED ────────────────────
 * Toggle Light/Dark and the ring changes hue AND width — both deliberate, and
 * both will look like mistakes if you do not know why.
 *
 * The status tokens are solved to clear Lc 65 against the card, which on a
 * light canvas forces them DARK: `--attention` is #764900, a brown, and at ring
 * width it reads as mud. Turning up the vibrancy does nothing at all — that
 * lightness is already past sRGB's chroma ceiling for the hue, so the token is
 * gamut-clipped and asking for more hands back the identical brown. Lightness
 * is the only lever that opens any chroma headroom, so light re-solves the ring
 * at L=0.65 (a real amber, #cb7900) and pays 26–31 Lc for it — which also puts
 * it under WCAG 1.4.11's 3:1, deliberately and with the reasoning written out
 * in `globals.css`. That is affordable *here* and nowhere else: this is a 2px
 * edge rather than status text, and it is never the only place its state is
 * said.
 *
 * Which is also why light keeps 2px against dark's 1.5px — not a second helping
 * of the same budget, but the other half of one trade. Judge the two
 * appearances separately rather than as a before-and-after. Tried and rejected:
 * 2.5px on the old brown (thicker mud), 3px on anything (reads outlined, not
 * lit).
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
