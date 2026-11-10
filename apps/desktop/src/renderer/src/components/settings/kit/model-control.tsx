import { ModelPill, type ComposerModel } from "@renderer/components/chat/composer-ui";
import type { ModelAccessModel, ModelAccessProvider, ModelSelection } from "@volli/shared";

/** The composer's searchable provider-filtered picker, with inheritance as a non-model choice. */
export function ModelControl({
  models,
  providers,
  selection,
  inherit,
  disabled,
  onChange,
}: {
  models: readonly ModelAccessModel[];
  providers: readonly ModelAccessProvider[];
  selection: ModelSelection | null;
  inherit?: string | null;
  disabled: boolean;
  onChange(next: ModelSelection | null): void;
}) {
  const items: ComposerModel[] = models.map((model) => ({
    ...model,
    id: `${model.providerId}/${model.modelId}`,
    providerLabel: providers.find((p) => p.id === model.providerId)?.label ?? model.providerId,
  }));
  if (inherit)
    items.unshift({
      id: "__inherit__",
      providerId: "",
      providerLabel: "",
      modelId: "__inherit__",
      label: inherit,
      reasoningLevels: [],
    });
  const picked = models.find(
    (m) => m.providerId === selection?.providerId && m.modelId === selection.modelId,
  );
  const value = selection ?? {
    providerId: "",
    modelId: inherit ? "__inherit__" : "",
    reasoningLevel: "off",
  };
  return (
    <div className="@container/composer w-80 max-w-full" data-composer-container="settings">
      <ModelPill
        models={items}
        selection={value}
        disabled={disabled}
        onChange={(next) => {
          if (next.modelId === "__inherit__" && next.providerId === "") {
            onChange(null);
            return;
          }
          const model = models.find(
            (m) => m.providerId === next.providerId && m.modelId === next.modelId,
          );
          if (!model) return;
          const reasoningLevel =
            model.reasoningLevels.find((level) => level === next.reasoningLevel) ??
            model.reasoningLevels.at(-1) ??
            "off";
          onChange({ providerId: model.providerId, modelId: model.modelId, reasoningLevel });
        }}
        compactEffort={
          picked && selection
            ? {
                levels: picked.reasoningLevels,
                value: selection.reasoningLevel,
                onChange: (next) => {
                  const reasoningLevel = picked.reasoningLevels.find((level) => level === next);
                  if (reasoningLevel) onChange({ ...selection, reasoningLevel });
                },
              }
            : undefined
        }
      />
    </div>
  );
}
