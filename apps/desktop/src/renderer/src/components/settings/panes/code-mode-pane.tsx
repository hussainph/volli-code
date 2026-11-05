import { CodeIcon, CloseIcon, InfoIcon } from "@renderer/components/ui/icon";

import * as React from "react";
import {
  CODE_MODE_MODES,
  CODE_MODE_MODEL_DEFAULTS,
  CODE_MODE_POLICY_MODELS_MAX,
  codeModeModelKey,
  DEFAULT_CODE_MODE_POLICY,
  defaultCodeModeMode,
  type CodeModeMode,
  type CodeModePolicy,
  type ModelAccessModel,
  type ModelAccessProvider,
} from "@volli/shared";

import { ModelName } from "@renderer/components/models/model-identity";
import type { ProviderModelGroup } from "@renderer/components/pages/model-access-settings";
import { PrefRow, PrefSection, RowAction } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { toastError } from "@renderer/lib/toast";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Notice } from "@renderer/components/ui/notice";
import { ModelControl } from "../kit/model-control";

export const CODE_MODE_MODE_LABELS: Readonly<Record<CodeModeMode, string>> = Object.freeze({
  off: "Direct tools",
  both: "Code and direct tools",
  only: "Code only",
});

interface CodeModePin {
  key: string;
  mode: CodeModeMode;
  model: Pick<ModelAccessModel, "providerId" | "modelId" | "label">;
}

