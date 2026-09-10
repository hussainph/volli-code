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

/**
 * The identity a label name is matched under: `UI` and `ui` are ONE label, so
 * `getOrCreateLabel` resolves an existing spelling instead of minting a second
 * one (VC-310).
 *
 * The fold is ASCII-only, deliberately, because it has to agree EXACTLY with
 * the `COLLATE NOCASE` unique index that backs it (migration 043). A JS
 * `toLowerCase()` would fold more than the index does, so the repo could report
 * `ü` taken by `Ü` while SQLite still stored both.
 *
 * SQLite's built-in collations stop comparing at the first NUL byte. JavaScript
 * strings can carry NUL through the Client Surface even though shell argv
 * cannot, so the key stops there too: `A\0x` and `a\0y` are one SQLite NOCASE
 * identity. Migration 043 groups with the collation itself for the same reason.
 *
 * It does not trim: the index sees leading and trailing spaces, so `" ui"` and
 * `"ui"` are genuinely different names. Trimming input is a separate concern
 * from deciding identity.
 */
export function labelNameKey(name: string): string {
  const nul = name.indexOf("\0");
  const significant = nul === -1 ? name : name.slice(0, nul);
  return significant.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());
}
