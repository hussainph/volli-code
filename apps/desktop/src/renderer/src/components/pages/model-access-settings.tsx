import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import * as React from "react";
import type {
  ModelAccessModel,
  ModelAccessProvider,
  ModelAccessRecovery,
  ModelSelection,
  ReasoningLevel,
} from "@volli/shared";

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
  const [recoveringProviderId, setRecoveringProviderId] = React.useState<string | null>(null);

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

  async function recover(provider: ModelAccessProvider): Promise<void> {
    if (provider.recovery === null || recoveringProviderId !== null) return;
    if (provider.recovery.kind === "retry") {
      await load(true);
      return;
    }
    setRecoveringProviderId(provider.id);
    try {
      await client!.openExternalSignIn();
    } catch (error) {
      toastError(`Couldn't open Model Access: ${errorMessage(error)}`);
    } finally {
      setRecoveringProviderId(null);
    }
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
            value={selection === null ? "" : modelKey(selection)}
            disabled={loading || saving}
            onValueChange={(key) => {
              const model = models.find((candidate) => modelKey(candidate) === key);
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
              {models.map((model) => (
                <SelectItem
                  key={modelKey(model)}
                  value={modelKey(model)}
                  disabled={model.state === "unavailable"}
                >
                  {modelOptionLabel(model)}
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
        loading={loading}
        recoveringProviderId={recoveringProviderId}
        onRecover={recover}
      />
    </>
  );
}

export function ModelAccessAccounts({
  providers,
  loading,
  recoveringProviderId,
  onRecover,
}: {
  providers: readonly ModelAccessProvider[];
  loading: boolean;
  recoveringProviderId: string | null;
  onRecover(provider: ModelAccessProvider): void | Promise<void>;
}) {
  if (providers.length === 0) return null;
  return (
    <SettingsSection title="Accounts">
      {providers.map((provider) => (
        <SettingsRow key={provider.id} label={provider.label}>
          <span className="text-xs text-muted-foreground">{providerAccessLabel(provider)}</span>
          {provider.recovery === null ? null : (
            <Button
              size="sm"
              variant="secondary"
              disabled={loading || recoveringProviderId !== null}
              onClick={() => void onRecover(provider)}
            >
              {providerRecoveryActionLabel(provider.recovery)}
            </Button>
          )}
        </SettingsRow>
      ))}
    </SettingsSection>
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

export function canSaveDefaultModel(
  model: ModelAccessModel | null,
  selection: ModelSelection | null,
): boolean {
  return (
    model !== null &&
    model.state !== "unavailable" &&
    selection !== null &&
    model.reasoningLevels.includes(selection.reasoningLevel)
  );
}

export function modelOptionLabel(model: ModelAccessModel): string {
  if (model.state === "authentication-required") return `${model.label} — Sign in required`;
  if (model.state === "unavailable") return `${model.label} — Unavailable`;
  return model.label;
}

export function providerAccessLabel(provider: ModelAccessProvider): string {
  const access =
    provider.state === "authentication-required"
      ? "Sign in required"
      : provider.state === "unavailable"
        ? "Unavailable"
        : (provider.accountLabel ?? "Available");
  const billing = provider.billingSource
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
  return `${access} · ${billing}`;
}

export function providerRecoveryActionLabel(recovery: ModelAccessRecovery | null): string | null {
  if (recovery === null) return null;
  return recovery.kind === "external-sign-in" ? "Sign in" : "Retry";
}

function modelKey(model: Pick<ModelAccessModel, "providerId" | "modelId">): string {
  return JSON.stringify([model.providerId, model.modelId]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
