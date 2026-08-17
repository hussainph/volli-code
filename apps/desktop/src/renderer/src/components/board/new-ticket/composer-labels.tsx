import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import type { Label } from "@volli/shared";

import { composerChipClass } from "@renderer/components/board/new-ticket/composer-chip";
import { LabelPickerPopover } from "@renderer/components/ticket/label-picker";
import { Button } from "@renderer/components/ui/button";
import { resolveLabelColor } from "@renderer/lib/labels";
import { useBoardStore } from "@renderer/stores/board";

// Stable fallback for a project with no label rows — an inline `?? []` mints a
// fresh array identity on every render of a label-less project's composer.
const NO_LABELS: readonly Label[] = [];

/**
 * The composer's Labels chip: the shared {@link LabelPickerPopover} hung off a
 * chip that shows what has been picked, driven by local `value`/`onChange`
 * (no persisted ticket yet). The picker offers the project's existing labels
 * and takes a new name typed into its field; Escape closes only the popover
 * (not the composer dialog) because the popover is the topmost dismissable
 * layer.
 */
export function ComposerLabels({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]) ?? NO_LABELS;

  return (
    <LabelPickerPopover projectId={projectId} value={value} onChange={onChange}>
      <Button variant="ghost" size="sm" className={composerChipClass()}>
        <TagIcon />
        {value.length === 0 ? (
          "Labels"
        ) : (
          <span className="flex items-center gap-1">
            {value.slice(0, 3).map((label) => (
              <span
                key={label}
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ backgroundColor: resolveLabelColor(projectLabels, label) }}
              />
            ))}
            {value.length} {value.length === 1 ? "label" : "labels"}
          </span>
        )}
      </Button>
    </LabelPickerPopover>
  );
}