export function CodeModeSettings({
  models,
  providers,
  pickable,
}: {
  models: readonly ModelAccessModel[];
  providers: readonly ModelAccessProvider[];
  pickable: readonly ProviderModelGroup[];
}) {
  const client = useModelAccessClient();
  // Null until main has answered: the controls stay disabled until then, and
  // after a failed read, rather than offering to overwrite a value unseen.
  const [policy, setPolicy] = React.useState<CodeModePolicy | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  // What main last said it holds. A failed save goes back to THIS, not to the
  // state the save started from — that may itself have been an earlier save's
  // optimistic guess, still in flight.
  const stored = React.useRef<CodeModePolicy | null>(null);
  // A read that was already out when a save started may answer with the value
  // from before it; minting a new generation on every save is how its late
  // answer knows to stay out.
  const readGeneration = React.useRef(0);
  const writeGeneration = React.useRef(0);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readGeneration.current += 1;
      writeGeneration.current += 1;
    };
  }, []);

  // Re-read whenever the shared client turns over — a Refresh, a sign-in —
  // which is also how a failed first read gets its retry.
  React.useEffect(() => {
    if (!client) return;
    const generation = ++readGeneration.current;
    client.codeModePolicy().then(
      (answer) => {
        if (generation !== readGeneration.current) return;
        stored.current = answer;
        setLoadError(null);
        setPolicy(answer);
      },
      (error: unknown) => {
        if (generation !== readGeneration.current) return;
        setLoadError(errorMessage(error));
      },
    );
    return () => {
      readGeneration.current += 1;
    };
  }, [client, attempt]);

  if (!client) return <Notice tone="neutral" title="Code Mode is unavailable on this host." />;
  if (loadError !== null && policy === null)
    return (
      <PrefSection title="Code Mode" icon={CodeIcon}>
        <Notice
          tone="error"
          title="Couldn't read Code Mode settings"
          detail={loadError}
          actions={
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          }
        />
      </PrefSection>
    );
  if (policy === null)
    return (
      <PrefSection title="Code Mode" icon={CodeIcon}>
        <div className="p-4" aria-label="Loading Code Mode">
          <Skeleton className="h-8 w-full" />
        </div>
      </PrefSection>
    );

  async function save(next: CodeModePolicy): Promise<void> {
    const write = ++writeGeneration.current;
    readGeneration.current += 1;
    setPolicy(next);
    try {
      const answer = await client!.setCodeModePolicy(next);
      if (!mounted.current) return;
      stored.current = answer;
      // A later save is already showing its own guess; this answer is older.
      if (write === writeGeneration.current) setPolicy(answer);
    } catch (error) {
      if (!mounted.current) return;
      if (write === writeGeneration.current) setPolicy(stored.current);
      toastError(`Couldn't save Code Mode settings: ${errorMessage(error)}`);
    }
  }

  const loaded = policy !== null;
  const current = policy ?? DEFAULT_CODE_MODE_POLICY;
  const pins = pinsOf(current, models);
  // Off means no new Session gets Code Mode at all, whatever a pin says.
  const pinsEditable = loaded && current.enabled;

  const setPin = (key: string, mode: CodeModeMode | null): void => {
    const nextModels: Record<string, CodeModeMode> = { ...current.models };
    if (mode === null) delete nextModels[key];
    else nextModels[key] = mode;
    void save({ ...current, models: nextModels });
  };

  return (
    <div role="group" aria-label="Code Mode" className="flex flex-col gap-5">
      <PrefSection
        title="Default"
        icon={CodeIcon}
        action={
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Code Mode meanings and defaults">
                <InfoIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="flex max-w-sm flex-col gap-2 text-ui" align="start">
              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-2">
                <dt className="font-medium">{CODE_MODE_MODE_LABELS.off}</dt>
                <dd>No Code Mode, except to defer a very large MCP server.</dd>
                <dt className="font-medium">{CODE_MODE_MODE_LABELS.both}</dt>
                <dd>Code Mode beside every tool; the model chooses.</dd>
                <dt className="font-medium">{CODE_MODE_MODE_LABELS.only}</dt>
                <dd>Program-callable tools are reached only through Code Mode.</dd>
              </dl>
              <ul>
                {CODE_MODE_MODEL_DEFAULTS.map((row) => (
                  <li key={row.family}>
                    {row.family}: {CODE_MODE_MODE_LABELS[row.mode]}
                  </li>
                ))}
                <li>Every other model: {CODE_MODE_MODE_LABELS.off}</li>
              </ul>
              <span>
                Turning Code Mode off also declares every large-server tool again. Changes apply to
                new Sessions.
              </span>
            </PopoverContent>
          </Popover>
        }
      >
        <PrefRow label="Code Mode" testId="code-mode">
          <Switch
            aria-label="Code Mode for new Sessions"
            data-testid="code-mode-switch"
            checked={current.enabled}
            disabled={!loaded}
            onCheckedChange={(enabled) => void save({ ...current, enabled })}
          />
        </PrefRow>
      </PrefSection>
      <PrefSection title="Exceptions">
        <PrefRow label="Add model exception" testId="code-mode-pin">
          <PinPicker
            pickable={pickable}
            providers={providers}
            pinned={current.models}
            disabled={!pinsEditable || pins.length >= CODE_MODE_POLICY_MODELS_MAX}
            onPin={(model) => setPin(codeModeModelKey(model), defaultCodeModeMode(model.modelId))}
          />
        </PrefRow>
        {!current.enabled ? (
          <div data-testid="code-mode-off-note" className="px-3 py-2 text-ui text-muted-foreground">
            Inactive while Code Mode is off
          </div>
        ) : null}
        {pins.map((pin) => (
          <div
            key={pin.key}
            data-slot="pref-row"
            className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3 py-2"
          >
            <div className="min-w-0 flex-1 break-words">
              <ModelName model={pin.model} models={models} providers={providers} alwaysProvider />
              <div className="text-label text-muted-foreground">
                Default: {CODE_MODE_MODE_LABELS[defaultCodeModeMode(pin.model.modelId)]}
              </div>
            </div>
            <Select
              value={pin.mode}
              disabled={!pinsEditable}
              onValueChange={(mode) => setPin(pin.key, mode as CodeModeMode)}
            >
              <SelectTrigger
                size="sm"
                className="w-auto max-w-full"
                aria-label={`Code Mode for ${pin.model.label}`}
                data-testid={`code-mode-pin-${pin.key}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODE_MODE_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {CODE_MODE_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <RowAction
              label={`Remove exception for ${pin.model.label}`}
              hint="Remove exception"
              icon={CloseIcon}
              disabled={!pinsEditable}
              onAct={() => setPin(pin.key, null)}
            />
          </div>
        ))}
        {pins.length === 0 ? (
          <div className="p-4 text-ui text-muted-foreground">No model exceptions</div>
        ) : null}
      </PrefSection>
    </div>
  );
}

function PinPicker({
  pickable,
  providers,
  pinned,
  disabled,
  onPin,
}: {
  pickable: readonly ProviderModelGroup[];
  providers: readonly ModelAccessProvider[];
  pinned: Readonly<Record<string, CodeModeMode>>;
  disabled: boolean;
  onPin(model: ModelAccessModel): void;
}) {
  const groups = pickable
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => !Object.hasOwn(pinned, codeModeModelKey(model))),
    }))
    .filter((group) => group.models.length > 0);
  const candidates = groups.flatMap((group) => group.models);

  return (
    <ModelControl
      models={candidates}
      providers={providers}
      selection={null}
      disabled={disabled || candidates.length === 0}
      onChange={(selection) => {
        const model = candidates.find(
          (candidate) =>
            candidate.providerId === selection?.providerId &&
            candidate.modelId === selection.modelId,
        );
        if (model) onPin(model);
      }}
    />
  );
}

function pinsOf(
  policy: CodeModePolicy,
  models: readonly ModelAccessModel[],
): readonly CodeModePin[] {
  return Object.entries(policy.models).map(([key, mode]) => {
    const known = models.find((model) => codeModeModelKey(model) === key);
    if (known) return { key, mode, model: known };
    // The provider id never holds a slash; a routed model id may.
    const slash = key.indexOf("/");
    const modelId = key.slice(slash + 1);
    return { key, mode, model: { providerId: key.slice(0, slash), modelId, label: modelId } };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
