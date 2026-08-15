import { Segmented } from "@renderer/components/ui/segmented";
import type { DiffPresentation } from "@renderer/stores/ui";

const PRESENTATIONS = [
  { key: "inline", label: "Inline" },
  { key: "side-by-side", label: "Side by side" },
] as const satisfies readonly { key: DiffPresentation; label: string }[];

export function DiffPresentationToggle({
  presentation,
  onChange,
}: {
  presentation: DiffPresentation;
  onChange(next: DiffPresentation): void;
}) {
  return (
    <Segmented
      ariaLabel="Diff presentation"
      testId="ticket-diff-presentation"
      value={presentation}
      options={PRESENTATIONS}
      className="shrink-0 border-b border-border px-gutter py-1"
      onChange={onChange}
    />
  );
}
