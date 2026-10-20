import type { ModelSelection } from "@volli/shared";

import { ModelName } from "@renderer/components/models/model-identity";
import { useModelCatalogue } from "@renderer/lib/use-model-catalogue";

/**
 * A durable model reference rendered like the composer and Settings pickers.
 * Resolve both IDs, including gateway IDs containing slashes. Never prettify an
 * unknown ID into a guessed name, or let display resolution change the policy.
 */
export function ResolvedModelName({
  selection,
  providerLabel,
  trailing,
  alwaysProvider = false,
  className,
}: {
  selection: Pick<ModelSelection, "providerId" | "modelId">;
  /** A caller's known provider name while the catalogue is unavailable. */
  providerLabel?: string;
  trailing?: string;
  alwaysProvider?: boolean;
  className?: string;
}) {
  const catalogue = useModelCatalogue();
  const listed = catalogue?.models.find(
    (model) => model.providerId === selection.providerId && model.modelId === selection.modelId,
  );
  const model = listed ?? { ...selection, label: selection.modelId };
  const provider =
    catalogue?.providers.find((candidate) => candidate.id === selection.providerId)?.label ??
    (providerLabel || selection.providerId);

  return (
    <ModelName
      model={model}
      models={catalogue?.models ?? []}
      providerLabel={provider}
      alwaysProvider={alwaysProvider || listed === undefined}
      trailing={trailing}
      className={className}
    />
  );
}
