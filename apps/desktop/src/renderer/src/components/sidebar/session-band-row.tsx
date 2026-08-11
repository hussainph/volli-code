/**
 * The two session-band rows and the small parts they share.
 *
 * Split from `active-sessions.tsx` because that module owns fetching, clocks
 * and navigation, and none of that is what a row is. Everything here is a pure
 * function of a built row plus `now` — the same contract the lab scratch these
 * were prototyped in relied on to draw them against a scrubbable clock.
 *
 * The two rows are deliberately unequal on every axis at once. Active is two
 * lines, a status dot and full ink; Previous is one line, smaller type, muted,
 * no dot. Previous is where you go looking for something you already remember;
 * Active is where you look without being asked, and only one of them can win
 * that competition.
 */
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import {
  displayTicketId,
  type ChatWaitingReason,
  type SessionActivityState,
  type Ticket,
} from "@volli/shared";

import type {
  ActiveSessionRow,
  PreviousSessionRow,
  SessionAttention,
  SessionRowKind,
} from "@renderer/components/sidebar/active-session-listing";
import { SidebarMenuButton, SidebarMenuItem } from "@renderer/components/ui/sidebar";
import { compactAge } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

const ACTIVITY_LABEL: Record<SessionActivityState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  parked: "Parked",
  exited: "Exited",
};

/**
 * What a waiting chat is waiting FOR, as the one thing the reader can do about
 * it. A verb, because the row's whole job in this state is to hand over an
 * errand — "Waiting" on its own only tells them to go and find out.
 */
const WAITING_COPY: Record<ChatWaitingReason, string> = {
  question: "Answer a question",
  permission: "Approve a tool call",
  auth: "Sign in needed",
};

/**
 * Identity, in the one slot both bands give it: the ticket, or a globe for a
 * Session that has none. The globe is not decoration: a ticketless row has no
 * board card or ticket rail, so this list is its only Session 4 listing surface.
 *
 * `bold` at 12px is the sidebar's small-glyph tier, and it is a statement about
 * the PEN rather than the size: Phosphor draws regular at 16/256 em against
 * bold's 24/256, which at 12px is 0.75px of ink against 1.13px next to a ~1.1px
 * text stem. Coverage is scale-invariant, so growing the glyph could never have
 * fixed the hairline that made it read as a smudge beside its own label.
 *
 * A LANE, NOT JUST A FACE. The id has been `font-mono` from the start and it was
 * not enough: it sits inside `text-label`, which bakes in +0.05em of tracking for
 * the uppercase sans labels it was drawn for, and tracked-out monospace at 11px
 * is a font that has given up the one property anybody wants from it. `VLT-14`
 * measured the same rhythm as the Mona beside it and the whole line read as one
 * grey phrase — which is exactly what "they all blend together" describes.
 *
 * So: {@link ID_LANE} of fixed width with the tracking handed back. The tracking
 * is what makes it read as a token rather than a word; the lane is what makes a
 * COLUMN out of it, and a column is the only thing that separates rows rather
 * than glyphs. Everything after the identity — the `·` on an Active row, the
 * title on a Previous one — now starts at the same x in every row of the band,
 * including the ticketless ones, where the globe is centred in the same lane
 * instead of shunting its row half a word left of its neighbours.
 *
 * `ch` rather than px, because in a monospace face `ch` IS the glyph advance:
 * the lane holds a 4-character prefix and three digits at any type scale, and a
 * longer prefix grows it rather than clipping. `min-`, so the exceptional
 * project widens the lane instead of overflowing it.
 */
const ID_LANE =
  // Four decisions, none of them cosmetic.
  //
  // `inline-flex`, not the inline span this used to be: `min-width` does not
  // apply to a non-replaced inline box at all, so a lane declared on one is a
  // lane the browser reads and drops — measured at 0 effect before this.
  //
  // `text-label` here rather than on a wrapper, so the identity is one size in
  // both bands instead of 11px under the Active row's meta line and 12px
  // inheriting the Previous row's button.
  //
  // `font-mono` on the LANE, including the ticketless one that renders a globe
  // and no text at all, because `ch` resolves against the element's OWN font:
  // with the family on the id only, the two variants measured 46.2px and 47.3px
  // and the column the lane exists to make was a pixel out on exactly the rows
  // that had no id to line up.
  //
  // `tracking-normal` last, undoing `text-label`'s baked +0.05em — see above.
  "inline-flex min-w-[7ch] shrink-0 items-center font-mono text-label tracking-normal";

function RowIdentity({ ticket, ticketPrefix }: { ticket: Ticket | null; ticketPrefix: string }) {
  if (ticket === null) {
    return (
      <span className={cn(ID_LANE, "justify-center")}>
        <GlobeIcon weight="bold" aria-label="No ticket" className="size-3" />
      </span>
    );
  }
  return <span className={ID_LANE}>{displayTicketId(ticketPrefix, ticket.ticketNumber)}</span>;
}

/**
 * Which execution surface a Previous row speaks for — the axis its filter sorts
 * on. It LEADS the identity it qualifies rather than trailing the title, which
 * is what clears the row's right edge for the age alone.
 */
