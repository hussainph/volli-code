/**
 * PROTOTYPE — VC-55, pass 3. The empty chat as a scope-matched instrument.
 *
 * THE MODEL THIS PASS SETTLES ON, and the reason the axes are shaped the way
 * they are: the empty-state visual is a CHOICE, but not a free one. Each visual
 * is only legible at one scope, so the menu a surface offers is itself the
 * identity signal — a Home chat can draw the streak or the board, a ticket chat
 * cannot, and that asymmetry is the thing the user eventually internalises.
 * The two pickers in the bar are deliberately shaped like the Settings control
 * this would become: one default per scope, chosen from that scope's legal set.
 *
 *   Home    → Streak · Board · Venue
 *   Ticket  → Venue        (default)
 *
 * WHAT MOVED SINCE PASS 2 (all owner notes):
 *   1. The session FIELD is gone. It grew without bound and said nothing on a
 *      ticket. Replaced by STREAK — a GitHub-style per-day matrix of every
 *      session run in Volli, project and ticket alike. It is a fixed 26-week
 *      window, so it cannot grow; and it is deliberately NOT offered on a
 *      ticket, where a cross-project achievement read is nonsense.
 *   2. BOARD keeps its bars but they are no longer flat: each column takes a
 *      hue fanned off the LIVE canvas primary (`--primary`, read at render and
 *      rotated in OKLCH), so the chart is themed rather than painted. Hover
 *      names the column and its count. Home only.
 *   3. VENUE is the merged one, and the only visual both scopes offer. The
 *      uncommitted ticks stack directly over the +/− bar so one object answers
 *      "what is loose here" and "what has this branch done" together.
 *
 * VENUE IS KEYED ON THE VENUE, NOT THE SESSION KIND. A ticket that runs in the
 * main checkout (no worktree — see VC-96) draws main's tree and no branch bar,
 * because there is no branch to diff. That is the whole reason this visual can
 * serve both scopes: it describes the DIRECTORY, which is the fact VC-55 exists
 * to surface.
 *
 * DITHER-KIT is wired as a second drawing of the Board bars (`Board · dither`)
 * so the aesthetic can be judged against the cost. Read the note on
 * {@link DITHER_COLOR} before adopting it — its palette is seven fixed sRGB
 * triples, which is the one thing this repo's generated-canvas theming forbids.
 *
 * Fixtures are frozen; the board counts are this repo's real ones. The lab has
 * no main-process half (CLAUDE.md), so nothing here reads git or the ledger.
 */
import * as React from "react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { CompassIcon } from "@phosphor-icons/react/dist/csr/Compass";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { hexToOklch, lerp, oklchToHex } from "@volli/shared";

import { BarChart } from "@renderer/components/dither-kit/bar-chart";
import { Bar } from "@renderer/components/dither-kit/bar";
import { Tooltip as DitherTooltip } from "@renderer/components/dither-kit/tooltip";
import { XAxis } from "@renderer/components/dither-kit/x-axis";
import { Button } from "@renderer/components/ui/button";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { Tab, TabStrip, tabStopIndex } from "@renderer/components/ui/tab-strip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

export const title = "Project session · identity, info, empty chat";
export const note = "Streak / Board / Venue — the scope decides the menu (VC-55 pass 3)";
export const viewport = "window" as const;

// ---------------------------------------------------------------------------
// Venue — the thing every visual is really about

interface Venue {
  kind: "main-checkout" | "worktree";
  path: string;
  branch: string;
  /** Loose in this directory right now. */
  dirty: { modified: number; added: number; untracked: number };
  /** What this branch has done vs its base. `null` when there is no base to diff. */
  diff: { added: number; removed: number; files: number; base: string } | null;
}

const MAIN_CHECKOUT: Venue = {
  kind: "main-checkout",
  path: "~/Desktop/code/volli-code",
  branch: "main",
  dirty: { modified: 2, added: 1, untracked: 3 },
  diff: null,
};

