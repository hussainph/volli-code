import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

import { ComposerLabels } from "@renderer/components/board/new-ticket/composer-labels";
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Switch } from "@renderer/components/ui/switch";

/** A rounded-full ghost chip trigger — the composer's quiet metadata affordance. */
function chipClass() {
  return "h-7 gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground";
}

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
        <Button variant="ghost" className={chipClass()}>
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
        <Button variant="ghost" className={chipClass()}>
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
 * The composer's metadata chip row: Status, Priority, Labels, and the Worktree
 * toggle (binds `usesWorktree`, default on). All local-state driven — nothing
 * is persisted until the ticket is created.
 */
export function ComposerChips({
  projectId,
  status,
  onStatusChange,
  priority,
  onPriorityChange,
  labels,
  onLabelsChange,
  usesWorktree,
  onUsesWorktreeChange,
}: {
  projectId: string;
  status: TicketStatus;
  onStatusChange: (status: TicketStatus) => void;
  priority: TicketPriority;
  onPriorityChange: (priority: TicketPriority) => void;
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  usesWorktree: boolean;
  onUsesWorktreeChange: (usesWorktree: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusChip status={status} onChange={onStatusChange} />
      <PriorityChip priority={priority} onChange={onPriorityChange} />
      <ComposerLabels projectId={projectId} value={labels} onChange={onLabelsChange} />
      <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          aria-label="Worktree"
          checked={usesWorktree}
          onCheckedChange={onUsesWorktreeChange}
        />
        Worktree
      </label>
    </div>
  );
}
