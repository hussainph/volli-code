/**
 * The column-header bolt (VC-112, "Surfaces"): arm this column, or disarm it.
 *
 * The menu offers exactly this column's **Offered list** — the Automations
 * whose Trigger names it — plus `Nothing`. That is the whole vocabulary, and
 * the order matters: offering is a property of the record and arming is a
 * property of the column, so a column can only ever fire something it already
 * offers. When the list is empty the menu says so and hands over the one act
 * that changes it, rather than showing an armed-looking control with nothing
 * behind it.
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
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import {
  offeredAutomationsForColumn,
  TICKET_STATUS_LABELS,
  type TicketStatus,
} from "@volli/shared";

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
  useAutomationsStore,
} from "@renderer/stores/automations";

/** The `Nothing` row's value. Not an empty string: a radio group needs a real token. */
const DISARMED = "none";

export function ColumnArmingButton({
  projectId,
  status,
}: {
  projectId: string;
  status: TicketStatus;
}) {
  const automations = useAutomationsStore((state) => selectAutomations(state, projectId));
  const armed = useAutomationsStore((state) => selectArmedAutomation(state, projectId, status));
  const refresh = useAutomationsStore((state) => state.refresh);
  const refreshArming = useAutomationsStore((state) => state.refreshArming);
  const arm = useAutomationsStore((state) => state.arm);

  const offered = offeredAutomationsForColumn(automations, status, armed?.id ?? null);
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
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              aria-label={label}
              data-column-arming={status}
              data-armed={armed === null ? undefined : armed.id}
              className={cn(
                "size-6 shrink-0 p-0 transition-opacity duration-150",
                armed === null
                  ? [
                      "text-muted-foreground opacity-0",
                      "group-hover/column-header:opacity-100 focus-visible:opacity-100",
                      "data-[state=open]:opacity-100",
                    ]
                  : "text-foreground",
              )}
            >
              <LightningIcon className="size-3.5" weight={armed === null ? "regular" : "fill"} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Arrives in {TICKET_STATUS_LABELS[status]}</DropdownMenuLabel>
        {offered.length === 0 ? (
          <>
            <DropdownMenuItem disabled>No automation is offered here</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => useAutomationsStore.getState().openEditor(projectId)}>
              <LightningIcon />
              New automation…
            </DropdownMenuItem>
          </>
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
            <DropdownMenuRadioItem value={DISARMED}>Nothing</DropdownMenuRadioItem>
            {offered.map((automation) => (
              <DropdownMenuRadioItem key={automation.id} value={automation.id}>
                {automation.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