const TICKET_WORKTREE: Venue = {
  kind: "worktree",
  path: "~/.volli/worktrees/volli-code-f3732f45/VC-81-auto-title…",
  branch: "volli/VC-81-auto-title-model-generated-titles",
  dirty: { modified: 4, added: 2, untracked: 1 },
  diff: { added: 214, removed: 63, files: 7, base: "main" },
};

const SESSION_MODEL = { model: "Claude Opus 4.6", effort: "High" } as const;

/** This repo's real board, so the bars are honestly proportioned. */
const BOARD = [
  { column: "Backlog", count: 46 },
  { column: "Todo", count: 7 },
  { column: "Doing", count: 1 },
  { column: "Needs Review", count: 0 },
  { column: "Done", count: 24 },
] as const;

const MENTIONED = [
  { id: "VC-54", title: "Home taxonomy: board becomes a tabbed Home" },
  { id: "VC-75", title: "Active-session discoverability" },
  { id: "VC-42", title: "UX audit of every user surface" },
] as const;

// ---------------------------------------------------------------------------
// Streak fixture — sessions per day, across the whole install

const STREAK_WEEKS = 26;

interface StreakDay {
  id: string;
  count: number;
  /** Days back from today, for the tooltip's date. */
  ago: number;
}

/** Deterministic, with a believable weekday/weekend rhythm and a ramp-up. */
function streakDays(): readonly StreakDay[] {
  const out: StreakDay[] = [];
  const total = STREAK_WEEKS * 7;
  let x = 20260817;
  for (let index = 0; index < total; index += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const roll = x / 2147483648;
    const weekday = index % 7;
    const weekend = weekday === 0 || weekday === 6;
    // Volli got used more as it got built — the recent end is denser.
    const ramp = index / total;
    const lift = roll * (weekend ? 0.35 : 1) * (0.25 + ramp);
    const ago = total - 1 - index;
    // The last few days are never empty: you are reading this IN a session, so
    // a fixture that shows "0-day streak" is lying about its own premise.
    const floor = ago <= 4 ? 2 : 0;
    out.push({
      id: `d${index}`,
      ago,
      count: Math.max(
        floor,
        lift > 0.62 ? 9 : lift > 0.44 ? 5 : lift > 0.26 ? 2 : lift > 0.12 ? 1 : 0,
      ),
    });
  }
  return out;
}

const STREAK = streakDays();

/** Which of the four ramp steps a day's count lands on. */
function streakStep(count: number): number {
  return count === 0 ? 0 : count >= 9 ? 3 : count >= 5 ? 2 : 1;
}

function streakDayLabel(day: StreakDay): string {
  const sessions =
    day.count === 0 ? "No sessions" : `${day.count} session${day.count === 1 ? "" : "s"}`;
  return `${sessions} · ${day.ago === 0 ? "today" : `${day.ago}d ago`}`;
}

// ---------------------------------------------------------------------------
// Theme-derived series colour
//
// The app's colour tokens are GENERATED from a canvas (CLAUDE.md), so a chart
// may not carry a palette of its own. These read `--primary` off the live
// document and fan hues around it in OKLCH, which means the chart re-themes
// with the window instead of fighting it.

function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Ticks whenever the theme changes, so anything derived from a token recomputes.
 *
 * This is not optional bookkeeping — it is the whole reason a derived colour is
 * allowed to exist. `readToken` samples the document once; without a
 * subscription, a ramp memoised on mount keeps painting the appearance that was
 * live when it mounted. The first version of the streak grid did exactly that
 * and drew dark-mode colours on light paper, which read as an inverted grid
 * (empty days heavier than busy ones) and looked like a palette bug rather than
 * a staleness bug.
 *
 * Appearance is stamped as a CLASS on `documentElement` and the canvas writes
 * its tokens there as inline custom properties (CLAUDE.md), so watching those
 * two attributes covers both.
 */
