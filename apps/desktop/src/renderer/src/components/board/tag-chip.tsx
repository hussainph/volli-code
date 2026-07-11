/** A single ticket tag rendered as a small pill. */
export function TagChip({ tag }: { tag: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-1.5 py-px text-[11px] leading-4 text-muted-foreground">
      {tag}
    </span>
  );
}
