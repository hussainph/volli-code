import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";

import { TagChip } from "@renderer/components/board/tag-chip";
import { LabelEditorCore } from "@renderer/components/ticket/label-editor-core";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { resolveLabelColor } from "@renderer/lib/labels";
import { useBoardStore } from "@renderer/stores/board";

/**
 * The composer's Labels chip + popover: multi-select over the project's
 * existing labels plus free-typed new ones, driven by local `value`/`onChange`
 * (no persisted ticket yet). The popover body reuses the shared
 * {@link LabelEditorCore} in its always-input variant — its Enter commits a new
 * label without dismissing, and Escape closes only the popover (not the dialog)
 * because the popover is the topmost dismissable layer. Unselected project
 * labels are offered as one-click adds beneath the editor.
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
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]) ?? [];
  const unselected = projectLabels.filter((label) => !value.includes(label.name));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="h-7 gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground"
        >
          <TagIcon className="size-3.5" />
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
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <LabelEditorCore
          projectId={projectId}
          value={value}
          onChange={onChange}
          addPlaceholder="Add label…"
          alwaysInput
        />
        {unselected.length > 0 ? (
          <div className="flex flex-wrap gap-1 border-t border-border p-2">
            {unselected.map((label) => (
              <button
                key={label.id}
                type="button"
                onClick={() => onChange([...value, label.name])}
                className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <TagChip tag={label.name} color={resolveLabelColor(projectLabels, label.name)} />
              </button>
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
