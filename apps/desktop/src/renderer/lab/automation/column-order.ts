/**
 * Per-column digit order for the drag picker.
 *
 * The studio board is where you arrange which automation is `1`–`9` when a card
 * is dragged over a column. Arming (which automation a *plain* drop fires) is a
 * different act — it lives on the board canvas, not here. This module only
 * answers "in what order do the digits read?"
 *
 * An automation that fires in two columns can sit at different ranks in each.
 * That is intentional: Needs Review may want "Two-opinion review" as `1` while
 * Doing wants "Implement" as `1`, and the same grill automation can be `2` in
 * Todo and `1` in Backlog.
 *
 * Lab session state is shared between the studio and the trigger scratch via
 * {@link useColumnOrder}, so reordering on one surface is what the other reads.
 */
import * as React from "react";
import { TICKET_STATUSES, type TicketStatus } from "@volli/shared";

import { triggerColumns, type Automation } from "./model";

/** Ordered automation ids per column. Missing columns fall back to seed order. */
export type ColumnOrder = Partial<Record<TicketStatus, string[]>>;

const MAX_DIGIT = 9;

/** Automations whose trigger names this column (board-scoped only — not off-board). */
export function candidatesForColumn(
  automations: readonly Automation[],
  status: TicketStatus,
): Automation[] {
  return automations.filter((automation) => {
    const columns = triggerColumns(automation.trigger);
    return columns !== "any" && columns.includes(status);
  });
}

/**
 * The list the drag picker offers for `status`, in digit order.
 *
 * Ids named in {@link ColumnOrder} come first, in that order. Anything new
 * (created after the last reorder, or never ranked) appends in the order the
 * automations array already had — so a fresh project without an order file
 * still gets a stable `1`–`n` from seed order.
 */
export function offeredForColumn(
  automations: readonly Automation[],
  status: TicketStatus,
  order: ColumnOrder,
): Automation[] {
  const candidates = candidatesForColumn(automations, status);
  const ranked = order[status] ?? [];
  const byId = new Map(candidates.map((automation) => [automation.id, automation]));
  const result: Automation[] = [];

  for (const id of ranked) {
    const automation = byId.get(id);
    if (automation === undefined) continue;
    result.push(automation);
    byId.delete(id);
  }
  for (const automation of candidates) {
    if (byId.has(automation.id)) result.push(automation);
  }
  return result.slice(0, MAX_DIGIT);
}

/** Digit shown on a card in a lane — `1`-based, or null past nine. */
export function digitFor(
  automations: readonly Automation[],
  status: TicketStatus,
  order: ColumnOrder,
  automationId: string,
): number | null {
  const index = offeredForColumn(automations, status, order).findIndex(
    (automation) => automation.id === automationId,
  );
  return index === -1 ? null : index + 1;
}

/**
 * Move one id within a column's ranking. Operates on the *current* offered
 * list so dragging works even before an explicit order has been written.
 */
export function reorderInColumn(
  automations: readonly Automation[],
  order: ColumnOrder,
  status: TicketStatus,
  fromIndex: number,
  toIndex: number,
): ColumnOrder {
  const ids = offeredForColumn(automations, status, order).map((automation) => automation.id);
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= ids.length ||
    toIndex >= ids.length ||
    fromIndex === toIndex
  ) {
    return order;
  }
  const next = [...ids];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return { ...order, [status]: next };
}

/** Drop an id from every column ranking (automation deleted). */
export function forgetAutomation(order: ColumnOrder, automationId: string): ColumnOrder {
  let changed = false;
  const next: ColumnOrder = {};
  for (const status of TICKET_STATUSES) {
    const ranked = order[status];
    if (ranked === undefined) continue;
    const filtered = ranked.filter((id) => id !== automationId);
    if (filtered.length !== ranked.length) changed = true;
    if (filtered.length > 0) next[status] = filtered;
  }
  return changed ? next : order;
}

/* ----------------------------------------------------------- lab session */

type Listener = () => void;

let columnOrder: ColumnOrder = {};
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

export function getColumnOrder(): ColumnOrder {
  return columnOrder;
}

export function setColumnOrder(next: ColumnOrder) {
  columnOrder = next;
  emit();
}

export function patchColumnOrder(recipe: (current: ColumnOrder) => ColumnOrder) {
  columnOrder = recipe(columnOrder);
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shared between the Automations studio board and the drag-picker scratch. */
export function useColumnOrder(): [ColumnOrder, (next: ColumnOrder) => void] {
  const order = React.useSyncExternalStore(subscribe, getColumnOrder, getColumnOrder);
  return [order, setColumnOrder];
}
