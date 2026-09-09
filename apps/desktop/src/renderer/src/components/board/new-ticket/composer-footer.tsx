import { ComposerAttachButton } from "@renderer/components/attachments/composer-attach-button";
import { OffNote } from "@renderer/components/automations/automation-run-menu";
import type { AutomationGroup } from "@renderer/components/automations/ticket-rail-automations-model";
import {
  ComposerRunRow,
  type ComposerRun,
} from "@renderer/components/board/new-ticket/composer-run";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Switch } from "@renderer/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";

/**
 * The composer's bottom rail: one attachment affordance, what a kickoff will
 * RUN on the left, a "Create more" toggle, and the ways to commit — the
 * secondary "Create", the primary "Create & start", and (VC-329 item 4) the
 * named "Create & run" action, whose menu runs a SAVED Automation on the
 * ticket the commit creates (`data-testid="composer-run-automation"`).
 *
 * ONE ROW FOR THE RUN, AND IT IS THIS ONE. The model and effort pills sit here
 * rather than up in the metadata row because of what the two rows are ABOUT:
 * the metadata row describes the ticket (status, priority, labels, the branch
 * it lands on) and this one is the act of creating it. Model and effort belong
 * to the act — they are only consulted if you press the right-hand button — and
 * putting them here is also what un-wraps the row above, which had been
 * spilling the branch pair onto a second line since the harness chip joined it.
 *
 * The two commits are welded into one pill rather than spaced apart, because
 * they are one decision with two answers: both create this ticket, and only one
 * of them also starts an agent. Butting them together says that; a gap would
 * have made them look like unrelated actions that happen to sit side by side.
 * They stay two separate buttons — each is one press, neither hides behind a
 * caret.
 *
 * THE TOOLTIPS ARE THE ONE EXCEPTION to "let controls talk" this surface takes,
 * and they are one clause each. "Create" and "Create & start" are not
 * self-evident as a PAIR — the difference between them is invisible in the
 * words, and the first external user hit exactly that — so each names what it
 * does and the chord that does it, and neither explains anything else.
 *
 * Each trigger is a `span` around its button rather than the button itself,
 * which is not decoration: an empty title disables both buttons, `Button`
 * carries `disabled:pointer-events-none`, and a disabled control dispatches no
 * pointer events — so the labels would be missing at the one moment a
 * first-timer is reading the footer and has typed nothing yet. The wrapper is
 * the hover target; focus still reaches the button and still opens the label,
 * because React's synthetic focus bubbles to it.
 *
 * The pair carries its own {@link TooltipProvider} rather than borrowing one.
 * There IS one overhead in the app — `SidebarProvider` mounts it, and the
 * composer happens to render inside that — but Radix throws outright when the
 * context is missing, so "the sidebar happens to be an ancestor" was the whole
 * of what kept a modal dialog from crashing its own subtree. It is not a
 * relationship either component states, and the lab found it the first time the
 * composer was mounted without the shell around it. Providers nest, so owning
 * one costs nothing and the delay stays the house's (500ms — an extended hover,
 * never a twitch).
 */
export function ComposerFooter({
  onAttachFiles,
  run,
  createMore,
  onCreateMoreChange,
  onCreate,
  onKickoff,
  automationRun,
  disabled,
}: {
  /** Attach images/files from anywhere on disk (VC-50). */
  onAttachFiles?: (files: readonly File[]) => void;
  /** The model + effort a kickoff will run on — see {@link ComposerRunRow}. */
  run: ComposerRun;
  createMore: boolean;
  onCreateMoreChange: (createMore: boolean) => void;
  onCreate: () => void;
  onKickoff: () => void;
  /**
   * The saved-automation commit (VC-329 item 4): a named action whose menu
   * lists the project's SAVED Automations, grouped and labelled by column.
   * Choosing one creates the ticket in the chip's status — never moved to make
   * a column match — and runs that Automation on it, through the same service
   * every other hand-run door uses. Not a rewritten prompt: the record is the
   * definition of the work, and the record is what runs.
   */
  automationRun: {
    groups: readonly AutomationGroup[];
    ready: boolean;
    enabledIds: readonly string[];
    onRun(automation: { id: string; name: string }): void;
  };
  disabled: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {/* One paperclip: images and files from anywhere. Project files are not a
          second icon — typing `@` in the description completes against the same
          file index (VC-115). */}
      {onAttachFiles === undefined ? null : <ComposerAttachButton onFiles={onAttachFiles} />}
      <ComposerRunRow run={run} />

      <label className="ml-auto flex shrink-0 items-center gap-2 text-ui text-muted-foreground">
        <Switch
          aria-label="Create more"
          checked={createMore}
          onCheckedChange={onCreateMoreChange}
        />
        Create more
      </label>

      {/* No `overflow-hidden` on the group: each half keeps its own outer pill
          corners, so the press scale reads as that half depressing inside the
          control rather than as the seam tearing open. */}
      <TooltipProvider>
        <div className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onCreate}
                  disabled={disabled}
                  className="rounded-r-none"
                >
                  Create
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Create ticket (⌘↵)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  data-testid="composer-kickoff"
                  onClick={onKickoff}
                  disabled={disabled}
                  size="sm"
                  className="rounded-l-none"
                >
                  Create &amp; start
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Create ticket and start agent (⇧⌘↵)</TooltipContent>
          </Tooltip>
          {/* A named action, not a hidden caret on generic Create & start:
              the saved Automation is a distinct way to launch this ticket. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label="Create and run an automation"
                data-testid="composer-run-automation"
                className="ml-2"
              >
                <LightningIcon />
                Create &amp; run
                <CaretDownIcon weight="bold" className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <CreateRunAutomationItems
                groups={automationRun.groups}
                ready={automationRun.ready}
                enabledIds={automationRun.enabledIds}
                onRun={automationRun.onRun}
                disabled={disabled}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TooltipProvider>
    </div>
  );
}

/**
 * The caret menu's rows: every column's saved Automations, grouped and labelled
 * (the rail's own cross-column answer, VC-329 item 5). A project listing none
 * still says so — a caret opening onto an empty popover would read as broken —
 * and the rows stay pressable only while the composer can commit, so the
 * disabled Create pair and these rows refuse together.
 */
export function CreateRunAutomationItems({
  groups,
  enabledIds,
  onRun,
  disabled,
  ready = true,
}: {
  groups: readonly AutomationGroup[];
  ready?: boolean;
  enabledIds: readonly string[];
  onRun(automation: { id: string; name: string }): void;
  disabled: boolean;
}) {
  if (!ready || groups.length === 0) {
    return (
      <div className="px-2 py-1 text-label text-muted-foreground">
        {ready ? "No ticket automations in this project." : "Reading automations…"}
      </div>
    );
  }
  return groups.map((group, index) => (
    <div key={group.status}>
      {index > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuLabel className="text-label text-muted-foreground">
        {group.label}
        {group.current ? " · this column" : ""}
      </DropdownMenuLabel>
      {group.automations.map((automation) => (
        <DropdownMenuItem
          key={automation.id}
          disabled={disabled}
          onSelect={() => onRun(automation)}
        >
          <LightningIcon />
          <span className="min-w-0 flex-1 truncate">Create &amp; run: {automation.name}</span>
          <OffNote automation={automation} enabledIds={enabledIds} />
        </DropdownMenuItem>
      ))}
    </div>
  ));
}
