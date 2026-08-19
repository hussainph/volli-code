/**
 * PROTOTYPE — VC-55, pass 4. The empty chat as a scope-matched instrument.
 *
 * THE MODEL. The empty-state visual is a CHOICE, but not a free one: each
 * visual is only legible at one scope, so the menu a surface OFFERS is itself
 * the identity signal. A Home chat can draw the streak or the board; a ticket
 * chat cannot, and that asymmetry is what the user internalises.
 *
 *   Home    → Streak · Board · Venue
 *   Ticket  → Venue        (default)
 *
 * Every visual sits over a CAPTION, and the caption is its own axis because the
 * mono path line under pass 3's drawings read as thrown together rather than
 * composed. Four treatments, from silent to conversational — see {@link Caption}.
 *
 * VENUE IS DESIGNED FIVE WAYS (owner note: "unbalanced"), under the design-it-
 * twice discipline — radically different shapes under different constraints,
 * compared rather than iterated:
 *
 *   stack       CONTROL. Two stacked reads in one card: loose over committed.
 *   figure      MINIMISE. One dominant numeral; everything else subordinate.
 *   single-bar  COMMON CASE. Loose and committed as segments of ONE object,
 *               which is the direct answer to "the two-part stack feels
 *               unbalanced" — there is no stack left to balance.
 *   ledger      MAXIMISE DENSITY. An aligned mono ledger, no card. `git status`
 *               set properly.
 *   files       BORROW THE VOCABULARY of the thing it describes: changed-file
 *               rows with per-file diff gutters. Concrete, not abstract.
 *
 * VENUE KEYS ON THE VENUE, NOT THE SESSION KIND. A ticket that runs in the main
 * checkout (no worktree — VC-96) draws main's tree and no branch bar, because
 * there is no branch to diff. That is why one visual can serve both scopes.
 *
 * DITHER-KIT WAS REMOVED (owner ruling: too much work). The record of why, so
 * nobody re-litigates it: its `ChartConfig` accepts only seven hard-coded colour
 * NAMES with no arbitrary-hex path, which the generated-canvas theming forbids;
 * its 23 vendored files tripped `vp lint` in 6 places; and it added d3-scale and
 * d3-shape to the desktop app's production dependencies for one chart.
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
export const note = "Streak / Board / Venue ×5, with caption treatments (VC-55 pass 4)";
export const viewport = "window" as const;

// ---------------------------------------------------------------------------
// Venue — the thing every visual is really about

/**
 * A file's state, and the four are DISJOINT by construction — `committed` means
 * changed on this branch and now clean in the tree.
 *
 * That disjointness is load-bearing, not tidiness. The first single-bar summed
 * loose files and `diff.files` for its headline and printed 14 for a worktree
 * holding 7 changed files, because every file that was both committed and dirty
 * got counted twice. A segmented bar is a claim that its parts partition the
 * whole, so the data has to actually partition.
 */
type FileState = "committed" | "modified" | "added" | "untracked";

interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  state: FileState;
}

interface Venue {
  kind: "main-checkout" | "worktree";
  path: string;
  branch: string;
  files: readonly ChangedFile[];
  /** What this branch has done vs its base. `null` when there is no base to diff. */
  diff: { added: number; removed: number; files: number; base: string } | null;
}

const MAIN_CHECKOUT: Venue = {
  kind: "main-checkout",
  path: "~/Desktop/code/volli-code",
  branch: "main",
  files: [
    { path: "docs/DESIGN.md", added: 18, removed: 4, state: "modified" },
    { path: "apps/desktop/src/renderer/src/globals.css", added: 6, removed: 6, state: "modified" },
    { path: "packages/shared/src/theme/canvas/ladder.ts", added: 31, removed: 0, state: "added" },
    { path: "notes/scratch.md", added: 12, removed: 0, state: "untracked" },
    { path: "notes/palette-trials.md", added: 44, removed: 0, state: "untracked" },
    { path: ".env.local", added: 2, removed: 0, state: "untracked" },
  ],
  diff: null,
};

