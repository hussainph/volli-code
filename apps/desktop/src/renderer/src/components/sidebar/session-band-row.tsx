/**
 * The two session-band rows and the small parts they share.
 *
 * Split from `active-sessions.tsx` because that module owns fetching, clocks
 * and navigation, and none of that is what a row is. Everything here is a pure
 * function of a built row plus `now` — the same contract the lab scratch these
 * were prototyped in relied on to draw them against a scrubbable clock.
 *
 * The two rows are deliberately unequal on every axis at once. Active is two
 * lines and full ink; Previous is one line, smaller type, muted. Previous is
 * where you go looking for something you already remember; Active is where you
 * look without being asked, and only one of them can win that competition.
 *
 * WHAT VC-30 CHANGED, AND WHY (the approved lab, `lab/session-peek/`):
 *
 *   1. THE LEADING SLOT IS THE MARK on every row — {@link SessionGlyph}: the
 *      vendor's logo with the state as a badge. It replaces the Active row's
 *      status dot, the Previous row's kind glyph and the Active row's companion
 *      glyph, so one Session reads the same in both bands and in the peek card.
 *   2. THE ACTIVE ROW IS THE SHIPPED TWO-LINE `ListRow`, whose second line says
 *      WHERE and WHEN — `VLT-14 · 2m ago` — and never a state word: the mark
 *      already carries the state, and a line repeating it is noise at a glance.
 *      `stateLine`, `placeLine`, `attentionLine` and `WAITING_COPY` went with it.
 *   3. UNREAD IS ITS OWN AXIS (VC-108): a blue dot in the trailing slot and a
 *      semibold title, never the badge — a result can be unread while a new
 *      turn runs. Right-click marks a chat row read or unread.
 *   4. NO NATIVE `title` ON A PEEKABLE ROW (D1). What the attribute carried —
 *      the untruncated title, the harness, the provenance line — the peek card
 *      says, and a browser tooltip would open on top of it.
 *
 * Rows are addressed by `data-peek-row` / `data-peek-surface`
 * (`components/session-peek/use-session-peek.tsx`): a Session's `<li>`, a
 * folder's disclosure BUTTON — the folder's own `<li>` also holds its children,
 * and a pointer over a child must resolve to the child.
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
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { AsteriskIcon } from "@phosphor-icons/react/dist/csr/Asterisk";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { CursorIcon } from "@phosphor-icons/react/dist/csr/Cursor";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/dist/csr/EnvelopeSimple";
import { EnvelopeSimpleOpenIcon } from "@phosphor-icons/react/dist/csr/EnvelopeSimpleOpen";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { HexagonIcon } from "@phosphor-icons/react/dist/csr/Hexagon";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import {
  displayTicketId,
  harnessLabel,
  isFirstClassHarnessId,
  type FirstClassHarnessId,
  type HarnessId,
  type Ticket,
} from "@volli/shared";

import type {
  ActiveSessionRow,
  PreviousSessionRow,
} from "@renderer/components/sidebar/active-session-listing";
import { canPeekRow, folderRowId } from "@renderer/components/session-peek/peek-subject";
import { SessionGlyph, harnessVendorId } from "@renderer/components/sessions/session-glyph";
import { SessionProvenanceMark } from "@renderer/components/sessions/session-provenance-mark";
import { splitDragSourceProps } from "@renderer/components/split/split-drag-source";
import type { SplitDragPayload } from "@renderer/components/split/split-drop";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { ListRow, type LoadingBarWidth } from "@renderer/components/ui/list-row";
import { SidebarMenuButton, SidebarMenuItem } from "@renderer/components/ui/sidebar";
import { Skeleton } from "@renderer/components/ui/skeleton";
import {
  SESSION_ACTIVITY_LABEL,
  sessionActivityDotState,
} from "@renderer/components/ui/session-activity-status";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { compactAge, relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

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
 * WHICH CLI a terminal companion is running, one glyph per first-class harness
 * (VC-402).
 *
 * The band could not say this at all: a companion row names its harness in the
 * hover `title` and nowhere else, so two rows running Claude Code and Codex
 * differed by their titles and by nothing a reader could scan. Herdr draws the
 * same mark beside its status glyph, and it is the right shape for it — the
 * harness is a property of the row, not an errand, so it belongs in the slot
 * that already qualifies identity rather than in a fourth colour or a word.
 *
 * MNEMONIC, NOT BRANDING. None of these is a vendor logo — a 12px trace of one
 * would be both worse artwork and a claim we have no licence to make. Each is
 * the Phosphor glyph whose silhouette a reader can already attach to the name:
 * Claude's radial burst, the hexagonal knot Codex's vendor is drawn as, the
 * pointer that IS Cursor's word, and `</>` for OpenCode. What the set is
 * actually chosen for is being four silhouettes nothing else in this band
 * shares — radial, polygon, arrow, chevrons, against a rounded terminal
 * rectangle and a speech circle — because told apart at a glance is the whole
 * requirement and detail is what a 12px glyph cannot spend.
 *
 * A CUSTOM SLUG KEEPS THE TERMINAL. A bring-your-own harness has no artwork we
 * could invent that would mean anything, and inventing a second generic mark
 * would only teach the reader a symbol that says "not one of the four".
 * {@link TerminalWindowIcon} already says exactly what is true of it, and it is
 * the mark that row draws today.
 */
