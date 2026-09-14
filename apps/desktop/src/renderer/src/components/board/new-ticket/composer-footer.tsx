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
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";

/**
 * TWO COMMITS AND A CHOOSER, in that order of prominence.
 *
 * Plain **Create** is its own button and always has been the quiet half of the
 * pair. It briefly lived inside the caret menu as "Create only" while the
 * Automation launcher was added, and that was the wrong trade: filing a ticket
 * without starting an agent is not an advanced variant of starting one, it is
 * the other ordinary answer, and burying it behind a dropdown made the common
 * case cost a menu. It is back beside the primary, one press, always visible.
 *
 * What the caret still owns is the one genuinely open-ended choice: WHICH start
 * — chat, or one of the project's saved Automations. That list has no fixed
 * length, so it cannot be buttons, and picking from it only configures the next
 * press. Selecting never creates a Ticket.
 *
 * The three segments are welded into one pill because they are one decision
 * with three answers: all of them create this ticket, and they differ only in
 * what happens next. A gap would read as unrelated actions that happen to sit
 * together.
 *
 * Model/effort only describe a chat kickoff: a saved Automation uses its own
 * Runtime, and plain creation uses neither.
 */
export function ComposerFooter({
  projectId,
  onAttachFiles,
  run,
  launch,
  onLaunchChange,
  onCreate,
  onSubmit,
  automationOffer,
  disabled,
}: {
  projectId: string;
  onAttachFiles?: (files: readonly File[]) => void;
  run: ComposerRun;
  launch: ComposerLaunch;
  onLaunchChange(launch: ComposerLaunch): void;
  /** Plain creation, straight from its own button — never routed through `launch`. */
  onCreate(): void;
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
        {onAttachFiles === undefined ? null : (
          <ComposerAttachButton className="prompt-add" onFiles={onAttachFiles} />
        )}
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
        {/* The quiet half of the pair, and a peer of the primary rather than a
            row inside its menu — but still an OBJECT. `secondary` put a fill
            two steps off the tray's own tint here, which on the dark canvases
            left the word floating with no edge, reading as a label beside the
            real button rather than the other half of the pair. `outline` is
            the same call the composer's Stop key makes for the same reason:
            the hairline is what holds it as a shape. Its right edge doubles as
            the seam, so the primary draws no border on that side. */}
        <Button
          variant="outline"
          data-testid="composer-create"
          onClick={onCreate}
          disabled={disabled}
          aria-label="Create ticket"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          title="Create the ticket without starting any work (⌘↵)"
          className="shrink-0 rounded-r-none"
        >
          {/* No glyph. A `+` here would be the SECOND plus in the row — the Add
              door already owns that mark on this surface — and "Create" needs
              no icon to be read. */}
          Create
        </Button>
        <Button
          data-testid={launch.kind === "kickoff" ? "composer-kickoff" : "composer-submit"}
          onClick={onSubmit}
          disabled={disabled || !action.available}
          aria-label={action.label}
          aria-keyshortcuts="Shift+Meta+Enter Shift+Control+Enter"
          title={`${action.label} (⇧⌘↵)`}
          className="min-w-0 rounded-none"
        >
          <span className="max-w-64 truncate">{action.label}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              aria-label="Choose what starts"
              title="Start chat, or run an Automation"
              data-testid="composer-launch-picker"
              className="shrink-0 rounded-l-none border-l border-primary-foreground/30"
            >
              <CaretDownIcon weight="bold" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-80">
            {/* No "Create only" row: that action is the button to the left of
                this caret. The menu chooses what the PRIMARY starts. */}
            <DropdownMenuRadioGroup
              value={selection}
              onValueChange={(value) => {
                if (value === "kickoff") onLaunchChange({ kind: value });
                else
                  onLaunchChange({
                    kind: "automation",
                    projectId,
                    automationId: value.slice("automation:".length),
                  });
              }}
            >
              {/* No chord badge on the row: ⇧⌘↵ fires whatever this menu has
                  SELECTED, so printing it against one option would be a lie the
                  moment an Automation is chosen. The primary button carries it,
                  because the primary button is what it presses. */}
              <DropdownMenuRadioItem value="kickoff">
                <ChatCircleIcon />
                Start chat
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
