/**
 * The label picker: one popover, shared by every surface that puts labels ON a
 * ticket — the rail's Properties fold, the New-ticket composer's Labels chip.
 * The board card's context menu offers the same vocabulary as a submenu of
 * check rows (`board/ticket-context-menu.tsx`), because a menu cannot hold a
 * field.
 *
 * It is a picker FIRST and a field second, and that order is the point. Every
 * one of these surfaces used to be a bare text input, so the only way to put an
 * existing label on a ticket was to retype its name — which mints `Bug` beside
 * `bug` on the first slip and leaves the board's Label facet listing both. The
 * project's own names sit in the list; typing filters them; and a new label is
 * offered only once what was typed matches none of them
 * ({@link newLabelFromQuery} decides that, case-insensitively).
 *
 * Multi-select, so a tick does NOT dismiss: labelling a ticket `bug` + `docs`
 * is one gesture, not two openings. The query lives with the content, which
 * Radix unmounts on close, so a picker always opens on the full list.
 *
 * Geometry and idiom follow the composer's branch picker (`Popover` + cmdk
 * `Command`, our own filter, a trailing check on the chosen rows) — the app's
 * one shape for "pick from a list you can also search".
 */
import * as React from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import type { Label, Ticket } from "@volli/shared";

import {
  labelPickerOptions,
  labelVocabulary,
  newLabelFromQuery,
  withLabelToggled,
} from "@renderer/components/ticket/label-picker-model";
import { Command, CommandInput, CommandItem, CommandList } from "@renderer/components/ui/command";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { resolveLabelColor } from "@renderer/lib/labels";
import { useBoardStore } from "@renderer/stores/board";

// Stable fallbacks: an inline `?? []` mints a fresh array identity per render,
// which would defeat the memo below for a project with no labels or no tickets.
const NO_LABELS: readonly Label[] = [];
const NO_TICKETS: readonly Ticket[] = [];

/**
 * The label names a project knows — see {@link labelVocabulary} for why the
 * ticket names are in there beside the label rows.
 *
 * Call this from a component that is mounted only while the picker is OPEN:
 * it subscribes to the project's whole ticket slice, and a board card holds one
 * of these menus per card.
 */
export function useLabelVocabulary(projectId: string): string[] {
  const labels = useBoardStore((state) => state.labelsByProject[projectId]);
  const tickets = useBoardStore((state) => state.ticketsByProject[projectId]);
  return React.useMemo(
    () => labelVocabulary(labels ?? NO_LABELS, tickets ?? NO_TICKETS),
    [labels, tickets],
  );
}

/** The chip's color dot, at the size the list and the menus both draw it. */
function LabelDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * The popover's body. Its own component so the store reads and the query live
 * behind Radix's presence gate — mounted when the picker opens, gone when it
 * closes, which is also what resets the field. Exported for the test that
 * renders it without a live popover.
 */
export function LabelPickerContent({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = React.useState("");
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]);
  const vocabulary = useLabelVocabulary(projectId);
  const options = labelPickerOptions(vocabulary, value, query);
  const creatable = newLabelFromQuery(vocabulary, value, query);

  return (
    // Our own filter, so the rows stay in the vocabulary's alphabetical order
    // rather than cmdk's match ranking — a label list is a vocabulary, and one
    // that reorders itself as you type is one you cannot learn.
    <Command shouldFilter={false} className="bg-transparent">
      <CommandInput autoFocus value={query} onValueChange={setQuery} placeholder="Search labels…" />
      <CommandList className="max-h-64">
        {options.length === 0 && creatable === null ? (
          <div className={EMPTY_INLINE}>No labels</div>
        ) : null}
        {options.map((option) => (
          <CommandItem
            key={option.name}
            value={option.name}
            // The closure, never cmdk's callback argument: it hands the value
            // back LOWERCASED, and `bug` is not the label `Bug`.
            onSelect={() => onChange(withLabelToggled(value, option.name))}
          >
            <LabelDot color={resolveLabelColor(projectLabels, option.name)} />
            <span className="truncate">{option.name}</span>
            {option.selected ? (
              <CheckIcon weight="bold" className="ml-auto size-3.5 shrink-0 text-foreground" />
            ) : null}
          </CommandItem>
        ))}
        {creatable === null ? null : (
          <CommandItem
            // Namespaced so a project that literally has a label called
            // `new label` cannot collide with this row's cmdk value.
            value={`new-label:${creatable}`}
            onSelect={() => {
              onChange([...value, creatable]);
              setQuery("");
            }}
          >
            <PlusIcon />
            <span className="truncate">Create “{creatable}”</span>
          </CommandItem>
        )}
      </CommandList>
    </Command>
  );
}

/**
 * The picker, wrapped around whatever opens it — `children` is the trigger,
 * rendered `asChild`, so each surface keeps its own control (the fold's `+`,
 * the composer's chip).
 *
 * `value`/`onChange` rather than a ticket id: this drives a persisted ticket
 * through the board store AND the composer's local draft, which has no ticket
 * to write to yet.
 */
export function LabelPickerPopover({
  projectId,
  value,
  onChange,
  children,
}: {
  projectId: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <LabelPickerContent projectId={projectId} value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}
