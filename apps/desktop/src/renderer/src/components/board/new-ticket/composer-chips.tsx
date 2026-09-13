import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

import {
  ComposerBranchRow,
  type ComposerBranchRowProps,
} from "@renderer/components/board/new-ticket/composer-branch";
import { composerChipClass } from "@renderer/components/board/new-ticket/composer-chip";
import { ComposerLabels } from "@renderer/components/board/new-ticket/composer-labels";
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Switch } from "@renderer/components/ui/switch";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";

function StatusChip({
  status,
  onChange,
}: {
  status: TicketStatus;
  onChange: (status: TicketStatus) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={composerChipClass()}>
          {TICKET_STATUS_LABELS[status]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={status}
          onValueChange={(value) => onChange(value as TicketStatus)}
        >
          {TICKET_STATUSES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {TICKET_STATUS_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityChip({
  priority,
  onChange,
}: {
  priority: TicketPriority;
  onChange: (priority: TicketPriority) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={composerChipClass()}>
          {/* aria-hidden: the indicator already carries a "Priority: X" label,
              which would pollute the chip/option's accessible name (its own
              text label is the name that matters). */}
          <span aria-hidden className="flex items-center">
            <PriorityIndicator priority={priority} />
          </span>
          {TICKET_PRIORITY_LABELS[priority]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={priority}
          onValueChange={(value) => onChange(value as TicketPriority)}
        >
          {TICKET_PRIORITIES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              <span aria-hidden className="flex items-center">
                <PriorityIndicator priority={option} />
              </span>
              {TICKET_PRIORITY_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Ticket metadata stays on the canvas; working-copy and batch-entry settings
 * are secondary, behind Options. Non-default checkout/batch choices remain
 * visible on the closed trigger so hidden settings cannot become surprises.
 */
export function ComposerChips({
  projectId,
  status,
  onStatusChange,
  priority,
  onPriorityChange,
  labels,
  onLabelsChange,
  branch,
  createMore,
  onCreateMoreChange,
}: {
  projectId: string;
  status: TicketStatus;
  onStatusChange: (status: TicketStatus) => void;
  priority: TicketPriority;
  onPriorityChange: (priority: TicketPriority) => void;
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  branch: ComposerBranchRowProps;
  createMore: boolean;
  onCreateMoreChange(createMore: boolean): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <StatusChip status={status} onChange={onStatusChange} />
      <PriorityChip priority={priority} onChange={onPriorityChange} />
      <ComposerLabels projectId={projectId} value={labels} onChange={onLabelsChange} />
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Ticket options"
            className="ml-auto text-muted-foreground"
          >
            <SlidersHorizontalIcon />
            {branch.usesWorktree ? "Options" : "Project checkout"}
            {createMore ? " · Create more" : ""}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-80 p-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <span className="text-ui font-medium">Working copy</span>
              <div className="flex">
                <ComposerBranchRow {...branch} />
              </div>
            </div>
            <label className="flex items-center justify-between gap-2 border-t border-border pt-4 text-ui">
              Create more
              <Switch
                aria-label="Create more"
                checked={createMore}
                onCheckedChange={onCreateMoreChange}
              />
            </label>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
