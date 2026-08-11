import type { HarnessId, WorktreeBranchListing } from "@volli/shared";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

import { ComposerBranchRow } from "@renderer/components/board/new-ticket/composer-branch";
import { composerChipClass } from "@renderer/components/board/new-ticket/composer-chip";
import { ComposerHarnessChip } from "@renderer/components/board/new-ticket/composer-harness";
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
 * Priority, Labels, the terminal harness — and where its work will HAPPEN on
 * the right, as one `base → destination` statement.
 *
 * The split is the point. Everything on the left describes the ticket; the
 * right names the git ground it lands on, and the two never interleave, so the
 * row can be read as two thoughts instead of six controls. All of it is local
 * state — nothing is persisted until the ticket is created.
 */
export function ComposerChips({
  projectId,
  status,
  onStatusChange,
  priority,
  onPriorityChange,
  labels,
  onLabelsChange,
  harnessId,
  onHarnessChange,
  branchListing,
  branchError,
  baseBranch,
  onBaseBranchChange,
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
  harnessId: HarnessId;
  onHarnessChange: (harnessId: HarnessId) => void;
  branchListing: WorktreeBranchListing | null;
  branchError: string | null;
  baseBranch: string | null;
  onBaseBranchChange: (branch: string) => void;
  usesWorktree: boolean;
  onUsesWorktreeChange: (usesWorktree: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusChip status={status} onChange={onStatusChange} />
      <PriorityChip priority={priority} onChange={onPriorityChange} />
      <ComposerLabels projectId={projectId} value={labels} onChange={onLabelsChange} />
      <ComposerHarnessChip harnessId={harnessId} onChange={onHarnessChange} />
      <ComposerBranchRow
        listing={branchListing}
        error={branchError}
        baseBranch={baseBranch}
        onBaseBranchChange={onBaseBranchChange}
        usesWorktree={usesWorktree}
        onUsesWorktreeChange={onUsesWorktreeChange}
      />
    </div>
  );
}
