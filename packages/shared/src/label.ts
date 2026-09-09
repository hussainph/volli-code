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
 * the `COLLATE NOCASE` unique index that backs it (migration 043): SQLite's
 * NOCASE and its `lower()` both fold `A`-`Z` and nothing else. A JS
 * `toLowerCase()` here would fold more than the index does, and the two would
 * disagree on non-ASCII — the repo would report `ü` taken by `Ü` while the
 * index happily stored both. One rule, enforced in two places, has to BE one
 * rule. The cost is that names differing only in a non-ASCII letter's case
 * stay distinct labels, which is precisely what the database enforces.
 *
 * It does not trim, for the same reason: the index sees the stored name, so
 * `" ui"` and `"ui"` are genuinely different names. Trimming input is a
 * separate concern from deciding identity.
 */
export function labelNameKey(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());
}
