/**
 * The sidebar row's right edge: what lands on it, how far in it sits, and what
 * happens to it the moment the list is long enough to scroll.
 *
 * ROUND 1 settled the marks. The kind glyph leads the identity it qualifies,
 * the age is alone on the right, the broom is retired, and a cleaned row says
 * so by ghosting. What remains is geometry, and it turned out to have a third
 * term nobody had counted.
 *
 * THE MEASUREMENT, from the pane's right wall inward. `SidebarGroup` spends 8,
 * the row button another 8, and the framed shell's presentation pane a fold of
 * 6 (globals.css § SEAM GEOMETRY) — 22 to a row's ink, 14 to its hover pill.
 * The band header spends the same 16 and then CENTRES its glyph in a 20px box,
 * landing that glyph's ink further in again. Three edges where the eye expects
 * one, and that gap is the whole of "it's not symmetrical". The correction is a
 * property of the trigger's own box — half of `20 − glyph` — so it is unchanged
 * at every fold step, and it is the ONE number here that moved when the icon
 * audit settled the small-glyph tier at 12px bold rather than 14px regular:
 * `(20 − 12) / 2` = 4, where a 14px glyph would have wanted 3.
 *
 * THE FOURTH EDGE, and the reason the fold is now 2 rather than 6. Volli styles
 * `*::-webkit-scrollbar` at 10px wide (globals.css § Scrollbars). Authoring that
 * pseudo-element takes the element off Chromium's overlay path, so the bar is a
 * CLASSIC scrollbar: it takes 10px of layout out of the scrollport the moment
 * the content overflows. The scroll container here is `SidebarContent`, INSIDE
 * the pane — so a session list long enough to scroll shoves every row's ink from
 * 22 to 32 and back again as the list grows and shrinks. The fold was never the
 * biggest number on that edge.
 *
 * That also disposes of the macOS "Show scroll bars: Always" trap, in the
 * direction nobody wants: because the app already draws a custom scrollbar, the
 * system setting is irrelevant and the space is reserved in BOTH settings. The
 * fix is not to reserve less; it is to reserve nothing. § ScrollPane hides the
 * real bar outright and draws an overlay thumb inside the 10px of gutter the row
 * pill already leaves, which is ephemeral by construction — it cannot reserve a
 * gutter because it is not in the layout at all. With the scrollbar out of the
 * flow the fold has no work left except the fold itself, and 2 is the smallest
 * value at which a hard seam still reads differently from the soft canvas edge.
 *
 * WHAT IS COPIED RATHER THAN IMPORTED. `KindGlyph`, `RowIdentity`,
 * `PreviousBandRow` and the filter trigger hardcode `weight="fill"` and their
 * child order, which is what is being proposed against — so the Proposed column
 * carries copies and the Current column is the shipped component, untouched.
 *
 * The copies draw at 12px `bold`, which is the icon audit's answer and reverses
 * a guess of mine: I grew the kind glyph to 14px because at 12px regular it read
 * as a hairline. Coverage is scale-invariant — two icons of the same weight have
 * identical ink whatever their size — so growth could never have fixed that. The
 * hairline is pen width, and Phosphor's pen is 16/256 em regular against 24/256
 * bold, which at 12px is 0.75px against 1.13px next to a ~1.1px text stem. Bold
 * at 12 lands on the stem; regular at 14 reaches 0.88px and costs 17% more
 * footprint for it. The toggle keeps all three so the pen is visible as a pen.
 *
 * WHY LITERAL ROWS. `sidebar-sessions.tsx` drives the real listing model on a
 * scrubbable clock and that is where the model belongs. Alignment needs a set of
 * ages chosen to be different STRING WIDTHS — including "just now", the one the
 * column cannot hold — and no single clock position produces all of them.
 */
import * as React from "react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FunnelSimpleIcon } from "@phosphor-icons/react/dist/csr/FunnelSimple";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { apcaLc, compositeHex, displayTicketId, isHexColor, type Ticket } from "@volli/shared";

