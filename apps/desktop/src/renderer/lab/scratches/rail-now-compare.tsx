/**
 * THE NOW PAGE, COMPARED — the branch as it ships beside the orderings and
 * additions the VC-406 review proposed, drawn from the same fixtures in the
 * same frame so the only thing that differs between two columns is the
 * decision under test.
 *
 * Every block that already ships is the real one (`TicketProperties`,
 * `TicketAutomationsPanel`, `TicketSessionsPanel`, `TicketUsageRailFooter`,
 * `RailModeTabs`). What does NOT ship yet is drawn here as a PROTOTYPE and
 * marked as such in its own comment — the worktree glance, the narrow
 * automation row, the unread skeleton. None of it is imported by the app;
 * once a column wins, its prototype is ported into the component it belongs
 * to and this file loses it.
 *
 * Fixtures, stubs and seeding are `rail-whole.tsx`'s, re-exported, so the two
 * scratches can never disagree about what this Ticket holds.
 *
 * Read it top to bottom:
 *   1. THE ORDER, at 300px. A is the branch. B moves the roster up under the
 *      Properties header. C adds the worktree glance as a pinned row over
 *      cost; D adds it as a chip in Properties instead.
 *   2. THE FLOOR, at 240px. A is the branch; B is the reordered page with the
 *      narrow automation row that keeps the NAME and drops the qualifier.
 *   3. THE UNREAD BLOCK. What Automations draws while the rail re-reads (which
 *      is every planning change): the branch's one-line label beside a
 *      skeleton at the list's own height. The loaded list sits between them
 *      so the shift each one causes can be read off the column below.
 *   4. THE GLANCE, in its four states.
 *
 * THE SECOND ROUND (strips 5–7) answers the review of round one:
 *   5. THE REVISION. The footer's two rows open IN the rail rather than in
 *      popovers; the roster is ONE list whose eyebrow folds the record away
 *      and back; the automation row's right edge stops eating its name.
 *   6. PROPERTIES, FOUR WAYS. The chip run beside the same three facts marked
 *      with an eyebrow, drawn as section rows, and drawn as a card.
 *   7. THE AUTOMATION ROW'S RIGHT EDGE. `Manual only · Doing` beside two
 *      shorter ways of saying the same two things.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitCommitIcon } from "@phosphor-icons/react/dist/csr/GitCommit";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { LightningSlashIcon } from "@phosphor-icons/react/dist/csr/LightningSlash";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { ReceiptIcon } from "@phosphor-icons/react/dist/csr/Receipt";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  UNBOUND_RUN_LABEL,
  type SessionUsageScope,
} from "@volli/shared";
import { formatTokens } from "@volli/session-presentation";

import { useAutomationRunOffer } from "@renderer/components/automations/automation-run-menu";
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { NewSessionControl } from "@renderer/components/sessions/new-session-control";
import { TicketAutomationsPanel } from "@renderer/components/automations/ticket-rail-automations";
import {
  railAutomationRows,
  type RailAutomationRow,
} from "@renderer/components/automations/ticket-rail-automations-model";
import { RailModeTabs, type RailModeTab } from "@renderer/components/ticket/rail-mode-tabs";
import { LabelPickerPopover } from "@renderer/components/ticket/label-picker";
import {
  RAIL_CARD_FRAME,
  RAIL_CARD_ROW,
  RAIL_CARD_SEAM,
  RAIL_CONTROL,
  RAIL_PANEL_INSET,
  RAIL_PANEL_MARGIN,
  RailSectionHeadingRow,
} from "@renderer/components/ticket/rail-panel-parts";
import { TicketChangesPanel } from "@renderer/components/ticket/ticket-changes-panel";
import { EMPTY_CHANGE_RECENCY_STATE } from "@renderer/components/ticket/ticket-change-recency";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { TicketRail } from "@renderer/components/ticket/ticket-rail";
import {
  TICKET_RAIL_MODE_LABELS,
  type TicketRailMode,
} from "@renderer/components/ticket/ticket-rail-model";
import { WorktreeStateStrip } from "@renderer/components/ticket/ticket-repository-summary";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { ListRow, ListRowSkeleton } from "@renderer/components/ui/list-row";
import { SECTION_HEADING } from "@renderer/components/ui/section-heading";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { UsageBar } from "@renderer/components/usage/usage-bar";
import {
  UsageBreakdownFact,
  UsageCostFigure,
  UsageRankList,
} from "@renderer/components/usage/usage-card";
import { TicketUsageRailFooter } from "@renderer/components/usage/usage-rail";
import { modelLabel, ticketSessionRows } from "@renderer/components/usage/usage-rail-model";
import { resolveLabelColor } from "@renderer/lib/labels";
import { cn } from "@renderer/lib/utils";
import { formatCachedShare, totalUsageTokens, usageBasisLine } from "@renderer/usage/usage-format";
import { useBoardStore } from "@renderer/stores/board";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { usageKey, useUsageStore } from "@renderer/stores/usage";

import { project, ticketById } from "../fixtures";

export { api, seed } from "./rail-whole";

export const title = "The Now page, compared (VC-406)";
export const note =
  "The branch beside the proposed order; then the folds, the footer disclosures, Properties four ways";
export const viewport = "window" as const;

const RAIL_DEFAULT = 300;
const RAIL_FLOOR = 240;
const TICKET = ticketById("tkt-14");
const ACTIVE_TAB = chatTabId("chat-14a");

const NOOP = () => {};

// ─── the app's own frame and page chrome ────────────────────────────────────

/** `ticket-detail.tsx`'s aside, at the width the column is being judged at. */
function RailFrame({ width, children }: React.PropsWithChildren<{ width: number }>) {
  return (
    <div
      className="relative flex min-h-0 flex-1 shrink-0 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-sidebar"
      style={{ width }}
    >
      {children}
    </div>
  );
}

