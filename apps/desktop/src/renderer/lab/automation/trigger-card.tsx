/**
 * When this Automation fires.
 *
 * ── DESIGNED FOR EIGHT, BUILT FOR THREE ───────────────────────────────────
 * v1 fires on one thing: a ticket entering a column. The roadmap is explicitly
 * bigger and explicitly meta — automations that fire when checks go green, when
 * a label lands, on a schedule, or on an event from another tracker, and whose
 * job may be to CREATE a ticket rather than to work one. Every one of those is a
 * different operand behind the same question.
 *
 * So the control is a KIND picker plus a kind-specific operand, and the picker
 * renders the unbuilt kinds as disabled rows in their real groups. That is not a
 * roadmap tease; it is the load test. A picker that reads well with one entry
 * and badly with eight has to be rebuilt the first time a trigger is added, and
 * this scratch exists to find that out now rather than then.
 *
 * The three v1 kinds are all Board kinds, which is itself worth looking at: with
 * `Outside Volli` sitting there empty, the grouping either carries the future
 * shape or looks like padding. That judgement is the point.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The bolt, and the absence of any connector above this card, are lifted from
 * n8n — its trigger nodes have a rounded left edge and a bolt WHERE the input
 * connector would be, so the geometry itself says nothing flows into this. Here
 * that costs one icon and one missing line, and it is the difference between a
 * step list with a header and a step list whose first entry is a different kind
 * of thing.
 */
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { TICKET_STATUS_LABELS, TICKET_STATUSES, type TicketStatus } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

import {
  blankTrigger,
  TRIGGER_GROUPS,
  TRIGGER_KINDS,
  type Trigger,
  type TriggerKind,
} from "./model";

/**
 * The whole board, as toggles. A checkbox menu would be smaller and would hide
 * the one thing worth seeing — that this fires in Doing and NOT in Needs Review
 * is a fact about the board, and the board is five items long.
 */
function ColumnToggles({
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
    <div className="flex flex-wrap items-center gap-1">
      {TICKET_STATUSES.map((status) => (
        <button
          key={status}
          type="button"
          onClick={() => toggle(status)}
          aria-pressed={columns.includes(status)}
          className={cn(
            "rounded-full border border-border px-2.5 py-0.5 text-label text-muted-foreground",
            "transition-[background-color,color,border-color] duration-150 ease-out",
            "hover:text-foreground motion-reduce:transition-none",
            "aria-pressed:border-primary/40 aria-pressed:bg-primary/15 aria-pressed:text-primary-text",
          )}
        >
          {TICKET_STATUS_LABELS[status]}
        </button>
      ))}
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="gap-1.5 border border-border">
          {TRIGGER_KINDS[trigger.kind].label}
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {TRIGGER_GROUPS.map((group, index) => (
          <div key={group}>
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
          </div>
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
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <LightningIcon
        weight="fill"
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <KindPicker trigger={trigger} onChange={onChange} />
      {trigger.kind === "manual" ? null : (
        <ColumnToggles
          columns={trigger.columns}
          onChange={(columns) => onChange({ ...trigger, columns })}
        />
      )}
    </div>
  );
}