function KindGlyph({ kind }: { kind: SessionRowKind }) {
  const Glyph = kind === "chat" ? ChatCircleIcon : TerminalWindowIcon;
  return (
    <span className="flex shrink-0 items-center">
      <Glyph weight="bold" aria-label={kind === "chat" ? "Chat" : "Terminal"} className="size-3" />
    </span>
  );
}

/**
 * Why a human is needed. `blocked` is the agent's own voluntary `volli session`
 * signal and carries its words; `waiting` is the involuntary channel, which
 * knows only that someone is needed — so a chat's `waitingOn` is what turns
 * that into an errand.
 */
function attentionLine(attention: SessionAttention, waitingOn: ChatWaitingReason | null): string {
  if (attention.signal === "blocked") {
    return attention.reason === null ? "Blocked" : `Blocked · ${attention.reason}`;
  }
  return waitingOn === null ? "Waiting for you" : WAITING_COPY[waitingOn];
}

/** The Active row's second line: why a human is needed, else what is running. */
function stateLine(row: ActiveSessionRow): string {
  if (row.attention !== null) return attentionLine(row.attention, row.waitingOn);
  // A session whose hooks never arrived states that, in place of an activity it
  // would only be guessing at. Every other row keeps its activity word: a Known
  // harness never promised to report, so inference there is not news.
  if (row.activitySource === "silent") return `${row.source} · Not reporting`;
  return `${row.source} · ${ACTIVITY_LABEL[row.activity]}`;
}

/**
 * Two lines: what it is, then who it belongs to and what it is doing.
 *
 * The dot carries the three states worth telling apart at a glance — a human is
 * needed, an agent is running, nothing is happening — and a working row's title
 * SWEEPS rather than growing a fourth colour, so a band of running work still
 * reads as one list. Every dimmed thing in the row promotes together on
 * hover/selected (decision #74's vibrancy rule): the row's fill is a veil, so
 * at the canvas band's ceiling this text measures under the contrast floor
 * un-promoted and comfortably over it promoted.
 */
export function ActiveBandRow({
  row,
  ticketPrefix,
  selected,
  onSelect,
}: {
  row: ActiveSessionRow;
  ticketPrefix: string;
  selected: boolean;
  onSelect(): void;
}) {
  const needsYou = row.attention !== null;
  const working = !needsYou && row.activity === "working";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={selected}
        onClick={onSelect}
        // Two lines at the tighter padding: long titles stay readable and the
        // band stops out-massing the board it sits beside.
        className="h-auto min-h-9 items-start gap-2 py-1 [&:hover_.session-row-dim]:text-sidebar-accent-foreground [&[data-active=true]_.session-row-dim]:text-sidebar-accent-foreground"
      >
        <span
          aria-hidden
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            needsYou ? "bg-amber-500" : working ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
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
            <RowIdentity ticket={row.ticket} ticketPrefix={ticketPrefix} />
            <span aria-hidden>·</span>
            <span className="truncate">{stateLine(row)}</span>
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * One line, and quieter than Active on every axis at once.
 *
 * The order is the marks in the order they qualify each other: the kind glyph
 * leads the identity, the identity leads the title, and the age is ALONE on the
 * right. That last part is the whole of the row's geometry — one trailing mark
 * means one right edge, so the age reserves `3ch` of tabular figures and a
 * ticking row can no longer drag the title's truncation point back and forth as
 * "59m" becomes "1h".
 *
 * A cleaned row is one the rules decided was concluded business, showing only
 * because the filter asked for it back. It says so by ghosting and by nothing
 * else: the broom that used to ride the row was a second signifier for a state
 * the reader had just asked to see, and a second signifier on a row this small
 * is clutter. The ghost is 0.80 — enough to read as withdrawn, not so little
 * that the rows a reader turned the filter ON to find are the hardest to read.
 * Its departure takes the state's only accessible name with it, so the row says
 * it out of band.
 */
export function PreviousBandRow({
  row,
  ticketPrefix,
  now,
  selected,
  onSelect,
}: {
  row: PreviousSessionRow;
  ticketPrefix: string;
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
        // `px-2` is gone rather than kept: the button's own `p-2` is already
        // 8px, so the override was a no-op that read like a deliberate
        // difference from the Active row above it.
        className={cn("h-6 gap-1.5 text-xs text-muted-foreground", row.cleaned && "opacity-80")}
      >
        {/* No `session-row-dim` here: this band is uniformly muted, with no
            dim/promote pairing to join — and that class also names the Active
            row's meta line for the smokes' contrast checks. */}
        {row.cleaned ? <span className="sr-only">Cleaned up</span> : null}
        <KindGlyph kind={row.kind} />
        <RowIdentity ticket={row.ticket} ticketPrefix={ticketPrefix} />
        <span className="min-w-0 flex-1 truncate">{row.title}</span>
        {/* 0 is the model's "nothing durable can date this" sentinel — an age
            drawn from it would read as the epoch, so the row says nothing. */}
        {row.endedOrQuietAt > 0 ? (
          <span className="min-w-[3ch] shrink-0 text-right text-label tabular-nums">
            {compactAge(row.endedOrQuietAt, now)}
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
