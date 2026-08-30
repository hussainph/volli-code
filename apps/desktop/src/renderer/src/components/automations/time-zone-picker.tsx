/**
 * The IANA zone control on a schedule's row (VC-112, VC-130).
 *
 * A searchable picker rather than a text field or a short menu, for two
 * reasons that are really one: there are around four hundred zones, and the
 * stored zone WINS — a schedule set to `Europe/London` keeps firing at 21:00
 * London whoever is holding the laptop. A value that decisive has to be
 * chosen from the real list rather than typed and hoped for, and it has to
 * stay legible on the row afterwards.
 *
 * It composes the same three primitives `theme/theme-combo-box.tsx` does —
 * Button trigger, Popover, cmdk list — rather than reusing that component,
 * which is Appearance's: its props are a preview/commit contract for painting
 * a theme live, and a zone has nothing to preview. What is shared is the
 * shape, not a control that would have to grow an axis to serve both.
 *
 * The catalog is `Intl.supportedValuesOf("timeZone")`, so the list is the one
 * this build can actually resolve — a zone offered here is a zone the pure
 * schedule policy can compute with.
 */
import * as React from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { Command } from "cmdk";

import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";

/**
 * Every zone this build knows, read once per module rather than per render:
 * it is a constant of the runtime, and it is four hundred strings.
 */
function supportedTimeZones(): readonly string[] {
  return Intl.supportedValuesOf("timeZone");
}

let catalog: readonly string[] | null = null;

function timeZoneCatalog(value: string): readonly string[] {
  catalog ??= supportedTimeZones();
  // A stored zone this build no longer lists (an old record, a newer tz
  // database) still appears, and appears as the selected one. Dropping it would
  // make the control silently disagree with the record it is editing.
  return catalog.includes(value) ? catalog : [value, ...catalog];
}

export function TimeZonePicker({
  value,
  onChange,
}: {
  value: string;
  onChange(timeZone: string): void;
}) {
  const [open, setOpen] = React.useState(false);
  const zones = React.useMemo(() => timeZoneCatalog(value), [value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Time zone" className="max-w-52 shrink-0">
          <span className="truncate">{value}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command loop className="flex flex-col overflow-hidden rounded-md">
          <Command.Input
            autoFocus
            aria-label="Find a time zone"
            placeholder="Find a time zone"
            className="h-9 border-b border-border bg-transparent px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className={EMPTY_INLINE}>No zone by that name.</Command.Empty>
            {zones.map((zone) => (
              <Command.Item
                key={zone}
                value={zone}
                onSelect={() => {
                  onChange(zone);
                  setOpen(false);
                }}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
              >
                <span className="truncate">{zone}</span>
                {zone === value ? <CheckIcon weight="bold" className="size-3.5" /> : null}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
