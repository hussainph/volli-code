import { Button } from "@renderer/components/ui/button";
import type { DiffPresentation } from "@renderer/stores/ui";

export function DiffPresentationToggle({
  presentation,
  onChange,
}: {
  presentation: DiffPresentation;
  onChange(next: DiffPresentation): void;
}) {
  return (
    <div
      data-testid="ticket-diff-presentation"
      className="flex shrink-0 items-center gap-1 border-b border-border px-gutter py-1"
    >
      <Button
        size="sm"
        variant={presentation === "inline" ? "secondary" : "ghost"}
        aria-pressed={presentation === "inline"}
        onClick={() => onChange("inline")}
      >
        Inline
      </Button>
      <Button
        size="sm"
        variant={presentation === "side-by-side" ? "secondary" : "ghost"}
        aria-pressed={presentation === "side-by-side"}
        onClick={() => onChange("side-by-side")}
      >
        Side by side
      </Button>
    </div>
  );
}
