/**
 * Code Mode in the Models pane (VC-471): one switch, and behind an Advanced
 * disclosure a mode pinned per model.
 *
 * ONE SWITCH, ON BY DEFAULT. The owner's brief was that this pane is getting
 * too complicated, so the setting a person is asked about is the one they can
 * answer: whether the agent may write programs at all. Which models use Code
 * Mode, and how far, is the benchmark's call (`CODE_MODE_MODEL_DEFAULTS` in
 * `@volli/shared`), not a ladder of choices on screen.
 *
 * THE PINS ARE ADVANCED, AND COLLAPSED. A pin overrides one model's built-in
 * mode. Few people will want one, so the disclosure stays shut until asked
 * and its trigger says how many pins it holds — a pin hidden behind a closed
 * door with no count on it is a setting nobody remembers making. While the
 * switch is off the pins stay stored but cannot be edited: off means no new
 * Session gets Code Mode whatever a pin says, and an editable control that
 * changes nothing is a control lying about what it does.
 *
 * NOTHING HERE REACHES A SESSION ALREADY RUNNING. A Session reads the policy
 * once, at birth, and freezes the routes it got into its tool surface — its
 * tool array is part of its Cache Prefix — so a change here is a change to
 * the next Session created. The switch's own copy says so.
 *
 * THIS SECTION LOADS AND SAVES ITS OWN POLICY, unlike compaction, which rides
 * the pane's one read. A failed Code Mode read then costs this section and not
 * the model catalogue above it, and the controls stay disabled until main has
 * said what it holds: a switch drawn from a default after a failed read would
 * show a value nothing stored.
 */
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import * as React from "react";
import {
  CODE_MODE_MODEL_DEFAULTS,
  CODE_MODE_MODES,
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
import {
  Cell,
  CONTROL_W,
  DataTable,
  PrefRow,
  PrefSection,
  RowAction,
} from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/** A mode as the controls name it. */
export const CODE_MODE_MODE_LABELS: Readonly<Record<CodeModeMode, string>> = Object.freeze({
  off: "Off",
  both: "Both",
  only: "Only",
});

/** One stored pin, with the catalogue row that names it when there is one. */
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
  /** The whole catalogue, to name a pin whose provider is signed out. */
  models: readonly ModelAccessModel[];
  providers: readonly ModelAccessProvider[];
  /**
   * What a person may pin, grouped per provider: what the default pickers
   * offer — models this profile can run, minus the ones curated out of
   * pickers. A pin is per `providerId/modelId`, so the list is too.
   */
  pickable: readonly ProviderModelGroup[];
}) {
  const client = useModelAccessClient();
  // Null until main has answered: the controls stay disabled until then, and
  // after a failed read, rather than offering to overwrite a value unseen.
  const [policy, setPolicy] = React.useState<CodeModePolicy | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
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
        setPolicy(answer);
      },
      (error: unknown) => {
        if (generation !== readGeneration.current) return;
        toastError(`Couldn't load Code Mode settings: ${errorMessage(error)}`);
      },
    );
    return () => {
      readGeneration.current += 1;
    };
  }, [client]);

  if (!client) return null;

  /**
   * Optimistic, as the pane's other switches are: a control that waits a
   * round trip to move reads as one that did not take. The policy is saved
   * whole — the switch and every pin — because that is the only shape main
   * stores, and the answer is what main stored.
   */
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
    <PrefSection title="Code Mode" icon={CodeIcon}>
      {/* The control is the explanation (AGENTS.md, "let controls talk"):
          what each mode does, which models get which, and that the switch
          also governs large-server deferral are in Advanced's (i) and in
          the Code Mode guide, not under the switch. */}
      <PrefRow label="Code Mode" testId="code-mode">
        <Switch
          aria-label="Code Mode for new Sessions"
          data-testid="code-mode-switch"
          checked={current.enabled}
          disabled={!loaded}
          onCheckedChange={(enabled) => void save({ ...current, enabled })}
        />
      </PrefRow>
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <div className="border-t border-border/50 pt-3">
          <CollapsibleTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              className="-ml-2"
              aria-label={`${advancedOpen ? "Hide" : "Show"} advanced Code Mode settings`}
              data-testid="code-mode-advanced"
            >
              <CaretDownIcon
                aria-hidden
                className={cn("transition-transform", advancedOpen && "rotate-180")}
              />
              Advanced
              {pins.length > 0 ? (
                <span className="text-muted-foreground">{pins.length} pinned</span>
              ) : null}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-3 pt-3">
              {loaded && !current.enabled ? (
                // A blocked state with one recovery — the switch above.
                <p className="text-ui text-muted-foreground" data-testid="code-mode-off-note">
                  Code Mode is off, so no new Session uses these. They&rsquo;re kept for when
                  it&rsquo;s back on.
                </p>
              ) : null}
              {/* Its own box, so the row's `first:`/`last:` rules hold and it
                  draws no hairline against the note above it. */}
              <div>
                <PrefRow label="Pin a model" hint={<ModesHint />} testId="code-mode-pin">
                  <PinPicker
                    pickable={pickable}
                    providers={providers}
                    pinned={current.models}
                    disabled={!pinsEditable || pins.length >= CODE_MODE_POLICY_MODELS_MAX}
                    onPin={(model) =>
                      setPin(codeModeModelKey(model), defaultCodeModeMode(model.modelId))
                    }
                  />
                </PrefRow>
              </div>
              {pins.length > 0 ? (
                <DataTable
                  label="Models with a pinned Code Mode"
                  items={pins}
                  keyOf={(pin) => pin.key}
                  rows={6}
                  empty="No models pinned."
                  columns={[
                    {
                      key: "model",
                      header: "Model",
                      cell: (pin) => (
                        <ModelName
                          model={pin.model}
                          models={models}
                          providers={providers}
                          alwaysProvider
                        />
                      ),
                    },
                    {
                      key: "default",
                      header: "Default",
                      width: "5rem",
                      cell: (pin) => (
                        <Cell muted>
                          {CODE_MODE_MODE_LABELS[defaultCodeModeMode(pin.model.modelId)]}
                        </Cell>
                      ),
                    },
                    {
                      key: "mode",
                      header: "Mode",
                      width: "8rem",
                      cell: (pin) => (
                        <Select
                          value={pin.mode}
                          disabled={!pinsEditable}
                          onValueChange={(mode) => setPin(pin.key, mode as CodeModeMode)}
                        >
                          <SelectTrigger
                            size="sm"
                            className={CONTROL_W.sm}
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
                      ),
                    },
                    {
                      key: "remove",
                      header: "Remove",
                      width: "3rem",
                      align: "end",
                      headerHidden: true,
                      cell: (pin) => (
                        <RowAction
                          label={`Unpin ${pin.model.label}`}
                          hint="Unpin"
                          icon={XIcon}
                          disabled={!pinsEditable}
                          onAct={() => setPin(pin.key, null)}
                        />
                      ),
                    },
                  ]}
                />
              ) : null}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </PrefSection>
  );
}

