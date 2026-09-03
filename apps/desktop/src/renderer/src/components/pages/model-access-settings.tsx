/**
 * The Model Access pane: per-purpose default models, when a Session compacts,
 * the visibility curation every composer honors, and the provider accounts
 * underneath all three.
 *
 * Three defaults instead of one (VC-53): orchestration (project chats),
 * execution (Ticket Sessions), and cost-efficient utility work resolve
 * separately at Session creation. Ticket and Utility inherit the project
 * default until an explicit choice is made — the "Project default" option is
 * that inheritance stated as a value, never a silent substitution.
 *
 * Compaction is one switch, not a per-model surface. Per-model reserve
 * budgets used to sit on every model row and were retired (VC-155): a reserve
 * is a number nobody can pick by feel, and the executor defaults it sensibly.
 * The one question a person can actually answer — whether a Session may
 * interrupt them to make room — is the one control left.
 *
 * Every control saves on change. A Save button earned its place when there was
 * one selection to compose; three purposes and a control per model would
 * make this pane a form, and a picker whose choice does not hold is a picker
 * lying about what is configured.
 */
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import * as React from "react";
import { toast } from "sonner";
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  isModelHidden,
  withModelVisibility,
  type CompactionPolicy,
  type HiddenModelRef,
  type ModelAccessDefaults,
  type ModelAccessModel,
  type ModelAccessProvider,
  type ModelPurpose,
  type ModelSelection,
  type ReasoningLevel,
} from "@volli/shared";

import { ModelAccessAccounts } from "@renderer/components/pages/model-access-accounts";
import {
  refreshOutcome,
  type RefreshOutcome,
} from "@renderer/components/pages/model-access-refresh-model";
import {
  Cell,
  DataTable,
  PrefRow,
  PrefSection,
  TableSearch,
} from "@renderer/components/settings/kit";
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
import { useUiStore } from "@renderer/stores/ui";

/**
 * The rows of the Default models section, in resolution order.
 *
 * `hint` is the `(i)` a row carries when its purpose is not obvious from its
 * two-word label (VC-81 asked for one on the utility row): what the slot is
 * FOR, so a person picking a model for it knows what the bill is for.
 *
 * The Utility hint also names what happens when the slot is EMPTY, and that
 * half is not optional. Leaving it unset does not switch background work off;
 * those calls fall to the model each chat is already running under. That is a
 * fallback a person can be billed for, and CONTEXT.md's Model Access rule is
 * that Volli never falls back to another model silently.
 *
 * Held to the hint budget — twelve words — which is what turned three lines of
 * prose into one sentence without losing either fact.
 */
export const PURPOSE_ROWS: readonly {
  purpose: ModelPurpose;
  label: string;
  hint?: string;
}[] = [
  { purpose: "global", label: "Project chats" },
  { purpose: "ticket", label: "Ticket Sessions" },
  {
    purpose: "utility",
    label: "Utility",
    hint: "Naming chats and summarizing. Unset, they use the chat's own model.",
  },
];

/** The Select value that says "no explicit choice — resolve the project default". */
const INHERIT_VALUE = "__project-default__";