const MODE_ICONS: Record<TicketRailMode, RailModeTab<TicketRailMode>["icon"]> = {
  now: ChatCircleDotsIcon,
  changes: GitDiffIcon,
  files: FoldersIcon,
  search: MagnifyingGlassIcon,
};
const MODES: RailModeTab<TicketRailMode>[] = (["now", "changes", "files", "search"] as const).map(
  (key) => ({ key, label: TICKET_RAIL_MODE_LABELS[key], icon: MODE_ICONS[key] }),
);

/**
 * `ticket-rail.tsx`'s column, with its Now page's blocks and footer handed in
 * rather than fixed — the ONE thing this scratch has to vary. The group
 * attribute, the pill, the scroller and its floor are the file's own.
 */
function ComposedRail({
  width,
  blocks,
  footer,
}: {
  width: number;
  blocks: React.ReactNode;
  footer: React.ReactNode;
}) {
  const narrow = width <= (RAIL_FLOOR + 300) / 2;
  return (
    <RailFrame width={width}>
      <div
        className="group/rail flex min-h-0 min-w-0 flex-1 flex-col"
        data-narrow={narrow ? "true" : "false"}
      >
        <RailModeTabs
          modes={MODES}
          active="now"
          label="Ticket rail pages"
          idPrefix="compare"
          onSelect={NOOP}
        />
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-8 [scroll-padding-bottom:2rem]">
            {blocks}
          </div>
          {footer}
        </section>
      </div>
    </RailFrame>
  );
}

/** The branch, untouched. */
function ShippedRail({ width }: { width: number }) {
  return (
    <RailFrame width={width}>
      <TicketRail
        projectId={project.id}
        ticket={TICKET}
        creating={false}
        onNewSession={NOOP}
        onNewChat={NOOP}
        onActivateSession={NOOP}
        onActivateChat={NOOP}
        activeTabId={ACTIVE_TAB}
        changesContent={
          <TicketChangesPanel
            ticket={TICKET}
            activeTabId={ACTIVE_TAB}
            recency={EMPTY_CHANGE_RECENCY_STATE}
            onOpenDiff={NOOP}
          />
        }
      />
    </RailFrame>
  );
}

/** The roster with whatever goes between its working set and its record. */
function Sessions({ children }: { children?: React.ReactNode }) {
  return (
    <TicketSessionsPanel
      projectId={project.id}
      ticketId={TICKET.id}
      creating={false}
      onNewSession={NOOP}
      onNewChat={NOOP}
      onActivateSession={NOOP}
      onActivateChat={NOOP}
    >
      {children}
    </TicketSessionsPanel>
  );
}

// ─── PROTOTYPE: the worktree glance ─────────────────────────────────────────

/**
 * The one line of worktree state the resting page lost when the repository
 * card moved to Diffs: where the branch stands. Read only — the button that
 * acts on it stays on Diffs, with the files it acts on. Pressing the line
 * opens that page.
 *
 * TWO facts, not three. The first cut printed the branch AND a two-part
 * phrase (`Uncommitted · 3 to push`), and at 300px the phrase ate the branch
 * down to `volli/VLT…`; at 240px to `vol…`. A glance is ONE fact about the
 * branch, chosen by priority — the thing the reader would have to act on
 * next — in the words `formatWorktreeState` and the checks row already use:
 *
 *   checks failed  >  uncommitted  >  N to push  >  checks running  >
 *   checks passed  >  pushed
 *
 * The rest is on Diffs, one press away. The branch drops the project's own
 * `volli/` scheme prefix: the Ticket id that follows is what identifies it.
 *
 * THE DOT IS QUIET FOR LOCAL STATE. Uncommitted work and unpushed commits are
 * the resting condition of a worktree an agent is working in — a tone that
 * lit for them would be lit nearly always, and a dot that is always amber
 * says nothing. So they take the neutral `idle` dot, and the tones are spent
 * only where something outside the worktree has an opinion: checks passed,
 * checks failed. (The Diffs card's strip keeps its `text-attention` for the
 * same facts; that is a working surface, and this is a glance.)
 */
interface Glance {
  branch: string;
  phrase: string;
  tone: StatusDotState;
}

const BRANCH = "VLT-14-inline-diff-gutter";
/** The fixture's own state: dirty, three ahead. Commit comes first, so it says that. */
const GLANCE_DIRTY: Glance = { branch: BRANCH, phrase: "Uncommitted", tone: "idle" };
const GLANCE_UNPUSHED: Glance = { branch: BRANCH, phrase: "3 to push", tone: "idle" };
const GLANCE_GREEN: Glance = { branch: BRANCH, phrase: "Checks passed", tone: "ready" };
const GLANCE_RED: Glance = { branch: BRANCH, phrase: "2 checks failed", tone: "error" };

/** As a PINNED ROW, over the cost footer — the page's second glance fact. */
function GlanceFooterRow({ glance }: { glance: Glance }) {
  return (
    <button
      type="button"
      aria-label={`Worktree ${glance.branch}: ${glance.phrase}. Open Diffs`}
      className={cn(
        "flex w-full shrink-0 items-center gap-2 border-t border-sidebar-border/70 bg-background/30 py-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/45",
        RAIL_PANEL_INSET,
      )}
    >
      <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-ui text-sidebar-foreground">
        {glance.branch}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
        <StatusDot state={glance.tone} />
        {glance.phrase}
      </span>
    </button>
  );
}

/** As a CHIP in the Properties run — the ticket's fourth fact, where it lives. */
function GlanceChip({ glance }: { glance: Glance }) {
  return (
    <button
      type="button"
      aria-label={`Worktree ${glance.branch}: ${glance.phrase}. Open Diffs`}
      className="flex h-6 min-w-0 max-w-full shrink items-center gap-2 rounded-full border border-sidebar-border bg-background/30 px-2 text-ui text-foreground hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none"
    >
      <StatusDot state={glance.tone} />
      <span className="min-w-0 truncate font-mono">{glance.branch}</span>
    </button>
  );
}

