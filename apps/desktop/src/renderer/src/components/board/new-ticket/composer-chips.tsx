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
 * The composer's metadata row: what the ticket IS on the left — Status,
 * Priority, Labels — and where its work will HAPPEN on the right, as one
 * `base → destination` statement.
 *
 * The split is the point. Everything on the left describes the ticket; the
 * right names the git ground it lands on, and the two never interleave, so the
 * row can be read as two thoughts instead of five controls. All of it is local
 * state — nothing is persisted until the ticket is created.
 *
 * AND IT IS ONE ROW, which it had stopped being. The terminal-harness chip used
 * to sit at the end of the left group; at the composer's own width its ~110px
 * pushed the `base → destination` pair past the wrap, so the row's two thoughts
 * were rendered as two LINES with the second one right-aligned under the first
 * — which reads as a layout accident rather than a split. The chip is gone with
 * the terminal kickoff it described (VC-15/VC-56) and its successor, the model +
 * effort pair, belongs to the ACT of creating rather than to the ticket, so it
 * sits in the footer beside the button that consults it (`composer-footer.tsx`).
 * Keep this row's left group short enough that the pair stays beside it.
 *
 * The branch half arrives as ONE `branch` prop rather than five loose ones.
 * This row does not read or decide anything about a base; passing the pair's
 * state through field by field only gave every future change to it a second
 * place to be spelled out.
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
}: {
  projectId: string;
  status: TicketStatus;
  onStatusChange: (status: TicketStatus) => void;
  priority: TicketPriority;
  onPriorityChange: (priority: TicketPriority) => void;
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  branch: ComposerBranchRowProps;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <StatusChip status={status} onChange={onStatusChange} />
      <PriorityChip priority={priority} onChange={onPriorityChange} />
      <ComposerLabels projectId={projectId} value={labels} onChange={onLabelsChange} />
      <ComposerBranchRow {...branch} />
    </div>
  );
}
