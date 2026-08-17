/**
 * PROTOTYPE — VC-55, pass 2. What an empty chat should DRAW instead of telling
 * you where you are.
 *
 * THE TURN THIS PASS TAKES. Pass 1 answered "which session is this?" with words
 * — chips that named the venue, a line of prose under them. The owner's ruling
 * killed both: prose explaining obvious UI is lazy design, and a row of nouns is
 * redundant with the sidebar that already names the same things.
 *
 * The replacement is INDIRECT: draw data that only makes sense at this session's
 * scope, and let the shape of it carry the identity. A project session opens on
 * a FIELD of many things — every session the project has ever run, the whole
 * board's shape. A ticket session opens on ONE thing's progress — this ticket's
 * column, this worktree's diff. Many-vs-one is a silhouette you read before you
 * read anything, and unlike a label it stays useful after you have learnt it.
 * Nobody is told "this is a project session"; the drawing is only true of one.
 *
 * WHAT IS DELIBERATELY GONE (all owner rulings, pass 1):
 *   - The purpose sentence, and "Your working tree — not isolated." The dirty
 *     count is drawn now; a sentence about it was the lazy version.
 *   - `material` on the identity axis — it did nothing legible.
 *   - The prototype rail on the TICKET surface. Ticket-rail changes are a
 *     non-goal; only the project surface gets a new rail here.
 *   - "Touched" as a label. It is "Mentioned" now, and the word is load-bearing
 *     — see MENTIONS below.
 *
 * PARKED, NOT REJECTED: the icon-driven intent chips ("Shape an idea", "File
 * tickets"). They read well and they belong with Automations in 0.1.2, not in a
 * release whose job is telling two session kinds apart.
 *
 * MENTIONS is a real feature this prototype is only DRAWING, not implementing:
 * `@VC-22` in a chat message becomes a backlink chip in the feed and pulls that
 * ticket into the rail's Mentioned column. Both halves need parsing, storage and
 * a prompt instruction telling the agent to use the `@vc-nn` form for external
 * tickets — none of which is in this file. `View → Feed` draws the chip so the
 * chip can be judged; the plumbing is a separate ticket.
 *
 * Fixtures are frozen. The board counts are this repo's real ones so the bars
 * have honest proportions; the session states are generated deterministically.
 * The lab has no main-process half (CLAUDE.md), so nothing here reads git.
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

import { Button } from "@renderer/components/ui/button";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { Tab, TabStrip, tabStopIndex } from "@renderer/components/ui/tab-strip";
import { cn } from "@renderer/lib/utils";

export const title = "Project session · identity, info, empty chat";
export const note = "Scope-matched data as the identity — VC-55 pass 2";
export const viewport = "window" as const;

// ---------------------------------------------------------------------------
// Fixtures

const PROJECT = {
  name: "volli-code",
  path: "~/Desktop/code/volli-code",
  branch: "main",
  model: "Claude Opus 4.6",
  effort: "High",
  /** Uncommitted in the MAIN CHECKOUT — the user's own tree. */
  dirty: { modified: 2, added: 1, untracked: 3 },
} as const;

const TICKET = {
  id: "VC-81",
  title: "Auto-title v2: model-generated titles",
  branch: "volli/VC-81-auto-title-model-generated-titles",
  worktree: "~/.volli/worktrees/volli-code-f3732f45/VC-81-auto-title…",
  column: "Doing",
  diff: { added: 214, removed: 63, files: 7 },
} as const;

/** This repo's real board, so the bars are honestly proportioned. */
const BOARD = [
  { column: "Backlog", count: 46 },
  { column: "Todo", count: 7 },
  { column: "Doing", count: 1 },
  { column: "Needs Review", count: 0 },
  { column: "Done", count: 24 },
] as const;

type SessionState = "done" | "active" | "waiting" | "error";

/** Each cell carries its own id so the grid never keys on an array index. */
interface SessionCell {
  id: string;
  state: SessionState;
}

/**
 * Deterministic, so the field looks the same every reload and two screenshots
 * are comparable. Pure — no module-level side effects (see `scratch.ts`).
 */
