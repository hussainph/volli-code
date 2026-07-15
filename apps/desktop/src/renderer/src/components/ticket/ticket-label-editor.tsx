import * as React from "react";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { Ticket } from "@volli/shared";

import { TagChip } from "@renderer/components/board/tag-chip";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { resolveLabelColor } from "@renderer/lib/labels";
import { useBoardStore } from "@renderer/stores/board";

/**
 * Ticket labels as removable chips (reusing the board's `TagChip` +
 * stored-color-or-hash treatment — tag-chip.tsx, lib/labels.ts) plus an
 * inline "add label" affordance. Edits write through `setLabels` (board.ts),
 * which replaces the ticket's label set wholesale, so every add/remove here
 * sends the full next array.
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

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ticket.labels.map((label) => (
        <span key={label} className="group/chip inline-flex items-center">
          <TagChip tag={label} color={resolveLabelColor(projectLabels, label)} />
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={() => remove(label)}
            className="-ml-1.5 flex size-4 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover/chip:opacity-100 hover:text-foreground"
          >
            <XIcon className="size-2.5" />
          </button>
        </span>
      ))}
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
