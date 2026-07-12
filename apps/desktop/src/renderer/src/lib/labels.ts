/**
 * Chip-color resolution for board labels: a project's `labelsByProject` slice
 * (board store) carries the first-class `Label` entities with their optional
 * stored `color`; a name alone (e.g. a ticket's `labels: string[]`, or a
 * facet option before any label row exists) has no color of its own. This is
 * the one place that bridges "a label name" to "the color to paint it" —
 * see `labelColor` in `@volli/shared` for the stored-color-wins/hash-fallback
 * rule itself.
 */
import { labelColor, type Label } from "@volli/shared";

/**
 * Resolves `name`'s chip color within `labels` (a project's label rows): a
 * stored {@link Label.color} wins when a matching row exists; otherwise the
 * deterministic hash fallback.
 */
export function resolveLabelColor(labels: readonly Label[] | undefined, name: string): string {
  const stored = labels?.find((label) => label.name === name);
  return labelColor({ name, color: stored?.color ?? null });
}