/** Properties with the chip appended to its first row. Drawn here because the
 *  real block's rows are not slots; the chip is the only addition. */
function PropertiesWithChip({ glance }: { glance: Glance }) {
  return (
    <div className="flex flex-col gap-1">
      <TicketProperties projectId={project.id} ticket={TICKET} />
      <div className={cn("flex min-h-6 items-center", RAIL_PANEL_INSET)}>
        <GlanceChip glance={glance} />
      </div>
    </div>
  );
}

// ─── PROTOTYPE: the automation row at the floor ─────────────────────────────

/**
 * Run once is GONE. Stripped to what it does, it minted a chat Session with a
 * typed first message, in the background, wearing the bolt — which is
 * `+ Chat` with a worse text box (a dialog, not the composer) and a Runs
 * history row named "Run once". The block's question is "what SAVED things
 * can this Ticket be made to run", and the rows answer it alone; a one-off is
 * `+ Chat` and typing. That reverses VC-112's "One-time work" ruling on
 * purpose.
 *
 * What is left is the eyebrow, its one control (the door to the page — the
 * same `icon-xs` ghost the branch draws), and the rows. Nothing under the
 * list, so the block ends where its last row does and the roster's History
 * sits one `gap-4` below it.
 */
function AutomationsPageDoor() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-xs" variant="ghost" aria-label="Open Automations">
          <ArrowSquareOutIcon weight="bold" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Open Automations</TooltipContent>
    </Tooltip>
  );
}

/**
 * The row's right edge says TWO things about a record — whether its automatic
 * triggers are off (`Manual only`) and which column offers it (or `Armed`) —
 * and at 300px the pair costs the name half its width: `Review every b…
 * Manual only · Doing`. The name is what a reader presses; the qualifier is
 * what they check. Three ways to spend less on the check:
 *
 *   `words`  the branch: `Manual only · Doing`, hidden at the 240px floor.
 *   `glyph`  the column word alone, and the switched-off fact moves into the
 *            bolt: `LightningSlash` for a record nothing fires by itself.
 *            The bolt already carries armed-vs-not as fill-vs-outline, so the
 *            row's one glyph now says all three states and the right edge
 *            says one thing.
 *   `title`  the column word alone; `Manual only` lives only in the row's
 *            hover title and accessible name.
 *
 * All three keep the name's `min-w-24` floor, so no width can reduce it to
 * `Revi…`.
 */
type OffNoteDrawing = "words" | "glyph" | "title";

function NarrowAutomationRow({
  row,
  switchedOff,
  edge,
}: {
  row: RailAutomationRow;
  switchedOff: boolean;
  edge: OffNoteDrawing;
}) {
  const column = row.armed ? "Armed" : row.columnLabel;
  const qualifier = `${switchedOff ? "Manual only · " : ""}${column}`;
  const Bolt = edge === "glyph" && switchedOff ? LightningSlashIcon : LightningIcon;
  return (
    <li>
      <ListRow
        aria-label={`Run ${row.automation.name} on this ticket${switchedOff ? " (manual only)" : ""}`}
        onActivate={NOOP}
        leading={
          <Bolt
            weight={row.armed ? "fill" : undefined}
            className={cn("size-4 shrink-0", row.armed ? "text-primary" : "text-muted-foreground")}
          />
        }
        primary={
          <span
            className="min-w-24 flex-1 truncate text-ui"
            title={`${row.automation.name} — ${qualifier}`}
          >
            {row.automation.name}
          </span>
        }
        trailing={
          <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
            {edge === "words" && switchedOff ? (
              <span className="group-data-[narrow=true]/rail:hidden">Manual only ·</span>
            ) : null}
            <span className={row.armed ? "text-primary-text" : undefined}>{column}</span>
          </span>
        }
      />
    </li>
  );
}

/** The proposed block: eyebrow, door, rows. No Run once. */
function AutomationsProposed({ edge = "words" }: { edge?: OffNoteDrawing }) {
  const rail = useAutomationRunOffer(project.id, TICKET.status);
  const rows = railAutomationRows(rail);
  return (
    <section className={cn("flex flex-col gap-1", RAIL_PANEL_INSET)} aria-label="Automations">
      <RailSectionHeadingRow label="Automations">
        <AutomationsPageDoor />
      </RailSectionHeadingRow>
      <ul className="max-h-40 overflow-y-auto overscroll-contain">
        {rows.map((row) => (
          <NarrowAutomationRow
            key={row.automation.id}
            row={row}
            switchedOff={row.automation.id !== "automation-implement"}
            edge={edge}
          />
        ))}
      </ul>
    </section>
  );
}

/** The branch's own Run once, kept only for the shipped unread drawing. */
function RunOnceShipped() {
  return (
    <div className="px-2 pt-1">
      <Button variant="outline" size="sm" className={cn(RAIL_CONTROL, "min-w-0 shrink px-2")}>
        <PlayIcon />
        <span>{UNBOUND_RUN_LABEL}…</span>
      </Button>
    </div>
  );
}

// ─── PROTOTYPE: the unread block ────────────────────────────────────────────

/** What the branch draws while the rail re-reads: the eyebrow, one line, the button. */
function AutomationsUnreadShipped() {
  return (
    <section className={cn("flex flex-col gap-1", RAIL_PANEL_INSET)}>
      <RailSectionHeadingRow label="Automations">
        <span className="size-5" />
      </RailSectionHeadingRow>
      <p className="px-2 text-label text-muted-foreground">Reading automations…</p>
      <RunOnceShipped />
    </section>
  );
}

/**
 * The same wait at the list's own height: as many skeleton rows as the cache
 * last held (three here), so the roster under it does not move when the read
 * lands. The one-line label is not wrong about anything except geometry.
 */