function sessionField(prefix: string, count: number, seed: number): readonly SessionCell[] {
  const out: SessionCell[] = [];
  let x = seed;
  for (let index = 0; index < count; index += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const roll = x / 2147483648;
    out.push({
      id: `${prefix}-${index}`,
      state: roll > 0.94 ? "waiting" : roll > 0.9 ? "error" : roll > 0.82 ? "active" : "done",
    });
  }
  return out;
}

const PROJECT_SESSIONS = sessionField("p", 147, 7);
const TICKET_SESSIONS: readonly SessionCell[] = [
  { id: "t-0", state: "done" },
  { id: "t-1", state: "done" },
  { id: "t-2", state: "done" },
  { id: "t-3", state: "active" },
];

/** Tickets this session has mentioned as `@vc-nn`. Nothing is fetched for it. */
const MENTIONED = [
  { id: "VC-54", title: "Home taxonomy: board becomes a tabbed Home", column: "Todo" },
  { id: "VC-75", title: "Active-session discoverability", column: "Backlog" },
  { id: "VC-42", title: "UX audit of every user surface", column: "Done" },
] as const;

const STATE_TONE: Record<SessionState, string> = {
  done: "bg-muted-foreground/30",
  active: "bg-positive",
  waiting: "bg-attention",
  error: "bg-destructive",
};

// ---------------------------------------------------------------------------
// Axes

type Identity = "none" | "glyph" | "tint";
type Info = "none" | "rail" | "venue-bar";
type Empty = "mark" | "field" | "pulse" | "tree";
type View = "home" | "ticket" | "both" | "feed";

const IDENTITY_LABELS: Record<Identity, string> = {
  none: "None (today)",
  glyph: "Glyph",
  tint: "Glyph + tint",
};

const INFO_LABELS: Record<Info, string> = {
  none: "None (today)",
  rail: "Rail (⌥⌘B) — project only",
  "venue-bar": "Venue bar — project only",
};

const EMPTY_LABELS: Record<Empty, string> = {
  mark: "Mark (today)",
  field: "Session field",
  pulse: "Board pulse",
  tree: "Working tree",
};

const VIEW_LABELS: Record<View, string> = {
  home: "Home",
  ticket: "Ticket",
  both: "Both (at-a-glance test)",
  feed: "Feed (backlink chips)",
};

// ---------------------------------------------------------------------------
// Shared parts

/**
 * The scope caption. Demoted on purpose: pass 1 made these the hero and they
 * read as a redundant restatement of the sidebar. One quiet mono line under a
 * drawing is the most they have ever been worth.
 */
function ScopeCaption({ project }: { project: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 font-mono text-ui text-muted-foreground">
      <span className="flex items-center gap-1">
        <FolderOpenIcon
          weight="bold"
          className="size-3"
          aria-label={project ? "Main checkout" : "Worktree"}
        />
        {project ? PROJECT.path : TICKET.worktree}
      </span>
      <span className="flex items-center gap-1">
        <GitBranchIcon weight="bold" className="size-3" aria-label="Branch" />
        {project ? PROJECT.branch : TICKET.branch}
      </span>
    </div>
  );
}

