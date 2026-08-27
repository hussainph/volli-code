import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowsDownUpIcon } from "@phosphor-icons/react/dist/csr/ArrowsDownUp";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import {
  DEFAULT_SORT_DIRECTION,
  TICKET_SORT_KEYS,
  TICKET_SORT_LABELS,
  type Ticket,
  type TicketFilter,
} from "@volli/shared";

import { ArchiveDialog } from "@renderer/components/board/archive-dialog";
import { boardSummary } from "@renderer/components/board/board-summary";
import { FilterBar } from "@renderer/components/board/filter-bar";
import { useBoardSessionActivityMap } from "@renderer/components/board/session-activity-context";
import { PageHeader } from "@renderer/components/layout/page-header";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";
import {
  DEFAULT_WORKSPACE_UI,
  useWorkspaceStore,
  type BoardView,
} from "@renderer/stores/workspace";

interface BoardHeaderProps {
  projectId: string;
  /** Tickets on screen now, and what the board holds behind the filter. */
  ticketCount: number;
  /** Unfiltered — passed through to the filter bar for facet options. */
  tickets: readonly Ticket[];
  filter: TicketFilter;
}

/**
 * Ordering dropdown: pick one of the five sort keys (each seeds its natural
 * direction), then flip Asc/Desc. Direction is meaningless for manual (the
 * drag order is one-directional), so those items disable there.
 */
