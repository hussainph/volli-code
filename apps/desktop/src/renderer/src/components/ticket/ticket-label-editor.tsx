import type { Ticket } from "@volli/shared";

import { LabelEditorCore } from "@renderer/components/ticket/label-editor-core";
import { useBoardStore } from "@renderer/stores/board";

/**
 * Ticket labels as removable chips plus an inline "add label" affordance — a
 * thin wrapper over the shared {@link LabelEditorCore} (the composer's Labels
 * menu wraps the same core). Every add/remove writes through `setLabels`
 * (board.ts), which replaces the ticket's label set wholesale, so this hands
 * the core the ticket's current labels as `value` and turns each `onChange`
 * into the full next array. Right-clicking a chip that has a project row opens
 * the core's color menu, which persists a picked swatch via `setLabelColor` —
 * the color then shows up everywhere the label renders (board chips, filter
 * dots), since they all resolve through the same `labelsByProject` slice.
 */
export function TicketLabelEditor({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  return (
    <LabelEditorCore
      projectId={projectId}
      value={ticket.labels}
      onChange={(next) => void useBoardStore.getState().setLabels(ticket.id, next)}
    />
  );
}
