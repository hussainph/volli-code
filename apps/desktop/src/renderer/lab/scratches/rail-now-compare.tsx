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
 *   4. THE GLANCE, in its three tones.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { UNBOUND_RUN_LABEL } from "@volli/shared";

import { useAutomationRunOffer } from "@renderer/components/automations/automation-run-menu";
import { TicketAutomationsPanel } from "@renderer/components/automations/ticket-rail-automations";
import {
  railAutomationRows,
  type RailAutomationRow,
} from "@renderer/components/automations/ticket-rail-automations-model";
import { RailModeTabs, type RailModeTab } from "@renderer/components/ticket/rail-mode-tabs";
import {
  RAIL_CONTROL,
  RAIL_PANEL_INSET,
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
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import { Button } from "@renderer/components/ui/button";
import { ListRow, ListRowSkeleton } from "@renderer/components/ui/list-row";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { TicketUsageRailFooter } from "@renderer/components/usage/usage-rail";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

import { project, ticketById } from "../fixtures";

export { api, seed } from "./rail-whole";

export const title = "The Now page, compared (VC-406)";
export const note = "The branch beside the proposed order, the worktree glance, the 240px row";
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
 * The offer list with one change: the NAME has a floor and the qualifier
 * yields. At 240px the branch's row prints `Revi… Manual only · Doing` — the
 * qualifier outlives the thing it qualifies, which is the composer's own rule
 * broken on the page under it. Here the name keeps `min-w-24` (ten or so
 * characters — enough to tell "Review every…" from "Merge the PR"), the
 * `Manual only` note leaves the face at narrow and lives in the row's `title`,
 * and the column word — the shorter, more useful qualifier — stays.
 */
function NarrowAutomationRow({
  row,
  switchedOff,
}: {
  row: RailAutomationRow;
  switchedOff: boolean;
}) {
  const qualifier = `${switchedOff ? "Manual only · " : ""}${row.armed ? "Armed" : row.columnLabel}`;
  return (
    <li>
      <ListRow
        aria-label={`Run ${row.automation.name} on this ticket`}
        onActivate={NOOP}
        leading={
          <LightningIcon
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
            {switchedOff ? (
              <span className="group-data-[narrow=true]/rail:hidden">Manual only ·</span>
            ) : null}
            <span className={row.armed ? "text-primary-text" : undefined}>
              {row.armed ? "Armed" : row.columnLabel}
            </span>
          </span>
        }
      />
    </li>
  );
}

/** The proposed block: eyebrow, door, rows. No Run once. */
function AutomationsProposed() {
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

// ─── the scratch ────────────────────────────────────────────────────────────

/**
 * Each strip pushes its own width into the store while it is the one on
 * screen, so the shipping blocks' narrow inset agrees with the frame. Strips
 * are shown one at a time for that reason: two widths in one store is a lie
 * one of the columns would be drawn in.
 */
type Strip = "order" | "floor" | "unread" | "glance";

const STRIPS: { key: Strip; label: string; width: number }[] = [
  { key: "order", label: "1 · The order, 300px", width: RAIL_DEFAULT },
  { key: "floor", label: "2 · The floor, 240px", width: RAIL_FLOOR },
  { key: "unread", label: "3 · Automations while unread", width: RAIL_DEFAULT },
  { key: "glance", label: "4 · The glance, four states", width: RAIL_DEFAULT },
];

export default function NowPageCompared() {
  const [strip, setStrip] = React.useState<Strip>("order");
  const width = STRIPS.find((entry) => entry.key === strip)?.width ?? RAIL_DEFAULT;
  React.useEffect(() => {
    useUiStore.setState({ railWidth: width });
  }, [width]);

  return (
    <TooltipProvider>
      <div className="flex h-svh min-h-0 flex-col gap-4 p-6">
        <div className="flex shrink-0 items-center gap-2">
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
      </div>
    </TooltipProvider>
  );
}

function Row({ children }: React.PropsWithChildren) {
  return <div className="flex min-h-0 flex-1 items-stretch gap-6">{children}</div>;
}

function Labelled({
  label,
  sub,
  children,
}: React.PropsWithChildren<{ label: string; sub: string }>) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
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
