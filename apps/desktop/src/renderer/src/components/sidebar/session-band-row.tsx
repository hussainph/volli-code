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
 *
 * **Both are memoised, and `onSelect` takes its row.** These bands are the one
 * list in the app whose length nobody controls — Previous holds every Session a
 * project has ever had — and the section around them re-renders for reasons
 * that touch one row at most: a tab coming forward, a nav switch, an age
 * ticking over. A per-row `() => activate(row)` closure would defeat the memo
 * on every one of those, so the handler is the section's own stable callback
 * and the row hands its own row back to it.
 */
import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import {
  displayTicketId,
  TICKET_STATUS_LABELS,
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
import { StatusDot } from "@renderer/components/ui/status-dot";
import { compactAge } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

const ACTIVITY_LABEL: Record<SessionActivityState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  parked: "Parked",
  exited: "Exited",
  stopped: "Stopped",
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
 * A FACE, NOT A LANE. The id has been `font-mono` from the start and it was not
 * enough: it sits inside `text-label`, which bakes in +0.05em of tracking for
 * the uppercase sans labels it was drawn for, and tracked-out monospace at 11px
 * is a font that has given up the one property anybody wants from it. `VLT-14`
 * measured the same rhythm as the Mona beside it and the whole line read as one
 * grey phrase — which is exactly what "they all blend together" describes.
 *
 * Handing the tracking back is the whole fix, and it is what the scratch draws.
 * A fixed-width column on top of it was tried and reverted: sized for the worst
 * case — a four-character prefix and three digits — it spends that width on
 * every row, so a two-character prefix leaves a visible hole before the `·`, a
 * ticketless row centres a 12px glyph in it, and every Previous row pays the
 * remainder out of its title's truncation point. A column only earns its keep
 * when the things in it are the same length, and ticket ids are not.
 */
const ID_LANE =
  // `inline-flex items-center` so the globe variant centres on the text
  // baseline's box rather than sitting on it.
  //
  // `text-label` here rather than on a wrapper, so the identity is one size in
  // both bands instead of 11px under the Active row's meta line and 12px
  // inheriting the Previous row's button.
  //
  // `tracking-normal` last, undoing `text-label`'s baked +0.05em — see above.
  "inline-flex shrink-0 items-center font-mono text-label tracking-normal";

function RowIdentity({ ticket, ticketPrefix }: { ticket: Ticket | null; ticketPrefix: string }) {
  if (ticket === null) {
    return (
      <span className={ID_LANE}>
        {/* `bold` OVERRIDES the audit's `regular` verdict for this site
            (the retired icon-weight-audit lab scratch), under CLAUDE.md's fifth
            clause: this glyph stands in the ID lane at 12px, where regular draws
            lighter than the `text-label` ids it alternates with — so the one
            row without a ticket would read as the faintest row in the band. */}
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
      {/* `bold` OVERRIDES the audit's `regular` verdict for both glyphs
          (the retired icon-weight-audit lab scratch), under CLAUDE.md's fifth clause:
          at 12px regular draws lighter than the row's own title, and a kind that
          leads the identity cannot be the faintest mark in the row it opens.
          Emphatically not `fill` — at this size ChatCircle's is a solid disc
          covering 54% of its box, which the audit is right to refuse. */}
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

/**
 * The meta line's first slot: WHERE the Session lives, not what launched it.
 *
 * This slot used to hold the source label — the harness name, or `Chat · Live`
 * for an attached chat. Neither is what a reader scans this band for. A band
 * holding twenty Sessions is parsed by which ticket column each one sits in,
 * and "Live" in particular said only what the Active band already says by
 * being the Active band. The ticket's status is the fact that makes the list
 * sortable by eye, so it takes the slot; the harness moves to the row's
 * `title`, where a question asked about ONE row belongs.
 *
 * A ticketless row — a project Project Session, or one whose ticket has left
 * the board — has no column to name and keeps its source. That is also the one
 * place `Chat · Live` still earns its keep: with no status to say it better,
 * whether the attachment is still open is the only thing worth saying.
 */
function placeLine(row: ActiveSessionRow): string {
  return row.ticket === null ? row.source : TICKET_STATUS_LABELS[row.ticket.status];
}

/** The Active row's second line: why a human is needed, else where it lives and what is running. */
function stateLine(row: ActiveSessionRow): string {
  if (row.attention !== null) return attentionLine(row.attention, row.waitingOn);
  // A session whose hooks never arrived states that, in place of an activity it
  // would only be guessing at. Every other row keeps its activity word: a Known
  // harness never promised to report, so inference there is not news.
  if (row.activitySource === "silent") return `${placeLine(row)} · Not reporting`;
  return `${placeLine(row)} · ${ACTIVITY_LABEL[row.activity]}`;
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
export const ActiveBandRow = React.memo(function ActiveBandRow({
  row,
  ticketPrefix,
  now,
  selected,
  onSelect,
}: {
  row: ActiveSessionRow;
  ticketPrefix: string;
  /** The clock the last-activity age is read against. */
  now: number;
  selected: boolean;
  onSelect(row: ActiveSessionRow): void;
}) {
  const needsYou = row.attention !== null;
  const working = !needsYou && row.activity === "working";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={selected}
        onClick={() => onSelect(row)}
        // The source label's new home, now that the ticket's status holds the
        // meta line's first slot. Native `title` rather than the button's
        // `tooltip` prop: that one is Radix and `hidden` unless the sidebar is
        // COLLAPSED (`ui/sidebar.tsx`), so it would never fire on the expanded
        // band this row lives in. The full title rides along because the
        // visible one truncates.
        title={`${row.title}\n${row.source}`}
        // Two lines at the tighter padding: long titles stay readable and the
        // band stops out-massing the board it sits beside.
        className="h-auto min-h-9 items-start gap-2 py-1 [&:hover_.session-row-dim]:text-foreground [&[data-active=true]_.session-row-dim]:text-foreground"
      >
        {/* The third copy of the status→tone map was written out right here,
            which is how this band could paint a Session amber while the ticket
            strip painted the same one with the accent. The row states the STATE
            and `ui/status-dot.tsx` owns what colour that is. */}
        {/* THE TWO HALF-STEPS HERE ARE DELIBERATE, and they are the recorded
            exception to the 0/4/8/16/24 spacing collapse. `mt-1.5` is optical
            alignment — it drops the dot onto the title's cap height, which is a
            measurement of the type, not a rung of the rhythm. `gap-0.5` is what
            binds the title to its meta line: at 4px the pair spaces the same as
            the gap BETWEEN rows and the two lines stop reading as one entity,
            which is the whole shape of this band. Screenshot-verified against
            the collapse; anything that moves them has to look at the band. */}
        <StatusDot state={needsYou ? "waiting" : working ? "working" : "idle"} className="mt-1.5" />
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
            {row.lastActivityAt !== null ? (
              <span className="shrink-0 text-label tabular-nums">
                last {compactAge(row.lastActivityAt, now)}
              </span>
            ) : null}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});

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
export const PreviousBandRow = React.memo(function PreviousBandRow({
  row,
  ticketPrefix,
  now,
  selected,
  onSelect,
  showIdentity = true,
}: {
  row: PreviousSessionRow;
  ticketPrefix: string;
  /**
   * The clock the age below is read against. It advances on the next instant
   * one of these rows' ages actually reads differently (`nextAgeChangeAt`) —
   * roughly a minute for a fresh row and a day for an old one — never on an
   * interval, so this prop is not a per-second re-render of the band.
   */
  now: number;
  selected: boolean;
  onSelect(row: PreviousSessionRow): void;
  /**
   * Whether the row draws its own ticket id. `false` under a
   * {@link TicketGroupRow}, where the id is the thing the reader just expanded
   * and repeating it on every child is noise the row pays for twice — once in
   * ink, and once in the ~45px of width it takes out of a title that truncates.
   *
   * A prop rather than a second component: everything else about a nested child
   * — the kind glyph, the muted tier, the `3ch` age column holding one right
   * edge — is unchanged, and a copy of this row that drifted from it would be a
   * worse outcome than one conditional.
   */
  showIdentity?: boolean;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        isActive={selected}
        onClick={() => onSelect(row)}
        // `px-2` is gone rather than kept: the button's own `p-2` is already
        // 8px, so the override was a no-op that read like a deliberate
        // difference from the Active row above it.
        className={cn("h-6 gap-1.5 text-ui text-muted-foreground", row.cleaned && "opacity-80")}
      >
        {/* No `session-row-dim` here: this band is uniformly muted, with no
            dim/promote pairing to join — and that class also names the Active
            row's meta line for the smokes' contrast checks. */}
        {row.cleaned ? <span className="sr-only">Cleaned up</span> : null}
        <KindGlyph kind={row.kind} />
        {showIdentity ? <RowIdentity ticket={row.ticket} ticketPrefix={ticketPrefix} /> : null}
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
});

/**
 * The id tying a {@link TicketGroupRow} to the list it discloses, so the
 * disclosure is announced as a control OVER something rather than as a lone
 * "expanded". Derived from the ticket id rather than taken from `useId` because
 * the two ends are rendered by different components — the row here, the list by
 * the band — and a derived id needs no channel between them.
 *
 * The list is unmounted while the group is collapsed, so this names nothing in
 * that state. That is the same trade Radix's `Collapsible` made in the sidebar
 * file tree that used to sit one section up (retired with the Files nav item,
 * VC-122), and it is the right side of it: keeping every hidden row mounted to
 * satisfy the reference would cost the band exactly the density this grouping
 * exists to buy.
 */
export function sessionGroupPanelId(ticketId: string): string {
  return `session-group-${ticketId}`;
}

/**
 * A ticket, standing for the Previous sessions filed under it (VC-69).
 *
 * The Previous band is unbounded by design and sorted by global recency, so a
 * ticket's sessions were never adjacent to each other: eight runs of one ticket
 * arrived scattered the width of the whole list, each row repeating the same id
 * and most of them titled "Chat". This row is what collapses that — one entry
 * per ticket, holding its id, its title, how many sessions are behind it and
 * when the newest of them last did anything.
 *
 * **The caller supplies the `SidebarMenuItem`**, unlike the two rows above,
 * which wrap themselves in one. The list this row discloses has to sit inside
 * the same `<li>` to be that row's child, and only the caller holds both. A row
 * dropped straight into a `SidebarMenu` would put a `<button>` in a `<ul>`.
 *
 * **It carries no status dot, and that is structural rather than an omission.**
 * A Session needing a human is pinned to the Active band for as long as it is
 * asking, so nothing behind a collapsed ticket here can ever be waiting on
 * anyone — see {@link PreviousListingEntry}. A dot would be a mark that is
 * always the same colour, which is how a reader learns to stop reading dots.
 *
 * **The count is drawn even at 1.** Every ticket gets one of these rows, so the
 * count is the only thing that says which of them is hiding a stack; a row that
 * showed it only when it exceeded one would make the common case unreadable to
 * anybody who had not noticed the rule.
 *
 * **Nothing animates except the caret.** A disclosure in a navigator is opened
 * tens of times a day, which is the frequency where motion should be reduced
 * rather than added, and animating the list's height would be layout and paint
 * inside a scroll container this band can fill. The caret's `transform` is the
 * whole treatment — the same one the sidebar's file tree settled on before it
 * retired (VC-122).
 */
export const TicketGroupRow = React.memo(function TicketGroupRow({
  ticket,
  ticketPrefix,
  count,
  newestAt,
  now,
  open,
  selected,
  onToggle,
}: {
  ticket: Ticket;
  ticketPrefix: string;
  count: number;
  newestAt: number;
  /** The same clock the child rows' ages are read against. */
  now: number;
  open: boolean;
  /**
   * Whether the Session in front of you is one of this ticket's.
   *
   * The band reveals that group as well as marking it, so the two normally
   * show together — the child carries the precise highlight, this one says
   * which stack it came out of. They come apart in the one state that needs
   * this most: collapse the group by hand and the mark is all that is left
   * pointing at where you are.
   */
  selected: boolean;
  onToggle(ticketId: string): void;
}) {
  return (
    <SidebarMenuButton
      size="sm"
      isActive={selected}
      aria-expanded={open}
      aria-controls={sessionGroupPanelId(ticket.id)}
      onClick={() => onToggle(ticket.id)}
      title={`${displayTicketId(ticketPrefix, ticket.ticketNumber)} · ${ticket.title}`}
      className="h-6 gap-1.5 text-ui"
    >
      {/* `bold` for the same reason every other glyph in this band takes it:
          at 12px regular draws lighter than the label beside it. */}
      <CaretRightIcon
        weight="bold"
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
      />
      <span className={ID_LANE}>{displayTicketId(ticketPrefix, ticket.ticketNumber)}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{ticket.title}</span>
      <span className="shrink-0 text-label tabular-nums text-muted-foreground/70">
        {count}
        {/* The count and the age are two unlabelled numbers standing next to
            each other, which a screen reader runs into one token — 3 sessions
            at 43m read as "343m". The unit is what breaks them apart, and it is
            spelled only where there is room for it, which is out of band. */}
        <span className="sr-only">{count === 1 ? " session" : " sessions"}</span>
      </span>
      {/* The same `3ch` reservation the child rows make, for the same reason:
          one trailing mark, one right edge, and a ticking age that cannot drag
          the title's truncation point back and forth as "59m" becomes "1h".
          And the same 0 sentinel they honour: "nothing durable can date this"
          drawn as an age would read as the epoch, so the row says nothing. */}
      {newestAt > 0 ? (
        <span className="min-w-[3ch] shrink-0 text-right text-label tabular-nums text-muted-foreground">
          {compactAge(newestAt, now)}
        </span>
      ) : null}
    </SidebarMenuButton>
  );
});
