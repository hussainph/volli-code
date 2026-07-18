import * as React from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { TAG_COLORS } from "@volli/shared";

import { TagChip } from "@renderer/components/board/tag-chip";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { Input } from "@renderer/components/ui/input";
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
 * an inline "add label" affordance — driven purely by a `value: string[]` and
 * `onChange`, so it works both against a persisted ticket (the ticket detail's
 * `TicketLabelEditor` wraps this and writes through `setLabels`) and against
 * plain local state (the New-ticket composer, before any ticket exists).
 *
 * The add affordance has two modes:
 * - default (`alwaysInput` false): a `+` button reveals the text input, which
 *   commits on Enter/blur and dismisses on Escape — the ticket-detail behavior.
 * - `alwaysInput`: the input is always shown (no `+` toggle) and commits on
 *   Enter without dismissing, so it can live inside a popover whose own Escape
 *   closes the popover rather than the field — the composer's Labels menu.
 *
 * Label-color edits still write straight through the board store (project
 * scoped, and only offered for labels that already have a project row), which
 * both surfaces share unchanged.
 */
export function LabelEditorCore({
  projectId,
  value,
  onChange,
  addPlaceholder = "Label…",
  alwaysInput = false,
}: {
  projectId: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  addPlaceholder?: string;
  alwaysInput?: boolean;
}) {
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]);
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  function commitAdd() {
    const trimmed = draft.trim();
    setDraft("");
    if (!alwaysInput) setAdding(false);
    if (trimmed === "" || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
  }

  function remove(label: string) {
    onChange(value.filter((existing) => existing !== label));
  }

  function pickColor(labelId: string, color: string | null) {
    void useBoardStore.getState().setLabelColor(projectId, labelId, color);
  }

  const showInput = alwaysInput || adding;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((label) => {
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
              className="-ml-1.5 flex size-4 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover/chip:opacity-100 hover:text-foreground"
            >
              <XIcon className="size-2.5" />
            </button>
          </span>
        );
      })}
      {showInput ? (
        <Input
          autoFocus={!alwaysInput}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={alwaysInput ? undefined : commitAdd}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitAdd();
            } else if (event.key === "Escape" && !alwaysInput) {
              // In the popover variant, let Escape bubble so the popover closes;
              // inline, Escape just abandons the add.
              event.preventDefault();
              setDraft("");
              setAdding(false);
            }
          }}
          placeholder={addPlaceholder}
          className="h-6 w-28 px-1.5 text-xs"
        />
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Add label"
          onClick={() => setAdding(true)}
        >
          <PlusIcon />
        </Button>
      )}
    </div>
  );
}
