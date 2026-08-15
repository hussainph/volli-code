import { tagColor } from "@volli/shared";

import { Badge } from "@renderer/components/ui/badge";

/**
 * A single ticket label rendered as a small pill, prefixed with a color dot.
 * `color` is the caller-resolved chip color (a stored `Label.color` wins —
 * see `lib/labels.ts`'s `resolveLabelColor`); when omitted this falls back to
 * the deterministic hash directly, for callers with no label rows to look up.
 *
 * The one chip in the app that overrides the badge's padding: several of these
 * wrap onto a board card under a two-line title, where the standard `px-2 py-1`
 * makes a row of three labels the loudest thing on the card.
 */
export function TagChip({ tag, color }: { tag: string; color?: string }) {
  return (
    <Badge className="px-1 py-px">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? tagColor(tag) }}
      />
      {tag}
    </Badge>
  );
}
