import { tagColor } from "@volli/shared";

/**
 * A single ticket label rendered as a small pill, prefixed with a color dot.
 * `color` is the caller-resolved chip color (a stored `Label.color` wins —
 * see `lib/labels.ts`'s `resolveLabelColor`); when omitted this falls back to
 * the deterministic hash directly, for callers with no label rows to look up.
 */
export function TagChip({ tag, color }: { tag: string; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-[11px] leading-4 text-muted-foreground">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? tagColor(tag) }}
      />
      {tag}
    </span>
  );
}
