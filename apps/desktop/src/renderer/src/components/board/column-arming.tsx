import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { SearchableCommand } from "@renderer/components/ui/searchable-command";
import { CheckIcon } from "@renderer/components/ui/icon";
/**
 * The column-header bolt (VC-112, "Surfaces"): arm this column, or disarm it.
 *
 * The menu offers exactly this column's **Offered list** — the Automations
 * whose Trigger names it — plus `No Automation`. That is the whole
 * vocabulary, and the order matters: offering is a property of the record and
 * arming is a property of the column, so a column can only ever fire something it already
 * offers. When the list is empty the menu says so and hands over the way to
 * change it, rather than showing an armed-looking control with nothing behind
 * it.
 *
 * That way is a LINK, never an editor. VC-112: "only the nav page authors,
 * every other surface just runs" — so this menu arms the column and links to
 * the Automations page, which is the one place a record is written (and, since
 * VC-127, the only surface that mounts the editor at all). The link is offered
 * in both states for the same reason: the answer to "nothing is offered here"
 * and to "I want a different one" is the same page.
 *
 * The bolt is always outline: accent ink means armed and ready. Automatic
 * triggers are a separate machine-local choice. With those paused, selected
 * background retains the armed distinction, muted ink and the name say paused.
 * The menu exposes that switch beside the arming choice.
 *
 * The list is re-read on open. Arming is machine-local and the record is not:
 * an Automation authored anywhere else in the app is a change this menu's own
 * open is the moment to notice, which is the palette's convention too.
 */
import * as React from "react";
import { AutomationIcon, AutomationOffIcon, RemoveCircleIcon } from "@renderer/components/ui/icon";

import {
  offeredAutomationsForColumn,
  TICKET_STATUS_LABELS,
  type TicketStatus,
} from "@volli/shared";

import { SWITCHED_OFF_NOTE } from "@renderer/components/automations/automations-page-model";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { guardWrite, readOnlyControl, useCanWrite } from "@renderer/components/hosts/use-hosts";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import {
  selectArmedAutomation,
  selectAutomations,
  selectColumnRank,
  useAutomationsStore,
} from "@renderer/stores/automations";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { automationSourceIsCloud } from "@renderer/stores/automation-source";
import { CloudColumnArming } from "../automations/cloud-automation-controls";

/** The `No Automation` row's value. Not an empty string: a radio group needs a real token. */
const DISARMED = "none";