function useThemeEpoch(): number {
  const [epoch, setEpoch] = React.useState(0);
  React.useEffect(() => {
    const observer = new MutationObserver(() => setEpoch((value) => value + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);
  return epoch;
}

/**
 * `count` hues fanned across ±`spread` degrees around the canvas primary,
 * holding its lightness and chroma so the series reads as one family. Returns
 * hex, because that is what a canvas painter and an inline style both take.
 */
function seriesColors(count: number, spread = 70): string[] {
  const primary = readToken("--primary", "#d37550");
  const { L, C, h } = hexToOklch(primary);
  if (count === 1) return [oklchToHex(L, C, h)];
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1) - 0.5;
    return oklchToHex(L, C, (h + t * spread + 360) % 360);
  });
}

/**
 * The streak ramp: four steps travelling from the BACKGROUND to the primary,
 * in the primary's hue.
 *
 * Lightness has to travel, not just chroma. Draining chroma out of a mid-tone
 * primary lands on a mid-tone grey, which on a light canvas is DARKER than the
 * paper — so the first version drew empty days heavier than busy ones and the
 * grid read inside out. Interpolating from the background instead is also what
 * makes one ramp correct in both appearances: light mode ramps down from paper,
 * dark mode ramps up from ink, and neither is special-cased.
 */
function streakRamp(): string[] {
  const base = hexToOklch(readToken("--background", "#1a1210"));
  const tip = hexToOklch(readToken("--primary", "#d37550"));
  // Not 0: an empty day still has to be a cell you can see the grid through.
  return [0.12, 0.42, 0.72, 1].map((t) =>
    oklchToHex(lerp(base.L, tip.L, t), lerp(0.004, tip.C, t), tip.h),
  );
}

/**
 * dither-kit's `config` only accepts one of seven hard-coded colour NAMES
 * (`components/dither-kit/palette.ts` — fixed sRGB triples). There is no
 * arbitrary-hex path, so a dithered chart cannot take {@link seriesColors}
 * without us rewriting that palette to derive from the canvas. `orange` is the
 * nearest neighbour to the ember accent; it is a stand-in, not an endorsement.
 */
const DITHER_COLOR = "orange" as const;

// ---------------------------------------------------------------------------
// Axes

type HomeVisual = "mark" | "streak" | "board" | "board-dither" | "venue";
type TicketVisual = "mark" | "venue";
type Info = "none" | "rail" | "venue-bar";
type View = "home" | "ticket" | "both" | "feed";

const HOME_VISUAL_LABELS: Record<HomeVisual, string> = {
  mark: "Mark (today)",
  streak: "Streak",
  board: "Board",
  "board-dither": "Board · dither-kit",
  venue: "Venue",
};

const TICKET_VISUAL_LABELS: Record<TicketVisual, string> = {
  mark: "Mark (today)",
  venue: "Venue",
};

const INFO_LABELS: Record<Info, string> = {
  none: "None (today)",
  rail: "Rail (⌥⌘B) — Home only",
  "venue-bar": "Venue bar — Home only",
};

const VIEW_LABELS: Record<View, string> = {
  home: "Home",
  ticket: "Ticket",
  both: "Both (at-a-glance test)",
  feed: "Feed (backlink chips)",
};

// ---------------------------------------------------------------------------
// Shared parts

function ScopeCaption({ venue }: { venue: Venue }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 font-mono text-ui text-muted-foreground">
      <span className="flex items-center gap-1" title={venue.path}>
        <FolderOpenIcon weight="bold" className="size-3" aria-label="Directory" />
        {venue.path}
      </span>
      <span className="flex items-center gap-1">
        <GitBranchIcon weight="bold" className="size-3" aria-label="Branch" />
        {venue.branch}
      </span>
    </div>
  );
}

function MentionChip({ id }: { id: string }) {
  return (
    <button
      type="button"
      className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2 align-baseline font-mono text-ui text-foreground transition-colors hover:border-primary/40 hover:text-primary-text"
    >
      <TicketIcon weight="bold" className="size-3 text-muted-foreground" />
      {id}
    </button>
  );
}

