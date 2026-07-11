/**
 * Deterministic tag colors. Tags are ad-hoc strings (`Ticket.tags: string[]`,
 * see `ticket.ts`) with no stored color, so a color is derived from the tag
 * text itself — the same round-robin-palette idea as `projectColor` in
 * `project-identity.ts`, but hashed rather than round-robin since tags aren't
 * assigned in creation order.
 *
 * This is an interim scheme: once labels become first-class entities with a
 * stored color, that stored value should win and this module goes away.
 */

/** Palette a tag color is hashed into. Order is data, not meaningful. */
export const TAG_COLORS = [
  "#D26A6A", // red
  "#D08948", // orange
  "#BFA43C", // yellow
  "#7FAE68", // green
  "#4FA8A0", // teal
  "#6E97CF", // blue
  "#9C7ED8", // violet
  "#C9709F", // pink
] as const;

/**
 * Hashes a tag string to a color in {@link TAG_COLORS} via FNV-1a (32-bit,
 * over Unicode code points, modulo palette length). FNV-1a was chosen after
 * checking spread over the demo-seed tags: every co-occurring pair on the
 * demo board's cards lands on distinct colors, so there's no visible
 * collision in practice.
 */
export function tagColor(tag: string): string {
  let hash = 2166136261;
  for (const ch of tag) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return TAG_COLORS[hash % TAG_COLORS.length]!;
}