export function ColumnArmingButton(props: { projectId: string; status: TicketStatus }) {
  return automationSourceIsCloud() ? (
    <CloudColumnArming {...props} />
  ) : (
    <LocalColumnArmingButton {...props} />
  );
}
function LocalColumnArmingButton({
  projectId,
  status,
}: {
  projectId: string;
  status: TicketStatus;
}) {
  const automations = useAutomationsStore((state) => selectAutomations(state, projectId));
  const rank = useAutomationsStore((state) => selectColumnRank(state, projectId, status));
  const armed = useAutomationsStore((state) => selectArmedAutomation(state, projectId, status));
  const enabledIds = useAutomationsStore((state) => state.enabledIds);
  // The project's host cannot serve (VC-576): arming is a write, so it stands down.
  const canWrite = useCanWrite(projectId);
  const refresh = useAutomationsStore((state) => state.refresh);
  const refreshArming = useAutomationsStore((state) => state.refreshArming);
  const refreshOrder = useAutomationsStore((state) => state.refreshOrder);
  const refreshEnablement = useAutomationsStore((state) => state.refreshEnablement);
  const arm = useAutomationsStore((state) => state.arm);
  const setEnabled = useAutomationsStore((state) => state.setEnabled);

  // The column's AUTHORED rank (VC-132) — the same order the lane view
  // arranges, so the menu and the lane are one list read twice. Deliberately
  // NOT the drag's pinned shape: the pin exists to protect what digit `1`
  // means, and this menu has no digits. Memoized because the composition mints
  // an array: a selector returning a fresh one on every read is what a store
  // subscription may never do.
  const offered = React.useMemo(
    () => offeredAutomationsForColumn(automations, status, rank),
    [automations, status, rank],
  );
  const armingState =
    armed === null ? "unarmed" : enabledIds.includes(armed.id) ? "ready" : "switched-off";
  const label =
    armed === null
      ? `Arm ${TICKET_STATUS_LABELS[status]}`
      : armingState === "ready"
        ? `${TICKET_STATUS_LABELS[status]} runs ${armed.name}`
        : `${TICKET_STATUS_LABELS[status]} is armed with ${armed.name} — automatic triggers off`;

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const opening = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      return;
    }
    void refresh(projectId);
    void refreshArming(projectId);
    void refreshOrder(projectId);
    void refreshEnablement();
  };
  const choose = (value: string) => {
    if (!guardWrite(projectId)) return;
    void arm({ projectId, status, automationId: value === DISARMED ? null : value }).then(
      (refusal) => {
        if (refusal !== null) toastError(`Couldn't arm this column: ${refusal}`);
      },
    );
  };
  if (offered.length > 12) {
    const choices = [
      { id: DISARMED, name: "No automation" },
      ...offered.filter(
        (automation) =>
          automation.id === armed?.id ||
          automation.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    ];
    return (
      <Popover open={open} onOpenChange={opening}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                {...readOnlyControl(canWrite)}
                aria-label={label}
                data-column-arming={status}
                data-armed={armed?.id}
                data-arming-state={armingState}
                className={cn(
                  "shrink-0",
                  armed !== null && armingState !== "ready" && "bg-accent",
                  armingState === "ready" ? "text-primary-text" : "text-muted-foreground",
                )}
              >
                <AutomationIcon data-arming-mark={armed === null ? "unarmed" : "armed"} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" className="w-80 gap-0 p-0">
          <SearchableCommand
            items={choices}
            keyOf={(automation) => automation.id}
            query={query}
            onQueryChange={setQuery}
            placeholder="Search automations"
            onSelect={(automation) => {
              choose(automation.id);
              setOpen(false);
              setQuery("");
            }}
            renderItem={(automation) => (
              <>
                {automation.id === DISARMED ? (
                  <RemoveCircleIcon />
                ) : enabledIds.includes(automation.id) ? (
                  <AutomationIcon />
                ) : (
                  <AutomationOffIcon />
                )}
                <span className="min-w-0 flex-1 truncate" title={automation.name}>
                  {automation.name}
                </span>
                {(armed?.id ?? DISARMED) === automation.id ? <CheckIcon /> : null}
              </>
            )}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-2">
            {armed === null ? null : (
              <Button
                variant="ghost"
                size="sm"
                role="switch"
                aria-checked={enabledIds.includes(armed.id)}
                onClick={() => void setEnabled(armed.id, !enabledIds.includes(armed.id))}
              >
                <AutomationIcon />
                Automatic triggers
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                useProjectUiStore.getState().setNav(projectId, "automations");
              }}
            >
              <AutomationIcon />
              Automations
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={opening}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              {...readOnlyControl(canWrite)}
              aria-label={label}
              data-column-arming={status}
              data-armed={armed === null ? undefined : armed.id}
              data-arming-state={armingState}
              className={cn(
                "shrink-0",
                armed !== null && armingState !== "ready" && "bg-accent",
                armingState === "ready" ? "text-primary-text" : "text-muted-foreground",
              )}
            >
              <AutomationIcon data-arming-mark={armed === null ? "unarmed" : "armed"} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>Arrives in {TICKET_STATUS_LABELS[status]}</DropdownMenuLabel>
        {offered.length === 0 ? (
          <div className="sr-only">No automations in this column</div>
        ) : (
          <DropdownMenuRadioGroup value={armed?.id ?? DISARMED} onValueChange={choose}>
            <DropdownMenuRadioItem value={DISARMED}>
              <RemoveCircleIcon />
              No automation
            </DropdownMenuRadioItem>
            {offered.map((automation) => (
              <DropdownMenuRadioItem
                key={automation.id}
                value={automation.id}
                title={
                  enabledIds.includes(automation.id)
                    ? automation.name
                    : `${automation.name} · ${SWITCHED_OFF_NOTE}`
                }
                aria-label={
                  enabledIds.includes(automation.id)
                    ? automation.name
                    : `${automation.name} · ${SWITCHED_OFF_NOTE}`
                }
              >
                {enabledIds.includes(automation.id) ? <AutomationIcon /> : <AutomationOffIcon />}
                <span className="min-w-0 flex-1 whitespace-normal wrap-anywhere">
                  {automation.name}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
        {armed === null ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={enabledIds.includes(armed.id)}
              onCheckedChange={(enabled) => void setEnabled(armed.id, enabled)}
            >
              <AutomationIcon />
              Automatic triggers
            </DropdownMenuCheckboxItem>
          </>
        )}
        <DropdownMenuSeparator />
        {/* The link, not an editor: authoring lives on the page (VC-112), and
            what a column offers is decided by an Automation's Trigger there. */}
        <DropdownMenuItem
          data-column-arming-page
          onSelect={() => useProjectUiStore.getState().setNav(projectId, "automations")}
        >
          <AutomationIcon />
          Automations
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
