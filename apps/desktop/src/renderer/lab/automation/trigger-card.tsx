/**
 * When this Automation fires.
 *
 * v1's honest triggers: board column moves, run-by-hand, and schedule (off-board
 * intake). Future kinds stay in the picker as disabled rows so the control is
 * load-tested at eight entries rather than rebuilt the first time one lands.
 *
 * Columns are a mini board strip — five equal cells that light when armed —
 * not a dump of pills. The silhouette should feel related to the real board
 * the drag picker already polished.
 */
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { HandPointingIcon } from "@phosphor-icons/react/dist/csr/HandPointing";
import { TICKET_STATUS_LABELS, TICKET_STATUSES, type TicketStatus } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

import {
  blankTrigger,
  isOffBoardTrigger,
  TRIGGER_GROUPS,
  TRIGGER_KINDS,
  type Trigger,
  type TriggerKind,
} from "./model";

function ColumnStrip({
  columns,
  onChange,
}: {
  columns: TicketStatus[];
  onChange: (columns: TicketStatus[]) => void;
}) {
  function toggle(status: TicketStatus) {
    onChange(
      columns.includes(status)
        ? columns.filter((item) => item !== status)
        : [...columns, status].toSorted(
            (a, b) => TICKET_STATUSES.indexOf(a) - TICKET_STATUSES.indexOf(b),
          ),
    );
  }

  return (
    <div
      role="group"
      aria-label="Columns"
      className="grid flex-1 grid-cols-5 gap-0.5 rounded-lg bg-muted/35 p-0.5"
    >
      {TICKET_STATUSES.map((status) => {
        const on = columns.includes(status);
        return (
          <button
            key={status}
            type="button"
            onClick={() => toggle(status)}
            aria-pressed={on}
            className={cn(
              "cursor-pointer rounded-md px-1 py-1.5 text-center text-label",
              "transition-[background-color,color,transform,box-shadow] duration-150 ease-out",
              "motion-reduce:transition-none active:scale-[0.97]",
              "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              on
                ? "bg-card text-foreground shadow-raised ring-1 ring-primary/35"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {TICKET_STATUS_LABELS[status]}
          </button>
        );
      })}
    </div>
  );
}

function KindPicker({
  trigger,
  onChange,
}: {
  trigger: Trigger;
  onChange: (trigger: Trigger) => void;
}) {
  const kinds = Object.keys(TRIGGER_KINDS) as TriggerKind[];
  const Icon =
    trigger.kind === "schedule"
      ? ClockIcon
      : trigger.kind === "manual"
        ? HandPointingIcon
        : LightningIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="gap-1.5 border border-border active:scale-[0.97] transition-transform duration-100 ease-out"
        >
          <Icon weight="fill" className="size-3.5 text-muted-foreground" />
          {TRIGGER_KINDS[trigger.kind].label}
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {TRIGGER_GROUPS.map((group, index) => (
          <DropdownMenuGroup key={group} aria-label={group}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{group}</DropdownMenuLabel>
            {kinds
              .filter((kind) => TRIGGER_KINDS[kind].group === group)
              .map((kind) => (
                <DropdownMenuItem
                  key={kind}
                  disabled={!TRIGGER_KINDS[kind].available}
                  onSelect={() => onChange(blankTrigger(kind))}
                >
                  {TRIGGER_KINDS[kind].label}
                </DropdownMenuItem>
              ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TriggerCard({
  trigger,
  onChange,
}: {
  trigger: Trigger;
  onChange: (trigger: Trigger) => void;
}) {
  const offBoard = isOffBoardTrigger(trigger);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-3">
      <div className="flex items-center gap-2">
        <LightningIcon
          weight="fill"
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <KindPicker trigger={trigger} onChange={onChange} />
        {offBoard ? (
          <span className="text-label text-muted-foreground">
            {trigger.kind === "schedule" ? "Off the board — cron later" : "Off the board"}
          </span>
        ) : null}
      </div>
      {offBoard ? null : (
        <ColumnStrip
          columns={trigger.columns}
          onChange={(columns) => onChange({ ...trigger, columns })}
        />
      )}
    </div>
  );
}
