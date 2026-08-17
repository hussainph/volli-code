import * as React from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { TAG_COLORS } from "@volli/shared";

import { TagChip } from "@renderer/components/board/tag-chip";
import { LabelPickerPopover } from "@renderer/components/ticket/label-picker";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { resolveLabelColor } from "@renderer/lib/labels";
import { useBoardStore } from "@renderer/stores/board";

/**
 * Swatch grid for a label chip's stored color, opened by right-clicking the
 * chip (`ContextMenu`, matching the board's `TicketContextMenu` idiom). The
 * palette is `TAG_COLORS` — the SAME set `tagColor`'s hash fallback draws
 * from (`@volli/shared`) — so a picked color reads as "one of the label
 * colors this app already uses," not an arbitrary custom hex. "Default"
 * clears the stored color (`color: null`), falling back to the hash.
 * `effectiveColor` (from `resolveLabelColor`) marks the current swatch (or
 * Default, when no color is stored) with a check.
 */
function LabelColorMenu({
  labelId,
  effectiveColor,
  storedColor,
  onPick,
  children,
}: {
  labelId: string;
  effectiveColor: string;
  storedColor: string | null;
  onPick: (labelId: string, color: string | null) => void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <div className="grid grid-cols-4 gap-1 p-1">
          {TAG_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Color ${color}`}
              onClick={() => onPick(labelId, color)}
              className="flex size-6 items-center justify-center rounded-full ring-1 ring-inset ring-border/50"
              style={{ backgroundColor: color }}
            >
              {color === effectiveColor ? (
                <CheckIcon weight="bold" className="size-3 text-white mix-blend-difference" />
              ) : null}
            </button>
          ))}
        </div>
        <ContextMenuSeparator />
        <ContextMenuItem icon={ArrowCounterClockwiseIcon} onSelect={() => onPick(labelId, null)}>
          Default color
          {storedColor === null ? <CheckIcon weight="bold" className="ml-auto size-3.5" /> : null}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The presentational core of the label editor: a wrap-flow of removable label
 * chips (reusing the board's `TagChip` + stored-color-or-hash treatment, and
 * `LabelColorMenu` on right-click for labels that exist as project rows) plus
 * the `+` that opens the shared {@link LabelPickerPopover} — driven purely by a
 * `value: string[]` and `onChange`, so it works both against a persisted ticket
 * (`ticket-properties.tsx` calls this directly and writes through `setLabels`)
 * and against plain local state.
 *
 * The `+` used to reveal a bare text field, and that was the whole affordance:
 * putting an existing label on a ticket meant retyping its name from memory,
 * which is how `bug` and `Bug` end up as two labels on one board. The picker
 * offers the project's own vocabulary first and still takes a new name typed
 * into its field — see `label-picker.tsx`.
 *
 * Label-color edits write straight through the board store (project scoped, and
 * only offered for labels that already have a project row).
 */
export function LabelEditorCore({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]);

  function remove(label: string) {
    onChange(value.filter((existing) => existing !== label));
  }

  function pickColor(labelId: string, color: string | null) {
    void useBoardStore.getState().setLabelColor(projectId, labelId, color);
  }

  const chips = value.map((label) => {
    const row = projectLabels?.find((candidate) => candidate.name === label);
    const color = resolveLabelColor(projectLabels, label);
    return (
      <span key={label} className="group/chip inline-flex items-center">
        {row ? (
          <LabelColorMenu
            labelId={row.id}
            effectiveColor={color}
            storedColor={row.color}
            onPick={pickColor}
          >
            <TagChip tag={label} color={color} />
          </LabelColorMenu>
        ) : (
          <TagChip tag={label} color={color} />
        )}
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={() => remove(label)}
          className="-ml-1 flex size-4 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover/chip:opacity-100 hover:text-foreground"
        >
          <XIcon className="size-2.5" />
        </button>
      </span>
    );
  });

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips}
      <LabelPickerPopover projectId={projectId} value={value} onChange={onChange}>
        <Button variant="ghost" size="icon-xs" aria-label="Add label">
          <PlusIcon />
        </Button>
      </LabelPickerPopover>
    </div>
  );
}
