import { tagColor } from "@volli/shared";

/** A single ticket tag rendered as a small pill, prefixed with a deterministic color dot. */
export function TagChip({ tag }: { tag: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-[11px] leading-4 text-muted-foreground">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: tagColor(tag) }}
      />
      {tag}
    </span>
  );
}
