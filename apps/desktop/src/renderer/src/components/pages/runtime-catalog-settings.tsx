import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star";
import * as React from "react";
import type {
  RuntimeCatalogModel,
  RuntimeCatalogView,
  RuntimeModelRef,
  RuntimePreferences,
} from "@volli/shared";

import { SettingsSection } from "@renderer/components/pages/settings-shell";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";
import { Switch } from "@renderer/components/ui/switch";
import {
  useRuntimeCatalogClient,
  type RuntimeCatalogContextValue,
} from "@renderer/lib/runtime-catalog-client";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

const ADAPTER_ID = "opencode";
const SEARCH_DELAY_MS = 180;

type CatalogState =
  | { status: "loading"; view: RuntimeCatalogView | null }
  | { status: "loaded"; view: RuntimeCatalogView }
  | { status: "error"; view: RuntimeCatalogView | null };

/** OpenCode discovery and the small app-wide model allowlist used by chat. */
export function RuntimeCatalogSettings() {
  const client = useRuntimeCatalogClient();
  if (!client) return null;
  return <ConnectedRuntimeCatalogSettings client={client} />;
}

function ConnectedRuntimeCatalogSettings({ client }: { client: RuntimeCatalogContextValue }) {
  const [state, setState] = React.useState<CatalogState>({ status: "loading", view: null });
  const [providerId, setProviderId] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const request = React.useRef(0);

  const load = React.useCallback(
    async (refresh = false) => {
      const requestId = ++request.current;
      setState((current) => ({ status: "loading", view: current.view }));
      try {
        const view = await client.inspect({
          adapterId: ADAPTER_ID,
          ...(providerId ? { providerId } : {}),
          ...(query.trim() ? { query: query.trim() } : {}),
          refresh,
        });
        if (request.current !== requestId) return;
        setState({ status: "loaded", view });
        if (!providerId && view.providers.length > 0) {
          const preferred =
            view.providers.find(
              (provider) => provider.id === view.preferences.defaults.providerId,
            ) ?? view.providers.find((provider) => provider.availableModelCount > 0);
          setProviderId(preferred?.id ?? view.providers[0]!.id);
        }
      } catch (error) {
        if (request.current !== requestId) return;
        setState((current) => ({ status: "error", view: current.view }));
        toastError(`Couldn't load OpenCode models: ${errorMessage(error)}`);
      }
    },
    [client, providerId, query],
  );

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [load]);

  const view = state.view;

  async function save(preferences: RuntimePreferences): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await client.save({ adapterId: ADAPTER_ID, preferences });
      await load();
    } catch (error) {
      toastError(`Couldn't save OpenCode models: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      title="OpenCode"
      icon={CpuIcon}
      action={
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh OpenCode models"
          disabled={state.status === "loading"}
          onClick={() => void load(true)}
        >
          {state.status === "loading" ? (
            <Spinner className="size-3.5" />
          ) : (
            <ArrowClockwiseIcon className="size-3.5" />
          )}
        </Button>
      }
    >
      {view?.status !== "available" ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-3 text-ui">
          <p className="font-medium text-foreground">OpenCode unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {view?.reason ?? "Checking the local runtime…"}
          </p>
        </div>
      ) : (
        <div className="grid min-h-72 grid-cols-[12rem_minmax(0,1fr)] overflow-hidden rounded-lg border border-border">
          <div className="border-r border-border bg-muted/20 p-2">
            <p className="px-2 pb-2 pt-1 text-label uppercase text-muted-foreground">Providers</p>
            <div className="space-y-0.5">
              {view.providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setProviderId(provider.id);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-ui transition-colors",
                    provider.id === providerId
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="truncate">{provider.label}</span>
                  <span className="shrink-0 font-mono text-label">
                    {provider.enabledModelCount}/{provider.availableModelCount}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-0 p-3">
            <Input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search models"
              aria-label="Search OpenCode models"
              className="h-8"
            />
            <div className="mt-2 max-h-80 overflow-y-auto [scrollbar-gutter:stable]">
              {view.models.length === 0 ? (
                <p className="px-2 py-8 text-center text-ui text-muted-foreground">
                  {state.status === "loading" ? "Loading models…" : "No matching models"}
                </p>
              ) : (
                view.models.map((model) => (
                  <ModelPreferenceRow
                    key={model.id}
                    model={model}
                    preferences={view.preferences}
                    disabled={saving}
                    onSave={save}
                  />
                ))
              )}
            </div>
            {view.modelTotal > view.models.length ? (
              <p className="border-t border-border px-2 pt-2 text-label text-muted-foreground">
                {view.modelTotal - view.models.length} more · refine search
              </p>
            ) : null}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function ModelPreferenceRow({
  model,
  preferences,
  disabled,
  onSave,
}: {
  model: RuntimeCatalogModel;
  preferences: RuntimePreferences;
  disabled: boolean;
  onSave(preferences: RuntimePreferences): Promise<void>;
}) {
  const enabled = preferences.enabledModels.some((entry) => sameModel(entry, model));
  const isDefault =
    preferences.defaults.providerId === model.providerId &&
    preferences.defaults.modelId === model.modelId;

  return (
    <div className="flex min-h-12 items-center gap-3 border-t border-border/60 px-2 first:border-t-0">
      <Switch
        checked={enabled}
        disabled={disabled}
        aria-label={`${enabled ? "Hide" : "Show"} ${model.label} in chat`}
        onCheckedChange={(checked) => {
          const enabledModels = checked
            ? appendModel(preferences.enabledModels, model)
            : preferences.enabledModels.filter((entry) => !sameModel(entry, model));
          const defaults =
            !checked && isDefault
              ? { providerId: "", modelId: "", variant: "", agent: preferences.defaults.agent }
              : preferences.defaults;
          void onSave({ ...preferences, enabledModels, defaults });
        }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui font-medium text-foreground">{model.label}</p>
        <p className="truncate font-mono text-label text-muted-foreground">{model.modelId}</p>
      </div>
      {model.state !== "available" ? <Badge variant="outline">Unavailable</Badge> : null}
      <Button
        size="icon-xs"
        variant={isDefault ? "secondary" : "ghost"}
        aria-label={`${isDefault ? "Default model" : "Make default"}: ${model.label}`}
        disabled={disabled || !enabled || model.state !== "available"}
        onClick={() =>
          void onSave({
            ...preferences,
            defaults: {
              ...preferences.defaults,
              providerId: model.providerId,
              modelId: model.modelId,
              variant: model.variants.includes(preferences.defaults.variant)
                ? preferences.defaults.variant
                : (model.variants[0] ?? ""),
            },
          })
        }
      >
        <StarIcon className="size-3" weight={isDefault ? "fill" : "regular"} />
      </Button>
    </div>
  );
}

function appendModel(
  current: readonly RuntimeModelRef[],
  model: RuntimeModelRef,
): readonly RuntimeModelRef[] {
  return current.some((entry) => sameModel(entry, model))
    ? current
    : [...current, { providerId: model.providerId, modelId: model.modelId }];
}

function sameModel(left: RuntimeModelRef, right: RuntimeModelRef): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