/** A backlink chip — what `@VC-54` becomes in the feed and in the rail. */
function MentionChip({ id, column }: { id: string; column?: string }) {
  return (
    <button
      type="button"
      title={column ? `${id} · ${column}` : id}
      className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2 align-baseline font-mono text-ui text-foreground transition-colors hover:border-primary/40 hover:text-primary-text"
    >
      <TicketIcon weight="bold" className="size-3 text-muted-foreground" />
      {id}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The four empty-state drawings
//
// Each draws differently per scope, and the DIFFERENCE is the point: a field vs
// a handful, a whole board vs one column, a whole checkout vs one diff.

/** Today. Kept only so the others have something to beat. */
function MarkEmpty() {
  return (
    <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-raised">
      <CodeIcon className="size-5 text-muted-foreground" />
    </div>
  );
}

/**
 * SESSION FIELD — every session in scope, one cell each.
 *
 * The project field is dense and the ticket field is four cells in the same
 * geometry, so the two are unmistakable from across the room without either one
 * naming itself. Toned by state, which makes it a live read rather than a
 * decoration: a row of amber is work waiting on you.
 */
function SessionFieldEmpty({ project }: { project: boolean }) {
  const cells = project ? PROJECT_SESSIONS : TICKET_SESSIONS;
  const waiting = cells.filter((cell) => cell.state === "waiting").length;
  const active = cells.filter((cell) => cell.state === "active").length;

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className="grid w-80 grid-cols-[repeat(21,minmax(0,1fr))] gap-1"
        role="img"
        aria-label={`${cells.length} sessions in scope`}
      >
        {cells.map((cell) => (
          <span
            key={cell.id}
            className={cn("aspect-square rounded-full", STATE_TONE[cell.state])}
            title={cell.state}
          />
        ))}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-title text-foreground">{cells.length}</span>
        <span className="text-ui text-muted-foreground">
          {project ? "sessions in this project" : `sessions on ${TICKET.id}`}
        </span>
      </div>
      {active + waiting > 0 ? (
        <div className="flex items-center gap-4 text-ui text-muted-foreground">
          {active > 0 ? (
            <span className="flex items-center gap-1">
              <StatusDot state="working" />
              {active} running
            </span>
          ) : null}
          {waiting > 0 ? (
            <span className="flex items-center gap-1">
              <StatusDot state="waiting" />
              {waiting} waiting on you
            </span>
          ) : null}
        </div>
      ) : null}
      <ScopeCaption project={project} />
    </div>
  );
}

/**
 * BOARD PULSE — the same five columns, drawn two ways.
 *
 * A project session gets the board's whole distribution as bars: it is looking
 * at all of them. A ticket session gets the identical five as a track with one
 * segment lit: it is one of them, and which one is the single most useful fact
 * about it. Same vocabulary, opposite reading.
 */
function BoardPulseEmpty({ project }: { project: boolean }) {
  const peak = Math.max(...BOARD.map((entry) => entry.count));

  if (project) {
    return (
      <div className="flex flex-col items-center gap-4">
        <div className="flex h-24 w-80 items-end gap-2" role="img" aria-label="Board distribution">
          {BOARD.map((entry) => (
            <div key={entry.column} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="text-ui text-muted-foreground">{entry.count}</span>
              <span
                className={cn(
                  "w-full rounded-md",
                  entry.count === 0 ? "bg-border" : "bg-primary/30",
                )}
                style={{ height: `${Math.max(2, (entry.count / peak) * 68)}px` }}
              />
            </div>
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
        <ScopeCaption project={project} />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className="flex w-80 gap-1"
        role="img"
        aria-label={`${TICKET.id} is in ${TICKET.column}`}
      >
        {BOARD.map((entry) => (
          <span
            key={entry.column}
            className={cn(
              "h-1.5 min-w-0 flex-1 rounded-full",
              entry.column === TICKET.column ? "bg-primary" : "bg-border",
            )}
          />
        ))}
      </div>
      <div className="flex w-80 gap-1">
        {BOARD.map((entry) => (
          <span
            key={entry.column}
            className={cn(
              "min-w-0 flex-1 truncate text-center text-label uppercase",
              entry.column === TICKET.column ? "text-primary-text" : "text-muted-foreground",
            )}
          >
            {entry.column}
          </span>
        ))}
      </div>
      <div className="flex max-w-80 flex-col items-center gap-1">
        <span className="font-mono text-ui text-muted-foreground">{TICKET.id}</span>
        <span className="text-heading text-foreground">{TICKET.title}</span>
      </div>
      <ScopeCaption project={project} />
    </div>
  );
}

/**
 * WORKING TREE — the dirty count, drawn.
 *
 * This is the replacement for the sentence "Your working tree — not isolated."
 * A project session's tree is the user's own, so its changes are drawn as loose
 * ticks with no diff total: they are not this session's work and summing them
 * would imply they were. A ticket worktree's diff IS the session's work, so it
 * gets the proportional +/− bar.
 */
function WorkingTreeEmpty({ project }: { project: boolean }) {
  if (project) {
    const { modified, added, untracked } = PROJECT.dirty;
    const total = modified + added + untracked;
    const ticks = [
      ...Array.from({ length: modified }, (_, i) => ({ id: `m${i}`, tone: "bg-attention" })),
      ...Array.from({ length: added }, (_, i) => ({ id: `a${i}`, tone: "bg-positive" })),
      ...Array.from({ length: untracked }, (_, i) => ({
        id: `u${i}`,
        tone: "bg-muted-foreground/40",
      })),
    ];
    return (
      <div className="flex flex-col items-center gap-4">
        <div
          className="flex h-12 w-80 items-end justify-center gap-1"
          role="img"
          aria-label={`${total} uncommitted files`}
        >
          {ticks.map((tick) => (
            <span key={tick.id} className={cn("h-full w-2 rounded-full", tick.tone)} />
          ))}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-title text-foreground">{total}</span>
          <span className="text-ui text-muted-foreground">uncommitted here</span>
        </div>
        <div className="flex items-center gap-4 text-ui text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-attention" />
            {modified} modified
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-positive" />
            {added} added
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-muted-foreground/40" />
            {untracked} untracked
          </span>
        </div>
        <ScopeCaption project={project} />
      </div>
    );
  }

  const { added, removed, files } = TICKET.diff;
  const span = added + removed;
  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className="flex h-3 w-80 overflow-hidden rounded-full"
        role="img"
        aria-label={`${added} added, ${removed} removed`}
      >
        <span className="bg-positive" style={{ width: `${(added / span) * 100}%` }} />
        <span className="bg-destructive" style={{ width: `${(removed / span) * 100}%` }} />
      </div>
      <div className="flex items-baseline gap-4">
        <span className="text-title text-positive">+{added}</span>
        <span className="text-title text-destructive">−{removed}</span>
      </div>
      <span className="text-ui text-muted-foreground">{files} files in this worktree</span>
      <ScopeCaption project={project} />
    </div>
  );
}

function EmptyChat({ variant, project }: { variant: Empty; project: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-gutter py-8 text-center">
      {variant === "mark" ? <MarkEmpty /> : null}
      {variant === "field" ? <SessionFieldEmpty project={project} /> : null}
      {variant === "pulse" ? <BoardPulseEmpty project={project} /> : null}
      {variant === "tree" ? <WorkingTreeEmpty project={project} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Info surfaces — PROJECT ONLY. The ticket rail is a non-goal.

function VenueBar() {
  const { modified, added, untracked } = PROJECT.dirty;
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-border px-4 py-2 font-mono text-ui text-muted-foreground">
      <span className="flex items-center gap-1">
        <FolderOpenIcon weight="bold" className="size-3" />
        {PROJECT.path}
      </span>
      <span className="flex items-center gap-1">
        <GitBranchIcon weight="bold" className="size-3" />
        {PROJECT.branch}
      </span>
      <span className="flex items-center gap-1 text-attention">
        <span className="size-2 rounded-full bg-attention" />
        {modified + added + untracked}
      </span>
      <span className="ml-auto">
        {PROJECT.model} · {PROJECT.effort}
      </span>
    </div>
  );
}

function InfoRail() {
  const { modified, added, untracked } = PROJECT.dirty;
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar">
      <section className="flex flex-col gap-2 px-4 py-4">
        <h3 className="text-label uppercase text-muted-foreground">Venue</h3>
        <div className="flex flex-col gap-2 rounded-row border border-border bg-card p-4">
          <p className="truncate font-mono text-ui text-foreground" title={PROJECT.path}>
            {PROJECT.path}
          </p>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 font-mono text-ui text-muted-foreground">
              <GitBranchIcon weight="bold" className="size-3" />
              {PROJECT.branch}
            </span>
            <span className="flex items-center gap-1 text-ui text-attention">
              <span className="size-2 rounded-full bg-attention" />
              {modified + added + untracked}
            </span>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2 px-4 py-4">
        <h3 className="text-label uppercase text-muted-foreground">Session</h3>
        <div className="flex flex-col gap-2">
          {[
            ["Model", PROJECT.model],
            ["Effort", PROJECT.effort],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-2">
              <span className="text-ui text-muted-foreground">{label}</span>
              <span className="text-ui text-foreground">{value}</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui text-muted-foreground">Activity</span>
            <span className="flex items-center gap-1 text-ui text-foreground">
              <StatusDot state="ready" />
              Ready
            </span>
          </div>
        </div>
      </section>

      {/* MENTIONED, not "Touched": the word states the mechanism. A ticket is in
          this list because someone wrote `@vc-nn` in the transcript — which is
          also what makes it a backlink chip in the feed. One taxonomy, two
          surfaces. */}
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

// ---------------------------------------------------------------------------
// Feed — only here to judge the backlink chip inline in running text.

function FeedPreview() {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-6 px-gutter py-8">
      <div className="flex flex-col gap-2">
        <span className="text-label uppercase text-muted-foreground">You</span>
        <p className="text-sm leading-prose text-foreground">
          Fold <MentionChip id="VC-55" column="Todo" /> into{" "}
          <MentionChip id="VC-54" column="Todo" /> where they overlap, and check whether the digest
          half belongs in <MentionChip id="VC-75" column="Backlog" /> instead.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-label uppercase text-muted-foreground">Agent</span>
        <p className="text-sm leading-prose text-foreground">
          The tab-strip half of <MentionChip id="VC-55" column="Todo" /> dissolves into{" "}
          <MentionChip id="VC-54" column="Todo" /> — after Home the two kinds never share a strip.
          The digest is already <MentionChip id="VC-75" column="Backlog" />
          &apos;s.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surface

function Surface({
  project,
  identity,
  info,
  empty,
}: {
  project: boolean;
  identity: Identity;
  info: Info;
  empty: Empty;
}) {
  const tinted = project && identity === "tint";
  const Glyph = project && identity !== "none" ? CompassIcon : ChatCircleIcon;
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
  // Both info surfaces are project-only — the ticket workspace keeps the rail
  // it already has, untouched.
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
            labelClassName={index === activeIndex && tinted ? "text-primary-text" : undefined}
            leading={
              tab.permanent ? (
                <PermanentGlyph weight="bold" className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <Glyph
                  weight="bold"
                  className={cn(
                    "size-3 shrink-0",
                    tinted ? "text-primary-text" : "text-muted-foreground",
                  )}
                />
              )
            }
            onActivate={() => {}}
          />
        ))}
      </TabStrip>

      {project && info === "venue-bar" ? <VenueBar /> : null}

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col",
            tinted &&
              "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-primary/30",
          )}
        >
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
            <EmptyChat variant={empty} project={project} />
          </div>
          <div className="shrink-0 px-4 pb-4">
            <div className="mx-auto flex max-w-content flex-col gap-2 rounded-container border border-border bg-card p-4 shadow-raised">
              <span className="text-sm text-muted-foreground">Message…</span>
              <div className="flex items-center gap-2 text-ui text-muted-foreground">
                <span>{PROJECT.model}</span>
                <span>·</span>
                <span>{PROJECT.effort}</span>
              </div>
            </div>
          </div>
        </div>
        {railOn ? <InfoRail /> : null}
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
  const [identity, setIdentity] = React.useState<Identity>("glyph");
  const [info, setInfo] = React.useState<Info>("rail");
  const [empty, setEmpty] = React.useState<Empty>("field");
  const [view, setView] = React.useState<View>("both");

  return (
    <div className="flex h-svh w-full flex-col bg-rail">
      <div className="flex min-h-0 flex-1 gap-2 p-2 pb-16">
        {view === "feed" ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto rounded-xl border border-border bg-background">
            <FeedPreview />
          </div>
        ) : (
          <>
            {view !== "ticket" ? (
              <Surface project identity={identity} info={info} empty={empty} />
            ) : null}
            {view !== "home" ? (
              <Surface project={false} identity={identity} info={info} empty={empty} />
            ) : null}
          </>
        )}
      </div>

      <div className="fixed bottom-3 left-3 z-[9998] flex max-w-[calc(100vw-14rem)] flex-wrap items-center gap-4 rounded-full border border-border bg-background/90 px-4 py-2 shadow-overlay backdrop-blur">
        <AxisPicker
          label="Identity"
          value={identity}
          options={IDENTITY_LABELS}
          onChange={setIdentity}
        />
        <AxisPicker label="Info" value={info} options={INFO_LABELS} onChange={setInfo} />
        <AxisPicker label="Empty" value={empty} options={EMPTY_LABELS} onChange={setEmpty} />
        <AxisPicker label="View" value={view} options={VIEW_LABELS} onChange={setView} />
        <code className="font-mono text-label text-muted-foreground">
          {identity} / {info} / {empty}
        </code>
      </div>
    </div>
  );
}