function OrderingMenu({ projectId }: { projectId: string }) {
  const sort = useWorkspaceStore(
    (state) => state.byProject[projectId]?.boardSort ?? DEFAULT_WORKSPACE_UI.boardSort,
  );
  const setBoardSort = useWorkspaceStore((state) => state.setBoardSort);
  const isManual = sort.key === "manual";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="gap-1 border border-border px-2 text-ui text-muted-foreground"
        >
          <ArrowsDownUpIcon className="size-3.5" />
          {TICKET_SORT_LABELS[sort.key]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={sort.key}
          onValueChange={(key) => {
            // Picking a key resets to its natural direction; the user can then
            // flip it below. `key` is one of TICKET_SORT_KEYS by construction.
            const nextKey = key as (typeof TICKET_SORT_KEYS)[number];
            setBoardSort(projectId, { key: nextKey, direction: DEFAULT_SORT_DIRECTION[nextKey] });
          }}
        >
          {TICKET_SORT_KEYS.map((key) => (
            <DropdownMenuRadioItem key={key} value={key}>
              {TICKET_SORT_LABELS[key]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={sort.direction}
          onValueChange={(direction) =>
            setBoardSort(projectId, { ...sort, direction: direction as "asc" | "desc" })
          }
        >
          <DropdownMenuRadioItem value="asc" disabled={isManual}>
            Ascending
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="desc" disabled={isManual}>
            Descending
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Two-segment board/list toggle; the active segment mirrors the filter chips' active state. */
function ViewToggle({ projectId }: { projectId: string }) {
  const view = useWorkspaceStore(
    (state) => state.byProject[projectId]?.boardView ?? DEFAULT_WORKSPACE_UI.boardView,
  );
  const setBoardView = useWorkspaceStore((state) => state.setBoardView);

  const segment = (value: BoardView, label: string, Icon: typeof KanbanIcon) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={view === value}
      onClick={() => setBoardView(projectId, value)}
      className={cn(
        // Button-primitive idiom (ui/button.tsx): press/focus feedback for a
        // hand-rolled control, segmented look unchanged at rest. `scale` is
        // named in the transition list and cancelled by `scale-100!` under
        // reduced motion for the reason spelled out there.
        "flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-[color,transform,scale,box-shadow] duration-150 ease-out hover:text-foreground active:scale-[0.97] motion-reduce:scale-100! focus-visible:ring-2 focus-visible:ring-ring/45",
        view === value && "bg-accent text-foreground",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );

  return (
    <div className="flex items-center gap-1 rounded-lg border border-border p-1">
      {segment("board", "Board view", KanbanIcon)}
      {segment("list", "List view", ListBulletsIcon)}
    </div>
  );
}

/**
 * Compact board page header: what the board holds and what it is doing · filter
 * bar · ordering + view controls.
 *
 * The title is `sr-only` (see the `titleHidden` note below), so the summary is
 * what actually opens this row — see `board-summary.ts` for what it says and
 * why the live half ignores the filter.
 */
export function BoardHeader({ projectId, ticketCount, tickets, filter }: BoardHeaderProps) {
  // The Archive dialog's one entry point is the button below, so its open
  // state lives here (not in the ui store — no hotkey or second surface needs
  // it, unlike the New-ticket dialog's app-wide "c" shortcut).
  const [archiveOpen, setArchiveOpen] = React.useState(false);

  return (
    <PageHeader
      title="Board"
      // Named by the permanent tab directly above this row (VC-54), so the word
      // stays in the outline and leaves the screen — the two are one object at
      // one scope, and it only has one name.
      titleHidden
      actions={
        <>
          <OrderingMenu projectId={projectId} />
          <ViewToggle projectId={projectId} />
          {/* The Archive is a per-project view, not a sixth column (CONCEPT #92) —
              reached from here and only here. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Archive"
            className="border border-border text-muted-foreground"
            onClick={() => setArchiveOpen(true)}
          >
            <ArchiveIcon className="size-3.5" />
          </Button>
          <ArchiveDialog open={archiveOpen} onOpenChange={setArchiveOpen} />
          {/* The prominent, always-reachable create entry point — the column
              composers (board-column.tsx) hide at the bottom of long columns,
              so this + the plain "c" hotkey (use-new-ticket-shortcut.ts) are
              the discoverable ways in. Default variant (not ghost/outline like
              the chips around it) so it visibly pops. Accessible name is "New
              ticket", not bare "New" — the column composers' buttons are named
              "New" and the e2e smoke matches both with exact:true. */}
          <Button
            className="gap-1 px-2 text-ui"
            onClick={() => useUiStore.getState().setNewTicketOpen(true)}
          >
            <PlusIcon className="size-3.5" />
            New ticket
          </Button>
        </>
      }
    >
      <BoardSummary visible={ticketCount} total={tickets.length} />
      <FilterBar projectId={projectId} tickets={tickets} filter={filter} className="ml-4" />
    </PageHeader>
  );
}

/**
 * The row's opening statement: how much is here, and how much of it is moving.
 *
 * The two halves are separated by the app's own middot rather than boxed apart:
 * they are one reading of one board, and a second chip would read as a second
 * object. Each half draws only when it has something to say — a board with
 * nothing running says nothing about it, which is what makes the dots mean
 * something when they do appear.
 */
function BoardSummary({ visible, total }: { visible: number; total: number }) {
  // Read here rather than taken as a prop from `BoardHeader`, so an agent's
  // output re-renders this one span instead of the whole header row — and, far
  // more importantly, never the board. See session-activity-context.tsx.
  const activityByTicket = useBoardSessionActivityMap();
  const summary = boardSummary({ visible, total, activityByTicket });
  const live = summary.working + summary.waiting > 0;
  if (summary.count === null && !live) return null;

  return (
    <span className="flex items-center gap-2">
      {summary.count === null ? null : <Badge variant="count">{summary.count}</Badge>}
      {live ? (
        <span className="flex items-center gap-2 text-ui text-muted-foreground">
          <span aria-hidden>·</span>
          {/* Waiting leads working, the precedence every surface in the app
              gives it: an agent that has stopped to ask something is the one
              thing here a person can act on. */}
          {summary.waiting > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex cursor-default items-center gap-1 tabular-nums">
                  <StatusDot state="waiting" />
                  {summary.waiting} needs you
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {summary.waiting} {summary.waiting === 1 ? "ticket needs" : "tickets need"} your
                input
              </TooltipContent>
            </Tooltip>
          ) : null}
          {summary.working > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex cursor-default items-center gap-1 tabular-nums">
                  <StatusDot state="working" />
                  {summary.working} working
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {summary.working} {summary.working === 1 ? "ticket has" : "tickets have"} an active
                agent
              </TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
