import {
  availableModelsByProvider,
  defaultPickerModels,
  offerableModels,
  providerLabelFor,
} from "@renderer/components/pages/model-access-settings";
import { OverrideLinks } from "../settings-navigation";
import { useProjectsStore } from "@renderer/stores/projects";
import {
  RefreshIcon,
  CollapseVerticalIcon,
  ProcessorIcon,
  PreviewIcon,
} from "@renderer/components/ui/icon";

import * as React from "react";
import { toast } from "sonner";
import {
  acceptsImageInputIn,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  isModelHidden,
  MODEL_TIER_ROWS,
  modelTierFallback,
  resolveModelTier,
  withModelVisibility,
  type CompactionPolicy,
  type HiddenModelRef,
  type ModelAccessDefaults,
  type ModelAccessModel,
  type ModelAccessProvider,
  type ModelPurpose,
  type ModelSelection,
} from "@volli/shared";

import { ModelName } from "@renderer/components/models/model-identity";
import { DecisionModelSettings } from "./decision-model-pane";
import { CodeModeSettings } from "./code-mode-pane";
import { ModelAccessAccounts } from "./provider-accounts";
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
import { Spinner } from "@renderer/components/ui/spinner";
import { Switch } from "@renderer/components/ui/switch";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { toastError } from "@renderer/lib/toast";
import { ModelControl } from "../kit/model-control";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Notice } from "@renderer/components/ui/notice";
import { useUiStore } from "@renderer/stores/ui";

const PURPOSE_ROWS: readonly {
  purpose: ModelPurpose;
  label: string;
  depth: 0 | 1;
}[] = (["global", "utility", "ticket", "fast", "deep", "visual"] as const).map((purpose) => {
  const row = MODEL_TIER_ROWS.find((candidate) => candidate.tier === purpose)!;
  return {
    purpose,
    label: row.label,
    depth: purpose === "global" || purpose === "ticket" || !row.advanced ? 0 : 1,
  };
});

function inheritLabel(purpose: ModelPurpose): string | null {
  if (purpose === "utility") return "Inherit from chat";
  const fallback = modelTierFallback(purpose);
  if (fallback === null) return null;
  return `Same as ${MODEL_TIER_ROWS.find((row) => row.tier === fallback)?.label ?? fallback}`;
}

