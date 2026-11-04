import { useId } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { PlayCircleIcon } from "@phosphor-icons/react/dist/csr/PlayCircle";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

import {
  BaseBranchChip,
  type ComposerBranchRowProps,
} from "@renderer/components/board/new-ticket/composer-branch";
import { composerChipClass } from "@renderer/components/board/new-ticket/composer-chip";
import { ComposerLabels } from "@renderer/components/board/new-ticket/composer-labels";
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { RepeatIcon } from "@phosphor-icons/react/dist/csr/Repeat";
import { MENU_SEPARATOR } from "@renderer/components/ui/menu-classes";
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

const STATUS_ICON = {
  backlog: TrayIcon,
  todo: ListChecksIcon,
  doing: PlayCircleIcon,
  needs_review: EyeIcon,
  done: CheckCircleIcon,
};

function StatusChip({
  status,
  onChange,
}: {
  status: TicketStatus;
  onChange: (status: TicketStatus) => void;
}) {
  const Icon = STATUS_ICON[status];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="inspector"
          aria-label={`Status: ${TICKET_STATUS_LABELS[status]}`}
          className={composerChipClass()}
        >
          <Icon aria-hidden className="text-primary-text" />
          {TICKET_STATUS_LABELS[status]}
          <CaretDownIcon aria-hidden weight="bold" className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={status}
          onValueChange={(value) => onChange(value as TicketStatus)}
        >
          {TICKET_STATUSES.map((option) => {
            const OptionIcon = STATUS_ICON[option];
            return (
              <DropdownMenuRadioItem key={option} value={option}>
                <OptionIcon aria-hidden />
                {TICKET_STATUS_LABELS[option]}
              </DropdownMenuRadioItem>
            );
          })}
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
        <Button
          variant="inspector"
          aria-label={`Priority: ${TICKET_PRIORITY_LABELS[priority]}`}
          className={composerChipClass()}
        >
          {/* aria-hidden: the indicator already carries a "Priority: X" label,
              which would pollute the chip/option's accessible name (its own
              text label is the name that matters). */}
          <span aria-hidden className="flex items-center">
            <PriorityIndicator priority={priority} />
          </span>
          {TICKET_PRIORITY_LABELS[priority]}
          <CaretDownIcon aria-hidden weight="bold" className="size-3 text-muted-foreground" />
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
  const workingCopyName = useId();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <StatusChip status={status} onChange={onStatusChange} />
      <PriorityChip priority={priority} onChange={onPriorityChange} />
      <ComposerLabels projectId={projectId} value={labels} onChange={onLabelsChange} />
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            aria-label="Ticket options"
            className="ml-auto text-muted-foreground"
          >
            <SlidersHorizontalIcon />
            {branch.usesWorktree ? "Options" : "Project checkout"}
            {createMore ? " · Create more" : ""}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-80 rounded-menu p-1">
          <fieldset className="min-w-0">
            <legend className="px-2 py-1 text-ui font-semibold">Working copy</legend>
            {[true, false].map((worktree) => {
              const Icon = worktree ? GitBranchIcon : FolderOpenIcon;
              return (
                <label
                  key={String(worktree)}
                  className="relative flex cursor-default select-none items-center gap-2 rounded-menu-item px-2 py-2 has-[:checked]:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                >
                  <input
                    type="radio"
                    name={workingCopyName}
                    className="sr-only"
                    checked={branch.usesWorktree === worktree}
                    onChange={() => branch.onUsesWorktreeChange(worktree)}
                  />
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-ui font-medium">
                      {worktree ? "New worktree" : "Project checkout"}
                    </span>
                  </span>
                  {branch.usesWorktree === worktree ? (
                    <CheckIcon aria-hidden weight="bold" className="size-3.5 shrink-0" />
                  ) : null}
                </label>
              );
            })}
          </fieldset>
          {branch.usesWorktree ? (
            <div className="flex min-w-0 items-center gap-2 px-2 py-2">
              <span className="shrink-0 text-ui font-medium text-muted-foreground">
                Branch from
              </span>
              <BaseBranchChip
                state={branch.state}
                value={branch.baseBranch}
                onChange={branch.onBaseBranchChange}
              />
            </div>
          ) : null}
          <div className={MENU_SEPARATOR} />
          <label className="flex items-center gap-2 px-2 py-2">
            <RepeatIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-ui font-medium">Create more</span>
            </span>
            <Switch
              aria-label="Create more"
              checked={createMore}
              onCheckedChange={onCreateMoreChange}
            />
          </label>
        </PopoverContent>
      </Popover>
    </div>
  );
}
