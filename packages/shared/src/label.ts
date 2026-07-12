/**
 * Labels: first-class, project-scoped entities backing the board's tag
 * chips (`labels`/`ticket_labels` tables, migration 001). Replaces the old
 * ad-hoc `Ticket.tags: string[]` — see `tag-color.ts`'s module doc for the
 * color-resolution story this module completes.
 */

import { tagColor } from "./tag-color";

/** A project-scoped label. */
export interface Label {
  id: string;
  projectId: string;
  name: string;
  /** `null` means "derive by hash" — see {@link labelColor}. A stored color wins. */
  color: string | null;
}

/**
 * Resolves the color to render a label chip with: a stored {@link
 * Label.color} wins; otherwise it's derived by hashing the name
 * ({@link tagColor}).
 */
export function labelColor(label: Pick<Label, "name" | "color">): string {
  return label.color ?? tagColor(label.name);
}