const HARNESS_GLYPHS: Record<FirstClassHarnessId, PhosphorIcon> = {
  "claude-code": AsteriskIcon,
  codex: HexagonIcon,
  cursor: CursorIcon,
  opencode: CodeIcon,
};

export function harnessGlyphOf(harnessId: HarnessId): PhosphorIcon {
  return isFirstClassHarnessId(harnessId) ? HARNESS_GLYPHS[harnessId] : TerminalWindowIcon;
}

/**
 * Which logo a row's mark draws, and what it announces (A3).
 *
 * A CHAT is its model's provider; a TERMINAL companion is its harness's
 * VENDOR, so a Claude Code pane and a Claude chat lead with the same logo —
 * they are the same maker, and the row's shape already says which surface it
 * is. Only a harness whose vendor publishes no mark falls back to the
 * {@link HARNESS_GLYPHS} mnemonic this band drew before.
 */
export interface SessionRowVendor {
  providerId: string | null;
  providerLabel: string;
  /** The glyph standing in where there is no logo — a mnemonic, or the kind's own. */
  fallback?: PhosphorIcon;
}

/**
 * The vendor a row's mark is drawn from when the band does not name one.
 *
 * A terminal companion is its harness's vendor, or that harness's shipped
 * mnemonic where nobody publishes one; a chat has no logo to draw without the
 * model its band holds, so it keeps the kind's own glyph and says `Chat`. The
 * default exists so a row is never mark-less: the band's own
 * {@link ActiveSessions} passes the richer answer.
 */
export function sessionRowVendor(row: {
  kind: "chat" | "terminal";
  harnessId: HarnessId | null;
}): SessionRowVendor {
  if (row.kind === "chat") return { providerId: null, providerLabel: "Chat" };
  if (row.harnessId === null) return { providerId: null, providerLabel: "Terminal" };
  const providerId = harnessVendorId(row.harnessId);
  return {
    providerId,
    providerLabel: harnessLabel(row.harnessId),
    ...(providerId === null ? { fallback: harnessGlyphOf(row.harnessId) } : {}),
  };
}

/**
 * The mark's accessible name: who is working, then what it is doing.
 *
 * The words are `SESSION_ACTIVITY_LABEL`'s, composed here because the row is
 * what knows whether it also PRINTS them — and since VC-30 it never does, so
 * this name is the only place the state is said at all.
 */
function markName(vendor: SessionRowVendor, state: StatusDotState | null): string {
  const who = vendor.providerLabel;
  switch (state) {
    case null:
      return who;
    case "working":
    case "setup":
    case "starting":
      return `${who} · ${SESSION_ACTIVITY_LABEL.working}`;
    case "waiting":
      return `${who} · ${SESSION_ACTIVITY_LABEL.waiting}`;
    case "interrupted":
    case "error":
      return `${who} · ${SESSION_ACTIVITY_LABEL.interrupted}`;
    default:
      return `${who} · ${SESSION_ACTIVITY_LABEL.idle}`;
  }
}

/** One row's mark, in the size its band gives it. */
function RowMark({
  vendor,
  state,
  kind,
  size,
}: {
  vendor: SessionRowVendor;
  state: StatusDotState | null;
  kind: "chat" | "terminal";
  size: "row" | "card";
}) {
  return (
    <SessionGlyph
      providerId={vendor.providerId}
      providerLabel={vendor.providerLabel}
      state={state}
      kind={kind}
      fallback={vendor.fallback}
      name={markName(vendor, state)}
      size={size}
      surface="sidebar"
    />
  );
}

