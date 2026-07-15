import * as React from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { TAG_COLORS, type Ticket } from "@volli/shared";

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
 * Ticket labels as removable chips (reusing the board's `TagChip` +
 * stored-color-or-hash treatment — tag-chip.tsx, lib/labels.ts) plus an
 * inline "add label" affordance. Edits write through `setLabels` (board.ts),
 * which replaces the ticket's label set wholesale, so every add/remove here
 * sends the full next array. Right-clicking a chip opens `LabelColorMenu`,
 * which persists a picked swatch via `setLabelColor` — the color then shows
 * up everywhere the label renders (this editor, board chips, filter dots),
 * since they all resolve through the same `labelsByProject` slice.
 */
export function TicketLabelEditor({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]);
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  function commitAdd() {
    const trimmed = draft.trim();
    setDraft("");
    setAdding(false);
    if (trimmed === "" || ticket.labels.includes(trimmed)) return;
    void useBoardStore.getState().setLabels(ticket.id, [...ticket.labels, trimmed]);
  }

  function remove(label: string) {
    void useBoardStore.getState().setLabels(
      ticket.id,
      ticket.labels.filter((existing) => existing !== label),
    );
  }

  function pickColor(labelId: string, color: string | null) {
    void useBoardStore.getState().setLabelColor(projectId, labelId, color);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ticket.labels.map((label) => {
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
      {adding ? (
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitAdd}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitAdd();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft("");
              setAdding(false);
            }
          }}
          placeholder="Label…"
          className="h-6 w-24 px-1.5 text-xs"
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
