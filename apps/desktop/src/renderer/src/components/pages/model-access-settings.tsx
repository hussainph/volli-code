/**
 * The Model Access pane: per-purpose default models, the visibility curation
 * every composer honors, and the provider accounts underneath both.
 *
 * Three defaults instead of one (VC-53): orchestration (project chats),
 * execution (Ticket Sessions), and cost-efficient utility work resolve
 * separately at Session creation. Ticket and Utility inherit the project
 * default until an explicit choice is made — the "Project default" option is
 * that inheritance stated as a value, never a silent substitution.
 *
 * Every control saves on change. A Save button earned its place when there was
 * one selection to compose; three purposes and a switch per model would make
 * this pane a form, and a picker whose choice does not hold is a picker lying
 * about what is configured.
 */
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import * as React from "react";
import {
  EMPTY_MODEL_ACCESS_DEFAULTS,
  isModelHidden,
  withModelVisibility,
  type HiddenModelRef,
  type ModelAccessDefaults,
  type ModelAccessModel,
  type ModelAccessProvider,
  type ModelPurpose,
  type ModelSelection,
  type ReasoningLevel,
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
import { Switch } from "@renderer/components/ui/switch";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { toastError } from "@renderer/lib/toast";

/** The rows of the Default models section, in resolution order. */
const PURPOSE_ROWS: readonly { purpose: ModelPurpose; label: string }[] = [
  { purpose: "global", label: "Project chats" },
  { purpose: "ticket", label: "Ticket Sessions" },
  { purpose: "utility", label: "Utility" },
];

/** The Select value that says "no explicit choice — resolve the project default". */
const INHERIT_VALUE = "__project-default__";

export function ModelAccessSettings({
  autoSignInProviderId,
}: { autoSignInProviderId?: string } = {}) {
  const client = useModelAccessClient();
  const [models, setModels] = React.useState<readonly ModelAccessModel[]>([]);
  const [providers, setProviders] = React.useState<readonly ModelAccessProvider[]>([]);
  const [defaults, setDefaults] = React.useState<ModelAccessDefaults>(EMPTY_MODEL_ACCESS_DEFAULTS);
  const [hidden, setHidden] = React.useState<readonly HiddenModelRef[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(
    async (refresh = false) => {
      if (!client) return;
      setLoading(true);
      try {
        const [access, configured, curated] = await Promise.all([
          client.inspect({ refresh }),
          client.defaults(),
          client.hiddenModels(),
        ]);
        setModels(access.models);
        setProviders(access.providers);
        setDefaults(configured);
        setHidden(curated);
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

  async function saveDefault(purpose: ModelPurpose, selection: ModelSelection | null) {
    if (saving) return;
    setSaving(true);
    try {
      setDefaults(await client!.setDefault(purpose, selection));
    } catch (error) {
      toastError(`Couldn't save the default model: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveVisibility(model: HiddenModelRef, visible: boolean) {
    // Optimistic: the switch is the state, and a toggle that waits a round
    // trip to move reads as a switch that did not take. The write's answer
    // (or its failure) settles it.
    const next = withModelVisibility(hidden, model, visible);
    const before = hidden;
    setHidden(next);
    try {
      setHidden(await client!.setHiddenModels(next));
    } catch (error) {
      setHidden(before);
      toastError(`Couldn't save model visibility: ${errorMessage(error)}`);
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

  const offerable = offerableModels(models);
  const groups = availableModelsByProvider(models, providers);

  return (
    <>
      <SettingsSection
        title="Default models"
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
        {PURPOSE_ROWS.map(({ purpose, label }) => (
          <DefaultModelRow
            key={purpose}
            purpose={purpose}
            label={label}
            selection={defaults[purpose]}
            models={models}
            offerable={defaultPickerModels(offerable, hidden, defaults[purpose])}
            providers={providers}
            disabled={loading || saving}
            onSave={(selection) => void saveDefault(purpose, selection)}
          />
        ))}
      </SettingsSection>
      {groups.length > 0 ? (
        <SettingsSection title="Visible models" icon={EyeIcon}>
          {groups.map((group) => (
            <React.Fragment key={group.providerId}>
              <p className="pt-2 pb-1 text-ui font-medium text-muted-foreground first:pt-1">
                {group.providerLabel}
              </p>
              {group.models.map((model) => (
                <SettingsRow
                  key={`${model.providerId}/${model.modelId}`}
                  label={model.label}
                  testId={`visibility-${model.providerId}-${model.modelId}`}
                >
                  <Switch
                    aria-label={`Show ${model.label} in pickers`}
                    checked={!isModelHidden(hidden, model)}
                    onCheckedChange={(visible) => void saveVisibility(model, visible)}
                  />
                </SettingsRow>
              ))}
            </React.Fragment>
          ))}
        </SettingsSection>
      ) : null}
      <ModelAccessAccounts
        providers={providers}
        loading={loading}
        autoSignInProviderId={autoSignInProviderId}
        onRecover={() => void retry()}
        onChanged={() => load(true)}
      />
    </>
  );
}

/**
 * One purpose's choice: the model, and the reasoning level beside it.
 *
 * A ticket/utility row carries "Project default" as an ordinary option rather
 * than a blank: unset is a real, resolvable value, and a Select that shows
 * nothing when the purpose inherits would read as unconfigured — which is the
 * one thing it is not.
 */
function DefaultModelRow({
  purpose,
  label,
  selection,
  models,
  offerable,
  providers,
  disabled,
  onSave,
}: {
  purpose: ModelPurpose;
  label: string;
  selection: ModelSelection | null;
  models: readonly ModelAccessModel[];
  offerable: readonly ModelAccessModel[];
  providers: readonly ModelAccessProvider[];
  disabled: boolean;
  onSave(selection: ModelSelection | null): void;
}) {
  const inheritable = purpose !== "global";
  const selectedModel = modelFor(models, selection);
  // A stored default whose provider is signed out reads as unset, because that
  // is what it is: it names no model this profile can run.
  const value =
    selection === null
      ? inheritable
        ? INHERIT_VALUE
        : ""
      : selectedModel?.state === "available"
        ? modelKey(selectedModel)
        : "";

  return (
    <SettingsRow label={label} testId={`default-model-${purpose}`}>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(key) => {
          if (key === INHERIT_VALUE) {
            onSave(null);
            return;
          }
          const model = offerable.find((candidate) => modelKey(candidate) === key);
          if (!model) return;
          onSave({
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
          {inheritable ? <SelectItem value={INHERIT_VALUE}>Project default</SelectItem> : null}
          {offerable.map((model) => (
            <SelectItem key={modelKey(model)} value={modelKey(model)}>
              {modelOptionLabel(model, providers)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={selection?.reasoningLevel ?? ""}
        disabled={disabled || selection === null || selectedModel === null}
        onValueChange={(reasoningLevel) => {
          if (selection === null) return;
          onSave({ ...selection, reasoningLevel: reasoningLevel as ReasoningLevel });
        }}
      >
        <SelectTrigger className="w-32">
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
    </SettingsRow>
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

/**
 * What a default picker lists: the offerable catalog minus the user's hidden
 * models — plus the currently configured model even when hidden, because a
 * value the control holds and cannot name is a control that looks broken.
 */
export function defaultPickerModels(
  offerable: readonly ModelAccessModel[],
  hidden: readonly HiddenModelRef[],
  current: ModelSelection | null,
): readonly ModelAccessModel[] {
  return offerable.filter(
    (model) =>
      !isModelHidden(hidden, model) ||
      (current !== null &&
        model.providerId === current.providerId &&
        model.modelId === current.modelId),
  );
}

/** One provider's offerable models, for the visibility switches. */
export interface ProviderModelGroup {
  providerId: string;
  providerLabel: string;
  models: readonly ModelAccessModel[];
}

/**
 * The offerable catalog grouped per provider, providers and models each in
 * label order. Only signed-in providers have offerable models, so the section
 * this feeds never lists forty providers of nothing.
 */
export function availableModelsByProvider(
  models: readonly ModelAccessModel[],
  providers: readonly ModelAccessProvider[],
): readonly ProviderModelGroup[] {
  const groups = new Map<string, ModelAccessModel[]>();
  for (const model of offerableModels(models)) {
    const group = groups.get(model.providerId);
    if (group) group.push(model);
    else groups.set(model.providerId, [model]);
  }
  return [...groups.entries()]
    .map(([providerId, grouped]) => ({
      providerId,
      providerLabel: providers.find((provider) => provider.id === providerId)?.label ?? providerId,
      models: grouped.toSorted((a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true }),
      ),
    }))
    .toSorted((a, b) =>
      a.providerLabel.localeCompare(b.providerLabel, undefined, { numeric: true }),
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