const TICKET_WORKTREE: Venue = {
  kind: "worktree",
  path: "~/.volli/worktrees/volli-code-f3732f45/VC-81-auto-title…",
  branch: "volli/VC-81-auto-title-model-generated-titles",
  files: [
    { path: "packages/shared/src/session-title.ts", added: 96, removed: 12, state: "committed" },
    {
      path: "packages/session-engine/src/title-model.ts",
      added: 74,
      removed: 0,
      state: "committed",
    },
    {
      path: "apps/desktop/src/renderer/src/chat/rename.ts",
      added: 22,
      removed: 31,
      state: "committed",
    },
    {
      path: "packages/shared/src/session-title.test.ts",
      added: 22,
      removed: 20,
      state: "committed",
    },
    {
      path: "apps/desktop/src/renderer/src/stores/chat-sessions.ts",
      added: 14,
      removed: 3,
      state: "modified",
    },
    { path: "packages/cli/src/session.ts", added: 9, removed: 1, state: "modified" },
    { path: "docs/plans/auto-title.md", added: 27, removed: 0, state: "untracked" },
  ],
  diff: { added: 214, removed: 63, files: 4, base: "main" },
};

const TICKET_ID = "VC-81";
const SESSION_MODEL = { model: "Claude Opus 4.6", effort: "High" } as const;

function counts(venue: Venue) {
  const of = (state: FileState) => venue.files.filter((file) => file.state === state).length;
  const modified = of("modified");
  const added = of("added");
  const untracked = of("untracked");
  return {
    committed: of("committed"),
    modified,
    added,
    untracked,
    /** Dirty right now. */
    loose: modified + added + untracked,
    /** Every file this venue has touched, committed or not. The four states
     *  partition this, which is what lets a segmented bar total it honestly. */
    total: venue.files.length,
  };
}

const STATE_TONE: Record<FileState, string> = {
  // Committed work takes the accent: it is the only state that means progress
  // rather than exposure.
  committed: "bg-primary",
  modified: "bg-attention",
  added: "bg-positive",
  untracked: "bg-muted-foreground/40",
};

/** This repo's real board, so the bars are honestly proportioned. */
const BOARD = [
  { column: "Backlog", count: 46 },
  { column: "Todo", count: 7 },
  { column: "Doing", count: 1 },
  { column: "Needs Review", count: 0 },
  { column: "Done", count: 24 },
] as const;

/**
 * The rail's Sessions page. PROJECT sessions only — a ticket's sessions live in
 * that ticket's own rail, and listing them here would make Home a second index
 * of the same rows.
 */
const PROJECT_SESSIONS = [
  { id: "s1", title: "Shape the 0.1.0 train", ago: "now", state: "working" as const, open: true },
  {
    id: "s2",
    title: "Triage the AX feedback batch",
    ago: "2h",
    state: "waiting" as const,
    open: false,
  },
  { id: "s3", title: "Release notes draft", ago: "yesterday", state: "idle" as const, open: false },
  {
    id: "s4",
    title: "Why is the CLI socket flaky?",
    ago: "3d",
    state: "idle" as const,
    open: false,
  },
  { id: "s5", title: "Board cleanup pass", ago: "1w", state: "idle" as const, open: false },
] as const;

const MENTIONED = [
  { id: "VC-54", title: "Home taxonomy: board becomes a tabbed Home" },
  { id: "VC-75", title: "Active-session discoverability" },
  { id: "VC-42", title: "UX audit of every user surface" },
] as const;

// ---------------------------------------------------------------------------
// Streak fixture

const STREAK_WEEKS = 26;

interface StreakDay {
  id: string;
  count: number;
  ago: number;
}

function streakDays(): readonly StreakDay[] {
  const out: StreakDay[] = [];
  const total = STREAK_WEEKS * 7;
  let x = 20260817;
  for (let index = 0; index < total; index += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const roll = x / 2147483648;
    const weekday = index % 7;
    const weekend = weekday === 0 || weekday === 6;
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

function streakStep(count: number): number {
  return count === 0 ? 0 : count >= 9 ? 3 : count >= 5 ? 2 : 1;
}

function streakDayLabel(day: StreakDay): string {
  const sessions =
    day.count === 0 ? "No sessions" : `${day.count} session${day.count === 1 ? "" : "s"}`;
  const when = day.ago === 0 ? "today" : day.ago === 1 ? "yesterday" : `${day.ago} days ago`;
  return `${sessions} · ${when}`;
}

// ---------------------------------------------------------------------------
// Theme-derived colour

function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Ticks whenever the theme changes, so anything derived from a token recomputes.
 *
 * Not optional bookkeeping — it is the whole reason a derived colour is allowed
 * to exist. `readToken` samples the document once; without a subscription, a
 * ramp memoised on mount keeps painting the appearance that was live when it
 * mounted. The first streak grid did exactly that and drew dark-mode colours on
 * light paper, which read as an inverted grid rather than a staleness bug.
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

/** `count` hues fanned around the canvas primary, holding its L and C. */
function seriesColors(count: number, spread = 70): string[] {
  const { L, C, h } = hexToOklch(readToken("--primary", "#d37550"));
  if (count === 1) return [oklchToHex(L, C, h)];
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1) - 0.5;
    return oklchToHex(L, C, (h + t * spread + 360) % 360);
  });
}