// ---------------------------------------------------------------------------
// STREAK — every session run in Volli, one cell per day. Home only.

function StreakVisual({ venue }: { venue: Venue }) {
  // Subscribe, then derive on every render. Four colours is cheaper to compute
  // than to memoise correctly against a subscription the linter cannot see.
  useThemeEpoch();
  const ramp = streakRamp();
  const total = STREAK.reduce((sum, day) => sum + day.count, 0);
  const active = STREAK.filter((day) => day.count > 0).length;

  // Current run of consecutive days with at least one session, counting back.
  let run = 0;
  for (let index = STREAK.length - 1; index >= 0; index -= 1) {
    if ((STREAK[index]?.count ?? 0) === 0) break;
    run += 1;
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Column-major, like GitHub: each column is a week, each row a weekday. */}
      <div
        className="grid grid-flow-col grid-rows-7 gap-1"
        role="img"
        aria-label={`${total} sessions over ${STREAK_WEEKS} weeks`}
      >
        {/* Native `title`, not a Radix Tooltip: this grid is 182 cells, and
            182 portalled tooltip roots is a measurable mount cost for a hover
            hint nobody reads twice. The board bars below DO get Radix — five
            of them, and the hover is the whole point there. */}
        {STREAK.map((day) => (
          <span
            key={day.id}
            title={streakDayLabel(day)}
            className="size-2.5 rounded-sm"
            style={{ backgroundColor: ramp[streakStep(day.count)] }}
          />
        ))}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-title text-foreground">{total}</span>
        <span className="text-ui text-muted-foreground">sessions in {STREAK_WEEKS} weeks</span>
      </div>
      <div className="flex items-center gap-4 text-ui text-muted-foreground">
        <span>{active} active days</span>
        {run > 0 ? <span>{run}-day streak</span> : null}
      </div>
      <ScopeCaption venue={venue} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// BOARD — the project's column distribution. Home only.

function BoardVisual({ venue }: { venue: Venue }) {
  useThemeEpoch();
  const colors = seriesColors(BOARD.length);
  const peak = Math.max(...BOARD.map((entry) => entry.count));

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex h-24 w-80 items-end gap-2" role="img" aria-label="Board distribution">
        {BOARD.map((entry, index) => (
          <Tooltip key={entry.column}>
            <TooltipTrigger asChild>
              <div className="flex min-w-0 flex-1 cursor-default flex-col items-center gap-1">
                <span className="text-ui text-muted-foreground">{entry.count}</span>
                <span
                  className="w-full rounded-md transition-opacity hover:opacity-80"
                  style={{
                    height: `${Math.max(3, (entry.count / peak) * 68)}px`,
                    backgroundColor: entry.count === 0 ? undefined : colors[index],
                    opacity: entry.count === 0 ? undefined : 0.85,
                  }}
                  // A zero column still needs a body to hover, and it must not
                  // read as a tiny amount of something.
                  data-empty={entry.count === 0 ? "true" : "false"}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {entry.count} in {entry.column}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="flex w-80 gap-2">
        {BOARD.map((entry) => (
          <span
            key={entry.column}
            className="min-w-0 flex-1 truncate text-center text-label uppercase text-muted-foreground"
          >
            {entry.column}
          </span>
        ))}
      </div>
      <ScopeCaption venue={venue} />
    </div>
  );
}

/** The same data through dither-kit, so the aesthetic can be judged directly. */
function BoardDitherVisual({ venue }: { venue: Venue }) {
  const data = React.useMemo(
    () => BOARD.map((entry) => ({ column: entry.column, tickets: entry.count })),
    [],
  );
  const config = React.useMemo(() => ({ tickets: { label: "Tickets", color: DITHER_COLOR } }), []);

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="h-32 w-80">
        <BarChart data={data} config={config} bloom="low">
          <XAxis dataKey="column" />
          <DitherTooltip labelKey="column" />
          <Bar dataKey="tickets" variant="gradient" />
        </BarChart>
      </div>
      <ScopeCaption venue={venue} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// VENUE — the merged working-tree overview. Both scopes; ticket default.

/**
 * Two stacked reads of one directory:
 *
 *   TOP     what is loose right now — ticks, one per uncommitted file, coloured
 *           by kind. Not summed into the diff below, because loose changes are
 *           not yet part of what the branch has done.
 *   BOTTOM  what this branch has done vs its base — the proportional +/− bar.
 *
 * A venue with no base to diff (the main checkout) draws only the top half and
 * says so, rather than drawing an empty bar that reads as "no work".
 */
function VenueVisual({ venue }: { venue: Venue }) {
  const { modified, added, untracked } = venue.dirty;
  const loose = modified + added + untracked;
  const ticks = [
    ...Array.from({ length: modified }, (_, i) => ({
      id: `m${i}`,
      tone: "bg-attention",
      kind: "modified",
    })),
    ...Array.from({ length: added }, (_, i) => ({
      id: `a${i}`,
      tone: "bg-positive",
      kind: "added",
    })),
    ...Array.from({ length: untracked }, (_, i) => ({
      id: `u${i}`,
      tone: "bg-muted-foreground/40",
      kind: "untracked",
    })),
  ];
  const diff = venue.diff;
  const span = diff === null ? 0 : diff.added + diff.removed;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-80 flex-col gap-4 rounded-row border border-border bg-card p-4">
        {/* Loose */}
        <div className="flex flex-col gap-2">
          <div className="flex h-10 items-end justify-center gap-1">
            {loose === 0 ? (
              <span className="h-1 w-full rounded-full bg-border" />
            ) : (
              ticks.map((tick) => (
                <Tooltip key={tick.id}>
                  <TooltipTrigger asChild>
                    <span className={cn("h-full w-2 rounded-full", tick.tone)} />
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {tick.kind}
                  </TooltipContent>
                </Tooltip>
              ))
            )}
          </div>
          <div className="flex items-baseline justify-center gap-2">
            <span className="text-heading text-foreground">{loose}</span>
            <span className="text-ui text-muted-foreground">uncommitted</span>
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* Committed on this branch */}
        {diff === null ? (
          <div className="flex flex-col items-center gap-1">
            <span className="text-ui text-muted-foreground">
              on <span className="font-mono text-foreground">{venue.branch}</span>
            </span>
            <span className="text-ui text-muted-foreground">no branch of its own</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex h-3 overflow-hidden rounded-full">
              <span className="bg-positive" style={{ width: `${(diff.added / span) * 100}%` }} />
              <span
                className="bg-destructive"
                style={{ width: `${(diff.removed / span) * 100}%` }}
              />
            </div>
            <div className="flex items-baseline justify-center gap-4">
              <span className="text-heading text-positive">+{diff.added}</span>
              <span className="text-heading text-destructive">−{diff.removed}</span>
              <span className="text-ui text-muted-foreground">
                {diff.files} files vs {diff.base}
              </span>
            </div>
          </div>
        )}
      </div>
      <ScopeCaption venue={venue} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function MarkVisual() {
  return (
    <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-raised">
      <CodeIcon className="size-5 text-muted-foreground" />
    </div>
  );
}

function EmptyChat({ visual, venue }: { visual: HomeVisual; venue: Venue }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-gutter py-8 text-center">
      {visual === "mark" ? <MarkVisual /> : null}
      {visual === "streak" ? <StreakVisual venue={venue} /> : null}
      {visual === "board" ? <BoardVisual venue={venue} /> : null}
      {visual === "board-dither" ? <BoardDitherVisual venue={venue} /> : null}
      {visual === "venue" ? <VenueVisual venue={venue} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Info surfaces — Home only. The ticket rail is a non-goal.

function VenueBar({ venue }: { venue: Venue }) {
  const { modified, added, untracked } = venue.dirty;
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-border px-4 py-2 font-mono text-ui text-muted-foreground">
      <span className="flex items-center gap-1">
        <FolderOpenIcon weight="bold" className="size-3" />
        {venue.path}
      </span>
      <span className="flex items-center gap-1">
        <GitBranchIcon weight="bold" className="size-3" />
        {venue.branch}
      </span>
      <span className="flex items-center gap-1 text-attention">
        <span className="size-2 rounded-full bg-attention" />
        {modified + added + untracked}
      </span>
      <span className="ml-auto">
        {SESSION_MODEL.model} · {SESSION_MODEL.effort}
      </span>
    </div>
  );
}

function InfoRail({ venue }: { venue: Venue }) {
  const { modified, added, untracked } = venue.dirty;
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar">
      <section className="flex flex-col gap-2 px-4 py-4">
        <h3 className="text-label uppercase text-muted-foreground">Venue</h3>
        <div className="flex flex-col gap-2 rounded-row border border-border bg-card p-4">
          <p className="truncate font-mono text-ui text-foreground" title={venue.path}>
            {venue.path}
          </p>
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1 font-mono text-ui text-muted-foreground">
              <GitBranchIcon weight="bold" className="size-3 shrink-0" />
              <span className="truncate">{venue.branch}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-ui text-attention">
              <span className="size-2 rounded-full bg-attention" />
              {modified + added + untracked}
            </span>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2 px-4 py-4">
        <h3 className="text-label uppercase text-muted-foreground">Session</h3>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui text-muted-foreground">Model</span>
            <span className="text-ui text-foreground">{SESSION_MODEL.model}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui text-muted-foreground">Effort</span>
            <span className="text-ui text-foreground">{SESSION_MODEL.effort}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui text-muted-foreground">Activity</span>
            <span className="flex items-center gap-1 text-ui text-foreground">
              <StatusDot state="ready" />
              Ready
            </span>
          </div>
        </div>
      </section>

      {/* MENTIONED, not "Touched": the word states the mechanism. A ticket is
          here because someone wrote `@vc-nn` — the same taxonomy that makes it
          a backlink chip in the feed. One vocabulary, two surfaces. */}
      <section className="flex flex-col gap-2 px-4 py-4">
        <h3 className="text-label uppercase text-muted-foreground">Mentioned</h3>
        <div className="flex flex-col gap-1">
          {MENTIONED.map((row) => (
            <button
              key={row.id}
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent"
            >
              <span className="shrink-0 font-mono text-ui text-muted-foreground">{row.id}</span>
              <span className="min-w-0 truncate text-ui text-foreground">{row.title}</span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

function FeedPreview() {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-6 px-gutter py-8">
      <div className="flex flex-col gap-2">
        <span className="text-label uppercase text-muted-foreground">You</span>
        <p className="text-sm leading-prose text-foreground">
          Fold <MentionChip id="VC-55" /> into <MentionChip id="VC-54" /> where they overlap, and
          check whether the digest half belongs in <MentionChip id="VC-75" /> instead.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-label uppercase text-muted-foreground">Agent</span>
        <p className="text-sm leading-prose text-foreground">
          The tab-strip half of <MentionChip id="VC-55" /> dissolves into <MentionChip id="VC-54" />{" "}
          — after Home the two kinds never share a strip.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surface

function Surface({ project, visual, info }: { project: boolean; visual: HomeVisual; info: Info }) {
  const venue = project ? MAIN_CHECKOUT : TICKET_WORKTREE;
  const Glyph = project ? CompassIcon : ChatCircleIcon;
  const PermanentGlyph = project ? KanbanIcon : TicketIcon;
  const tabs = project
    ? [
        { id: "board", label: "Board", permanent: true },
        { id: "chat", label: "Shape the 0.1.0 train", permanent: false },
      ]
    : [
        { id: "body", label: "Ticket", permanent: true },
        { id: "chat", label: "Auto-title v2 implementation", permanent: false },
      ];
  const activeIndex = 1;
  const stop = tabStopIndex(tabs.length, activeIndex);
  const railOn = project && info === "rail";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
      <TabStrip
        variant="pill"
        label={project ? "Home tabs" : "Ticket tabs"}
        className="shrink-0"
        actions={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="New session">
              <PlusIcon className="size-3.5" />
            </Button>
            {railOn ? (
              <Button variant="ghost" size="icon-sm" aria-label="Hide details rail (⌥⌘B)">
                <SidebarSimpleIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        }
      >
        {tabs.map((tab, index) => (
          <Tab
            key={tab.id}
            label={tab.label}
            active={index === activeIndex}
            tabStop={index === stop}
            closable={!tab.permanent}
            status={index === activeIndex ? "ready" : undefined}
            leading={
              tab.permanent ? (
                <PermanentGlyph weight="bold" className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <Glyph weight="bold" className="size-3 shrink-0 text-muted-foreground" />
              )
            }
            onActivate={() => {}}
          />
        ))}
      </TabStrip>

      {project && info === "venue-bar" ? <VenueBar venue={venue} /> : null}

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
            <EmptyChat visual={visual} venue={venue} />
          </div>
          <div className="shrink-0 px-4 pb-4">
            <div className="mx-auto flex max-w-content flex-col gap-2 rounded-container border border-border bg-card p-4 shadow-raised">
              <span className="text-sm text-muted-foreground">Message…</span>
              <div className="flex items-center gap-2 text-ui text-muted-foreground">
                <span>{SESSION_MODEL.model}</span>
                <span>·</span>
                <span>{SESSION_MODEL.effort}</span>
              </div>
            </div>
          </div>
        </div>
        {railOn ? <InfoRail venue={venue} /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The bar

function AxisPicker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Record<T, string>;
  onChange(next: T): void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-label uppercase text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-7 rounded-full border border-border bg-card px-2 text-ui text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
      >
        {(Object.keys(options) as T[]).map((key) => (
          <option key={key} value={key}>
            {options[key]}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function ProjectSessionIdentityScratch() {
  // Two pickers, not one: this is the shape the Settings control would take —
  // a default per scope, chosen from that scope's legal set. The ticket set
  // being shorter is the point, not an omission.
  const [homeVisual, setHomeVisual] = React.useState<HomeVisual>("streak");
  const [ticketVisual, setTicketVisual] = React.useState<TicketVisual>("venue");
  const [info, setInfo] = React.useState<Info>("venue-bar");
  const [view, setView] = React.useState<View>("both");

  return (
    // The app shell mounts this once at its root; a scratch that uses `Tooltip`
    // has to bring its own.
    <TooltipProvider>
      <div className="flex h-svh w-full flex-col bg-rail">
        <div className="flex min-h-0 flex-1 gap-2 p-2 pb-16">
          {view === "feed" ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto rounded-xl border border-border bg-background">
              <FeedPreview />
            </div>
          ) : (
            <>
              {view !== "ticket" ? <Surface project visual={homeVisual} info={info} /> : null}
              {view !== "home" ? (
                <Surface project={false} visual={ticketVisual} info={info} />
              ) : null}
            </>
          )}
        </div>

        <div className="fixed bottom-3 left-3 z-[9998] flex max-w-[calc(100vw-14rem)] flex-wrap items-center gap-4 rounded-full border border-border bg-background/90 px-4 py-2 shadow-overlay backdrop-blur">
          <AxisPicker
            label="Home"
            value={homeVisual}
            options={HOME_VISUAL_LABELS}
            onChange={setHomeVisual}
          />
          <AxisPicker
            label="Ticket"
            value={ticketVisual}
            options={TICKET_VISUAL_LABELS}
            onChange={setTicketVisual}
          />
          <AxisPicker label="Info" value={info} options={INFO_LABELS} onChange={setInfo} />
          <AxisPicker label="View" value={view} options={VIEW_LABELS} onChange={setView} />
          <code className="font-mono text-label text-muted-foreground">
            {homeVisual} / {ticketVisual}
          </code>
        </div>
      </div>
    </TooltipProvider>
  );
}
