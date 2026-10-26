import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";

import { Button } from "@renderer/components/ui/button";

/**
 * The visible way out of a tab group (VC-614): on the trailing edge of each
 * group pane's own strip, it takes that pane's front tab out of the group and
 * shows it full width. Nothing closes — the rest of the group stays as it was,
 * and a group left with one pane dissolves into ordinary tabs.
 *
 * Dragging the tab up to the top strip does the same, and the chip's menu can
 * Ungroup the whole group; neither is something a person finds by looking.
 * This is the one that says what it does where the tab already is.
 */
export function PaneTakeOutButton({ onTakeOut }: { onTakeOut(): void }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      data-slot="pane-take-out"
      className="mr-1"
      aria-label="Take out of group"
      title="Take out of group"
      onClick={onTakeOut}
    >
      <ArrowSquareOutIcon weight="bold" className="size-3" />
    </Button>
  );
}