/**
 * Four steps travelling from the BACKGROUND to the primary, in the primary's hue.
 *
 * Lightness has to travel, not just chroma: draining chroma out of a mid-tone
 * primary lands on a mid grey, which on a light canvas is DARKER than the paper.
 * Interpolating from the background is also what makes one ramp correct in both
 * appearances — light ramps down from paper, dark ramps up from ink.
 */
function streakRamp(): string[] {
  const base = hexToOklch(readToken("--background", "#1a1210"));
  const tip = hexToOklch(readToken("--primary", "#d37550"));
  return [0.12, 0.42, 0.72, 1].map((t) =>
    oklchToHex(lerp(base.L, tip.L, t), lerp(0.004, tip.C, t), tip.h),
  );
}

// ---------------------------------------------------------------------------
// Axes

type HomeVisual = "mark" | "streak" | "board" | "venue";
type TicketVisual = "mark" | "venue";
type VenueShape = "unified" | "stack" | "figure" | "single-bar" | "ledger" | "files";
type CaptionMode = "none" | "path" | "chips" | "greeter";
type Info = "none" | "rail";
type RailPage = "now" | "sessions";
type View = "home" | "ticket" | "both" | "feed";

const HOME_VISUAL_LABELS: Record<HomeVisual, string> = {
  mark: "Mark (today)",
  streak: "Streak",
  board: "Board",
  venue: "Venue",
};

const TICKET_VISUAL_LABELS: Record<TicketVisual, string> = {
  mark: "Mark (today)",
  venue: "Venue",
};

const VENUE_SHAPE_LABELS: Record<VenueShape, string> = {
  unified: "Unified (bar + diff)",
  stack: "Stack (pass 3)",
  figure: "Figure",
  "single-bar": "Single bar",
  ledger: "Ledger",
  files: "Files",
};

const CAPTION_LABELS: Record<CaptionMode, string> = {
  none: "None",
  path: "Path (pass 3)",
  chips: "Chips",
  greeter: "Greeter",
};

const INFO_LABELS: Record<Info, string> = {
  none: "None (today)",
  rail: "Rail (⌥⌘B) — Home only",
};

const RAIL_PAGE_LABELS: Record<RailPage, string> = {
  now: "Now",
  sessions: "Sessions",
};

const VIEW_LABELS: Record<View, string> = {
  home: "Home",
  ticket: "Ticket",
  both: "Both (at-a-glance test)",
  feed: "Feed (mid-session)",
};

// ---------------------------------------------------------------------------
// Caption — four treatments of the same footing

function partOfDay(hour: number): string {
  if (hour < 5) return "Late one";
  if (hour < 12) return "Morning";
  if (hour < 18) return "Afternoon";
  return "Evening";
}

/**
 * Greeters. Click to cycle — this is a lab affordance for browsing the set, not
 * a product interaction.
 *
 * The line that separates a greeter from the prose the owner killed: a greeter
 * does not EXPLAIN the surface. It opens a conversation. "Orchestrates from the
 * main checkout" is a description of the UI you are already looking at;
 * "Morning. What are we building?" is a question.
 */
function greeters(project: boolean, hour: number): string[] {
  const part = partOfDay(hour);
  return project
    ? [
        `${part}. What are we building?`,
        `${part} — where do you want to start?`,
        "What's on the board?",
        "What should we ship today?",
        "Got something to shape?",
      ]
    : [
        `${part}. Back on ${TICKET_ID}.`,
        `Picking up ${TICKET_ID}.`,
        `${TICKET_ID} — what's next?`,
        "Where did we leave this?",
      ];
}

/**
 * One scope chip: capped width, ellipsised, full value on hover.
 *
 * The cap is on the CHIP, not the text, so a long branch name can never push the
 * row wider than the drawing it sits under — which is what made these read as
 * thrown together rather than composed. `min-w-0` on the label is what actually
 * lets `truncate` fire inside a flex row; without it the text sets the width and
 * the cap never bites.
 */
