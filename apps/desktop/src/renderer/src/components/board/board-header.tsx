import { ArrowsDownUpIcon } from "@phosphor-icons/react/dist/csr/ArrowsDownUp";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import {
  DEFAULT_SORT_DIRECTION,
  TICKET_SORT_KEYS,
  TICKET_SORT_LABELS,
  type Ticket,
  type TicketFilter,
} from "@volli/shared";

import { FilterBar } from "@renderer/components/board/filter-bar";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";
import {
  DEFAULT_WORKSPACE_UI,
  useWorkspaceStore,
  type BoardView,
} from "@renderer/stores/workspace";

interface BoardHeaderProps {
  projectId: string;
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
          className="h-7 gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground"
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
        "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground",
        view === value && "bg-accent text-foreground",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
      {segment("board", "Board view", KanbanIcon)}
      {segment("list", "List view", ListBulletsIcon)}
    </div>
  );
}

/** Compact board page header: title · count · filter bar · ordering + view controls. */
export function BoardHeader({ projectId, ticketCount, tickets, filter }: BoardHeaderProps) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-3">
      <h2 className="shrink-0 text-sm font-semibold">Board</h2>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{ticketCount}</span>
      <FilterBar projectId={projectId} tickets={tickets} filter={filter} className="ml-4" />
      {/* ml-auto parks the ordering + view cluster on the right so it doesn't
          fight the filter bar as chips wrap onto a second line. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <OrderingMenu projectId={projectId} />
        <ViewToggle projectId={projectId} />
      </div>
    </div>
  );
}
