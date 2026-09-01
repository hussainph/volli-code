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
 * It is a Button trigger, a Popover, and the app's own `ui/command`
 * primitives — not raw `cmdk` and not `theme/theme-combo-box.tsx`. The shared
 * primitives own the field height, the row ink and the selected state, so this
 * picker cannot drift from every other searchable list in the app (DESIGN.md:
 * surfaces compose the shared primitives rather than hand-rolling containers).
 * The theme combo box is Appearance's and stays there: its props are a
 * preview/commit contract for painting a theme live, and a zone has nothing to
 * preview.
 *
 * The catalog is `Intl.supportedValuesOf("timeZone")`, so the list is the one
 * this build can actually resolve — a zone offered here is a zone the pure
 * schedule policy can compute with.
 */
import * as React from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";

import { Button } from "@renderer/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@renderer/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

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
  className,
}: {
  value: string;
  onChange(timeZone: string): void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const zones = React.useMemo(() => timeZoneCatalog(value), [value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Time zone"
          title={value}
          className={cn("max-w-52 shrink-0", className)}
        >
          <GlobeIcon />
          <span className="truncate">{value}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command loop>
          <CommandInput autoFocus aria-label="Find a time zone" placeholder="Find a time zone" />
          <CommandList className="max-h-64 p-1">
            <CommandEmpty>No zone by that name.</CommandEmpty>
            {zones.map((zone) => (
              <CommandItem
                key={zone}
                value={zone}
                onSelect={() => {
                  onChange(zone);
                  setOpen(false);
                }}
                // The row is the primitive's; only the two children are this
                // control's — a long zone name that truncates, and the mark on
                // the stored one. `justify-between` puts the mark at the end
                // without a spacer element.
                className="justify-between"
              >
                <span className="truncate">{zone}</span>
                {zone === value ? (
                  <CheckIcon weight="bold" className="size-3.5 text-current" />
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
