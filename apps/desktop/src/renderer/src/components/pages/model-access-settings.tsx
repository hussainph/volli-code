import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import * as React from "react";
import type {
  ModelAccessModel,
  ModelAccessProvider,
  ModelSelection,
  ReasoningLevel,
} from "@volli/shared";

import { ModelAccessAccounts } from "@renderer/components/pages/model-access-accounts";
import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Spinner } from "@renderer/components/ui/spinner";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { toastError } from "@renderer/lib/toast";

export function ModelAccessSettings() {
  const client = useModelAccessClient();
  const [models, setModels] = React.useState<readonly ModelAccessModel[]>([]);
  const [providers, setProviders] = React.useState<readonly ModelAccessProvider[]>([]);
  const [selection, setSelection] = React.useState<ModelSelection | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(
    async (refresh = false) => {
      if (!client) return;
      setLoading(true);
      try {
        const [access, configured] = await Promise.all([
          client.inspect({ refresh }),
          client.defaultSelection(),
        ]);
        setModels(access.models);
        setProviders(access.providers);
        setSelection(configured);
      } catch (error) {
        toastError(`Couldn't load models: ${errorMessage(error)}`);
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!client) return null;
  const offerable = offerableModels(models);
  const selectedModel = modelFor(models, selection);
  const valid = canSaveDefaultModel(selectedModel, selection);

  async function save(): Promise<void> {
    if (!selection || !valid || saving) return;
    setSaving(true);
    try {
      setSelection(await client!.setDefault(selection));
    } catch (error) {
      toastError(`Couldn't save the default model: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * The `retry` half of recovery, and all that is left here.
   *
   * Signing in used to be the other half and used to belong to this component,
   * because it was one call that opened a terminal and was done. It is now a
   * conversation with its own steps and its own cancellation, so it belongs to
   * the row that shows it — see `model-access-accounts.tsx`.
   */
  async function retry(): Promise<void> {
    await load(true);
  }

  return (
    <>
      <SettingsSection
        title="Default model"
        icon={CpuIcon}
        action={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh models"
            disabled={loading}
            onClick={() => void load(true)}
          >
            {loading ? (
              <Spinner className="size-3.5" />
            ) : (
              <ArrowClockwiseIcon className="size-3.5" />
            )}
          </Button>
        }
      >
        <SettingsRow label="Model">
          <Select
            // A stored default whose provider is signed out reads as unset,
            // because that is what it is: it names no model this profile can
            // run, and Save stays inert until one is picked.
            value={selectedModel?.state === "available" ? modelKey(selectedModel) : ""}
            disabled={loading || saving}
            onValueChange={(key) => {
              const model = offerable.find((candidate) => modelKey(candidate) === key);
              if (!model) return;
              setSelection({
                providerId: model.providerId,
                modelId: model.modelId,
                reasoningLevel: preferredReasoning(model, selection?.reasoningLevel),
              });
            }}
          >
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {offerable.map((model) => (
                <SelectItem key={modelKey(model)} value={modelKey(model)}>
                  {modelOptionLabel(model, providers)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="Reasoning">
          <Select
            value={selection?.reasoningLevel ?? ""}
            disabled={!selectedModel || saving}
            onValueChange={(reasoningLevel) => {
              if (!selection) return;
              setSelection({ ...selection, reasoningLevel: reasoningLevel as ReasoningLevel });
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Reasoning" />
            </SelectTrigger>
            <SelectContent>
              {(selectedModel?.reasoningLevels ?? []).map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!valid || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <ModelAccessAccounts
        providers={providers}
        onRecover={() => void retry()}
        onChanged={() => load(true)}
      />
    </>
  );
}

function modelFor(
  models: readonly ModelAccessModel[],
  selection: ModelSelection | null,
): ModelAccessModel | null {
  if (!selection) return null;
  return (
    models.find(
      (model) => model.providerId === selection.providerId && model.modelId === selection.modelId,
    ) ?? null
  );
}

export function preferredReasoning(
  model: ModelAccessModel,
  current: ReasoningLevel | undefined,
): ReasoningLevel {
  if (current !== undefined && model.reasoningLevels.includes(current)) return current;
  return model.reasoningLevels.at(-1) ?? "off";
}

/**
 * The models this profile can actually run, and the only ones ever offered.
 *
 * Pi's catalog is every provider it knows, signed in or not — around a thousand
 * models against the handful anyone has credentials for. Listing the rest as
 * disabled rows is not information: it buries the two that work, and eight
 * providers ship a model called exactly "GPT-5.6 Luna", so the row a person
 * lands on is decided by scroll position rather than by access.
 */
export function offerableModels(models: readonly ModelAccessModel[]): readonly ModelAccessModel[] {
  return models.filter((model) => model.state === "available");
}

export function canSaveDefaultModel(
  model: ModelAccessModel | null,
  selection: ModelSelection | null,
): boolean {
  return (
    model !== null &&
    model.state === "available" &&
    selection !== null &&
    (model.reasoningLevels.includes(selection.reasoningLevel) ||
      (model.reasoningLevels.length === 0 && selection.reasoningLevel === "off"))
  );
}

/**
 * `GPT-5.6 Luna · OpenAI Codex` — the provider is half the identity here.
 *
 * A model name is not unique across providers, and the difference between two
 * rows reading the same is a Session that cannot send its first message.
 */
export function modelOptionLabel(
  model: ModelAccessModel,
  providers: readonly ModelAccessProvider[],
): string {
  const provider = providers.find((candidate) => candidate.id === model.providerId);
  return `${model.label} · ${provider?.label ?? model.providerId}`;
}

function modelKey(model: Pick<ModelAccessModel, "providerId" | "modelId">): string {
  return JSON.stringify([model.providerId, model.modelId]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
