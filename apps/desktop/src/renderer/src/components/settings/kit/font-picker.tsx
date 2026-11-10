import * as React from "react";
import { Command } from "cmdk";
import { CheckIcon } from "@renderer/components/ui/icon";

import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";

/** Faces come only from Local Font Access. No bundled fonts or guessed font list. */
export function FontPicker({
  ariaLabel,
  buttonLabel,
  searchLabel,
  searchPlaceholder,
  empty,
  families,
  activeValue,
  onSelect,
  onOpenChange,
}: {
  ariaLabel: string;
  buttonLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  empty: React.ReactNode;
  families: readonly string[];
  activeValue: string | null;
  onSelect(value: string): Promise<boolean>;
  onOpenChange?(open: boolean): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={ariaLabel} className="w-52 justify-start">
          <span className="truncate">{buttonLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <Command loop>
          <Command.Input
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            className="mb-2 w-full rounded-control border border-input bg-card px-2 py-2 text-ui outline-none"
          />
          <Command.List className="max-h-64 overflow-y-auto">
            <Command.Empty className="p-2 text-ui text-muted-foreground">{empty}</Command.Empty>
            {families.map((family) => (
              <Command.Item
                key={family}
                value={family}
                disabled={busy}
                className="flex min-h-12 cursor-default items-center justify-between gap-2 rounded-row p-2 text-ui select-none data-[selected=true]:bg-accent"
                onSelect={() => {
                  if (busy) return;
                  setBusy(true);
                  void onSelect(family)
                    .then((saved) => {
                      if (saved) setOpen(false);
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="truncate">{family}</span>
                  <span
                    className="truncate text-sm text-muted-foreground"
                    style={{ fontFamily: `${JSON.stringify(family)}, monospace` }}
                  >
                    Aa Bb 012345 {"{} =>"}
                  </span>
                </span>
                {family === activeValue && <CheckIcon aria-hidden className="size-4 shrink-0" />}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
