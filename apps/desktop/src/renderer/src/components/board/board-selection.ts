export interface TicketSelectionGesture {
  /** Command on macOS, Control on other platforms. */
  toggle: boolean;
  /** Extend from the most recent non-range selection. */
  range: boolean;
}

export interface TicketSelectionResult {
  selectedIds: string[];
  anchorId: string;
}

export interface TicketSelectionColumn {
  /** Every ticket in the clicked card's column, including filtered-out cards. */
  allIds: readonly string[];
  /** The currently visible cards in their rendered order. */
  visibleIds: readonly string[];
}

/**
 * Resolves one ticket click into the board's familiar desktop selection model:
 * plain click replaces, Command/Control toggles, Shift selects the visible
 * range, and Command/Control+Shift adds that range. Selection is scoped to the
 * clicked card's column; clicking another column starts a new selection. The
 * anchor survives a successful range selection so repeated Shift-clicks keep
 * extending from the same card.
 */
export function ticketSelectionAfterClick(
  currentIds: readonly string[],
  clickedId: string,
  column: TicketSelectionColumn,
  anchorId: string | null,
  gesture: TicketSelectionGesture,
): TicketSelectionResult {
  const columnIds = new Set(column.allIds);
  const scopedCurrentIds = currentIds.filter((id) => columnIds.has(id));
  const scopedAnchorId = anchorId !== null && columnIds.has(anchorId) ? anchorId : null;

  if (gesture.range && scopedAnchorId !== null) {
    const anchorIndex = column.visibleIds.indexOf(scopedAnchorId);
    const clickedIndex = column.visibleIds.indexOf(clickedId);
    if (anchorIndex !== -1 && clickedIndex !== -1) {
      const start = Math.min(anchorIndex, clickedIndex);
      const end = Math.max(anchorIndex, clickedIndex);
      const range = column.visibleIds.slice(start, end + 1);
      if (!gesture.toggle) return { selectedIds: range, anchorId: scopedAnchorId };

      const combined = new Set([...scopedCurrentIds, ...range]);
      // Visible ids take board order; any currently-selected filtered-out ids
      // from this column remain selected and trail in their existing order.
      const visible = column.visibleIds.filter((id) => combined.has(id));
      const visibleSet = new Set(column.visibleIds);
      const hidden = scopedCurrentIds.filter((id) => !visibleSet.has(id));
      return { selectedIds: [...visible, ...hidden], anchorId: scopedAnchorId };
    }
  }

  if (gesture.toggle) {
    const selectedIds = scopedCurrentIds.includes(clickedId)
      ? scopedCurrentIds.filter((id) => id !== clickedId)
      : [...scopedCurrentIds, clickedId];
    return { selectedIds, anchorId: clickedId };
  }

  return { selectedIds: [clickedId], anchorId: clickedId };
}