export function ModelAccessSettings({
  autoSignInProviderId,
  hostName,
  agents = false,
}: { autoSignInProviderId?: string; hostName?: string; agents?: boolean } = {}) {
  const projects = useProjectsStore((state) => state.projects);
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
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current += 1;
    };
  }, []);
  const [saving, setSaving] = React.useState(false);
  // A sign-in the Decision model section asked for (VC-478): the Accounts list
  // remounts under a new key so the named provider's row presses its own
  // sign-in on arrival, exactly as a deep link from a chat blocker does.
  const [decisionSignIn, setDecisionSignIn] = React.useState<{
    providerId: string;
    nonce: number;
  } | null>(null);
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
        if (!mounted.current) return;
        // Said the moment the refresh answered, not after the reads below.
        // The shared revision's bump wakes this pane too, and the pass it
        // wakes sees the refreshed catalog with no report of its own — so a
        // pass that only re-reads says nothing, and this is the one that
        // pressed Refresh and says what it did.
        if (mounted.current && access !== undefined && access.refresh !== undefined) {
          announceRefresh(refreshOutcome(access.refresh));
        }
        const [opened, configured, curated, policy] = await Promise.all([
          access ?? client.inspect({ refresh: false }),
          client.defaults(),
          client.hiddenModels(),
          client.compactionPolicy(),
        ]);
        if (!mounted.current || generation !== loadGeneration.current) return;
        setLoadError(null);
        setModels(opened.models);
        setProviders(opened.providers);
        setDefaults(configured);
        setHidden(curated);
        setCompaction(policy);
      } catch (error) {
        if (generation === loadGeneration.current) {
          setLoadError(errorMessage(error));
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

  if (!client) return <Notice tone="neutral" title="Models are unavailable on this host." />;

  async function saveDefault(purpose: ModelPurpose, selection: ModelSelection | null) {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await client!.setDefault(purpose, selection);
      if (mounted.current) setDefaults(saved);
    } catch (error) {
      if (mounted.current) toastError(`Couldn't save the default model: ${errorMessage(error)}`);
    } finally {
      if (mounted.current) setSaving(false);
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
      const saved = await client!.setHiddenModels(next);
      if (mounted.current) setHidden(saved);
    } catch (error) {
      if (mounted.current) {
        setHidden(before);
        toastError(`Couldn't save model visibility: ${errorMessage(error)}`);
      }
    }
  }

  async function saveCompaction(next: CompactionPolicy) {
    const before = compaction;
    setCompaction(next);
    try {
      const saved = await client!.setCompactionPolicy(next);
      if (mounted.current) setCompaction(saved);
    } catch (error) {
      if (mounted.current) {
        setCompaction(before);
        toastError(`Couldn't save compaction settings: ${errorMessage(error)}`);
      }
    }
  }

  async function retry(): Promise<void> {
    await load(true);
  }

  if (hostName !== undefined && loadError !== null)
    return (
      <div role="alert" className="flex items-center justify-between gap-4 text-ui">
        <span>Couldn’t load models on {hostName}</span>
        <Button size="sm" disabled={loading} onClick={() => void load()}>
          Retry now
        </Button>
      </div>
    );

  const offerable = offerableModels(models);
  const sees = acceptsImageInputIn(models);

  const renderDefaultRow = ({ purpose, label }: (typeof PURPOSE_ROWS)[number]) => (
    <DefaultModelRow
      key={purpose}
      purpose={purpose}
      label={label}
      selection={defaults[purpose]}
      // Only Visual can inherit a rung and still be refused — a Ticket model
      // that cannot read images — and only that is said. An empty ladder is
      // one problem with one fix, and Board's own "Choose a model" is it.
      blocked={purpose === "visual" && resolveModelTier(defaults, purpose, sees) === null}
      models={models}
      offerable={defaultPickerModels(offerable, hidden, defaults[purpose], purpose)}
      providers={providers}
      disabled={loading || saving}
      onSave={(selection) => void saveDefault(purpose, selection)}
    />
  );

  return (
    <>
      {loadError !== null ? (
        <Notice
          tone="error"
          title="Couldn't read model settings"
          detail={loadError}
          actions={
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : null}
      {hostName === undefined && !agents && loading && providers.length === 0 ? (
        <PrefSection title="Accounts" icon={ProcessorIcon}>
          <div className="space-y-4 p-4" aria-label="Loading model accounts">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </PrefSection>
      ) : null}
      {hostName === undefined && !agents ? (
        <ModelAccessAccounts
          key={decisionSignIn?.nonce ?? 0}
          providers={providers}
          autoSignInProviderId={decisionSignIn?.providerId ?? deepLinkedProviderId}
          onRecover={() => void retry()}
          onChanged={() => load(true)}
        />
      ) : null}
      {!agents && (
        <PrefSection
          title="Default models"
          icon={ProcessorIcon}
          action={
            <div className="flex flex-wrap items-center gap-2">
              {hostName === undefined ? (
                <OverrideLinks
                  projects={projects.filter((p) => p.sessionModel != null)}
                  page="sessions"
                />
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh models"
                disabled={loading}
                onClick={() => void load(true)}
              >
                {loading ? <Spinner className="size-3.5" /> : <RefreshIcon className="size-3.5" />}
              </Button>
            </div>
          }
        >
          {loading ? (
            <div className="space-y-4 p-4" aria-label="Loading model defaults">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            loadError === null &&
            PURPOSE_ROWS.filter((row) => row.depth === 0).map((row) => renderDefaultRow(row))
          )}
          {/* The indent IS the inheritance: a left rule and a step in, nothing
            else. One wrapper for all three so `first:` / `last:` on PrefRow
            keep their meaning inside it; the first nested row draws its own
            hairline against Ticket above. */}
          <div
            data-testid="default-models-under-ticket"
            className="ml-2 border-l border-border/50 pl-4 [&>*:first-child]:border-t [&>*:first-child]:pt-4"
          >
            {!loading &&
              loadError === null &&
              PURPOSE_ROWS.filter((row) => row.depth === 1).map((row) => renderDefaultRow(row))}
          </div>
        </PrefSection>
      )}
      {agents && hostName === undefined ? (
        <DecisionModelSettings
          onSignIn={(providerId) => {
            if (agents) {
              useUiStore.getState().setSettingsOpen(true, "models", providerId);
              return;
            }
            setDecisionSignIn((current) => ({ providerId, nonce: (current?.nonce ?? 0) + 1 }));
            // The row is further down the page; bring it to the person.
            requestAnimationFrame(() =>
              document
                .querySelector(`[data-testid="account-${CSS.escape(providerId)}"]`)
                ?.scrollIntoView({ block: "center", behavior: "smooth" }),
            );
          }}
        />
      ) : null}
      {agents && (
        <PrefSection title="Compaction" icon={CollapseVerticalIcon}>
          {loading ? (
            <div className="p-4" aria-label="Loading compaction">
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            loadError === null && (
              <PrefRow label="Automatic compaction" testId="auto-compaction">
                <Switch
                  aria-label="Automatic compaction"
                  checked={compaction.autoCompaction}
                  disabled={loading}
                  onCheckedChange={(autoCompaction) =>
                    void saveCompaction({ ...compaction, autoCompaction })
                  }
                />
              </PrefRow>
            )
          )}
        </PrefSection>
      )}
      {agents && (
        <CodeModeSettings
          models={models}
          providers={providers}
          // A pin is offered for what the default pickers offer: models this
          // profile can run, minus the ones curated out of every picker.
          pickable={availableModelsByProvider(
            offerable.filter((model) => !isModelHidden(hidden, model)),
            providers,
          )}
        />
      )}
      {!agents && offerable.length > 0 ? (
        <CatalogSection
          offerable={offerable}
          providers={providers}
          hidden={hidden}
          onSaveVisibility={(model, visible) => void saveVisibility(model, visible)}
        />
      ) : null}
    </>
  );
}

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
      icon={PreviewIcon}
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
        empty="No models"
        noResults="No models match."
        columns={[
          {
            key: "name",
            header: "Model",
            cell: (model) => (
              <Cell strong>
                <ModelName model={model} models={[]} providers={providers} />
              </Cell>
            ),
          },
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

function DefaultModelRow({
  purpose,
  label,
  selection,
  blocked,
  models: _models,
  offerable,
  providers,
  disabled,
  onSave,
}: {
  purpose: ModelPurpose;
  label: string;
  selection: ModelSelection | null;
  blocked: boolean;
  models: readonly ModelAccessModel[];
  offerable: readonly ModelAccessModel[];
  providers: readonly ModelAccessProvider[];
  disabled: boolean;
  onSave(selection: ModelSelection | null): void;
}) {
  const inherit = inheritLabel(purpose);
  return (
    <PrefRow label={label} testId={`default-model-${purpose}`}>
      <div className="flex max-w-full flex-col items-end gap-2">
        <ModelControl
          models={offerable}
          providers={providers}
          selection={selection}
          inherit={inherit}
          disabled={disabled}
          onChange={onSave}
        />
        {selection === null && blocked && (
          <span className="text-ui text-attention" data-testid={`default-model-${purpose}-blocked`}>
            Choose a model that can read images.
          </span>
        )}
      </div>
    </PrefRow>
  );
}

function announceRefresh(outcome: RefreshOutcome): void {
  if (outcome.kind === "failed") toastError(outcome.message);
  else if (outcome.kind === "issues") toast.warning(outcome.message);
  else if (outcome.kind === "changed") toast.success(outcome.message);
  else toast.info(outcome.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
