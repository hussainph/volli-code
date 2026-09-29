import * as React from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { Command } from "cmdk";

import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

/**
 * The searchable "pick one name from a long list" control the Appearance rows
 * use.
 *
 * It carries the shared Popover + cmdk contracts. Two of them survive from the
 * version that also drove a live theme preview, because they are cmdk's rules
 * rather than the preview's:
 *
 *  - **cmdk must be CONTROLLED** or it never calls `onValueChange` — it just
 *    updates its own store and returns.
 *  - **Every way out clears the highlight.** cmdk no-ops on an unchanged value,
 *    so a row left highlighted would swallow the next hover over that same row.
 *    The ways out are more than the pointer leaving: Escape, an outside click,
 *    and the commit itself.
 *
 * THE LIVE PREVIEW IS GONE, and so is its plumbing (VC-413). It existed for the
 * terminal theme row, whose list was a theme catalog vendored out of Ghostty.app
 * — hovering a name repainted every live terminal. The app ships no catalog and
 * the row reports rather than picks, which leaves this control one caller (the
 * font-family row) and nothing to preview: a font is not a palette, and the list
 * is of faces already installed on the machine.
 */

/**
 * One selectable row: the value written on commit, plus how it reads and
 * searches. Generic in the value so a catalog with a narrower id union keeps
 * that union all the way through `onSelect`, rather than widening to `string`
 * and needing a cast back at the call site.
 */
export interface ThemeComboBoxItem<Value extends string = string> {
  /** The value / theme name this row commits. */
  value: Value;
  label: string;
  /** Extra search terms — a theme's family, say. */
  keywords?: readonly string[];
}

export interface ThemeComboBoxProps<Value extends string> {
  /** Names the trigger button for assistive tech (the visible label is the current value). */
  ariaLabel: string;
  /** What the trigger reads right now — the resolved value, not the highlighted one. */
  buttonLabel: string;
  /** Names the search field; the list is long enough that it is a landmark of its own. */
  searchLabel: string;
  searchPlaceholder?: string;
  /** Shown when the query matches nothing — also the slot for "still loading". */
  empty: React.ReactNode;
  items: readonly ThemeComboBoxItem<Value>[];
  /** The committed value, check-marked in the list. Null when nothing is set. */
  activeValue: string | null;
  /** Persist `value`; the menu closes only if this resolves true. */
  onSelect(value: Value): Promise<boolean>;
  /** Opening is the moment to fetch a list that is expensive to enumerate. */
  onOpenChange?(open: boolean): void;
  className?: string;
}

export function ThemeComboBox<Value extends string>({
  ariaLabel,
  buttonLabel,
  searchLabel,
  searchPlaceholder = "Search themes…",
  empty,
  items,
  activeValue,
  onSelect,
  onOpenChange,
  className,
}: ThemeComboBoxProps<Value>) {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState("");

  // cmdk fires `onValueChange` only on a CHANGE, so a row left highlighted
  // would swallow the next hover over that same row — and the ways out are more
  // than the pointer leaving (Escape, an outside click, and the commit itself,
  // which closes through our own `setOpen`).
  const clearHighlight = React.useCallback((): void => setSelected(""), []);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
        if (!next) clearHighlight();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={ariaLabel}
          className={cn("w-52 justify-between", className)}
        >
          <span className="truncate">{buttonLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command
          loop
          value={selected}
          onValueChange={setSelected}
          onPointerLeave={clearHighlight}
          className="flex flex-col overflow-hidden rounded-md"
        >
          <Command.Input
            autoFocus
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            className="h-9 border-b border-border bg-transparent px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className={EMPTY_INLINE}>{empty}</Command.Empty>
            {items.map((item) => (
              <Command.Item
                key={item.value}
                value={item.value}
                keywords={item.keywords === undefined ? undefined : [...item.keywords]}
                onSelect={() => {
                  // `finally`, not the resolve path: a persist that REJECTS
                  // must still leave the list in a state the next hover can
                  // act on. The rejection itself still propagates; every call
                  // site persists through `writeThrough`, which toasts.
                  void onSelect(item.value)
                    .then((saved) => {
                      if (saved) setOpen(false);
                    })
                    .finally(clearHighlight);
                }}
                className="flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-1 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
              >
                <span className="truncate">{item.label}</span>
                {item.value === activeValue ? (
                  <CheckIcon weight="bold" className="size-3.5" />
                ) : null}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The provenance chip every Appearance row wears (#67): a hairline pill that
 * goes accent-colored the moment something Volli wrote is what you are looking
 * at, so "where did this value come from" is answered without opening anything.
 *
 * The two drawings are `ui/badge.tsx`'s `outline` and `accent`; the accent
 * variant's ink/border split was worked out here and is recorded there now.
 */
export function ThemeOriginPill({
  emphasized,
  children,
}: {
  emphasized: boolean;
  children: React.ReactNode;
}) {
  return <Badge variant={emphasized ? "accent" : "outline"}>{children}</Badge>;
}