/**
 * The unread mark (VC-108, D6), in the row's trailing slot.
 *
 * Blue because it is the one hue neither a state badge nor a vendor logo
 * wears, so it cannot be read as either. `bg-info` is a generated token; the
 * word rides out of band, since a row this narrow has no room to print it.
 */
function UnreadDot() {
  return (
    <span data-unread-dot="" className="flex size-4 shrink-0 items-center justify-center">
      <span aria-hidden className="size-2 rounded-full bg-info" />
      <span className="sr-only">Unread</span>
    </span>
  );
}

/**
 * Right-click on a Session row: read it without opening it, or keep it for
 * later (D6).
 *
 * `null` draws the row with no menu at all, which is the whole answer for a
 * Chat Draft (no Session to mark) and for a terminal companion (amendment A4's
 * Q2: a companion has no turns, so nothing about it is unread).
 */
function ReadMenu({
  unread,
  onToggle,
  children,
}: {
  unread: boolean;
  onToggle: (() => void) | null;
  children: React.ReactElement;
}) {
  if (onToggle === null) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          icon={unread ? EnvelopeSimpleOpenIcon : EnvelopeSimpleIcon}
          onSelect={onToggle}
        >
          {unread ? "Mark as read" : "Mark as unread"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * WHAT THIS ROW WOULD OPEN, if it were dropped on a pane (VC-202 §4) — or
 * `null` for a row that is not a door.
 *
 * A CHAT always drags: the Session is durable, so dropping it adopts it and
 * mints its tab wherever it lands, exactly as clicking the row would. A
 * TERMINAL drags only while it is open, and the reason is the same one that
 * makes its row inert when it is not — the tab IS the terminal, and a pane
 * cannot hold a PTY that has exited.
 *
 * The scope travels with it because the drop cannot infer it: this band lists
 * every Session in the project, ticketed and not, and by the time one is over a
 * pane its row is the only thing that still knows which surface it belongs to.
 */
function sessionRowDragPayload(
  row: ActiveSessionRow | PreviousSessionRow,
  projectId: string,
): SplitDragPayload | null {
  const target = row.target;
  // A closed terminal's saved record is not draggable: a pane holds a live
  // surface, and this Session no longer has one (VC-290).
  if (target === null || target.kind === "session-detail") return null;
  const ticketId = row.ticket?.id ?? null;
  const origin =
    ticketId === null
      ? ({ scope: "project", projectId, ticketId: null } as const)
      : ({ scope: "ticket", projectId, ticketId } as const);
  if (target.kind === "chat") {
    return { ...origin, type: "session", kind: "chat", sessionId: target.sessionId };
  }
  // A terminal target's `tabId` is its tab — which is the thing a pane holds.
  return { ...origin, type: "session", kind: "terminal", sessionId: target.tabId };
}

/**
 * The Active row's second line: WHERE the Session lives, then WHEN it last did
 * anything (D5).
 *
 * Never a state word. The mark beside it already says what the Session is
 * doing, and the line this replaced spent its width saying it twice — "Doing ·
 * Working", "Answer a question" — which at a glance is noise over the one fact
 * a band of twenty rows is actually scanned for: which ticket each row is on.
 * A ticketless Session says so rather than leaving a hole.
 */
export function activeSubtitle(row: ActiveSessionRow, ticketPrefix: string, now: number): string {
  const where =
    row.ticket === null ? "No ticket" : displayTicketId(ticketPrefix, row.ticket.ticketNumber);
  return row.lastActivityAt === null
    ? where
    : `${where} · ${relativeTime(row.lastActivityAt, now)}`;
}

/**
 * Two lines: what it is, then where it lives and when it last spoke.
 *
 * The mark carries the three states worth telling apart at a glance — a human
 * is needed, an agent is running, nothing is happening — and a working row's
 * title still SWEEPS rather than growing a colour, so a band of running work
 * reads as one list. Unread outranks by WEIGHT alone (semibold), with the blue
 * dot at the row's end: two marks on two axes, neither borrowing the other's.
 */
export const ActiveBandRow = React.memo(function ActiveBandRow({
  row,
  projectId,
  ticketPrefix,
  now,
  selected,
  unread = false,
  vendor,
  onSelect,
  onToggleRead,
}: {
  row: ActiveSessionRow;
  /** Whose project this band belongs to — half of a drag payload's scope. */
  projectId: string;
  ticketPrefix: string;
  /** The clock the last-activity age is read against. */
  now: number;
  selected: boolean;
  /** Whether this Session has work nobody has looked at (VC-108). */
  unread?: boolean;
  /**
   * Whose logo leads the row. Built by the band, which is the surface holding
   * the chat records a model selection lives on; absent falls back to what the
   * row itself can say ({@link sessionRowVendor}).
   */
  vendor?: SessionRowVendor;
  onSelect(row: ActiveSessionRow): void;
  /**
   * Marks the row read or unread. `null` on a row with no Session to mark — a
   * Chat Draft — and on a terminal companion, which has no turns (A4 Q2).
   */
  onToggleRead?: ((row: ActiveSessionRow) => void) | null;
}) {
  const needsYou = row.attention !== null;
  const working = !needsYou && row.activity === "working";
  const kind = row.target?.kind === "chat" ? "chat" : "terminal";
  const mark = vendor ?? sessionRowVendor({ kind, harnessId: row.harnessId });
  // A Draft stands for no Session, so it has no peek and nothing to read.
  const peekable = canPeekRow(row.id);
  const title = unread ? "font-semibold text-sidebar-foreground" : "font-medium";

  return (
    <SidebarMenuItem
      data-peek-row={peekable ? row.id : undefined}
      data-peek-surface={peekable ? "nav" : undefined}
      data-unread={unread ? "" : undefined}
    >
      <ReadMenu
        unread={unread}
        onToggle={
          onToggleRead === null || onToggleRead === undefined || !peekable
            ? null
            : () => onToggleRead(row)
        }
      >
        <ListRow
          density="two-line"
          selected={selected}
          onActivate={() => onSelect(row)}
          // Draggable onto a pane (VC-202): the same door, opened somewhere
          // specific. A row with no live target does not drag. The props land
          // on the activation target, which is what a pointer presses.
          {...splitDragSourceProps(sessionRowDragPayload(row, projectId))}
          // NO `title` (D1): the peek says the untruncated title, the harness
          // and the provenance line, and a browser tooltip would open over it.
          leading={
            <RowMark
              vendor={mark}
              state={sessionActivityDotState(row.activity, { attention: needsYou })}
              kind={kind}
              size="card"
            />
          }
          primary={
            working ? (
              <span className={cn("session-title-sweep min-w-0 flex-1 text-ui", title)}>
                {row.title}
                <span className="session-title-peak" aria-hidden>
                  {row.title}
                </span>
              </span>
            ) : (
              <span className={cn("min-w-0 truncate text-ui text-sidebar-foreground", title)}>
                {row.title}
              </span>
            )
          }
          // The provenance mark qualifies WHOSE Session this is, so it rides
          // the title's own line — and draws nothing at all on a row no
          // Automation started (VC-131).
          primaryTrailing={
            <SessionProvenanceMark provenance={row.provenance} rowTitle={row.title} />
          }
          secondary={activeSubtitle(row, ticketPrefix, now)}
          trailing={unread ? <UnreadDot /> : undefined}
        />
      </ReadMenu>
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
  projectId,
  ticketPrefix,
  now,
  selected,
  vendor,
  onSelect,
  onToggleRead,
  showIdentity = true,
}: {
  row: PreviousSessionRow;
  /** Whose project this band belongs to — half of a drag payload's scope. */
  projectId: string;
  ticketPrefix: string;
  /**
   * The clock the age below is read against. It advances on the next instant
   * one of these rows' ages actually reads differently (`nextAgeChangeAt`) —
   * roughly a minute for a fresh row and a day for an old one — never on an
   * interval, so this prop is not a per-second re-render of the band.
   */
  now: number;
  selected: boolean;
  /** Whose logo leads the row — see {@link ActiveBandRow}'s own prop. */
  vendor?: SessionRowVendor;
  onSelect(row: PreviousSessionRow): void;
  /**
   * Marks the row unread, which brings its Session back to Active (VC-108).
   * `null` on a terminal companion, which has no turns to be unread (A4 Q2).
   */
  onToggleRead?: ((row: PreviousSessionRow) => void) | null;
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
  const peekable = canPeekRow(row.id);
  return (
    <SidebarMenuItem
      data-peek-row={peekable ? row.id : undefined}
      data-peek-surface={peekable ? "nav" : undefined}
    >
      <ReadMenu
        unread={false}
        onToggle={
          onToggleRead === null || onToggleRead === undefined || !peekable
            ? null
            : () => onToggleRead(row)
        }
      >
        <SidebarMenuButton
          size="sm"
          isActive={selected}
          onClick={() => onSelect(row)}
          {...splitDragSourceProps(sessionRowDragPayload(row, projectId))}
          // `px-2` is gone rather than kept: the button's own `p-2` is already
          // 8px, so the override was a no-op that read like a deliberate
          // difference from the Active row above it.
          //
          // NO `title` (D1). What it carried — the untruncated title, the
          // harness's words, the provenance line — the peek's card says, and a
          // native tooltip would open on top of that card.
          className={cn("h-6 gap-1.5 text-ui text-muted-foreground", row.cleaned && "opacity-80")}
        >
          {/* No `session-row-dim` here: this band is uniformly muted, with no
              dim/promote pairing to join — and that class also names the Active
              row's meta line for the smokes' contrast checks. */}
          {row.cleaned ? <span className="sr-only">Cleaned up</span> : null}
          {/* One mark everywhere (A3), and a Previous row passes its REAL state:
              an interrupted chat stays interrupted here, because the record's
              activity is durable and survived the relaunch (VC-324). The words
              ride in the mark's own name, as this row's size demands. */}
          <RowMark
            vendor={vendor ?? sessionRowVendor(row)}
            state={row.activity === "interrupted" ? "interrupted" : "idle"}
            kind={row.kind}
            size="row"
          />
          {showIdentity ? <RowIdentity ticket={row.ticket} ticketPrefix={ticketPrefix} /> : null}
          {/* Same slot as the Active row's — beside the title — so a Session
              keeps its mark in the same place as it ages out of one band and
              into the other. */}
          <SessionProvenanceMark provenance={row.provenance} rowTitle={row.title} />
          <span className="min-w-0 flex-1 truncate">{row.title}</span>
          {/* 0 is the model's "nothing durable can date this" sentinel — an age
              drawn from it would read as the epoch, so the row says nothing. */}
          {row.endedOrQuietAt > 0 ? (
            <span className="min-w-[3ch] shrink-0 text-right text-label tabular-nums">
              {compactAge(row.endedOrQuietAt, now)}
            </span>
          ) : null}
        </SidebarMenuButton>
      </ReadMenu>
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
      // The folder's peek hangs off the BUTTON, not off its `<li>`: that
      // element also holds the nested list of its Sessions, and a pointer over
      // a child must resolve to the child (D2, `use-session-peek.tsx`).
      data-peek-row={folderRowId(ticket.id)}
      data-peek-surface="nav"
      onClick={() => onToggle(ticket.id)}
      // No `title`, for the reason the rows above dropped theirs (D1): this row
      // peeks its TICKET, and the card says the id and the title in full.
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

/**
 * The box a band row will take, while the project's listing is being read
 * (VC-383).
 *
 * The same two-line shape at the same `min-h-9` and the same half-step
 * alignments the row above records — the dot on the cap height, the meta line
 * bound to its title — so the rows that replace this land where it stood.
 * VC-383 also records this skeleton's own `pt-0.5` and `gap-1.5`: its shorter
 * 14px/12px bars need the 2px nudge and 6px join to sit in that measured
 * two-line box before real text replaces them. Widths are per row and fixed:
 * the band is waiting, and a placeholder that redraws itself on every mount
 * adds motion to a surface that has none to give. Inert, with no hover fill:
 * there is nothing under it to activate.
 */
export function SessionBandRowSkeleton({ primaryWidth }: { primaryWidth: LoadingBarWidth }) {
  return (
    <SidebarMenuItem aria-hidden>
      <div className="flex min-h-9 w-full items-start gap-2 rounded-md px-2 py-1">
        <Skeleton className="mt-1.5 size-2 shrink-0 rounded-full" />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <Skeleton className={cn("h-3.5", primaryWidth)} />
          <Skeleton className="h-3 w-1/3" />
        </span>
      </div>
    </SidebarMenuItem>
  );
}