export function ModelAccessSettings({
  autoSignInProviderId,
}: { autoSignInProviderId?: string } = {}) {
  const client = useModelAccessClient();
  // The deep-linked sign-in, taken once and spent as it is taken.
  //
  // Held as this mount's own initial value, not read live: the store field is
  // cleared immediately (below), and the row underneath still needs the answer
  // for the rest of THIS visit. Switching category unmounts the pane, so the
  // next visit initializes from a field that now says nothing and starts no
  // auth flow — which is the point. A provider's browser sign-in is an external
  // act and belongs to the press that asked for it, not to the pane's mounting.
  const [deepLinkedProviderId] = React.useState(autoSignInProviderId);
  const consumeSignInRequest = useUiStore((state) => state.consumeSettingsSignIn);
  React.useEffect(() => {
    if (deepLinkedProviderId !== undefined) consumeSignInRequest();
  }, [deepLinkedProviderId, consumeSignInRequest]);
  const [models, setModels] = React.useState<readonly ModelAccessModel[]>([]);
  const [providers, setProviders] = React.useState<readonly ModelAccessProvider[]>([]);
  const [defaults, setDefaults] = React.useState<ModelAccessDefaults>(EMPTY_MODEL_ACCESS_DEFAULTS);
  const [hidden, setHidden] = React.useState<readonly HiddenModelRef[]>([]);
  const [compaction, setCompaction] = React.useState<CompactionPolicy>(DEFAULT_COMPACTION_POLICY);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  // Sign-in/out bumps the shared client revision while its explicit onChanged
  // refresh may still be in flight. Only the latest inspection may project
  // into this pane; otherwise a pre-sign-out snapshot can arrive last and put
  // Sign out back beside the newly correct Sign in button.
  const loadGeneration = React.useRef(0);

  const load = React.useCallback(
    async (refresh = false) => {
      if (!client) return;
      const generation = ++loadGeneration.current;
      setLoading(true);
      try {
        // A refresh may retire or rename ids, and main repairs defaults and
        // visibility as it applies the complete lists. Those preferences are
        // therefore read only after the inspection settles; folding them into
        // one Promise.all would race the repair and leave this visit showing
        // the stale value until the pane is reopened. An ordinary open has no
        // repair to wait for, so it still asks for everything at once.
        const access = refresh ? await client.inspect({ refresh: true }) : undefined;
        const [opened, configured, curated, policy] = await Promise.all([
          access ?? client.inspect({ refresh: false }),
          client.defaults(),
          client.hiddenModels(),
          client.compactionPolicy(),
        ]);
        if (generation !== loadGeneration.current) return;
        setModels(opened.models);
        setProviders(opened.providers);
        setDefaults(configured);
        setHidden(curated);
        setCompaction(policy);
        if (opened.refresh !== undefined) announceRefresh(refreshOutcome(opened.refresh));
      } catch (error) {
        if (generation === loadGeneration.current) {
          toastError(`Couldn't load models: ${errorMessage(error)}`);
        }
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
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
   * Optimistic and rolled back: a toggle that waits a round trip to move
   * reads as a switch that did not take.
   *
   * Nothing here tells a running Session. The runtime reads this policy off the
   * database at the moment it next considers compacting, so a Session already
   * mid-conversation is already under the new rule.
   */
  async function saveCompaction(next: CompactionPolicy) {
    const before = compaction;
    setCompaction(next);
    try {
      setCompaction(await client!.setCompactionPolicy(next));
    } catch (error) {
      setCompaction(before);
      toastError(`Couldn't save compaction settings: ${errorMessage(error)}`);
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

  return (
    <>
      <PrefSection
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
        {PURPOSE_ROWS.map(({ purpose, label, hint }) => (
          <DefaultModelRow
            key={purpose}
            purpose={purpose}
            label={label}
            hint={hint}
            selection={defaults[purpose]}
            models={models}
            offerable={defaultPickerModels(offerable, hidden, defaults[purpose])}
            providers={providers}
            disabled={loading || saving}
            onSave={(selection) => void saveDefault(purpose, selection)}
          />
        ))}
      </PrefSection>
      <PrefSection title="Compaction" icon={ArrowsInLineVerticalIcon}>
        <PrefRow label="Automatic compaction" testId="auto-compaction">
          <Switch
            aria-label="Compact a Session automatically before it fills its context window"
            checked={compaction.autoCompaction}
            disabled={loading}
            onCheckedChange={(autoCompaction) =>
              void saveCompaction({ ...compaction, autoCompaction })
            }
          />
        </PrefRow>
      </PrefSection>
      {offerable.length > 0 ? (
        <CatalogSection
          offerable={offerable}
          providers={providers}
          hidden={hidden}
          onSaveVisibility={(model, visible) => void saveVisibility(model, visible)}
        />
      ) : null}
      <ModelAccessAccounts
        providers={providers}
        autoSignInProviderId={deepLinkedProviderId}
        onRecover={() => void retry()}
        onChanged={() => load(true)}
      />
    </>
  );
}

/**
 * THE CATALOGUE AS A TABLE (VC-111), not a stack of rows grouped by a
 * provider paragraph.
 *
 * A signed-in profile can offer a hundred models. As rows this was a section
 * with no bottom: Accounts sat below it and was effectively unreachable, and
 * the provider — half a model's identity, since the same name ships from
 * several — was a heading you had to scroll back to rather than a value you
 * could read across. As a table it caps at eight rows and scrolls inside its
 * own box; provider becomes a column; the per-model control lines up in
 * columns of their own.
 *
 * SEARCH LIVES ON THE HEADER RAIL, beside the title — the same place and the
 * same w-56 field as "Available to connect" below it. It is the table's only
 * control, so a toolbar row for it alone drew a lone right-floating field
 * under an empty header rail. The query is owned HERE and handed down, which
 * is also why this is its own component: keystrokes re-render this section,
 * not the whole Models pane above it.
 */
function CatalogSection({
  offerable,
  providers,
  hidden,
  onSaveVisibility,
}: {
  offerable: readonly ModelAccessModel[];
  providers: readonly ModelAccessProvider[];
  hidden: readonly HiddenModelRef[];
  onSaveVisibility(model: HiddenModelRef, visible: boolean): void;
}) {
  const [query, setQuery] = React.useState("");

  return (
    <PrefSection
      title="Catalog"
      icon={EyeIcon}
      action={<TableSearch value={query} placeholder="Search models" onChange={setQuery} />}
    >
      <DataTable
        label="Model catalog"
        items={offerable}
        keyOf={(model) => `${model.providerId}/${model.modelId}`}
        rows={8}
        search={(model) => `${model.label} ${providerLabelFor(providers, model.providerId)}`}
        query={query}
        placeholder="Search models"
        empty="No models. Sign in to a provider below."
        noResults="No models match."
        columns={[
          { key: "name", header: "Model", cell: (model) => <Cell strong>{model.label}</Cell> },
          {
            key: "provider",
            header: "Provider",
            width: "10rem",
            cell: (model) => <Cell muted>{providerLabelFor(providers, model.providerId)}</Cell>,
          },
          // The Reserve column that sat here was retired with per-model
          // compaction reserves (VC-155) — a ladder of numbers nobody could
          // pick by feel; every Session runs on the executor's own reserve.
          {
            key: "shown",
            header: "Shown",
            width: "4rem",
            align: "end",
            headerHidden: true,
            cell: (model) => (
              <Switch
                aria-label={`Show ${model.label} by ${providerLabelFor(providers, model.providerId)} in pickers`}
                data-testid={`visibility-${model.providerId}-${model.modelId}`}
                checked={!isModelHidden(hidden, model)}
                onCheckedChange={(visible) => onSaveVisibility(model, visible)}
              />
            ),
          },
        ]}
      />
    </PrefSection>
  );
}

/**
 * One purpose's choice: the model, and the reasoning level beside it.
 *
 * A ticket/utility row carries "Project default" as an ordinary option rather
 * than a blank: unset is a real, resolvable value, and a Select that shows
 * nothing when the purpose inherits would read as unconfigured — which is the
 * one thing it is not.
 *
 * A row with a `hint` carries it as the `(i)` beside its label — rendered by
 * {@link PrefRow}, so every hint on both surfaces is the same glyph in the same
 * place, and the slot explains itself without a paragraph under the control
 * (CLAUDE.md's copy rule).
 */
function DefaultModelRow({
  purpose,
  label,
  hint,
  selection,
  models,
  offerable,
  providers,
  disabled,
  onSave,
}: {
  purpose: ModelPurpose;
  label: string;
  hint?: string;
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
    <PrefRow
      label={label}
      {...(hint === undefined ? {} : { hint })}
      testId={`default-model-${purpose}`}
    >
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
    </PrefRow>
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

/**
 * A provider's display name, or its id when the catalogue does not name it.
 *
 * The provider is half a model's identity — eight providers ship a model called
 * exactly "GPT-5.6 Luna" — so the Provider column exists to tell two identical
 * rows apart, and falling back to the id keeps it able to do that even for a
 * provider the profile has no metadata for.
 */
export function providerLabelFor(
  providers: readonly ModelAccessProvider[],
  providerId: string,
): string {
  return providers.find((provider) => provider.id === providerId)?.label ?? providerId;
}

function modelKey(model: Pick<ModelAccessModel, "providerId" | "modelId">): string {
  return JSON.stringify([model.providerId, model.modelId]);
}

/** Say one refresh outcome at the volume its kind earns. */
function announceRefresh(outcome: RefreshOutcome): void {
  if (outcome.kind === "failed") toastError(outcome.message);
  else if (outcome.kind === "issues") toast.warning(outcome.message);
  else if (outcome.kind === "changed") toast.success(outcome.message);
  else toast.info(outcome.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