/**
 * The model list a pin starts from, grouped as the default pickers group it.
 *
 * Choosing pins the model at its built-in mode, which the row then shows
 * beside its Default: the person changes it there. A select that resets to
 * its placeholder after every choice is an "add" control, not a value, which
 * is why it holds none.
 */
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
    <Select
      value=""
      disabled={disabled || candidates.length === 0}
      onValueChange={(key) => {
        const model = candidates.find((candidate) => codeModeModelKey(candidate) === key);
        if (model) onPin(model);
      }}
    >
      <SelectTrigger className={CONTROL_W.lg} aria-label="Pin a model">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        {groups.map((group) => (
          <SelectGroup key={group.providerId}>
            <SelectLabel>{group.providerLabel}</SelectLabel>
            {group.models.map((model) => (
              <SelectItem key={codeModeModelKey(model)} value={codeModeModelKey(model)}>
                <ModelName model={model} models={candidates} providers={providers} />
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The `(i)` on "Pin a model": what each mode does, and which models get which
 * without a pin. The defaults are read off the shared table, so a benchmark
 * that moves a family moves this sentence with it.
 */
function ModesHint() {
  return (
    <span className="flex flex-col gap-1">
      <span>
        <strong className="font-medium text-foreground">Off</strong> &mdash; no Code Mode, except to
        keep a very large MCP server out of the prompt.
      </span>
      <span>
        <strong className="font-medium text-foreground">Both</strong> &mdash; Code Mode beside every
        tool; the model chooses.
      </span>
      <span>
        <strong className="font-medium text-foreground">Only</strong> &mdash; tools a program can
        call are reached only through Code Mode. Smallest prompt.
      </span>
      <span>{builtInDefaultsSentence()}</span>
      <span>
        Turning Code Mode off also declares every tool of a large MCP server again. Changes apply to
        new Sessions.
      </span>
    </span>
  );
}

/** `Default: Both for Claude Haiku and Claude Sonnet; Off for every other model.` */
export function builtInDefaultsSentence(): string {
  const parts = CODE_MODE_MODES.filter((mode) => mode !== "off").flatMap((mode) => {
    const families = CODE_MODE_MODEL_DEFAULTS.filter((row) => row.mode === mode).map(
      (row) => row.family,
    );
    return families.length === 0 ? [] : [`${CODE_MODE_MODE_LABELS[mode]} for ${listOf(families)}`];
  });
  return `Default: ${[...parts, `${CODE_MODE_MODE_LABELS.off} for every other model`].join("; ")}.`;
}

function listOf(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * The stored pins, in the order they were made, each named by its catalogue
 * row when there is one. A pin whose model has left the catalogue — its
 * provider signed out, its id retired — is still stored and still listed, by
 * its id: hiding it would leave a setting in force that nobody can see.
 */
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
