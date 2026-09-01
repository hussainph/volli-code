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
 * The bolt is filled only while the column is armed. That is the fill rule
 * exactly as CLAUDE.md states it — the exception among its neighbours, where
 * position and ink are not already saying it — and it is the only mark that a
 * card dropped here will start work.
 *
 * And an UNARMED column's bolt is invisible until the column is hovered, the
 * button is focused, or its menu is open. A board with nothing armed must read
 * exactly as it read before this feature existed; five permanent glyphs saying
 * "nothing here" is five pieces of chrome earning nothing. It stays in the
 * layout and in the accessibility tree the whole time — `opacity`, not
 * `hidden` — so tabbing to it reveals it and the header never reflows.
 *
 * The list is re-read on open. Arming is machine-local and the record is not:
 * an Automation authored anywhere else in the app is a change this menu's own
 * open is the moment to notice, which is the palette's convention too.
 */
import * as React from "react";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import {
  selectArmedAutomation,
  selectAutomations,
  selectColumnRank,
  useAutomationsStore,
} from "@renderer/stores/automations";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** The `No Automation` row's value. Not an empty string: a radio group needs a real token. */
const DISARMED = "none";

export function ColumnArmingButton({
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
  const refresh = useAutomationsStore((state) => state.refresh);
  const refreshArming = useAutomationsStore((state) => state.refreshArming);
  const refreshOrder = useAutomationsStore((state) => state.refreshOrder);
  const refreshEnablement = useAutomationsStore((state) => state.refreshEnablement);
  const arm = useAutomationsStore((state) => state.arm);

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
  const label =
    armed === null
      ? `Arm ${TICKET_STATUS_LABELS[status]}`
      : `${TICKET_STATUS_LABELS[status]} runs ${armed.name}`;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) return;
        void refresh(projectId);
        void refreshArming(projectId);
        void refreshOrder(projectId);
        void refreshEnablement();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              data-column-arming={status}
              data-armed={armed === null ? undefined : armed.id}
              className={cn(
                "shrink-0 transition-opacity duration-150",
                armed === null
                  ? [
                      "text-muted-foreground opacity-0",
                      "group-hover/column-header:opacity-100 focus-visible:opacity-100",
                      "data-[state=open]:opacity-100",
                    ]
                  : "text-foreground",
              )}
            >
              <LightningIcon weight={armed === null ? "regular" : "fill"} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Arrives in {TICKET_STATUS_LABELS[status]}</DropdownMenuLabel>
        {offered.length === 0 ? (
          <DropdownMenuItem disabled>No automation is offered here</DropdownMenuItem>
        ) : (
          <DropdownMenuRadioGroup
            value={armed?.id ?? DISARMED}
            onValueChange={(value) => {
              void arm({
                projectId,
                status,
                automationId: value === DISARMED ? null : value,
              }).then((refusal) => {
                // A refusal here is not a correction to something still on
                // screen — the menu closed on select — so it toasts, like every
                // other failed mutation.
                if (refusal !== null) toastError(`Couldn't arm this column: ${refusal}`);
              });
            }}
          >
            <DropdownMenuRadioItem value={DISARMED}>No Automation</DropdownMenuRadioItem>
            {offered.map((automation) => (
              <DropdownMenuRadioItem key={automation.id} value={automation.id}>
                {automation.name}
                {/* An Automation that is switched off on this machine can be
                    armed — arming is the column's choice and the switch is the
                    record's — but it will not fire until someone turns it on,
                    so the row says so rather than letting a filled bolt
                    promise a Run that never comes. The switch itself lives on
                    the Automations page, where the same sentence is printed.
                    (VC-112: a machine fires nothing until someone turns
                    something on there.) */}
                {enabledIds.includes(automation.id) ? null : (
                  <span className="ml-auto shrink-0 text-label text-muted-foreground">
                    {SWITCHED_OFF_NOTE}
                  </span>
                )}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
        <DropdownMenuSeparator />
        {/* The link, not an editor: authoring lives on the page (VC-112), and
            what a column offers is decided by an Automation's Trigger there. */}
        <DropdownMenuItem
          data-column-arming-page
          onSelect={() => useWorkspaceStore.getState().setNav(projectId, "automations")}
        >
          <LightningIcon />
          Automations
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