function ScopeChip({
  icon: Icon,
  full,
  children,
}: {
  icon: React.ComponentType<{ className?: string; weight?: "bold" }>;
  /** The untruncated value — the tooltip's whole reason to exist. */
  full: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-7 max-w-48 cursor-default items-center gap-1 rounded-full border border-border bg-card px-2 text-ui text-muted-foreground">
          <Icon weight="bold" className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{children}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="font-mono">
        {full}
      </TooltipContent>
    </Tooltip>
  );
}

function Caption({ mode, venue, project }: { mode: CaptionMode; venue: Venue; project: boolean }) {
  const [cycle, setCycle] = React.useState(0);
  if (mode === "none") return null;

  if (mode === "path") {
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

  if (mode === "chips") {
    return (
      <div className="flex flex-wrap items-center justify-center gap-1">
        <ScopeChip icon={FolderOpenIcon} full={venue.path}>
          {venue.kind === "main-checkout" ? "Main checkout" : "Worktree"}
        </ScopeChip>
        <ScopeChip icon={GitBranchIcon} full={venue.branch}>
          {venue.branch}
        </ScopeChip>
      </div>
    );
  }

  const lines = greeters(project, new Date().getHours());
  return (
    <button
      type="button"
      onClick={() => setCycle((value) => value + 1)}
      title="Lab: click to cycle greeters"
      className="text-heading text-foreground transition-opacity hover:opacity-70"
    >
      {lines[cycle % lines.length]}
    </button>
  );
}

// ---------------------------------------------------------------------------
// STREAK — every session run in Volli, one cell per day. Home only.

function StreakVisual() {
  // Subscribe, then derive on every render. Four colours is cheaper to compute
  // than to memoise correctly against a subscription the linter cannot see.
  useThemeEpoch();
  const ramp = streakRamp();
  const [hover, setHover] = React.useState<{ day: StreakDay; x: number; y: number } | null>(null);

  const total = STREAK.reduce((sum, day) => sum + day.count, 0);
  const active = STREAK.filter((day) => day.count > 0).length;
  let run = 0;
  for (let index = STREAK.length - 1; index >= 0; index -= 1) {
    if ((STREAK[index]?.count ?? 0) === 0) break;
    run += 1;
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {/* ONE tooltip for 182 cells, driven by event delegation off the grid.
          Per-cell Radix tooltips would mount 182 portal roots for a hint nobody
          reads twice; per-cell handlers would allocate 182 closures a render.
          The grid reads `data-day` off whatever the pointer is over. */}
      <div
        className="relative"
        onPointerOver={(event) => {
          const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-day]");
          if (cell === null) return;
          const day = STREAK[Number(cell.dataset.day)];
          if (day === undefined) return;
          const grid = event.currentTarget.getBoundingClientRect();
          const box = cell.getBoundingClientRect();
          setHover({
            day,
            x: box.left - grid.left + box.width / 2,
            y: box.top - grid.top,
          });
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div
          className="grid grid-flow-col grid-rows-7 gap-1"
          role="img"
          aria-label={`${total} sessions over ${STREAK_WEEKS} weeks`}
        >
          {STREAK.map((day, index) => (
            <span
              key={day.id}
              data-day={index}
              className="size-2.5 rounded-sm"
              style={{ backgroundColor: ramp[streakStep(day.count)] }}
            />
          ))}
        </div>
        {hover === null ? null : (
          <div
            aria-hidden
            className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-ui text-popover-foreground shadow-overlay"
            style={{ left: hover.x, top: hover.y - 6 }}
          >
            {streakDayLabel(hover.day)}
          </div>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-title text-foreground">{total}</span>
        <span className="text-ui text-muted-foreground">sessions in {STREAK_WEEKS} weeks</span>
      </div>
      <div className="flex items-center gap-4 text-ui text-muted-foreground">
        <span>{active} active days</span>
        {run > 0 ? <span>{run}-day streak</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BOARD — the project's column distribution. Home only.

function BoardVisual() {
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
                  className="w-full rounded-md transition-opacity hover:opacity-100"
                  style={{
                    height: `${Math.max(3, (entry.count / peak) * 68)}px`,
                    backgroundColor: entry.count === 0 ? undefined : colors[index],
                    opacity: entry.count === 0 ? undefined : 0.85,
                  }}
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// VENUE ×5 — design it twice (and then three more times)

/**
 * UNIFIED — the single bar and the stack's diff bar as ONE object.
 *
 * The stack failed because it was two centred charts with a rule between them:
 * two silhouettes competing for the same slot, neither anchoring the other. The
 * fix is not to shrink one of them, it is to stop them being two objects.
 *
 * So: one rounded body, two registers sharing its exact width and its corner
 * radius. The thick track partitions FILES by state; the hairline track under it
 * splits LINES added against removed. Same left edge, same right edge, one
 * outline — the eye reads a single instrument with two scales, the way a level
 * has a bubble and a rule.
 *
 * They are different units on purpose, and that is why the object works: files
 * answer "how much of this tree is in play", lines answer "how much work is in
 * it". Stacking two file-count bars would just be a bar chart with two rows.
 *
 * A venue with no base to diff (the main checkout) drops the hairline entirely
 * rather than drawing an empty one — an empty track reads as "no work", which is
 * the opposite of what a dirty main checkout means.
 */
function VenueUnified({ venue }: { venue: Venue }) {
  const n = counts(venue);
  const diff = venue.diff;
  const span = diff === null ? 0 : diff.added + diff.removed;
  const segments = [
    { key: "committed", value: n.committed, tone: "bg-primary", label: "committed" },
    { key: "modified", value: n.modified, tone: "bg-attention", label: "modified" },
    { key: "added", value: n.added, tone: "bg-positive", label: "added" },
    {
      key: "untracked",
      value: n.untracked,
      tone: "bg-muted-foreground/40",
      label: "untracked",
    },
  ].filter((segment) => segment.value > 0);

  return (
    <div className="flex w-80 flex-col gap-3">
      {/* One silhouette: the wrapper owns the radius and clips both tracks, so
          neither can round its own corners and become a separate object. */}
      <div className="flex flex-col overflow-hidden rounded-control">
        <div className="flex h-8">
          {segments.map((segment) => (
            <Tooltip key={segment.key}>
              <TooltipTrigger asChild>
                <span
                  className={cn("h-full cursor-default", segment.tone)}
                  style={{ width: `${(segment.value / n.total) * 100}%` }}
                />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {segment.value} {segment.label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        {diff === null ? null : (
          <div className="flex h-1.5 border-t border-background">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="h-full cursor-default bg-positive"
                  style={{ width: `${(diff.added / span) * 100}%` }}
                />
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {diff.added} lines added
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="h-full cursor-default bg-destructive"
                  style={{ width: `${(diff.removed / span) * 100}%` }}
                />
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {diff.removed} lines removed
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      <div className="flex items-baseline justify-center gap-3">
        <span className="text-title text-foreground">{n.total}</span>
        <span className="text-ui text-muted-foreground">files</span>
        {diff === null ? null : (
          <>
            <span className="text-ui text-positive">+{diff.added}</span>
            <span className="text-ui text-destructive">−{diff.removed}</span>
            <span className="text-ui text-muted-foreground">vs {diff.base}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** CONTROL — pass 3's two stacked reads in one card. */
function VenueStack({ venue }: { venue: Venue }) {
  const n = counts(venue);
  const diff = venue.diff;
  const span = diff === null ? 0 : diff.added + diff.removed;
  return (
    <div className="flex w-80 flex-col gap-4 rounded-row border border-border bg-card p-4">
      <div className="flex flex-col gap-2">
        <div className="flex h-10 items-end justify-center gap-1">
          {venue.files
            .filter((file) => file.state !== "committed")
            .map((file) => (
              <span
                key={file.path}
                className={cn("h-full w-2 rounded-full", STATE_TONE[file.state])}
              />
            ))}
        </div>
        <div className="flex items-baseline justify-center gap-2">
          <span className="text-heading text-foreground">{n.loose}</span>
          <span className="text-ui text-muted-foreground">uncommitted</span>
        </div>
      </div>
      <div className="h-px bg-border" />
      {diff === null ? (
        <p className="text-center text-ui text-muted-foreground">no branch of its own</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex h-3 overflow-hidden rounded-full">
            <span className="bg-positive" style={{ width: `${(diff.added / span) * 100}%` }} />
            <span className="bg-destructive" style={{ width: `${(diff.removed / span) * 100}%` }} />
          </div>
          <div className="flex items-baseline justify-center gap-4">
            <span className="text-heading text-positive">+{diff.added}</span>
            <span className="text-heading text-destructive">−{diff.removed}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * MINIMISE — one number carries the surface, everything else is a footnote.
 *
 * The number is files touched HERE, because that is the one quantity that means
 * the same thing in a worktree and in the main checkout.
 */
function VenueFigure({ venue }: { venue: Venue }) {
  const n = counts(venue);
  const diff = venue.diff;
  return (
    <div className="flex flex-col items-center gap-2">
      {/* OFF-LADDER, and recorded as a finding rather than hidden: the type
          scale tops out at `text-title` (24px), so a hero numeral has no rung.
          Adopting this variant means arguing a new step into docs/DESIGN.md. */}
      <span className="text-[3.5rem] leading-none font-light text-foreground tabular-nums">
        {n.total}
      </span>
      <span className="text-ui text-muted-foreground">files touched here</span>
      <div className="mt-2 flex items-center gap-3 text-ui">
        {n.committed > 0 ? (
          <span className="text-primary-text">{n.committed} committed</span>
        ) : null}
        {n.modified > 0 ? <span className="text-attention">{n.modified} modified</span> : null}
        {n.added > 0 ? <span className="text-positive">{n.added} added</span> : null}
        {n.untracked > 0 ? (
          <span className="text-muted-foreground">{n.untracked} untracked</span>
        ) : null}
      </div>
      {diff === null ? null : (
        <div className="flex items-center gap-3 text-ui text-muted-foreground">
          <span className="text-positive">+{diff.added}</span>
          <span className="text-destructive">−{diff.removed}</span>
          <span>committed vs {diff.base}</span>
        </div>
      )}
    </div>
  );
}

/**
 * COMMON CASE — one object, not two.
 *
 * The direct answer to "the stack feels unbalanced": there is no stack. Loose
 * work and committed work are segments of a single bar, so the eye reads one
 * quantity split by state instead of two charts competing for the same slot.
 */
function VenueSingleBar({ venue }: { venue: Venue }) {
  const n = counts(venue);
  const diff = venue.diff;
  // The four states partition `total` by construction, so the segments sum to
  // the headline. Deriving the committed count from `diff.files` instead double
  // counted every file that was both committed and dirty.
  const total = n.total;
  const segments = [
    { key: "committed", value: n.committed, tone: "bg-primary", label: "committed" },
    { key: "modified", value: n.modified, tone: "bg-attention", label: "modified" },
    { key: "added", value: n.added, tone: "bg-positive", label: "added" },
    {
      key: "untracked",
      value: n.untracked,
      tone: "bg-muted-foreground/40",
      label: "untracked",
    },
  ].filter((segment) => segment.value > 0);

  return (
    <div className="flex w-80 flex-col gap-3">
      <div className="flex h-8 gap-1 overflow-hidden rounded-full">
        {segments.map((segment) => (
          <Tooltip key={segment.key}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "h-full cursor-default first:rounded-l-full last:rounded-r-full",
                  segment.tone,
                )}
                style={{ width: `${(segment.value / total) * 100}%` }}
              />
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {segment.value} {segment.label}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="flex items-baseline justify-center gap-2">
        <span className="text-title text-foreground">{total}</span>
        <span className="text-ui text-muted-foreground">
          files {diff === null ? "loose here" : "in this worktree"}
        </span>
      </div>
    </div>
  );
}

/** MAXIMISE DENSITY — `git status` set properly. No card, no chart. */
function VenueLedger({ venue }: { venue: Venue }) {
  const n = counts(venue);
  const diff = venue.diff;
  const rows: Array<[string, React.ReactNode]> = [
    [venue.kind === "main-checkout" ? "checkout" : "worktree", venue.path],
    ["branch", venue.branch],
    ...(diff === null
      ? ([["base", "— none"]] as Array<[string, React.ReactNode]>)
      : ([
          ["base", diff.base],
          [
            "committed",
            <span key="c">
              <span className="text-positive">+{diff.added}</span>{" "}
              <span className="text-destructive">−{diff.removed}</span>
            </span>,
          ],
        ] as Array<[string, React.ReactNode]>)),
    [
      "loose",
      <span key="l">
        {n.modified}M {n.added}A {n.untracked}U
      </span>,
    ],
  ];

  return (
    <dl className="grid w-96 grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-left font-mono text-ui">
      {rows.map(([key, value]) => (
        <React.Fragment key={key}>
          <dt className="text-muted-foreground">{key}</dt>
          <dd
            className="truncate text-foreground"
            title={typeof value === "string" ? value : undefined}
          >
            {value}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/**
 * BORROW THE VOCABULARY — changed-file rows with per-file diff gutters.
 *
 * The only variant that names anything concrete. Its risk is the opposite of
 * the others': it stops being a glanceable identity signal and becomes a list
 * you read, which on a busy tree is a wall.
 */
function VenueFiles({ venue }: { venue: Venue }) {
  const widest = Math.max(...venue.files.map((file) => file.added + file.removed), 1);
  return (
    <div className="flex w-96 flex-col gap-1">
      {venue.files.slice(0, 6).map((file) => {
        const span = file.added + file.removed;
        return (
          <div key={file.path} className="flex items-center gap-2">
            <span className={cn("size-1.5 shrink-0 rounded-full", STATE_TONE[file.state])} />
            <span
              className="min-w-0 flex-1 truncate text-left font-mono text-ui text-muted-foreground"
              title={file.path}
            >
              {file.path}
            </span>
            <span className="flex h-1.5 w-20 shrink-0 gap-px overflow-hidden rounded-full">
              {span === 0 ? (
                <span className="w-full bg-border" />
              ) : (
                <>
                  <span
                    className="bg-positive"
                    style={{ width: `${(file.added / widest) * 100}%` }}
                  />
                  <span
                    className="bg-destructive"
                    style={{ width: `${(file.removed / widest) * 100}%` }}
                  />
                </>
              )}
            </span>
          </div>
        );
      })}
      {venue.files.length > 6 ? (
        <span className="pt-1 text-left text-ui text-muted-foreground">
          +{venue.files.length - 6} more
        </span>
      ) : null}
    </div>
  );
}

function VenueVisual({ venue, shape }: { venue: Venue; shape: VenueShape }) {
  if (shape === "unified") return <VenueUnified venue={venue} />;
  if (shape === "figure") return <VenueFigure venue={venue} />;
  if (shape === "single-bar") return <VenueSingleBar venue={venue} />;
  if (shape === "ledger") return <VenueLedger venue={venue} />;
  if (shape === "files") return <VenueFiles venue={venue} />;
  return <VenueStack venue={venue} />;
}

// ---------------------------------------------------------------------------

function MarkVisual() {
  return (
    <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-raised">
      <CodeIcon className="size-5 text-muted-foreground" />
    </div>
  );
}

function EmptyChat({
  visual,
  venue,
  project,
  venueShape,
  caption,
}: {
  visual: HomeVisual;
  venue: Venue;
  project: boolean;
  venueShape: VenueShape;
  caption: CaptionMode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 px-gutter py-8 text-center">
      {visual === "mark" ? <MarkVisual /> : null}
      {visual === "streak" ? <StreakVisual /> : null}
      {visual === "board" ? <BoardVisual /> : null}
      {visual === "venue" ? <VenueVisual venue={venue} shape={venueShape} /> : null}
      <Caption mode={caption} venue={venue} project={project} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Info surfaces — Home only. The ticket rail is a non-goal.

/**
 * The rail's page switcher — the ticket rail's centred pill, with this surface's
 * two pages. Presentational; the page lives in the caller's state.
 */
function RailTabs({ page, onSelect }: { page: RailPage; onSelect(next: RailPage): void }) {
  return (
    <div className="sticky top-0 z-20 shrink-0 bg-sidebar/70 px-4 pt-4 pb-4 backdrop-blur-xl">
      <div
        role="tablist"
        aria-label="Home rail pages"
        className="mx-auto flex w-40 items-center gap-1 rounded-full border border-sidebar-border bg-background/70 p-1 shadow-raised"
      >
        {(Object.keys(RAIL_PAGE_LABELS) as RailPage[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={page === key}
            onClick={() => onSelect(key)}
            className={cn(
              "h-8 flex-1 rounded-full text-ui transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
              page === key
                ? "bg-accent text-foreground shadow-raised"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {RAIL_PAGE_LABELS[key]}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * SESSIONS — project session history, and ONLY project sessions.
 *
 * The scoping is the decision, not a filter: a ticket's sessions already have a
 * home in that ticket's own rail, so listing them here would make Home a second
 * index of the same rows. What has no home today is the project session you
 * closed — which is also VC-54's "closed project-session tabs are reopenable
 * from Home". This page IS that surface; the two tickets should not build it
 * twice.
 */
function RailSessions() {
  return (
    <div className="flex flex-col gap-2 px-4 pb-8">
      <h3 className="text-label uppercase text-muted-foreground">Project sessions</h3>
      <div className="flex flex-col gap-px">
        {PROJECT_SESSIONS.map((session) => (
          <button
            key={session.id}
            type="button"
            className="flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
          >
            <span className="flex min-w-0 items-center gap-2">
              {session.state === "idle" ? (
                <span className="size-1.5 shrink-0 rounded-full bg-transparent" />
              ) : (
                <StatusDot state={session.state} />
              )}
              <span
                className={cn(
                  "min-w-0 truncate text-ui",
                  session.open ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {session.title}
              </span>
            </span>
            <span className="pl-3.5 text-ui text-muted-foreground">
              {session.open ? "Open" : session.ago}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function InfoRail({ venue }: { venue: Venue }) {
  const n = counts(venue);
  const [page, setPage] = React.useState<RailPage>("now");
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar">
      <RailTabs page={page} onSelect={setPage} />
      {page === "sessions" ? <RailSessions /> : null}
      <section className={cn("flex flex-col gap-2 px-4 pb-4", page !== "now" && "hidden")}>
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
              {n.loose}
            </span>
          </div>
        </div>
      </section>

      <section className={cn("flex flex-col gap-2 px-4 py-4", page !== "now" && "hidden")}>
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
      <section className={cn("flex flex-col gap-2 px-4 py-4", page !== "now" && "hidden")}>
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

/**
 * A transcript, for the ONE question the empty state cannot answer: is the venue
 * bar redundant?
 *
 * It only duplicates the empty state while the empty state is on screen — which
 * is exactly as long as it takes to type one message. Judge the bar here, not
 * on the empty surface.
 */
function Transcript() {
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
          — after Home the two kinds never share a strip. The rail and the empty chat are the parts
          that survive on their own.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-label uppercase text-muted-foreground">You</span>
        <p className="text-sm leading-prose text-foreground">
          Right — and now that the transcript has scrolled, nothing on this surface says which
          directory the session is touching.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surface

function Surface({
  project,
  visual,
  info,
  venueShape,
  caption,
  transcript,
}: {
  project: boolean;
  visual: HomeVisual;
  info: Info;
  venueShape: VenueShape;
  caption: CaptionMode;
  transcript: boolean;
}) {
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

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className={cn(
              "flex min-h-0 flex-1 overflow-y-auto",
              transcript ? "flex-col" : "items-center justify-center",
            )}
          >
            {transcript ? (
              <Transcript />
            ) : (
              <EmptyChat
                visual={visual}
                venue={venue}
                project={project}
                venueShape={venueShape}
                caption={caption}
              />
            )}
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
  // Two visual pickers, not one: this is the shape the Settings control would
  // take — a default per scope, chosen from that scope's legal set.
  const [homeVisual, setHomeVisual] = React.useState<HomeVisual>("streak");
  const [ticketVisual, setTicketVisual] = React.useState<TicketVisual>("venue");
  const [venueShape, setVenueShape] = React.useState<VenueShape>("unified");
  const [caption, setCaption] = React.useState<CaptionMode>("chips");
  const [info, setInfo] = React.useState<Info>("none");
  const [view, setView] = React.useState<View>("both");

  const transcript = view === "feed";

  return (
    // The app shell mounts this once at its root; a scratch that uses `Tooltip`
    // has to bring its own.
    <TooltipProvider>
      <div className="flex h-svh w-full flex-col bg-rail">
        <div className="flex min-h-0 flex-1 gap-2 p-2 pb-16">
          {view === "ticket" ? null : (
            <Surface
              project
              visual={homeVisual}
              info={info}
              venueShape={venueShape}
              caption={caption}
              transcript={transcript}
            />
          )}
          {view === "home" || view === "feed" ? null : (
            <Surface
              project={false}
              visual={ticketVisual}
              info={info}
              venueShape={venueShape}
              caption={caption}
              transcript={false}
            />
          )}
        </div>

        <div className="fixed bottom-3 left-3 z-[9998] flex max-w-[calc(100vw-14rem)] flex-wrap items-center gap-3 rounded-full border border-border bg-background/90 px-4 py-2 shadow-overlay backdrop-blur">
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
          <AxisPicker
            label="Venue"
            value={venueShape}
            options={VENUE_SHAPE_LABELS}
            onChange={setVenueShape}
          />
          <AxisPicker
            label="Caption"
            value={caption}
            options={CAPTION_LABELS}
            onChange={setCaption}
          />
          <AxisPicker label="Info" value={info} options={INFO_LABELS} onChange={setInfo} />
          <AxisPicker label="View" value={view} options={VIEW_LABELS} onChange={setView} />
        </div>
      </div>
    </TooltipProvider>
  );
}