function AutomationsUnreadSkeleton({ rows }: { rows: number }) {
  return (
    <section className={cn("flex flex-col gap-1", RAIL_PANEL_INSET)}>
      <RailSectionHeadingRow label="Automations">
        <AutomationsPageDoor />
      </RailSectionHeadingRow>
      <div className="flex flex-col">
        {(["w-2/5", "w-3/4", "w-1/2"] as const).slice(0, rows).map((width) => (
          <ListRowSkeleton key={width} mark primaryWidth={width} trailingWidth="w-12" />
        ))}
      </div>
    </section>
  );
}

// ─── PROTOTYPE: the roster as ONE list, folded ──────────────────────────────

/**
 * Sessions and History were two sections because they are one roster read at
 * two ages, and the page wanted the young rows near the top and the old rows
 * near the bottom. Putting Automations between them bought that order by
 * splitting a component in half. This is the other answer: ONE section, whose
 * eyebrow folds the record away and back.
 *
 * The eyebrow's LABEL is the disclosure — `SESSIONS ›` closed, `SESSIONS ⌄`
 * open — and `+ Chat ▾` stays the row's one control at the right, untouched.
 * The caret follows the word rather than leading it so the eyebrow column
 * stays one straight line down the page; the count of what is folded sits
 * after the caret while it is folded, and goes when the rows are on screen.
 * The rows that were History carry the same trailing they always did (a
 * stamp, or `Stopped · stamp`), which is what tells them apart from the live
 * rows above without a rule between the two.
 *
 * The Calm Stack retired the old History DRAWER — a full-bleed rule, an
 * uppercase trigger with a rotating caret, a collapse animation. This is not
 * that: nothing here bleeds past the section's inset, the closed state still
 * shows the rows that matter, and what folds is the record alone.
 *
 * Drawn by hand over the same `ListRow` + `StatusDot` the real rows use,
 * because the fixture holds one live Session and one dead one and the fold is
 * only worth judging over a roster with a past.
 */
interface RosterRow {
  kind: "chat" | "terminal";
  title: string;
  state: StatusDotState;
  text: string;
}

const LIVE_ROWS: readonly RosterRow[] = [
  {
    kind: "chat",
    title: "Trace the dropped decorations back to the debounce",
    state: "waiting",
    text: "Waiting for you",
  },
  { kind: "terminal", title: "Session 3", state: "idle", text: "Idle" },
];

const PAST_ROWS: readonly RosterRow[] = [
  { kind: "terminal", title: "Session 1", state: "exited", text: "Jan 15" },
  { kind: "chat", title: "Sketch the gutter decoration API", state: "exited", text: "Jan 14" },
  {
    kind: "chat",
    title: "Why the debounce drops decorations",
    state: "stopped",
    text: "Stopped · Jan 12",
  },
  { kind: "terminal", title: "Session 2", state: "exited", text: "Jan 9" },
  { kind: "chat", title: "Plan the inline gutter", state: "exited", text: "Jan 8" },
];

function RosterRowDrawn({ row }: { row: RosterRow }) {
  const Glyph = row.kind === "chat" ? ChatCircleIcon : TerminalWindowIcon;
  return (
    <li>
      <ListRow
        onActivate={NOOP}
        leading={<Glyph className="size-4 shrink-0 text-muted-foreground" />}
        primary={row.title}
        trailing={
          <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
            <StatusDot state={row.state} />
            {row.text}
          </span>
        }
      />
    </li>
  );
}

