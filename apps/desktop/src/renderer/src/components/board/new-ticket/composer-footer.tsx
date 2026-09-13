import { ComposerAttachButton } from "@renderer/components/attachments/composer-attach-button";
import { OffNote } from "@renderer/components/automations/automation-run-menu";
import type { AutomationGroup } from "@renderer/components/automations/ticket-rail-automations-model";
import { ComposerRunRow, type ComposerRun } from "./composer-run";
import { composerLaunchAction, type ComposerLaunch } from "./composer-launch";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";

/**
 * One commit, with a mode selector beside it. Menu picks configure the next
 * press; they never create a Ticket. Model/effort only describe a chat kickoff:
 * a saved Automation uses its own Runtime, and plain creation uses neither.
 */
export function ComposerFooter({
  projectId,
  onAttachFiles,
  run,
  launch,
  onLaunchChange,
  onSubmit,
  automationOffer,
  disabled,
}: {
  projectId: string;
  onAttachFiles?: (files: readonly File[]) => void;
  run: ComposerRun;
  launch: ComposerLaunch;
  onLaunchChange(launch: ComposerLaunch): void;
  onSubmit(): void;
  automationOffer: {
    groups: readonly AutomationGroup[];
    ready: boolean;
    enabledIds: readonly string[];
  };
  disabled: boolean;
}) {
  const action = composerLaunchAction(launch, projectId, automationOffer);
  const selection =
    launch.kind === "automation" ? `automation:${launch.automationId}` : launch.kind;

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {onAttachFiles === undefined ? null : <ComposerAttachButton onFiles={onAttachFiles} />}
        {launch.kind === "kickoff" ? <ComposerRunRow run={run} /> : null}
        {launch.kind === "automation" ? (
          <span
            role="status"
            className="flex items-center gap-1 px-2 text-ui text-muted-foreground"
          >
            <LightningIcon className="size-3.5 shrink-0" />
            {action.available
              ? "Saved runtime"
              : automationOffer.ready
                ? "Choose an available automation"
                : "Reading automations…"}
          </span>
        ) : null}
      </div>

      <div className="ml-auto flex min-w-0 max-w-full items-center">
        <Button
          data-testid={launch.kind === "kickoff" ? "composer-kickoff" : "composer-submit"}
          onClick={onSubmit}
          disabled={disabled || !action.available}
          aria-label={action.label}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          title={`${action.label} (⌘↵)`}
          className="min-w-0 rounded-r-none"
        >
          <span className="max-w-64 truncate">{action.label}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              aria-label="Choose creation action"
              title="Create only, start chat, or run an Automation"
              data-testid="composer-launch-picker"
              className="shrink-0 rounded-l-none border-l border-primary-foreground/30"
            >
              <CaretDownIcon weight="bold" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-80">
            <DropdownMenuRadioGroup
              value={selection}
              onValueChange={(value) => {
                if (value === "create" || value === "kickoff") onLaunchChange({ kind: value });
                else
                  onLaunchChange({
                    kind: "automation",
                    projectId,
                    automationId: value.slice("automation:".length),
                  });
              }}
            >
              <DropdownMenuRadioItem value="create">
                <PlusIcon />
                Create only
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="kickoff">
                <ChatCircleIcon />
                Start chat
                <DropdownMenuShortcut>⇧⌘↵</DropdownMenuShortcut>
              </DropdownMenuRadioItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Run automation</DropdownMenuLabel>
              <CreateRunAutomationItems {...automationOffer} />
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Cross-column choices remain discoverable before a title has been written. */
export function CreateRunAutomationItems({
  groups,
  enabledIds,
  ready,
}: {
  groups: readonly AutomationGroup[];
  ready: boolean;
  enabledIds: readonly string[];
}) {
  if (!ready || groups.length === 0) {
    return (
      <div className="px-2 py-1 text-ui text-muted-foreground">
        {ready ? "No ticket automations in this project." : "Reading automations…"}
      </div>
    );
  }
  return groups.map((group) => (
    <div key={group.status}>
      <DropdownMenuLabel className="text-label text-muted-foreground">
        {group.label}
        {group.current ? " · this column" : ""}
      </DropdownMenuLabel>
      {group.automations.map((automation) => (
        <DropdownMenuRadioItem key={automation.id} value={`automation:${automation.id}`}>
          <LightningIcon />
          <span className="min-w-0 flex-1 truncate" title={automation.name}>
            {automation.name}
          </span>
          <OffNote automation={automation} enabledIds={enabledIds} />
        </DropdownMenuRadioItem>
      ))}
    </div>
  ));
}
