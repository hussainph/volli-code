import * as React from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { Command } from "cmdk";

import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

/**
 * The searchable "pick one name from a catalog" control every Appearance row
 * uses — global Settings and per-project Configure alike.
 *
 * It exists because four rows (terminal theme, terminal font family, editor
 * theme, and both of their project-scoped twins) were the same eighty lines of
 * Popover + cmdk with one thing swapped, and the interesting part of that
 * eighty lines is a set of contracts that must NOT drift between them:
 *
 *  - **cmdk must be CONTROLLED** or it never calls `onValueChange` — it just
 *    updates its own store and returns. An uncontrolled picker here would
 *    silently never preview anything.
 *  - **A hover-preview has no Escape.** The pointer just wanders off, so the
 *    pointer leaving the list IS the "never mind" ({@link onEndPreview}), and
 *    the highlight is cleared with it — cmdk no-ops on an unchanged value, so
 *    a row left highlighted would swallow the re-entry and never preview again.
 *    Every other way out (Escape, an outside click, the commit) clears it too.
 *  - **Commit first, then end the preview.** The write resolves into the same
 *    palette, so there is no flash; ending first would repaint twice.
 *  - **Unmounting ends the preview.** Leaving the surface mid-preview would
 *    strand the app on a look that is stored nowhere.
 *
 * Preview itself is optional: a row with nothing to preview (font family) just
 * omits the two callbacks and gets the same list, search and check mark.
 */

/**
 * One selectable row: the value written on commit, plus how it reads and
 * searches. Generic in the value so a catalog with a narrower id union (the
 * shipped editor themes) keeps that union all the way through `onSelect`,
 * rather than widening to `string` and needing a cast back at the call site.
 */
export interface ThemeComboBoxItem<Value extends string = string> {
  /** The catalog id / theme name this row commits. */
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
  /** Paint the highlighted value live, writing nothing. Omit for a row with no live preview. */
  onPreview?(value: string): void;
  /** Put the committed look back. Required whenever {@link onPreview} is given. */
  onEndPreview?(): void;
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
  onPreview,
  onEndPreview,
  onSelect,
  onOpenChange,
  className,
}: ThemeComboBoxProps<Value>) {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState("");

  // Read through a ref so the unmount effect stays exhaustive-deps clean and
  // never captures a stale closure over an earlier render's restore target. The
  // ref is moved in an effect rather than during render: render must stay pure,
  // and this effect is declared first, so the cleanup below always sees the
  // latest committed callback.
  const endPreview = React.useRef(onEndPreview);
  React.useEffect(() => {
    endPreview.current = onEndPreview;
  });
  const end = React.useCallback((): void => endPreview.current?.(), []);

  React.useEffect(() => end, [end]);

  // Every way OUT of a preview: the highlight has to go with it. cmdk fires
  // `onValueChange` only on a CHANGE, so a row left highlighted would swallow
  // the next hover over that same row and never preview again — and the ways
  // out are more than the pointer leaving (Escape, an outside click, and the
  // commit itself, which closes through our own `setOpen`).
  const endHighlightedPreview = React.useCallback((): void => {
    setSelected("");
    endPreview.current?.();
  }, []);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
        if (!next) endHighlightedPreview();
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
          onValueChange={(value) => {
            setSelected(value);
            onPreview?.(value);
          }}
          onPointerLeave={endHighlightedPreview}
          className="flex flex-col overflow-hidden rounded-md"
        >
          <Command.Input
            autoFocus
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            className="h-9 border-b border-border bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              {empty}
            </Command.Empty>
            {items.map((item) => (
              <Command.Item
                key={item.value}
                value={item.value}
                keywords={item.keywords === undefined ? undefined : [...item.keywords]}
                onSelect={() => {
                  // `finally`, not the resolve path: a persist that REJECTS
                  // would otherwise strand the app on a previewed look that is
                  // stored nowhere — the one thing the contracts above exist to
                  // prevent. The rejection itself still propagates; every call
                  // site persists through `writeThrough`, which toasts.
                  void onSelect(item.value)
                    .then((saved) => {
                      if (saved) setOpen(false);
                    })
                    .finally(endHighlightedPreview);
                }}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
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
 * `--primary-text`, not `--primary`: the label is 11px, so it needs the accent
 * solved for body-sized text even more than body copy does. The border stays on
 * `--primary`, which is a fill.
 */
export function ThemeOriginPill({
  emphasized,
  children,
}: {
  emphasized: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-label",
        emphasized ? "border-primary/40 text-primary-text" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