import type {
  ActiveSessionRow,
  PreviousSessionRow,
  SessionRowKind,
} from "@renderer/components/sidebar/active-session-listing";
import {
  DEFAULT_SESSION_BAND_FILTER,
  SessionBandFilterMenu,
  SessionBandHeader,
} from "@renderer/components/sidebar/session-band-header";
import { ActiveBandRow, PreviousBandRow } from "@renderer/components/sidebar/session-band-row";
import {
  Sidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@renderer/components/ui/sidebar";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

import { NOW, project, ticketById } from "../fixtures";

export const title = "Sidebar · Row anatomy";
export const note = "One right edge, an ephemeral scrollbar, and what the ghost costs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Phosphor's candidate weights for a 12px sidebar mark. `bold` is the audit's
 * answer; the other two are here to be looked at, not to be chosen — `fill`
 * because it is what ships today, `regular` because it is the baseline the
 * audit's rule starts from before the pen argument moves it.
 */
type GlyphWeight = "bold" | "regular" | "fill";

/** How a cleaned Previous row says so, now that the broom is retired. */
type CleanedSignifier = "ghost" | "ghost-indent" | "indent";

type Appearance = "dark" | "light";

/**
 * The insets the proposal reconciles, measured from the pane's right WALL and
 * named once so the guides and the rows can never disagree about where the edge
 * is. Both stack on the fold, which is the stepper.
 *
 *   ink  — the age's last pixel, and the filter glyph's.
 *   pill — where the row's hover fill stops, 8px further out. Also, now, the
 *          channel the overlay scrollbar runs in.
 */
const INK_INSET = 16;
const PILL_INSET = 8;

/** The fold steps, and the one this proposes. See the module comment for why 2. */
const FOLD_STEPS = [6, 4, 2, 0] as const;
const PROPOSED_FOLD = 2;

/**
 * The sidebar's small-glyph size, and the filter trigger's box around it.
 * Separate constants because the gap between them is the misalignment.
 */
const GLYPH_PX = 12;
const TRIGGER_BOX_PX = 20;

/**
 * Half the difference between the trigger's box and its glyph — exactly how far
 * the glyph sits inside the column the age defines, and so exactly how far the
 * trigger has to be pushed out. Written as the subtraction rather than as `4`
 * because it is a fact about the trigger, not about the fold: unchanged at every
 * step of the stepper, and the one number the 14 → 12 glyph decision moved.
 */
const FILTER_GLYPH_NUDGE = (TRIGGER_BOX_PX - GLYPH_PX) / 2;

/** What `*::-webkit-scrollbar` reserves today, whenever a container overflows. */
const NATIVE_SCROLLBAR_RESERVE = 10;

/** The overlay thumb: the app's own 4px pill, at rest and then gone. */
const THUMB_WIDTH = 4;
const THUMB_MIN_HEIGHT = 20;
const THUMB_FADE_MS = 700;

/**
 * The floor an 11px meta row is held to.
 *
 * Not a number of mine: `ARC_TUNING.ink.mutedFloor` is 48 and says in its own
 * comment that it "sits above APCA's 45 for large or bold text, which is the
 * relevant line for an 11px meta row". 45 is therefore the line a GHOSTED row
 * must still clear, since a reader who turned the cleaned filter on is looking
 * for one of these rows specifically — they are the rows most needing to be
 * read at that moment, not least.
 */
const MUTED_LC_FLOOR = 45;

/**
 * What the sidebar's text actually sits on, per appearance: the shipped default
 * canvas's base fill and its one pool stop, each under the tier-2 lift.
 *
 * Hardcoded from the generated block in `globals.css` rather than read back,
 * because `--canvas` is a multi-stop `background-image` and there is no token
 * holding either stop on its own. The lift is applied here rather than baked in
 * so the arithmetic stays visible — a lifted surface is the composite, and
 * scoring against the bare gradient would flatter every tier.
 */
const CANVAS_SURFACES: Record<Appearance, { lift: string; liftAlpha: number; stops: string[] }> = {
  dark: { lift: "#fbf1ed", liftAlpha: 0.03, stops: ["#481600", "#55220b"] },
  light: { lift: "#fdded2", liftAlpha: 0.175, stops: ["#ff9970", "#ffb294"] },
};

/**
 * The Previous band's age, with the one string that does not fit the column
 * given a form that does.
 *
 * `compactAge` inherits "just now" from `relativeTime`, eight characters where
 * every other answer is two or three — so a Session that ended forty seconds ago
 * is the one row that drags the title's truncation point sideways, on the
 * surface whose right edge is meant to be a column. Every row in this band is in
 * the past by construction; "now" says the same thing in the width of "12h".
 */
function proposedAge(at: number, now: number): string {
  const compact = relativeTime(at, now).replace(/ ago$/, "");
  return compact === "just now" ? "now" : compact;
}

/**
 * {@link KindGlyph}, at the shipped 12px with the weight on the outside.
 *
 * The size is deliberately unchanged even though this glyph now LEADS the row.
 * Leading is a heavier job than trailing, but weight is what answers that and
 * size is not: see the module comment on the pen.
 */
function ProposedKindGlyph({ kind, weight }: { kind: SessionRowKind; weight: GlyphWeight }) {
  const Glyph = kind === "chat" ? ChatCircleIcon : TerminalWindowIcon;
  return (
    <span className="flex shrink-0 items-center">
      <Glyph
        weight={weight}
        aria-label={kind === "chat" ? "Chat" : "Terminal"}
        className="size-3"
      />
    </span>
  );
}

/**
 * {@link RowIdentity}, unchanged except for the weight. The globe stands in for
 * 11px mono text and is now the same 12px as the kind glyph beside it, which is
 * the point of a tier: one size, one pen, whatever the mark is doing.
 */
function ProposedIdentity({
  ticket,
  ticketPrefix,
  weight,
}: {
  ticket: Ticket | null;
  ticketPrefix: string;
  weight: GlyphWeight;
}) {
  if (ticket === null) {
    return (
      <span className="flex shrink-0 items-center">
        <GlobeIcon weight={weight} aria-label="No ticket" className="size-3" />
      </span>
    );
  }
  return (
    <span className="shrink-0 font-mono">{displayTicketId(ticketPrefix, ticket.ticketNumber)}</span>
  );
}

/**
 * The proposed Previous row: kind, then identity, then title, then the age
 * alone on the right.
 *
 * Three things beyond the reorder. The age reserves `3ch` of tabular figures, so
 * a ticking row cannot drag the title's truncation point back and forth as
 * "59m" becomes "1h" — a reserved column is what `tabular-nums` was always for.
 * The broom's departure takes the state's only accessible name with it, so the
 * row says it out of band. And `px-2` is dropped rather than kept: the button's
 * own `p-2` is already 8px, so the shipped override was a no-op that read like a
 * deliberate difference from the Active row above it.
 */
function ProposedPreviousRow({
  row,
  ticketPrefix,
  now,
  selected,
  onSelect,
  weight,
  signifier,
  ghost,
}: {
  row: PreviousSessionRow;
  ticketPrefix: string;
  now: number;
  selected: boolean;
  onSelect(): void;
  weight: GlyphWeight;
  signifier: CleanedSignifier;
  ghost: number;
}) {
  const ghosted = row.cleaned && signifier !== "indent";
  const indented = row.cleaned && signifier !== "ghost";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        isActive={selected}
        onClick={onSelect}
        style={ghosted ? { opacity: ghost } : undefined}
        className={cn("h-6 gap-1.5 text-xs text-muted-foreground", indented && "pl-4")}
      >
        {row.cleaned ? <span className="sr-only">Cleaned up</span> : null}
        <ProposedKindGlyph kind={row.kind} weight={weight} />
        <span className="text-label">
          <ProposedIdentity ticket={row.ticket} ticketPrefix={ticketPrefix} weight={weight} />
        </span>
        <span className="min-w-0 flex-1 truncate">{row.title}</span>
        {row.endedOrQuietAt > 0 ? (
          <span className="min-w-[3ch] shrink-0 text-right text-label tabular-nums">
            {proposedAge(row.endedOrQuietAt, now)}
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The filter trigger, pushed out by exactly the padding its own box adds around
 * its glyph, so the glyph — not the box — lands on the age column.
 *
 * The box then ends 4px outside that column, which is correct rather than
 * residue: a hit target should be bigger than its mark. It still stops 4px
 * short of the row pill directly beneath it at every fold step, so the header's
 * hover fill never reaches further out than the rows' — icons align to their
 * ink, boxes align to their neighbours' boxes, and neither has to give.
 *
 * A plain button rather than the real menu because what is IN the menu is
 * settled and where its glyph lands is not. Clicking toggles the narrowed tint,
 * which is the thing the "trust the user knows the filter is on" argument rests
 * on and therefore worth being able to see.
 */
function ProposedFilterTrigger({
  narrowed,
  onToggle,
  weight,
}: {
  narrowed: boolean;
  onToggle(): void;
  weight: GlyphWeight;
}) {
  return (
    <button
      type="button"
      aria-label="Filter"
      aria-pressed={narrowed}
      onClick={onToggle}
      style={{ marginRight: -FILTER_GLYPH_NUDGE }}
      className={cn(
        "flex size-5 items-center justify-center rounded-sm ring-sidebar-ring outline-hidden transition-colors hover:bg-sidebar-accent-veil hover:text-sidebar-accent-foreground focus-visible:ring-2",
        narrowed ? "text-sidebar-accent-foreground" : "text-muted-foreground",
      )}
    >
      <FunnelSimpleIcon weight={weight} className="size-3" />
    </button>
  );
}

/**
 * The two edges, drawn. Solid is the ink column every trailing mark should land
 * on; the faint one is where the hover pill stops — a different edge on purpose,
 * and the channel the overlay thumb runs in.
 */
function EdgeGuides({ fold }: { fold: number }) {
  return (
    <>
      <span
        aria-hidden
        style={{ right: PILL_INSET + fold }}
        className="pointer-events-none absolute inset-y-0 z-20 w-px bg-primary/25"
      />
      <span
        aria-hidden
        style={{ right: INK_INSET + fold }}
        className="pointer-events-none absolute inset-y-0 z-20 w-px bg-primary/70"
      />
    </>
  );
}

/** Where the overlay thumb sits, in the scrollport's own pixels. */
interface ThumbGeometry {
  top: number;
  height: number;
}

/**
 * A scroll container that reserves nothing.
 *
 * `[&::-webkit-scrollbar]:hidden` is the whole trick and it is worth being
 * precise about what it buys. Chromium takes an element off the overlay
 * scrollbar path as soon as ANY author `::-webkit-scrollbar` rule matches it,
 * which globals.css already does app-wide — so today's bar is a classic one that
 * costs 10px of scrollport whenever the content overflows, in every macOS "Show
 * scroll bars" setting. Collapsing it to `display: none` keeps that custom path
 * (the system setting stays irrelevant, which is the point) and takes the width
 * to zero, so the layout is identical whether or not the list overflows. There
 * is no `scrollbar-gutter: stable` here and there must not be: a stable gutter
 * is the always-on reservation this is removing.
 *
 * The thumb that replaces it is a sibling, absolutely positioned, drawn in the
 * channel the row pill already leaves — so it is ephemeral by construction
 * rather than by timing. It reveals on scroll and fades, and also while the
 * container is hovered, which is the same progressive reveal the global
 * scrollbar rules describe; what it does not do is take part in layout.
 *
 * Wheel and trackpad scrolling still work untouched — only the painted widget
 * is gone, not the scrollport. Dragging the thumb is deliberately NOT wired up:
 * this is a prototype of the reveal and the geometry, and a drag would be the
 * one part of it that has to be right in app source rather than here.
 */
function ScrollPane({
  height,
  overlay,
  children,
}: {
  height: number;
  overlay: boolean;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const fade = React.useRef<number | null>(null);
  const [thumb, setThumb] = React.useState<ThumbGeometry | null>(null);
  const [scrolling, setScrolling] = React.useState(false);

  // Idempotent on purpose, and that is load-bearing rather than tidy: the
  // layout effect below re-runs whenever `children` changes identity — which is
  // every render, including the one this setter causes — so a measure that
  // returned a fresh object each time would never reach a fixed point and the
  // pane would render forever. Returning the SAME object when nothing moved is
  // what lets React bail out.
  const measure = React.useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    const { clientHeight, scrollHeight, scrollTop } = element;
    if (scrollHeight <= clientHeight) {
      setThumb((current) => (current === null ? current : null));
      return;
    }
    const thumbHeight = Math.max(THUMB_MIN_HEIGHT, (clientHeight / scrollHeight) * clientHeight);
    const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - thumbHeight);
    setThumb((current) =>
      current !== null && current.top === top && current.height === thumbHeight
        ? current
        : { top, height: thumbHeight },
    );
  }, []);

  // After layout rather than in an effect: the thumb's height is a fraction of a
  // scrollHeight that only exists once the rows are laid out, and a thumb that
  // appeared one frame late would be a thumb that jumps on first scroll.
  React.useLayoutEffect(measure, [measure, children, height]);

  React.useEffect(() => () => window.clearTimeout(fade.current ?? undefined), []);

  const onScroll = (): void => {
    measure();
    setScrolling(true);
    window.clearTimeout(fade.current ?? undefined);
    fade.current = window.setTimeout(() => setScrolling(false), THUMB_FADE_MS);
  };

  return (
    <div className="group/scroll relative">
      <div
        ref={ref}
        onScroll={onScroll}
        style={{ height }}
        className={cn(
          "flex min-h-0 flex-col overflow-x-hidden overflow-y-auto",
          overlay && "[&::-webkit-scrollbar]:hidden",
        )}
      >
        {children}
      </div>
      {overlay && thumb !== null ? (
        <span
          aria-hidden
          // Centred in the channel the row pill already leaves — the pane's
          // padding is outside this element, so `PILL_INSET` IS the channel
          // here, and the thumb clears the pill by 2px at every fold step.
          style={{
            top: thumb.top,
            height: thumb.height,
            width: THUMB_WIDTH,
            right: (PILL_INSET - THUMB_WIDTH) / 2,
          }}
          className={cn(
            "pointer-events-none absolute z-10 rounded-full bg-border-strong transition-opacity duration-200 ease-out",
            "motion-reduce:transition-none",
            scrolling ? "opacity-100" : "opacity-0 group-hover/scroll:opacity-70",
          )}
        />
      ) : null}
    </div>
  );
}

/**
 * One sidebar column at the width and on the surface the app gives it.
 *
 * `data-volli-sidebar` and `data-sidebar-presentation` are not decoration: they
 * are the selectors globals.css § SEAM GEOMETRY keys the lift, the frame and the
 * pane's fold off, so this column's geometry IS the app's rather than a
 * re-derivation that could drift. The outer box is the sidebar's own outer
 * width, which is what lets a guide positioned from its right edge be positioned
 * from the pane's right wall.
 */
function SidebarColumn({
  label,
  fold,
  guides,
  children,
}: {
  label: string;
  fold: number;
  guides: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="pl-2 font-mono text-label uppercase text-muted-foreground">{label}</span>
      <div className="relative" style={{ width: "calc(var(--sidebar-width) - var(--rail-width))" }}>
        <Sidebar collapsible="none" data-volli-sidebar className="w-full min-w-0">
          <div
            data-sidebar-presentation="expanded"
            style={{ paddingRight: fold }}
            className="flex min-h-0 flex-col"
          >
            {children}
          </div>
        </Sidebar>
        {guides ? <EdgeGuides fold={fold} /> : null}
      </div>
    </div>
  );
}

/** Every field a Previous row reads; the scenarios supply only what differs. */
function previousRow(
  overrides: Pick<PreviousSessionRow, "id" | "title" | "kind" | "endedOrQuietAt"> &
    Partial<PreviousSessionRow>,
): PreviousSessionRow {
  return { ticket: null, target: null, cleaned: false, ...overrides };
}

/**
 * Seven rows chosen for their string widths and their empty slots, not for their
 * plausibility as a work day: an ordinal title with nothing to say, a title long
 * enough to truncate under a globe, a one-digit ticket id beside two-digit ones,
 * and ages at every width the formatter can produce.
 *
 * Both of the strings that break the column are here, and NEITHER is a corner
 * case. "just now" is eight characters for the first forty-five seconds. Past
 * four weeks `relativeTime` stops being relative at all and rolls up to an
 * absolute date — the owner's own screenshots show "Jan 15" sitting in the age
 * column of the running app, so this is what ordinary use looks like, not a
 * contrived one. The last row is the WORSE half of that rollup: the year is
 * omitted only within the current calendar year, and this frozen clock (15 Jan)
 * has no same-year date four weeks behind it, so every cross-year row carries
 * "Dec 6, 2025" — twelve characters where the column reserves three.
 */
const PREVIOUS_ROWS: readonly PreviousSessionRow[] = [
  previousRow({
    id: "p-now",
    ticket: ticketById("tkt-13"),
    title: "Session 4",
    kind: "terminal",
    endedOrQuietAt: NOW - 20_000,
  }),
  previousRow({
    id: "p-4m",
    ticket: ticketById("tkt-14"),
    title: "Trace the dropped decorations back to the debounce",
    kind: "chat",
    endedOrQuietAt: NOW - 4 * MINUTE,
  }),
  previousRow({
    id: "p-45m",
    ticket: ticketById("tkt-9"),
    title: "Compare per-project and global harness defaults before the migration",
    kind: "chat",
    endedOrQuietAt: NOW - 45 * MINUTE,
  }),
  previousRow({
    id: "p-2h",
    title: "Rename the worktree branch scheme",
    kind: "terminal",
    endedOrQuietAt: NOW - 2 * HOUR,
  }),
  previousRow({
    id: "p-12h",
    ticket: ticketById("tkt-10"),
    title: "Summarize the hover-state regression",
    kind: "chat",
    endedOrQuietAt: NOW - 12 * HOUR,
    cleaned: true,
  }),
  previousRow({
    id: "p-3d",
    title: "Chat 1",
    kind: "chat",
    endedOrQuietAt: NOW - 3 * DAY,
  }),
  // Past PREVIOUS_MAX_AGE_MS, so `cleaned` is not decoration here — a row this
  // old can only be on screen because the filter asked for it back, which is
  // exactly the state the age column is widest in.
  previousRow({
    id: "p-rollup",
    ticket: ticketById("tkt-2"),
    title: "Move ticket ordering into the shared state machine",
    kind: "terminal",
    endedOrQuietAt: NOW - 40 * DAY,
    cleaned: true,
  }),
];

/**
 * The Active band's three dot states, so the changes below can be checked
 * against a band they must not disturb: an attention row, a working row with its
 * sweeping title, and a ticketless idle one.
 */
const ACTIVE_ROWS: readonly ActiveSessionRow[] = [
  {
    id: "a-waiting",
    ticket: ticketById("tkt-14"),
    title: "Trace the dropped decorations back to the debounce",
    source: "Claude Code",
    activity: "waiting",
    activitySource: "reported",
    attention: { signal: "waiting", reason: null },
    waitingOn: "question",
    target: null,
  },
  {
    id: "a-working",
    ticket: ticketById("tkt-12"),
    title: "Session 2",
    source: "Claude Code",
    activity: "working",
    activitySource: "reported",
    attention: null,
    waitingOn: null,
    target: null,
  },
  {
    id: "a-idle",
    ticket: null,
    title: "Rename the worktree branch scheme",
    source: "Codex",
    activity: "idle",
    activitySource: "inferred",
    attention: null,
    waitingOn: null,
    target: null,
  },
];

/**
 * The same six rows with two of them cleaned, and deliberately not the two
 * oldest.
 *
 * The band sorts on `endedOrQuietAt` alone, so cleaned rows INTERLEAVE with kept
 * ones — a Session whose ticket was archived four minutes ago sorts above one
 * from this morning. That is the fact that killed "no signifier at all" in round
 * 1: turning the filter on does not append a block you can watch arrive, it
 * inserts rows into the middle of a list you already knew.
 */
const CLEANED_IN_MIX = new Set(["p-4m", "p-12h", "p-rollup"]);
const CLEANED_MIX: readonly PreviousSessionRow[] = PREVIOUS_ROWS.map((row) => ({
  ...row,
  cleaned: CLEANED_IN_MIX.has(row.id),
}));

/** Enough rows to overflow a short pane — the only state the scrollbar has an opinion about. */
const OVERFLOW_ROWS: readonly PreviousSessionRow[] = [
  ...PREVIOUS_ROWS,
  ...PREVIOUS_ROWS.map((row) => ({ ...row, id: `${row.id}-b` })),
];

const SIGNIFIERS: readonly { key: CleanedSignifier; label: string }[] = [
  { key: "ghost", label: "Ghost" },
  { key: "ghost-indent", label: "Ghost + indent" },
  { key: "indent", label: "Indent only" },
];

/**
 * Previews an appearance by stamping the class `canvas-paint.ts` stamps in the
 * app, and puts back whatever was there on unmount.
 *
 * The lab has no appearance control of its own and renders the default block,
 * which is dark — so the light canvas, where the on-canvas ink ladder has its
 * least headroom, is the one surface a scratch could never be judged on. It is
 * also the surface the ghost's contrast turns on, which makes this the
 * difference between a measurement and an assertion.
 */
function useAppearancePreview(appearance: Appearance): void {
  React.useEffect(() => {
    const root = document.documentElement;
    const had = root.classList.contains("light");
    root.classList.toggle("light", appearance === "light");
    return () => {
      root.classList.toggle("light", had);
    };
  }, [appearance]);
}

/**
 * What a ghosted row measures, worst-case across the canvas's own surfaces.
 *
 * Worst-case rather than average for the reason `canvas/ink.ts` gives: text
 * crosses several pools, and an average happily blesses an ink that is
 * unreadable over one of them.
 */
function ghostContrast(appearance: Appearance, ink: string, ghost: number): number {
  const { lift, liftAlpha, stops } = CANVAS_SURFACES[appearance];
  const surfaces = stops.map((stop) => compositeHex(lift, liftAlpha, stop));
  return Math.min(
    ...surfaces.map((surface) => Math.abs(apcaLc(compositeHex(ink, ghost, surface), surface))),
  );
}

/**
 * A segmented row of the lab's own pill buttons. Terse by house rule.
 *
 * `onChange` is typed as the setter it is always handed rather than as
 * `(next: T) => void`: a `Dispatch` accepts an updater function too, so it is
 * not assignable to the narrower shape, and inference then falls back to the
 * `string | number` constraint at every call site.
 */
function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: React.Dispatch<React.SetStateAction<T>>;
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="uppercase">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={option === value}
          className="rounded-full border border-transparent px-2 py-0.5 tabular-nums transition-colors hover:text-foreground aria-pressed:border-border aria-pressed:text-foreground"
        >
          {option}
        </button>
      ))}
    </span>
  );
}

