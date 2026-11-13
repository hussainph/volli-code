/**
 * The bead's rise above the Activity Island, handed to the transcript's
 * jump-to-latest button and the clear band behind it, so the button never
 * shares its spot above the composer with the bead (VC-1210).
 *
 * Layout sees the island as its 32px box, and the composer's measured height
 * already includes that box. What it cannot see is the bead the island draws
 * above it while a turn runs beside clusters. The island's draw loop already
 * computes that shape every frame, so it publishes the rise here, and this
 * writes it as one custom property on each attached element: a style write,
 * never a layout read. The property is registered non-inheriting in
 * `globals.css`, so a change restyles the attached elements alone, not the
 * transcript beneath them.
 */
export const ISLAND_CLEARANCE_PROPERTY = "--island-clearance";

export interface IslandClearance {
  /** The rise in px; repeated or sub-half-pixel changes write nothing. */
  publish(px: number): void;
  /** A ref callback for an element that must stay clear of the bead. */
  attach(node: HTMLElement | null): (() => void) | undefined;
}

export function createIslandClearance(): IslandClearance {
  let value = 0;
  const nodes = new Set<HTMLElement>();
  const write = (node: HTMLElement) =>
    node.style.setProperty(ISLAND_CLEARANCE_PROPERTY, `${value}px`);
  return {
    publish(px) {
      const next = Math.max(0, Math.round(px * 2) / 2);
      if (next === value) return;
      value = next;
      nodes.forEach(write);
    },
    attach(node) {
      if (node === null) return undefined;
      nodes.add(node);
      write(node);
      return () => {
        nodes.delete(node);
      };
    },
  };
}