function SessionsFolded({ open, onToggle }: { open: boolean; onToggle(): void }) {
  return (
    <section className={cn("flex flex-col gap-1", RAIL_PANEL_INSET)} aria-label="Sessions">
      {/* `RailSectionHeadingRow`'s geometry, with the label as a button. */}
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide past sessions" : `Show ${PAST_ROWS.length} past sessions`}
          onClick={onToggle}
          className={cn(
            SECTION_HEADING,
            "flex items-center gap-1 rounded-sm outline-none transition-colors duration-150 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 motion-reduce:transition-none",
          )}
        >
          Sessions
          <CaretRightIcon
            aria-hidden
            weight="bold"
            className={cn(
              "size-2.5 transition-transform duration-150 ease-out motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          {open ? null : <Badge variant="count-pill">{PAST_ROWS.length}</Badge>}
        </button>
        <NewSessionControl
          disabled={false}
          placement="rail"
          align="end"
          shortcuts
          onNewChat={NOOP}
          onNewTerminal={NOOP}
        />
      </div>
      <ul className="flex flex-col gap-1">
        {LIVE_ROWS.map((row) => (
          <RosterRowDrawn key={row.title} row={row} />
        ))}
      </ul>
      {open ? (
        <>
          {/* History's own filter, past four rows — in flow, as before. */}
          <div className="relative my-1">
            <MagnifyingGlassIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Search session history"
              placeholder="Search history…"
              className="h-8 pl-8 text-ui md:text-ui"
            />
          </div>
          <ul className="flex flex-col gap-1">
            {PAST_ROWS.map((row) => (
              <RosterRowDrawn key={row.title} row={row} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

// ─── PROTOTYPE: the footer as two disclosures ───────────────────────────────

/**
 * The footer's two rows opened POPOVERS — the cost row its breakdown, the
 * glance (as first drawn) the Diffs page. Both now open IN the rail: press the
 * row and the body unfolds under it, the row rising to make room, the caret
 * turning to say so. A popover is a window over the page; a body that
 * unfolds under its own row is part of the page, and it stays open while the
 * reader reads the roster above it, which a popover cannot.
 *
 * Header ABOVE body, even at the bottom of the column. The alternative —
 * body unfolding upward, row staying under the pointer — keeps the pointer
 * still but reads bottom-up, and a section that reads bottom-up is the only
 * one on the page that would. The row moves by the body's height, once, and
 * the caret pointing up while open says where it went.
 *
 * The same top rule on both rows and one caret drawing for both: two rows in
 * one footer that open two ways would be two footers.
 */
function FooterDisclosure({
  open,
  onToggle,
  ariaLabel,
  icon: Icon,
  primary,
  trailing,
  testId,
  children,
}: {
  open: boolean;
  onToggle(): void;
  ariaLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  primary: React.ReactNode;
  trailing: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex shrink-0 flex-col border-t border-sidebar-border/70 bg-background/30"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={onToggle}
        className={cn(
          "flex min-h-8 w-full items-center gap-2 py-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/45",
          RAIL_PANEL_INSET,
        )}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        {primary}
        {trailing}
        <CaretDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? children : null}
    </div>
  );
}

/** The fixture's worktree, as the Diffs card reads it: dirty, three ahead, never pushed. */
const WORKTREE = {
  uncommitted: true,
  sequencerActive: false,
  aheadOfBase: 3,
  behindBase: 0,
  unpushed: 3,
};

/**
 * The worktree row, and what unfolds under it: the Diffs card's own body —
 * its three-column state strip (the real one), the CI row when there is a PR
 * (there is not, here), and the publish split. The branch line is not
 * repeated: the row above IS the branch line.
 *
 * This is the card, re-homed. The review's first cut kept the card on Diffs
 * and put a read-only glance here, which left the commit two pages apart
 * from the fact that says it is due. Folded under its own row the whole
 * object fits in the footer, is one press from any scroll position, and Diffs
 * is free to be the change set alone. (Whether the row should then show on
 * every page — it is true of the whole Ticket, like the pill above — is the
 * open question the port has to answer; the cost row is Now's alone.)
 */
function WorktreeFooter({
  glance,
  open,
  onToggle,
}: {
  glance: Glance;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <FooterDisclosure
      open={open}
      onToggle={onToggle}
      ariaLabel={`Worktree ${glance.branch}: ${glance.phrase}. ${open ? "Hide" : "Show"} details`}
      icon={GitBranchIcon}
      primary={
        <span className="min-w-0 flex-1 truncate font-mono text-ui text-sidebar-foreground">
          {glance.branch}
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
          <StatusDot state={glance.tone} />
          {glance.phrase}
        </span>
      }
    >
      <WorktreeStateStrip status={WORKTREE} />
      <div className={cn("flex items-center gap-2 py-2", RAIL_CARD_SEAM, RAIL_PANEL_INSET)}>
        <ButtonGroup aria-label="Publish repository changes" className="min-w-0">
          <Button variant="outline" size="sm" className={cn(RAIL_CONTROL, "min-w-0")}>
            <GitCommitIcon />
            <span className="truncate">Commit &amp; create draft PR</span>
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="More repository actions"
            className={RAIL_CONTROL}
          >
            <DotsThreeIcon weight="bold" />
          </Button>
        </ButtonGroup>
      </div>
    </FooterDisclosure>
  );
}

/**
 * The Ticket's figure over the fixture ledger, read the way
 * `TicketUsageRailFooter` reads it (the same store, the same two groupings),
 * so the breakdown that unfolds is the real `UsageBreakdown` and
 * `UsageRankList` over the real report — only the frame around them is new.
 */
function useTicketUsage() {
  const scope = React.useMemo<SessionUsageScope>(
    () => ({ kind: "ticket", ticketId: TICKET.id }),
    [],
  );
  const bySession = useUsageStore((state) => state.byQuery[usageKey(scope, undefined, "session")]);
  const byModel = useUsageStore((state) => state.byQuery[usageKey(scope, undefined, "model")]);
  const roster = useTicketSessionRecordsStore((state) => state.byTicket[TICKET.id]);
  React.useEffect(() => {
    void useUsageStore.getState().refresh({ scope, groupBy: "session" }, "lab");
    void useUsageStore.getState().refresh({ scope, groupBy: "model" }, "lab");
  }, [scope]);
  if (bySession?.status !== "ready") return null;
  const top = byModel?.status === "ready" ? byModel.report.groups[0] : undefined;
  return {
    summary: bySession.report.total,
    sessions: ticketSessionRows(bySession.report, roster),
    topModelLabel: top === undefined ? null : modelLabel(top.key),
  };
}

/**
 * The cost row, and its body unfolded under it instead of in a popover.
 *
 * NOT the popover's whole body. A popover has no height budget, so it could
 * afford to restate the figure, name the total tokens the row already
 * prints, and spell the bar's four classes out as a legend under it — about
 * 400px, which as an in-rail body pushes the Automations block out of the
 * scroller entirely. Here every line costs the roster a line, so the body
 * keeps what the ROW does not say: the basis sentence, the bar (its legend
 * lives in its accessible name and hover), the cached share, the top model,
 * and the per-Session ranking — about 180px.
 */
function CostFooterFolded({ open, onToggle }: { open: boolean; onToggle(): void }) {
  const usage = useTicketUsage();
  if (usage === null) return null;
  const tokens = totalUsageTokens(usage.summary);
  const basis = usageBasisLine(usage.summary);
  const cached = formatCachedShare(usage.summary);
  return (
    <FooterDisclosure
      open={open}
      onToggle={onToggle}
      ariaLabel={`Ticket usage — ${open ? "hide" : "show"} breakdown`}
      icon={ReceiptIcon}
      primary={
        <UsageCostFigure
          summary={usage.summary}
          className="shrink-0 text-ui font-medium text-foreground"
        />
      }
      trailing={
        <span className="min-w-0 flex-1 truncate text-right text-ui text-muted-foreground tabular-nums">
          {tokens > 0 ? `${formatTokens(tokens)} tokens` : ""}
        </span>
      }
    >
      <div className={cn("flex flex-col gap-3 pt-3 pb-4", RAIL_CARD_SEAM, RAIL_PANEL_INSET)}>
        <div className="flex flex-col gap-2">
          {tokens > 0 ? <UsageBar summary={usage.summary} /> : null}
          {basis === null ? null : <p className="text-ui text-muted-foreground">{basis}</p>}
        </div>
        <div className="flex flex-col gap-2">
          {cached === null ? null : (
            <UsageBreakdownFact label="Cached input share" value={cached} />
          )}
          {usage.topModelLabel === null ? null : (
            <UsageBreakdownFact label="Top model" value={usage.topModelLabel} />
          )}
        </div>
        {usage.sessions.length > 0 ? (
          <UsageRankList heading="By session" rows={usage.sessions} />
        ) : null}
      </div>
    </FooterDisclosure>
  );
}

// ─── PROTOTYPE: Properties, marked, as rows, as a card ──────────────────────

/**
 * The chip run is the one block on Now that is neither of the page's two
 * object kinds. It has no eyebrow, its pills wear a border at rest where
 * every row on the page wears one only under the pointer, and it sets two
 * facts on one line where the page sets one thing per line. Alone it reads
 * as Linear's property strip; under the sections it is the odd block out.
 * Three ways to bring it in:
 *
 *   `marked`   the chips, under a `PROPERTIES` eyebrow — the smallest change.
 *   `rows`     a SECTION: the eyebrow over three `ListRow`s. The row's grammar
 *              is the roster's — a glyph, the thing, a quiet qualifier at the
 *              right — and the THING is the value (`Doing`, `High`, the
 *              labels), because that is what a reader scans for; the field
 *              name is the qualifier. Each row opens the picker the chip did.
 *   `card`     the same three rows in `RAIL_CARD_FRAME` — the repository
 *              card's and Home's costume: seamed rows, a caret at the right.
 *
 * What each costs is height: the chips are ~52px, the rows ~130px. That is
 * the price of one-thing-per-line, and it is paid at the top of a page whose
 * most-read block is under it.
 */
type PropertiesDrawing = "chips" | "marked" | "rows" | "card";

/** The row's right-edge field word, at the roster's qualifier size. */
function FieldWord({ children }: { children: string }) {
  return <span className="shrink-0 text-label text-muted-foreground">{children}</span>;
}

function LabelRun() {
  const projectLabels = useBoardStore((state) => state.labelsByProject[project.id]);
  if (TICKET.labels.length === 0) {
    return <span className="truncate text-ui text-muted-foreground">No labels</span>;
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-ui">
      {TICKET.labels.map((label) => (
        <span key={label} className="flex shrink-0 items-center gap-1">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: resolveLabelColor(projectLabels, label) }}
          />
          {label}
        </span>
      ))}
    </span>
  );
}

/** Status and priority menus — the chips' own, wrapped around a row instead. */
function StatusMenu({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={TICKET.status}>
          {TICKET_STATUSES.map((status) => (
            <DropdownMenuRadioItem key={status} value={status}>
              {TICKET_STATUS_LABELS[status]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityMenu({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={TICKET.priority}>
          {TICKET_PRIORITIES.map((priority) => (
            <DropdownMenuRadioItem key={priority} value={priority}>
              <PriorityIndicator priority={priority} />
              {TICKET_PRIORITY_LABELS[priority]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelsMenu({ children }: { children: React.ReactNode }) {
  return (
    <LabelPickerPopover projectId={project.id} value={TICKET.labels} onChange={NOOP}>
      {children}
    </LabelPickerPopover>
  );
}

/** The three facts as section rows. */
function PropertiesRows() {
  return (
    <section className={cn("flex flex-col gap-1", RAIL_PANEL_INSET)} aria-label="Properties">
      <RailSectionHeadingRow label="Properties" />
      <ul className="flex flex-col">
        <li>
          <StatusMenu>
            <ListRow
              aria-label={`Status: ${TICKET_STATUS_LABELS[TICKET.status]}`}
              onActivate={NOOP}
              leading={<CircleIcon className="size-4 shrink-0 text-muted-foreground" />}
              primary={TICKET_STATUS_LABELS[TICKET.status]}
              trailing={<FieldWord>Status</FieldWord>}
            />
          </StatusMenu>
        </li>
        <li>
          <PriorityMenu>
            <ListRow
              aria-label={`Priority: ${TICKET_PRIORITY_LABELS[TICKET.priority]}`}
              onActivate={NOOP}
              leading={<PriorityIndicator priority={TICKET.priority} />}
              primary={TICKET_PRIORITY_LABELS[TICKET.priority]}
              trailing={<FieldWord>Priority</FieldWord>}
            />
          </PriorityMenu>
        </li>
        <li>
          <LabelsMenu>
            <ListRow
              aria-label="Labels"
              onActivate={NOOP}
              leading={<TagIcon className="size-4 shrink-0 text-muted-foreground" />}
              primary={<LabelRun />}
              trailing={<FieldWord>Labels</FieldWord>}
            />
          </LabelsMenu>
        </li>
      </ul>
    </section>
  );
}

/** One card row's classes: the first pays the frame's top inset, the rest a seam. */
function cardRow(seam: boolean): string {
  return cn(RAIL_CARD_ROW, seam && RAIL_CARD_SEAM, "min-h-8 py-2 hover:bg-accent/50");
}

/** The same three facts as seamed card rows, each with the card's caret. */
function PropertiesCard() {
  return (
    <section className={cn(RAIL_CARD_FRAME, RAIL_PANEL_MARGIN)} aria-label="Properties">
      <StatusMenu>
        <button type="button" className={cn(cardRow(false), "pt-3")}>
          <CircleIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-ui">
            {TICKET_STATUS_LABELS[TICKET.status]}
          </span>
          <FieldWord>Status</FieldWord>
          <CaretDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </StatusMenu>
      <PriorityMenu>
        <button type="button" className={cardRow(true)}>
          <PriorityIndicator priority={TICKET.priority} />
          <span className="min-w-0 flex-1 truncate text-ui">
            {TICKET_PRIORITY_LABELS[TICKET.priority]}
          </span>
          <FieldWord>Priority</FieldWord>
          <CaretDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PriorityMenu>
      <LabelsMenu>
        <button type="button" className={cardRow(true)}>
          <TagIcon className="size-4 shrink-0 text-muted-foreground" />
          <LabelRun />
          <FieldWord>Labels</FieldWord>
          <CaretDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </LabelsMenu>
    </section>
  );
}

function PropertiesDrawn({ drawing }: { drawing: PropertiesDrawing }) {
  switch (drawing) {
    case "chips":
      return <TicketProperties projectId={project.id} ticket={TICKET} />;
    case "marked":
      return (
        <div className="flex flex-col gap-1">
          <div className={RAIL_PANEL_INSET}>
            <RailSectionHeadingRow label="Properties" />
          </div>
          <TicketProperties projectId={project.id} ticket={TICKET} />
        </div>
      );
    case "rows":
      return <PropertiesRows />;
    case "card":
      return <PropertiesCard />;
  }
}

// ─── the columns ────────────────────────────────────────────────────────────

function Properties() {
  return <TicketProperties projectId={project.id} ticket={TICKET} />;
}
/** The branch's block, for the shipped column and the reorder-only column. */
function AutomationsShipped() {
  return <TicketAutomationsPanel projectId={project.id} ticket={TICKET} />;
}
function CostFooter() {
  return <TicketUsageRailFooter ticketId={TICKET.id} />;
}

/** B — the reorder ALONE: the branch's own blocks, roster under the header. */
function ReorderedRail({ width }: { width: number }) {
  return (
    <ComposedRail
      width={width}
      blocks={
        <>
          <Properties />
          <Sessions>
            <AutomationsShipped />
          </Sessions>
        </>
      }
      footer={<CostFooter />}
    />
  );
}

/** C — B, minus Run once, plus the worktree glance pinned over cost. */
function ProposedRail({ width, glance }: { width: number; glance: Glance }) {
  return (
    <ComposedRail
      width={width}
      blocks={
        <>
          <Properties />
          <Sessions>
            <AutomationsProposed />
          </Sessions>
        </>
      }
      footer={
        <>
          <GlanceFooterRow glance={glance} />
          <CostFooter />
        </>
      }
    />
  );
}

/** D — C, with the glance as a Properties chip instead of a pinned row. */
function GlanceChipRail({ width, glance }: { width: number; glance: Glance }) {
  return (
    <ComposedRail
      width={width}
      blocks={
        <>
          <PropertiesWithChip glance={glance} />
          <Sessions>
            <AutomationsProposed />
          </Sessions>
        </>
      }
      footer={<CostFooter />}
    />
  );
}

/**
 * E — the second round, whole: Properties (in whichever drawing), the folded
 * roster, Automations with the short right edge, and the two footer
 * disclosures. Every fold is live — press the eyebrow, press the rows.
 */
function RevisedRail({
  width,
  properties = "chips",
  edge = "glyph",
  sessionsOpen = false,
  worktreeOpen = false,
  costOpen = false,
}: {
  width: number;
  properties?: PropertiesDrawing;
  edge?: OffNoteDrawing;
  sessionsOpen?: boolean;
  worktreeOpen?: boolean;
  costOpen?: boolean;
}) {
  const [sessions, setSessions] = React.useState(sessionsOpen);
  const [worktree, setWorktree] = React.useState(worktreeOpen);
  const [cost, setCost] = React.useState(costOpen);
  return (
    <ComposedRail
      width={width}
      blocks={
        <>
          <PropertiesDrawn drawing={properties} />
          <SessionsFolded open={sessions} onToggle={() => setSessions((value) => !value)} />
          <AutomationsProposed edge={edge} />
        </>
      }
      footer={
        <>
          <WorktreeFooter
            glance={GLANCE_DIRTY}
            open={worktree}
            onToggle={() => setWorktree((value) => !value)}
          />
          <CostFooterFolded open={cost} onToggle={() => setCost((value) => !value)} />
        </>
      }
    />
  );
}

// ─── the scratch ────────────────────────────────────────────────────────────

/**
 * Each strip pushes its own width into the store while it is the one on
 * screen, so the shipping blocks' narrow inset agrees with the frame. Strips
 * are shown one at a time for that reason: two widths in one store is a lie
 * one of the columns would be drawn in.
 */
type Strip = "order" | "floor" | "unread" | "glance" | "revision" | "properties" | "edge";

const STRIPS: { key: Strip; label: string; width: number }[] = [
  { key: "order", label: "1 · The order, 300px", width: RAIL_DEFAULT },
  { key: "floor", label: "2 · The floor, 240px", width: RAIL_FLOOR },
  { key: "unread", label: "3 · Automations while unread", width: RAIL_DEFAULT },
  { key: "glance", label: "4 · The glance, four states", width: RAIL_DEFAULT },
  { key: "revision", label: "5 · The revision", width: RAIL_DEFAULT },
  { key: "properties", label: "6 · Properties, four ways", width: RAIL_DEFAULT },
  { key: "edge", label: "7 · The row's right edge", width: RAIL_DEFAULT },
];

export default function NowPageCompared() {
  const [strip, setStrip] = React.useState<Strip>("revision");
  const width = STRIPS.find((entry) => entry.key === strip)?.width ?? RAIL_DEFAULT;
  React.useEffect(() => {
    useUiStore.setState({ railWidth: width });
  }, [width]);

  return (
    <TooltipProvider>
      <div className="flex min-h-svh flex-col gap-4 p-6">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {STRIPS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setStrip(entry.key)}
              className={
                entry.key === strip
                  ? "rounded-md bg-accent px-3 py-1 font-mono text-ui text-accent-foreground"
                  : "rounded-md px-3 py-1 font-mono text-ui text-muted-foreground hover:bg-accent/40"
              }
            >
              {entry.label}
            </button>
          ))}
        </div>

        {strip === "order" ? (
          <Row>
            <Labelled label="A · As shipped" sub="Properties · Automations · Sessions · History">
              <ShippedRail width={width} />
            </Labelled>
            <Labelled label="B · Roster up" sub="the reorder alone; the branch's own blocks">
              <ReorderedRail width={width} />
            </Labelled>
            <Labelled label="C · Proposed" sub="no Run once · worktree glance pinned over cost">
              <ProposedRail width={width} glance={GLANCE_DIRTY} />
            </Labelled>
            <Labelled label="D · Glance as a chip" sub="C, with the branch as a fourth Property">
              <GlanceChipRail width={width} glance={GLANCE_DIRTY} />
            </Labelled>
          </Row>
        ) : null}

        {strip === "floor" ? (
          <Row>
            <Labelled label="A · As shipped, 240px" sub="the qualifier outlives the name">
              <ShippedRail width={width} />
            </Labelled>
            <Labelled
              label="C · Proposed, 240px"
              sub="name keeps a floor; 'Manual only' leaves the face"
            >
              <ProposedRail width={width} glance={GLANCE_DIRTY} />
            </Labelled>
          </Row>
        ) : null}

        {strip === "unread" ? (
          <Row>
            <Labelled label="Loaded" sub="the proposed block at rest">
              <ComposedRail
                width={width}
                blocks={
                  <>
                    <Properties />
                    <Sessions>
                      <AutomationsProposed />
                    </Sessions>
                  </>
                }
                footer={<CostFooter />}
              />
            </Labelled>
            <Labelled label="Unread · as shipped" sub="one line; the roster jumps when it lands">
              <ComposedRail
                width={width}
                blocks={
                  <>
                    <Properties />
                    <Sessions>
                      <AutomationsUnreadShipped />
                    </Sessions>
                  </>
                }
                footer={<CostFooter />}
              />
            </Labelled>
            <Labelled label="Unread · skeleton" sub="the list's own height; nothing under it moves">
              <ComposedRail
                width={width}
                blocks={
                  <>
                    <Properties />
                    <Sessions>
                      <AutomationsUnreadSkeleton rows={3} />
                    </Sessions>
                  </>
                }
                footer={<CostFooter />}
              />
            </Labelled>
          </Row>
        ) : null}

        {strip === "glance" ? (
          <Row>
            <Labelled label="Dirty" sub="the fixture's own state — commit comes first">
              <ProposedRail width={width} glance={GLANCE_DIRTY} />
            </Labelled>
            <Labelled label="Clean, unpushed" sub="the next act is a push">
              <ProposedRail width={width} glance={GLANCE_UNPUSHED} />
            </Labelled>
            <Labelled label="PR open, checks green" sub="nothing to do here">
              <ProposedRail width={width} glance={GLANCE_GREEN} />
            </Labelled>
            <Labelled label="PR open, checks red" sub="the one that needs you">
              <ProposedRail width={width} glance={GLANCE_RED} />
            </Labelled>
          </Row>
        ) : null}

        {strip === "revision" ? (
          <Row>
            <Labelled label="E · At rest" sub="one roster, folded · two footer rows, closed">
              <RevisedRail width={width} />
            </Labelled>
            <Labelled
              label="E · Sessions open"
              sub="the eyebrow unfolds the record under the live rows"
            >
              <RevisedRail width={width} sessionsOpen />
            </Labelled>
            <Labelled label="E · Worktree open" sub="the Diffs card's body, under its own row">
              <RevisedRail width={width} worktreeOpen />
            </Labelled>
            <Labelled label="E · Cost open" sub="what the row does not already say, under it">
              <RevisedRail width={width} costOpen />
            </Labelled>
          </Row>
        ) : null}

        {strip === "properties" ? (
          <Row>
            <Labelled label="Chips" sub="as shipped — no eyebrow, bordered at rest">
              <RevisedRail width={width} properties="chips" />
            </Labelled>
            <Labelled label="Chips, marked" sub="the same run under a PROPERTIES eyebrow">
              <RevisedRail width={width} properties="marked" />
            </Labelled>
            <Labelled label="Rows" sub="a section: glyph, value, field word — the roster's grammar">
              <RevisedRail width={width} properties="rows" />
            </Labelled>
            <Labelled label="Card" sub="the same rows in the repository card's frame">
              <RevisedRail width={width} properties="card" />
            </Labelled>
          </Row>
        ) : null}

        {strip === "edge" ? (
          <Row>
            <Labelled label="Words" sub="`Manual only · Doing` — the branch's right edge">
              <RevisedRail width={width} edge="words" />
            </Labelled>
            <Labelled label="Glyph" sub="column word only; a slashed bolt says 'manual only'">
              <RevisedRail width={width} edge="glyph" />
            </Labelled>
            <Labelled label="Title" sub="column word only; 'manual only' in the hover title">
              <RevisedRail width={width} edge="title" />
            </Labelled>
          </Row>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

/**
 * Columns wrap rather than clip, so a narrow window still reaches every one
 * by scrolling down; each stands at a fixed height that is a realistic rail
 * (the app's window is rarely taller than ~900px).
 */
function Row({ children }: React.PropsWithChildren) {
  return <div className="flex flex-wrap items-start gap-6">{children}</div>;
}

function Labelled({
  label,
  sub,
  children,
}: React.PropsWithChildren<{ label: string; sub: string }>) {
  return (
    <div className="flex h-[840px] min-h-0 flex-col gap-2">
      <div className="flex flex-col">
        <span className="font-mono text-caption tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <span className="text-ui text-muted-foreground/70">{sub}</span>
      </div>
      {children}
    </div>
  );
}