export default function SidebarRowAnatomyScratch() {
  const [guides, setGuides] = React.useState(true);
  const [fold, setFold] = React.useState<number>(PROPOSED_FOLD);
  const [weight, setWeight] = React.useState<GlyphWeight>("bold");
  const [appearance, setAppearance] = React.useState<Appearance>("dark");
  const [signifier, setSignifier] = React.useState<CleanedSignifier>("ghost-indent");
  // 0.80 is the owner's call, made with these numbers in front of him, and it
  // is exactly the LIGHT floor: Lc 45.5 there, 38.2 in dark against a floor of
  // 45. So it is legal on one canvas and four short on the other, deliberately —
  // not a value drifting toward a fix. What makes that defensible is the indent,
  // which is now the mark that actually carries "cleaned" and costs no contrast
  // at all; the ghost is tone on top of it rather than the whole signal. Raise
  // this to 0.91 only if the indent is ever dropped.
  const [ghost, setGhost] = React.useState(0.8);
  const [selectedId, setSelectedId] = React.useState<string>("p-45m");
  const [narrowed, setNarrowed] = React.useState(false);
  const now = NOW;

  useAppearancePreview(appearance);

  // Read back rather than hardcoded, so the readout follows the class stamped
  // above instead of a copy of it that could go stale.
  const [ink, setInk] = React.useState("#b6aca9");
  React.useEffect(() => {
    const read = getComputedStyle(document.documentElement)
      .getPropertyValue("--canvas-ink-muted")
      .trim();
    if (isHexColor(read)) setInk(read);
  }, [appearance]);

  const ghostLc = ghostContrast(appearance, ink, ghost);
  const legible = ghostLc >= MUTED_LC_FLOOR;

  const activeRows = ACTIVE_ROWS.map((row) => (
    <ActiveBandRow
      key={row.id}
      row={row}
      ticketPrefix={project.ticketPrefix}
      selected={row.id === selectedId}
      onSelect={() => setSelectedId(row.id)}
    />
  ));

  const proposedRows = (rows: readonly PreviousSessionRow[]) =>
    rows.map((row) => (
      <ProposedPreviousRow
        key={row.id}
        row={row}
        ticketPrefix={project.ticketPrefix}
        now={now}
        selected={row.id === selectedId}
        onSelect={() => setSelectedId(row.id)}
        weight={weight}
        signifier={signifier}
        ghost={ghost}
      />
    ));

  return (
    // The canvas the sidebar actually floats on. The lab stage paints
    // `bg-background` — the opaque CARD colour — over the gradient globals.css
    // puts on `html`, so a sidebar judged there is judged against the one
    // surface it never touches.
    <div className="flex flex-col gap-6 rounded-xl p-6" style={{ background: "var(--canvas)" }}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border/70 px-3 py-2.5 font-mono text-label text-muted-foreground">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={guides}
            onChange={(event) => setGuides(event.target.checked)}
            className="accent-primary"
          />
          <span className="uppercase">Guides</span>
        </label>
        <Segmented label="Fold" options={FOLD_STEPS} value={fold} onChange={setFold} />
        <Segmented
          label="Glyphs"
          options={["bold", "regular", "fill"] as const}
          value={weight}
          onChange={setWeight}
        />
        <Segmented
          label="Canvas"
          options={["dark", "light"] as const}
          value={appearance}
          onChange={setAppearance}
        />
      </div>

      <SidebarProvider
        data-volli-shell="framed"
        className="min-h-0 w-full flex-col gap-6"
        style={
          {
            "--sidebar-width": "318px",
            "--rail-width": "60px",
          } as React.CSSProperties
        }
      >
        <div className="flex flex-col gap-5">
          <SidebarColumn label="Current" fold={fold} guides={guides}>
            <SidebarGroup className="gap-1">
              <SessionBandHeader label="Active" count={ACTIVE_ROWS.length} />
              <SidebarMenu>{activeRows}</SidebarMenu>
            </SidebarGroup>
            <SidebarGroup className="gap-1 pt-0">
              <SessionBandHeader label="Previous" count={PREVIOUS_ROWS.length}>
                {/* The shipped menu, so the baseline is the real trigger box
                    rather than my copy of it. */}
                <SessionBandFilterMenu
                  filter={DEFAULT_SESSION_BAND_FILTER}
                  onChange={() => undefined}
                />
              </SessionBandHeader>
              <SidebarMenu>
                {PREVIOUS_ROWS.map((row) => (
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
            </SidebarGroup>
          </SidebarColumn>

          <SidebarColumn label="Proposed" fold={fold} guides={guides}>
            {/* Active is untouched. It is the band that must not flatten, and
                the only thing this pass gives it is the right edge it already
                had: empty. */}
            <SidebarGroup className="gap-1">
              <SessionBandHeader label="Active" count={ACTIVE_ROWS.length} />
              <SidebarMenu>{activeRows}</SidebarMenu>
            </SidebarGroup>
            <SidebarGroup className="gap-1 pt-0">
              <SessionBandHeader label="Previous" count={PREVIOUS_ROWS.length}>
                <ProposedFilterTrigger
                  narrowed={narrowed}
                  onToggle={() => setNarrowed((current) => !current)}
                  weight={weight}
                />
              </SessionBandHeader>
              <SidebarMenu>{proposedRows(PREVIOUS_ROWS)}</SidebarMenu>
            </SidebarGroup>
          </SidebarColumn>
        </div>

        {/* OVERFLOW. Both panes hold the same rows at the same height; the only
            difference is whether the scrollbar is in the layout. Scroll each. */}
        <div className="flex flex-wrap items-start gap-5">
          <SidebarColumn
            label={`Scrolling · native (−${NATIVE_SCROLLBAR_RESERVE}px)`}
            fold={fold}
            guides={guides}
          >
            <ScrollPane height={200} overlay={false}>
              <SidebarGroup className="gap-1">
                <SessionBandHeader label="Previous" count={OVERFLOW_ROWS.length} />
                <SidebarMenu>{proposedRows(OVERFLOW_ROWS)}</SidebarMenu>
              </SidebarGroup>
            </ScrollPane>
          </SidebarColumn>

          <SidebarColumn label="Scrolling · overlay" fold={fold} guides={guides}>
            <ScrollPane height={200} overlay>
              <SidebarGroup className="gap-1">
                <SessionBandHeader label="Previous" count={OVERFLOW_ROWS.length} />
                <SidebarMenu>{proposedRows(OVERFLOW_ROWS)}</SidebarMenu>
              </SidebarGroup>
            </ScrollPane>
          </SidebarColumn>
        </div>

        {/* THE GHOST, and what it costs. */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border/70 px-3 py-2.5 font-mono text-label text-muted-foreground">
            <label className="flex min-w-0 items-center gap-3">
              <span className="uppercase">Ghost</span>
              <input
                type="range"
                aria-label="Cleaned-row opacity"
                min={0.3}
                max={1}
                step={0.01}
                value={ghost}
                onChange={(event) => setGhost(Number(event.target.value))}
                style={
                  { "--slider-fill": `${((ghost - 0.3) / 0.7) * 100}%` } as React.CSSProperties
                }
                className="h-1 w-40"
              />
              <span className="w-10 shrink-0 tabular-nums text-foreground">{ghost.toFixed(2)}</span>
            </label>
            {/* Loud below the floor rather than merely tinted. 0.70 reads as
                legible on both canvases and is under on both (light wants 0.80,
                dark 0.91) — a dial that only whispered there would be a dial
                that let the eye win an argument the measurement had lost. */}
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 tabular-nums",
                legible
                  ? "border-transparent text-foreground"
                  : "border-primary-text text-primary-text",
              )}
              aria-live="polite"
            >
              Lc {ghostLc.toFixed(1)} · floor {MUTED_LC_FLOOR}
              {legible ? "" : ` · under on ${appearance}`}
            </span>
            <Segmented
              label="Mark"
              options={SIGNIFIERS.map((entry) => entry.key)}
              value={signifier}
              onChange={setSignifier}
            />
          </div>

          <div className="flex flex-wrap items-start gap-5">
            {SIGNIFIERS.map((variant) => (
              <SidebarColumn key={variant.key} label={variant.label} fold={fold} guides={false}>
                <SidebarGroup className="gap-1">
                  <SessionBandHeader label="Previous" count={CLEANED_MIX.length}>
                    <ProposedFilterTrigger narrowed onToggle={() => undefined} weight={weight} />
                  </SessionBandHeader>
                  <SidebarMenu>
                    {CLEANED_MIX.map((row) => (
                      <ProposedPreviousRow
                        key={row.id}
                        row={row}
                        ticketPrefix={project.ticketPrefix}
                        now={now}
                        selected={false}
                        onSelect={() => undefined}
                        weight={weight}
                        signifier={variant.key}
                        ghost={ghost}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              </SidebarColumn>
            ))}
          </div>
        </div>
      </SidebarProvider>
    </div>
  );
}
