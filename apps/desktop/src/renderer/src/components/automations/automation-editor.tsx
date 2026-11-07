/**
 * The Automation editor: the app's one authoring surface, embedded in the
 * Automations page beside its persistent record rail. Trigger, Instructions
 * and Runtime are separate visual regions instead of one row of competing
 * pills; the form still writes the same record through the same store doors.
 *
 * Instructions use the chat composer's grammar and supplies. The page opts the
 * shared picker into its floating layout so a slash list overlays the textarea
 * rather than moving the editor and Run history below it. Chat keeps the
 * shared stack's normal-flow default.
 */
import { automationSourceIsCloud } from "@renderer/stores/automation-source";
import { CloudAutomationState } from "./cloud-automation-controls";
import * as React from "react";
import {
  ClockIcon,
  ProcessorIcon,
  FolderOpenIcon,
  GlobeIcon,
  MoreIcon,
  InfoIcon,
} from "@renderer/components/ui/icon";

import {
  AUTOMATION_SCHEDULE_LATE_GRACE_MS,
  AUTOMATION_SCHEDULE_PRESETS,
  automationScheduleProblem,
  automationTriggerColumns,
  automationTriggerSchedule,
  errorMessage,
  hostTimeZone,
  AGENT_MODEL_TIERS,
  isAutomationRuntimePin,
  isAutomationRuntimeTier,
  isAgentModelTier,
  isValidAutomationRuntime,
  modelTierRow,
  NO_AUTOMATION_TRIGGER,
  nextScheduleOccurrence,
  SCHEDULE_WEEKDAY_LABELS,
  SCHEDULE_WEEKDAYS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Automation,
  type AutomationSchedule,
  type AutomationSchedulePreset,
  type AutomationTrigger,
  type ScheduleWeekday,
  type TicketStatus,
  type ValidAutomationRuntime,
} from "@volli/shared";
import { PROMPT_SURFACE } from "@renderer/components/chat/composer-chrome";
import { reclampEffort } from "@volli/session-presentation";

import {
  ComposerPickerStack,
  offerableModels,
  useComposerCaretBinding,
  type ComposerModel,
} from "@renderer/components/chat/composer-ui";
import { composerModelSelection } from "@renderer/components/chat/chat-plane-model";
import { ComposerAddMenu } from "@renderer/components/chat/composer-add-menu";
import { ModelName } from "@renderer/components/models/model-identity";
import { ResolvedModelName } from "@renderer/components/models/resolved-model-name";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { usePromptTemplates } from "@renderer/hooks/use-prompt-templates";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { cn } from "@renderer/lib/utils";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { PrefRow } from "@renderer/components/settings/kit/pref-row";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Segmented } from "@renderer/components/ui/segmented";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { guardWrite } from "@renderer/components/hosts/use-hosts";
import { AutomationTriggerState } from "./automation-trigger-state";
import { AutomationRuntimeValue } from "./automation-runtime-value";
import { triggerLabel } from "./automations-page-model";
import { PrefSection } from "@renderer/components/settings/kit/pref-section";
import { useAutomationsStore } from "@renderer/stores/automations";

import { INSTRUCTIONS_PLACEHOLDER, nextScheduledRun } from "./automations-page-model";
import {
  clearEditorDraft,
  loadEditorDraft,
  saveEditorDraft,
  type AutomationEditorDraft,
} from "./editor-draft";
import { TimeZonePicker } from "./time-zone-picker";
import { AutomationAuthoringButton } from "./automation-authoring-button";

const NO_MODELS: readonly ComposerModel[] = [];

type OwnershipChoice = "project" | "global";
type TriggerChoice = "none" | "columns" | "schedule";

const DEFAULT_SCHEDULE_HOUR = 9;
const DEFAULT_SCHEDULE_WEEKDAY: ScheduleWeekday = "monday";

function columnNames(statuses: readonly TicketStatus[]) {
  return statuses.map((status) => TICKET_STATUS_LABELS[status]).join(", ");
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * A schedule number keeps a string draft while focused, so typing `17` does
 * not have its first `1` reformatted to `01` before the second key lands.
 * Only complete in-range integers reach the schedule record.
 */
function ScheduleNumberInput({
  value,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  max: number;
  ariaLabel: string;
  onChange(value: number): void;
}) {
  const focused = React.useRef(false);
  const [draft, setDraft] = React.useState(() => twoDigits(value));

  React.useEffect(() => {
    if (!focused.current) setDraft(twoDigits(value));
  }, [value]);

  return (
    <Input
      inputMode="numeric"
      aria-label={ariaLabel}
      value={draft}
      className="h-6 w-14 px-2 text-center tabular-nums"
      onFocus={(event) => {
        focused.current = true;
        event.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(twoDigits(value));
      }}
      onChange={(event) => {
        const next = event.currentTarget.value.replace(/\D/g, "").slice(0, 2);
        if (next !== "" && Number(next) > max) return;
        setDraft(next);
        if (next !== "") onChange(Number(next));
      }}
    />
  );
}

function TimeField({
  hour,
  minute,
  onHourChange,
  onMinuteChange,
}: {
  hour: number;
  minute: number;
  onHourChange(hour: number): void;
  onMinuteChange(minute: number): void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Time"
          className="min-w-20 self-start tabular-nums"
        >
          <ClockIcon />
          {twoDigits(hour)}:{twoDigits(minute)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-ui font-medium text-muted-foreground">
            Hour
            <ScheduleNumberInput value={hour} max={23} ariaLabel="Hour" onChange={onHourChange} />
          </label>
          <span aria-hidden className="h-6 text-ui leading-6 text-muted-foreground">
            :
          </span>
          <label className="flex flex-col gap-1 text-ui font-medium text-muted-foreground">
            Minute
            <ScheduleNumberInput
              value={minute}
              max={59}
              ariaLabel="Minute"
              onChange={onMinuteChange}
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * "Next · …" at the schedule control (VC-298), for a schedule this machine will
 * actually fire. Its own component so the clock it keeps re-renders this line
 * rather than the editor, and its answer is memoized so the editor's renders
 * do not recompute it. Once the shown occurrence passes it reads the next one,
 * and it looks again at least once a minute so a slept laptop or a moved clock
 * corrects itself, like the host timer it mirrors.
 */
function NextScheduledRun({
  schedule,
  automationId,
}: {
  schedule: AutomationSchedule;
  automationId: string;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  // Memoized on its real inputs: the editor re-renders this line on every
  // keystroke elsewhere in the form, and none of those change the answer.
  const next = React.useMemo(
    () => nextScheduledRun({ schedule, automationId, now, timeZone: hostTimeZone() }),
    [schedule, automationId, now],
  );
  React.useEffect(() => {
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(next.at - Date.now(), 60_000)),
    );
    return () => window.clearTimeout(timer);
  }, [next.at, now]);
  return <p className="text-ui text-foreground tabular-nums">{next.label}</p>;
}

function modelValue(model: Pick<ComposerModel, "providerId" | "modelId">): string {
  return `${model.providerId}/${model.modelId}`;
}

/** The Select value that names a tier, kept apart from every model id. */
const TIER_VALUE_PREFIX = "tier:";

/**
 * The Runtime control: inherit, one of the user's named tiers, or an exact
 * pin (VC-259).
 *
 * The three sit in ONE Select rather than behind the composer pill's All
 * models / Defaults switch, because this control is a Select and a segmented
 * toggle inside a Select's content would be a second control the keyboard has
 * to cross to reach the list. The tiers are their own group, named Defaults
 * after the pill's view, so the two surfaces offer the same short list under
 * the same word.
 *
 * A tier draws NO reasoning control: a tier carries its model and level
 * together by reference, and a level authored here would be a level the
 * Settings row would then contradict.
 */
function RuntimeFields({
  models,
  runtime,
  onChange,
}: {
  models: readonly ComposerModel[];
  runtime: ValidAutomationRuntime;
  onChange(runtime: ValidAutomationRuntime): void;
}) {
  const pin = isAutomationRuntimePin(runtime) ? runtime : null;
  const selectedModel =
    pin === null
      ? undefined
      : models.find(
          (model) => model.providerId === pin.providerId && model.modelId === pin.modelId,
        );
  const unavailableValue =
    pin !== null && selectedModel === undefined ? `unavailable:${modelValue(pin)}` : null;
  const value =
    runtime === null
      ? "inherit"
      : isAutomationRuntimeTier(runtime)
        ? `${TIER_VALUE_PREFIX}${runtime.tier}`
        : (selectedModel?.id ?? unavailableValue!);
  const levels = selectedModel?.reasoningLevels ?? [];

  return (
    <div className="flex flex-col gap-2">
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === "inherit") {
            onChange(null);
            return;
          }
          if (next.startsWith(TIER_VALUE_PREFIX)) {
            const tier = next.slice(TIER_VALUE_PREFIX.length);
            // The same set the options below are built from (VC-431): a Run
            // starts a Session, and no Session runs on the Utility row.
            if (isAgentModelTier(tier)) onChange({ kind: "tier", tier });
            return;
          }
          const model = models.find((candidate) => candidate.id === next);
          if (model === undefined) return;
          const selection = composerModelSelection({
            providerId: model.providerId,
            modelId: model.modelId,
            reasoningLevel: reclampEffort(model.reasoningLevels, pin?.reasoningLevel ?? ""),
          });
          if (selection !== null) onChange(selection);
        }}
      >
        <SelectTrigger variant="inspector" className="w-full" aria-label="Runtime model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            <ProcessorIcon />
            Project default
          </SelectItem>
          {/* The tier's own label, never the model it currently resolves to:
              the record names a Settings row, and a Run is where the model it
              landed on is recorded. */}
          <SelectGroup>
            <SelectLabel>Defaults</SelectLabel>
            {AGENT_MODEL_TIERS.map((tier) => (
              <SelectItem key={tier} value={`${TIER_VALUE_PREFIX}${tier}`}>
                <ProcessorIcon />
                {modelTierRow(tier).label}
              </SelectItem>
            ))}
          </SelectGroup>
          {/* Model rows are the same drawing as the composer's picker and the
              Settings rows: the mark, the name, the provider only where the
              name alone is ambiguous. */}
          {unavailableValue === null || pin === null ? null : (
            <SelectItem value={unavailableValue}>
              <ResolvedModelName selection={pin} />
            </SelectItem>
          )}
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              <ModelName model={model} models={models} providerLabel={model.providerLabel} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pin !== null && levels.length > 1 ? (
        <Select
          value={pin.reasoningLevel}
          onValueChange={(reasoningLevel) => {
            const next = composerModelSelection({ ...pin, reasoningLevel });
            if (next !== null) onChange(next);
          }}
        >
          <SelectTrigger variant="inspector" className="w-full" aria-label="Reasoning effort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {levels.map((level) => (
              <SelectItem key={level} value={level}>
                <ProcessorIcon />
                {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}

/**
 * The draft state, stated in the editor's title row. Two things are separated
 * here, and the separation is the whole of it.
 *
 * THE SLOT NEVER CHANGES WIDTH. As a bordered bar above Instructions this
 * appeared on the first keystroke and pushed the whole form down — the layout
 * jump VC-405 calls glitchy. Moving it into the title row ends the vertical
 * push but not the jump: the name input is the row's only elastic member, so a
 * `shrink-0` child arriving still takes its width out of the one field under
 * the cursor, and `dirty` flips on the first character OF THE NAME. So the slot
 * is always in the row and only its ink changes. `opacity`, not `hidden` or a
 * conditional: it has to keep occupying the row to hold the width open. The
 * label it reserves is the label it will show, because `resumed` cannot change
 * while a draft is being typed — only a discard or a save clears it, and both
 * end the draft — so the width reserved is the exact width that arrives.
 *
 * THE ANNOUNCEMENT CARRIES TEXT AND NOTHING ELSE. `role="status"` used to wrap
 * the discard button with the sentence, which puts a control inside a live
 * region and re-reads it on every status change; `chat/activity-island-ui.tsx`
 * records the same lesson against the same mistake ("A GROUP, not a live
 * region"). The region is its own sr-only span, and it is mounted whether or
 * not a draft exists so that the text CHANGES inside a region the reader is
 * already watching — a live region that arrives with its text already in it is
 * the classic version of this bug, and it announces nothing.
 */
function DraftIndicator({
  dirty,
  resumed,
  onDiscard,
}: {
  dirty: boolean;
  resumed: boolean;
  onDiscard: () => void;
}) {
  const label = resumed ? "Draft restored" : "Draft saved";
  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {dirty ? label : ""}
      </span>
      <div
        data-slot={dirty ? (resumed ? "draft-resumed" : "draft-saved") : "draft-idle"}
        aria-hidden={!dirty}
        className={cn(
          "flex shrink-0 items-center text-ui text-muted-foreground",
          !dirty && "pointer-events-none opacity-0",
        )}
      >
        <span className="whitespace-nowrap">{label}</span>
        {/* No gap: the button's own inset is the space, so the pair reads as one
         * label with a door rather than two peers — the row's `gap-4` is then
         * the wider interval, and it is what separates this from the record's
         * controls. */}
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          disabled={!dirty}
          onClick={onDiscard}
        >
          Discard draft
        </Button>
      </div>
    </>
  );
}

export function AutomationEditorPanel({
  projectId,
  automation,
  actions,
  history,
  onDiscardedNewDraft,
  disabled = false,
  back,
  renameRequest = 0,
  readState = "ready",
}: {
  projectId: string;
  automation: Automation | null;
  actions?: React.ReactNode;
  history?: React.ReactNode;
  disabled?: boolean;
  back?: React.ReactNode;
  renameRequest?: number;
  readState?: "ready" | "loading" | "failed";
  /** Discarding a NEW record leaves nothing to show; the page chooses what replaces it. */
  onDiscardedNewDraft?: () => void;
}) {
  const save = useAutomationsStore((state) => state.save);
  const update = useAutomationsStore((state) => state.update);
  const commandId = React.useRef(crypto.randomUUID());
  const automationId = automation?.id ?? null;
  const creating = automation === null;
  type Group = "name" | "trigger" | "instructions" | "runtime";
  const panel = React.useRef<HTMLDivElement>(null);
  const lock = React.useRef(false);
  const [editing, setEditing] = React.useState<Group | null>(() => {
    const draft = loadEditorDraft(projectId, undefined, automationId);
    if (draft === null || automation === null) return null;
    return draft.name !== automation.name
      ? "name"
      : draft.instructions !== automation.instructions
        ? "instructions"
        : JSON.stringify(draft.runtime) !== JSON.stringify(automation.runtime)
          ? "runtime"
          : "trigger";
  });
  const [expanded, setExpanded] = React.useState(false);
  const [policy, setPolicy] = React.useState(false);
  function startEdit(group: Group) {
    if (editing !== null && editing !== group) {
      panel.current
        ?.querySelector<HTMLElement>(
          "[data-editing=true] input, [data-editing=true] textarea, [data-editing=true] button",
        )
        ?.focus();
      return;
    }
    setEditing(group);
  }
  function focusEdit(group: Group | null) {
    requestAnimationFrame(() => {
      panel.current
        ?.querySelector<HTMLElement>(
          group === "name" ? "h2 button" : `[aria-label="Edit ${group}"]`,
        )
        ?.focus();
    });
  }
  const previousRename = React.useRef(renameRequest);
  React.useEffect(() => {
    if (previousRename.current !== renameRequest) {
      previousRename.current = renameRequest;
      startEdit("name");
    }
  });
  React.useEffect(() => {
    if (editing !== null || creating)
      panel.current
        ?.querySelector<HTMLElement>(
          "[data-editing=true] input, [data-editing=true] textarea, [data-editing=true] button",
        )
        ?.focus();
  }, [editing, automationId, creating]);
  // Switched on HERE, read live: turning automatic triggers off clears the
  // next-run line in the same render the switch moves (VC-298).
  const firesHere = useAutomationsStore(
    (state) => automationId !== null && state.enabledIds.includes(automationId),
  );
  // Edits and new drafts both survive navigation. A refreshed saved record
  // never replaces unsaved words; record identity, not updatedAt, owns this mount.
  const [restored] = React.useState<AutomationEditorDraft | null>(() =>
    loadEditorDraft(projectId, undefined, automationId),
  );
  const [resumed, setResumed] = React.useState(restored !== null);
  const [name, setName] = React.useState(restored?.name ?? automation?.name ?? "");
  const [instructions, setInstructions] = React.useState(
    restored?.instructions ?? automation?.instructions ?? "",
  );
  const [ownership, setOwnership] = React.useState<OwnershipChoice>(
    restored?.ownership ??
      (automation === null || automation.projectId !== null ? "project" : "global"),
  );
  const [runtime, setRuntime] = React.useState<ValidAutomationRuntime>(
    restored !== null
      ? restored.runtime
      : automation !== null && isValidAutomationRuntime(automation.runtime)
        ? automation.runtime
        : null,
  );
  const [triggerChoice, setTriggerChoice] = React.useState<TriggerChoice>(
    restored?.triggerChoice ?? automation?.trigger.kind ?? "none",
  );
  const [columns, setColumns] = React.useState<readonly TicketStatus[]>(
    restored?.columns ?? (automation === null ? [] : automationTriggerColumns(automation.trigger)),
  );
  const storedSchedule =
    restored?.schedule ??
    (automation === null ? null : automationTriggerSchedule(automation.trigger));
  const [preset, setPreset] = React.useState<AutomationSchedulePreset>(
    storedSchedule?.preset ?? "daily",
  );
  const [weekday, setWeekday] = React.useState<ScheduleWeekday>(
    storedSchedule !== null && storedSchedule.preset === "weekly"
      ? storedSchedule.weekday
      : DEFAULT_SCHEDULE_WEEKDAY,
  );
  const [hour, setHour] = React.useState(
    storedSchedule !== null && storedSchedule.preset !== "hourly"
      ? storedSchedule.hour
      : DEFAULT_SCHEDULE_HOUR,
  );
  const [minute, setMinute] = React.useState(storedSchedule?.minute ?? 0);
  const [timeZone, setTimeZone] = React.useState(storedSchedule?.timeZone ?? hostTimeZone());
  const problemId = React.useId();
  const [problem, setProblem] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const { templates, skills } = usePromptTemplates(projectId);
  const fileIndex = useFileIndex(projectId);
  const access = useModelAccessClient();
  const inspect = access?.inspect;
  const hiddenModels = access?.hiddenModels;
  const [models, setModels] = React.useState<readonly ComposerModel[]>(NO_MODELS);
  React.useEffect(() => {
    if (inspect === undefined || hiddenModels === undefined) return;
    let current = true;
    void Promise.all([inspect({}), hiddenModels()])
      .then(([snapshot, hidden]) => {
        if (current) setModels(offerableModels(snapshot.models, snapshot.providers, hidden));
      })
      .catch(() => {
        if (current) setModels(NO_MODELS);
      });
    return () => {
      current = false;
    };
  }, [inspect, hiddenModels]);

  // Memoized so the draft-save effect below can depend on the schedule without
  // re-firing on every render — the fields it is composed from are its real deps.
  const schedule: AutomationSchedule = React.useMemo(
    () =>
      preset === "hourly"
        ? { preset, minute, timeZone }
        : preset === "weekly"
          ? { preset, weekday, hour, minute, timeZone }
          : { preset, hour, minute, timeZone },
    [preset, weekday, hour, minute, timeZone],
  );
  const trigger = React.useMemo<AutomationTrigger>(
    () =>
      triggerChoice === "schedule"
        ? { kind: "schedule", schedule }
        : triggerChoice === "columns"
          ? { kind: "columns", columns }
          : NO_AUTOMATION_TRIGGER,
    [triggerChoice, schedule, columns],
  );
  const ownershipChoice: OwnershipChoice =
    automationSourceIsCloud() || triggerChoice === "schedule" ? "project" : ownership;
  const savingProjectId =
    automation === null ? (ownershipChoice === "project" ? projectId : null) : automation.projectId;
  const scheduleProblem = automationScheduleProblem({ projectId: savingProjectId, trigger });

  const draft = React.useMemo<AutomationEditorDraft>(
    () => ({
      name,
      instructions,
      ownership: ownershipChoice,
      triggerChoice,
      columns,
      schedule,
      runtime,
    }),
    [name, instructions, ownershipChoice, triggerChoice, columns, schedule, runtime],
  );
  const ownershipDirty =
    ownershipChoice !==
    (automation !== null && automation.projectId === null ? "global" : "project");
  const dirty =
    automation === null
      ? name.trim() !== "" ||
        instructions.trim() !== "" ||
        ownershipDirty ||
        triggerChoice !== "none" ||
        runtime !== null
      : name !== automation.name ||
        instructions !== automation.instructions ||
        ownershipDirty ||
        JSON.stringify(trigger) !== JSON.stringify(automation.trigger) ||
        JSON.stringify(runtime) !== JSON.stringify(automation.runtime);

  // What this slot already holds, so a pass that would rewrite the same bytes
  // writes nothing. A draft merely RESTORED is the case that matters: its
  // fields are dirty by definition, so without this every arrival re-persists
  // a draft nobody touched — and a new-record draft that renews itself on
  // arrival is one the page keeps reading as "resume the record you were
  // creating", forever (VC-375). Advanced on every write, so reverting an edit
  // to the stored text still leaves screen and storage saying the same thing.
  const persisted = React.useRef(restored === null ? null : JSON.stringify(restored));
  React.useEffect(() => {
    if (dirty) {
      const next = JSON.stringify(draft);
      if (persisted.current === next) return;
      saveEditorDraft(projectId, draft, undefined, automationId);
      persisted.current = next;
    } else {
      clearEditorDraft(projectId, undefined, automationId);
      persisted.current = null;
    }
  }, [automationId, projectId, draft, dirty]);

  const baseline = React.useRef(automation);
  React.useEffect(() => {
    const previous = baseline.current;
    baseline.current = automation;
    if (automation === null || previous === null || previous === automation) return;
    setName((current) => (current === previous.name ? automation.name : current));
    setInstructions((current) =>
      current === previous.instructions ? automation.instructions : current,
    );
    if (
      JSON.stringify(runtime) === JSON.stringify(previous.runtime) &&
      isValidAutomationRuntime(automation.runtime)
    )
      setRuntime(automation.runtime);
    if (JSON.stringify(trigger) === JSON.stringify(previous.trigger)) {
      setTriggerChoice(automation.trigger.kind);
      setColumns(automationTriggerColumns(automation.trigger));
      const saved = automationTriggerSchedule(automation.trigger);
      if (saved) {
        setPreset(saved.preset);
        setMinute(saved.minute);
        setTimeZone(saved.timeZone);
        if (saved.preset !== "hourly") setHour(saved.hour);
        if (saved.preset === "weekly") setWeekday(saved.weekday);
      }
    }
  }, [automation, runtime, trigger]);

  /** Discard restores the saved record; only a new record becomes blank. */
  function discardDraft(): void {
    clearEditorDraft(projectId, undefined, automationId);
    setName(automation?.name ?? "");
    setInstructions(automation?.instructions ?? "");
    setOwnership(automation === null || automation.projectId !== null ? "project" : "global");
    setRuntime(
      automation !== null && isValidAutomationRuntime(automation.runtime)
        ? automation.runtime
        : null,
    );
    setTriggerChoice(automation?.trigger.kind ?? "none");
    setColumns(automation === null ? [] : automationTriggerColumns(automation.trigger));
    const savedSchedule =
      automation === null ? null : automationTriggerSchedule(automation.trigger);
    setPreset(savedSchedule?.preset ?? "daily");
    setWeekday(
      savedSchedule?.preset === "weekly" ? savedSchedule.weekday : DEFAULT_SCHEDULE_WEEKDAY,
    );
    setHour(
      savedSchedule !== null && savedSchedule.preset !== "hourly"
        ? savedSchedule.hour
        : DEFAULT_SCHEDULE_HOUR,
    );
    setMinute(savedSchedule?.minute ?? 0);
    setTimeZone(savedSchedule?.timeZone ?? hostTimeZone());
    setResumed(false);
    setProblem(null);
    setEditing(null);
    focusEdit(editing);
    // A new record has nothing to restore TO, so discarding it would otherwise
    // leave a blank create form standing where the page expects one selected
    // record. Hand the surface back to the rail's first Automation, which is
    // the same answer an ordinary arrival gives.
    if (automation === null) onDiscardedNewDraft?.();
  }

  function cancelGroup(): void {
    if (automation === null) return;
    if (editing === "name") setName(automation.name);
    if (editing === "instructions") setInstructions(automation.instructions);
    if (editing === "runtime")
      setRuntime(isValidAutomationRuntime(automation.runtime) ? automation.runtime : null);
    if (editing === "trigger") {
      setTriggerChoice(automation.trigger.kind);
      setColumns(automationTriggerColumns(automation.trigger));
      const saved = automationTriggerSchedule(automation.trigger);
      setPreset(saved?.preset ?? "daily");
      setMinute(saved?.minute ?? 0);
      setTimeZone(saved?.timeZone ?? hostTimeZone());
      setHour(saved && saved.preset !== "hourly" ? saved.hour : DEFAULT_SCHEDULE_HOUR);
      setWeekday(saved?.preset === "weekly" ? saved.weekday : DEFAULT_SCHEDULE_WEEKDAY);
    }
    setProblem(null);
    setEditing(null);
    focusEdit(editing);
  }

  async function submit(): Promise<void> {
    if (lock.current || disabled || !guardWrite(projectId)) return;
    const validation =
      name.trim() === ""
        ? "Name required"
        : instructions.trim() === ""
          ? "Instructions required"
          : triggerChoice === "columns" && columns.length === 0
            ? "Select a column"
            : scheduleProblem;
    if (validation !== null) {
      setProblem(validation);
      return;
    }
    const latest =
      automation === null
        ? null
        : (useAutomationsStore
            .getState()
            .byProject[projectId]?.find((row) => row.id === automation.id) ?? automation);
    if (latest !== null && editing !== "runtime" && !isValidAutomationRuntime(latest.runtime)) {
      setProblem("Saved Runtime is invalid. Choose a valid model-and-reasoning pair");
      return;
    }
    lock.current = true;
    setSaving(true);
    const submittedDraft = JSON.stringify(draft);
    try {
      // A group changes only its own fields. Whole-record update merges with the latest projection.
      const refusal =
        automation === null
          ? await save({
              commandId: commandId.current,
              projectId: savingProjectId,
              name,
              instructions,
              trigger,
              runtime,
            })
          : await update({
              commandId: commandId.current,
              automationId: automation.id,
              name: editing === "name" ? name : latest!.name,
              instructions: editing === "instructions" ? instructions : latest!.instructions,
              trigger: editing === "trigger" ? trigger : latest!.trigger,
              runtime:
                editing === "runtime" || !isValidAutomationRuntime(latest!.runtime)
                  ? runtime
                  : latest!.runtime,
            });
      if (refusal === null) {
        commandId.current = crypto.randomUUID();
        setProblem(null);
        const remainingDraft =
          latest !== null &&
          ((editing !== "name" && name !== latest.name) ||
            (editing !== "instructions" && instructions !== latest.instructions) ||
            (editing !== "runtime" && JSON.stringify(runtime) !== JSON.stringify(latest.runtime)) ||
            (editing !== "trigger" && JSON.stringify(trigger) !== JSON.stringify(latest.trigger)));
        // Never clear newer typing that happened while this save was in flight.
        if (
          loadEditorDraft(projectId, undefined, automationId) === null ||
          JSON.stringify(loadEditorDraft(projectId, undefined, automationId)) === submittedDraft
        ) {
          if (!remainingDraft) {
            clearEditorDraft(projectId, undefined, automationId);
            setResumed(false);
          }
          setEditing(null);
          focusEdit(editing);
        }
      } else {
        setProblem(`Couldn’t save ${name}: ${refusal}`);
      }
    } catch (error) {
      setProblem(`Couldn’t save ${name}: ${errorMessage(error)}`);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  function groupActions(group: Group) {
    if (automation === null) return null;
    return editing === group ? (
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={saving} onClick={cancelGroup}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={disabled || saving}
          aria-label={`Save ${group}`}
          onClick={() => void submit()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    ) : (
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || saving}
        aria-label={`Edit ${group}`}
        onClick={() => startEdit(group)}
      >
        Edit
      </Button>
    );
  }
  const triggerEditing = creating || editing === "trigger";
  const instructionsEditing = creating || editing === "instructions";
  const runtimeEditing = creating || editing === "runtime";
  const savedSchedule = automation === null ? null : automationTriggerSchedule(automation.trigger);
  const armings = useAutomationsStore((state) => state.armingByProject[projectId]);
  const armedColumns =
    automation === null
      ? []
      : automationTriggerColumns(automation.trigger).filter((status) =>
          armings?.some((a) => a.status === status && a.automationId === automation.id),
        );
  return (
    <div
      ref={panel}
      data-slot="automation-editor"
      className="automation-groups flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      onKeyDown={(event) => {
        if (event.defaultPrevented || saving) return;
        if (
          event.key === "Escape" &&
          editing !== null &&
          !panel.current?.querySelector("[data-slot=composer-picker]")
        ) {
          event.preventDefault();
          discardDraft();
        }
        if (
          event.key === "Enter" &&
          ((event.metaKey && (creating || editing !== null)) || editing === "name")
        ) {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <ContentColumn className="py-6">
        {back}
        <header className="mb-6 flex min-w-0 flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1" data-editing={creating || editing === "name"}>
            {creating || editing === "name" ? (
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                aria-label="Name"
                placeholder="Name"
                aria-invalid={problem === "Name required"}
                aria-describedby={problem === "Name required" ? problemId : undefined}
                className="min-w-0 text-heading font-semibold"
                disabled={disabled || saving}
              />
            ) : (
              <h2 aria-label={automation.name} className="text-heading font-semibold wrap-anywhere">
                <button
                  className="w-full rounded-control text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Rename ${automation.name}`}
                  disabled={disabled}
                  onClick={() => startEdit("name")}
                >
                  {automation.name}
                </button>
              </h2>
            )}
            {!creating && (
              <div className="mt-2 text-ui text-muted-foreground">
                {readState === "loading" ? (
                  "Loading automation…"
                ) : readState === "failed" ? null : automationSourceIsCloud() ? (
                  <CloudAutomationState projectId={projectId} automation={automation} />
                ) : automation.trigger.kind === "none" || !firesHere ? (
                  "Manual only"
                ) : savedSchedule ? (
                  <NextScheduledRun schedule={savedSchedule} automationId={automation.id} />
                ) : (
                  `${armedColumns.length > 0 ? "Armed" : "Offered"} in ${columnNames(armedColumns.length > 0 ? armedColumns : automationTriggerColumns(automation.trigger))}`
                )}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {editing === "name" ? groupActions("name") : actions}
          </div>
          {(dirty || creating) && (
            <div className="basis-full">
              <DraftIndicator dirty={dirty} resumed={resumed} onDiscard={discardDraft} />
            </div>
          )}
        </header>
        <fieldset
          aria-describedby={problem ? problemId : undefined}
          disabled={disabled || saving}
          className="flex min-w-0 flex-col gap-5"
        >
          <div data-editing={triggerEditing}>
            <PrefSection
              title="Trigger"
              action={
                <div className="flex items-center gap-1">
                  {groupActions("trigger")}
                  {!automationSourceIsCloud() && (savedSchedule || triggerChoice === "schedule") ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Trigger more actions">
                          <MoreIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setPolicy(true)}>
                          <InfoIcon />
                          Schedule policy
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              }
            >
              {triggerEditing ? (
                <>
                  <PrefRow label="Trigger">
                    <Segmented<TriggerChoice>
                      ariaLabel="Trigger"
                      tabIdPrefix="automation-trigger"
                      value={triggerChoice}
                      options={[
                        { key: "none", label: "None" },
                        { key: "columns", label: "Columns" },
                        { key: "schedule", label: "Schedule" },
                      ]}
                      onChange={setTriggerChoice}
                    />
                  </PrefRow>
                  <div
                    role="tabpanel"
                    className={
                      triggerChoice === "schedule" ? "border-t border-border/50" : undefined
                    }
                    id={`automation-trigger-page-${triggerChoice}`}
                    aria-labelledby={`automation-trigger-tab-${triggerChoice}`}
                  >
                    {triggerChoice === "columns" && (
                      <div className="flex flex-wrap gap-x-5 gap-y-3 border-t border-border p-3">
                        {TICKET_STATUSES.map((status) => (
                          <label key={status} className="flex items-center gap-2 text-ui">
                            <Checkbox
                              checked={columns.includes(status)}
                              aria-label={TICKET_STATUS_LABELS[status]}
                              onCheckedChange={() =>
                                setColumns(
                                  TICKET_STATUSES.filter((s) =>
                                    s === status ? !columns.includes(s) : columns.includes(s),
                                  ),
                                )
                              }
                            />
                            {TICKET_STATUS_LABELS[status]}
                          </label>
                        ))}
                      </div>
                    )}
                    {triggerChoice === "schedule" && (
                      <>
                        <PrefRow label="Frequency">
                          <Select
                            value={preset}
                            onValueChange={(v) => setPreset(v as AutomationSchedulePreset)}
                          >
                            <SelectTrigger
                              variant="inspector"
                              className="w-auto"
                              aria-label="Frequency"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {AUTOMATION_SCHEDULE_PRESETS.map((value) => (
                                <SelectItem key={value} value={value}>
                                  <ClockIcon />
                                  {
                                    {
                                      hourly: "Hourly",
                                      daily: "Daily",
                                      weekdays: "Weekdays",
                                      weekly: "Weekly",
                                    }[value]
                                  }
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </PrefRow>
                        {preset === "weekly" && (
                          <PrefRow label="Day">
                            <Select
                              value={weekday}
                              onValueChange={(v) => setWeekday(v as ScheduleWeekday)}
                            >
                              <SelectTrigger
                                variant="inspector"
                                className="w-auto"
                                aria-label="Day"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {SCHEDULE_WEEKDAYS.map((value) => (
                                  <SelectItem key={value} value={value}>
                                    <ClockIcon />
                                    {SCHEDULE_WEEKDAY_LABELS[value]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </PrefRow>
                        )}
                        {preset === "hourly" ? (
                          <PrefRow label="Minute">
                            <ScheduleNumberInput
                              value={minute}
                              max={59}
                              ariaLabel="Minute"
                              onChange={setMinute}
                            />
                          </PrefRow>
                        ) : (
                          <PrefRow label="Time">
                            <TimeField
                              hour={hour}
                              minute={minute}
                              onHourChange={setHour}
                              onMinuteChange={setMinute}
                            />
                          </PrefRow>
                        )}
                        <PrefRow label="Time zone">
                          <TimeZonePicker
                            value={timeZone}
                            onChange={setTimeZone}
                            className="max-w-full"
                          />
                        </PrefRow>
                        {!creating && scheduleProblem === null && (
                          <PrefRow label="Next runs">
                            <SchedulePreview schedule={schedule} automationId={automation.id} />
                          </PrefRow>
                        )}
                      </>
                    )}
                    {scheduleProblem && (
                      <p role="alert" className="p-3 text-ui text-destructive">
                        {scheduleProblem}
                      </p>
                    )}
                  </div>
                </>
              ) : savedSchedule ? (
                <>
                  <PrefRow label="Frequency">
                    <span className="text-ui">
                      {triggerLabel(automation.trigger).replace(` · ${savedSchedule.timeZone}`, "")}
                    </span>
                  </PrefRow>
                  <PrefRow label="Time zone">
                    <span className="text-ui wrap-anywhere">{savedSchedule.timeZone}</span>
                  </PrefRow>
                </>
              ) : (
                <PrefRow label="Trigger">
                  <span className="text-ui wrap-anywhere">{triggerLabel(automation.trigger)}</span>
                </PrefRow>
              )}
              {automation !== null && (
                <AutomationTriggerState
                  projectId={projectId}
                  automation={automation}
                  disabled={disabled || saving}
                />
              )}
            </PrefSection>
          </div>
          <div data-editing={instructionsEditing}>
            <PrefSection
              title="Instructions"
              action={
                <div className="flex flex-wrap items-center gap-1">
                  {instructionsEditing && (
                    <AutomationAuthoringButton
                      projectId={projectId}
                      context={{
                        name,
                        instructions,
                        trigger,
                        runtime,
                        skillSlugs: skills.map((s) => s.name),
                      }}
                    />
                  )}
                  {groupActions("instructions")}
                </div>
              }
            >
              {instructionsEditing ? (
                <ComposerPickerStack
                  value={instructions}
                  onValueChange={setInstructions}
                  ready
                  interactionOpen={false}
                  promptTemplates={templates}
                  skills={skills}
                  verbs={[]}
                  files={fileIndex.getIndex()}
                  onFilePickerOpen={fileIndex.refresh}
                  layout="overlay"
                >
                  <InstructionsTextarea
                    value={instructions}
                    onValueChange={setInstructions}
                    className="min-h-40"
                  />
                </ComposerPickerStack>
              ) : (
                <div className="p-3">
                  <p
                    className={cn(
                      "whitespace-pre-wrap text-ui leading-6 wrap-anywhere",
                      !expanded && "line-clamp-5",
                    )}
                  >
                    {automation.instructions}
                  </p>
                  {(automation.instructions.length > 250 ||
                    automation.instructions.split("\n").length > 5) && (
                    <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
                      {expanded ? "Less" : "More"}
                    </Button>
                  )}
                </div>
              )}
            </PrefSection>
          </div>
          <div data-editing={runtimeEditing}>
            <PrefSection title="Runtime" action={groupActions("runtime")}>
              <PrefRow label="Model">
                {runtimeEditing ? (
                  <RuntimeFields models={models} runtime={runtime} onChange={setRuntime} />
                ) : (
                  <AutomationRuntimeValue
                    runtime={automation.runtime}
                    projectId={projectId}
                    projectTarget={automation.trigger.kind === "schedule"}
                  />
                )}
              </PrefRow>
              <PrefRow label="Scope">
                {creating ? (
                  <Select
                    value={ownershipChoice}
                    disabled={triggerChoice === "schedule"}
                    onValueChange={(v) => setOwnership(v as OwnershipChoice)}
                  >
                    <SelectTrigger variant="inspector" className="w-auto" aria-label="Scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="project">
                        <FolderOpenIcon />
                        This project
                      </SelectItem>
                      {!automationSourceIsCloud() && (
                        <SelectItem value="global">
                          <GlobeIcon />
                          All projects
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-ui">
                    {automation.projectId === null ? "All projects" : "This project"}
                  </span>
                )}
              </PrefRow>
            </PrefSection>
          </div>
          {creating && (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={discardDraft}>
                Discard
              </Button>
              <Button size="sm" onClick={() => void submit()}>
                {saving ? "Saving…" : "Create"}
              </Button>
            </div>
          )}
        </fieldset>
        {problem !== null && (
          <p id={problemId} role="alert" className="mt-3 text-ui text-destructive">
            {problem}
          </p>
        )}
        {!creating && history}
      </ContentColumn>
      <Dialog open={policy} onOpenChange={setPolicy}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule policy</DialogTitle>
          </DialogHeader>
          <p className="text-ui">
            Up to {AUTOMATION_SCHEDULE_LATE_GRACE_MS / 60_000} min late. Skipped when Volli is
            closed or this Mac is asleep.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SchedulePreview({
  schedule,
  automationId,
}: {
  schedule: AutomationSchedule;
  automationId: string;
}) {
  const [now] = React.useState(() => Date.now());
  const dates = React.useMemo(() => {
    let after = now;
    return Array.from({ length: 3 }, () => {
      after = nextScheduleOccurrence({ schedule, staggerKey: automationId, after });
      return new Date(after).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: schedule.timeZone,
      });
    });
  }, [schedule, automationId, now]);
  return (
    <div className="text-right text-ui tabular-nums">
      {dates.map((date) => (
        <div key={date}>{date}</div>
      ))}
    </div>
  );
}

/**
 * The Instructions box with the shared composer's caret binding. Exported for
 * Run once, whose unbound Instructions use the same grammar without becoming
 * another Automation authoring surface.
 *
 * IT WEARS THE COMPOSER'S SHELL (VC-335), and the composer's `+`. This is a
 * prompt — the same `/` and `@` grammar, the same picker card over it — and it
 * was drawn as a bare form field with a browser resize grip in its corner, so
 * the two surfaces a person writes prompts into looked like two different
 * kinds of thing. Now it is `PROMPT_SURFACE` around the same textarea insets,
 * with the same `+` (Commands & skills and Mention a file — no attach row,
 * because Instructions take no files). The runtime lives in the aside on the
 * editor and under the box on Run once, where it already was.
 *
 * NO TINTED TRAY HERE, and that is the rule rather than an exception. The tray
 * exists to separate writing from CONFIGURATION — in chat it carries model,
 * effort and the send key; on a comment it carries the primary. This surface
 * has neither: saving belongs to the editor around it, so the band was a
 * full-width tint holding one 24px button at its far left and nothing else,
 * which read as a container someone forgot to fill. The door rests on the
 * writing sheet instead, aligned to the text's own inset. `new-command-dialog`
 * already draws a trayless prompt surface on the same reasoning.
 *
 * `className` reaches the textarea, because the two call sites disagree on
 * how tall a resting box should be (a page's instructions, a dialog's) and
 * that is the only thing they disagree on.
 */
export function InstructionsTextarea({
  value,
  onValueChange,
  className,
}: {
  value: string;
  onValueChange(value: string): void;
  className?: string;
}) {
  const caret = useComposerCaretBinding();
  return (
    <div
      data-slot="instructions-box"
      className={cn("flex min-w-0 flex-col overflow-hidden", PROMPT_SURFACE)}
    >
      <textarea
        ref={caret.ref}
        value={value}
        aria-label="Instructions"
        placeholder={INSTRUCTIONS_PLACEHOLDER}
        className={cn(
          // The chat composer's own text box: the same inset, the same size,
          // grown by content to a ceiling and scrolled inside itself past it.
          // No resize grip — `field-sizing-content` is the growth, and the
          // grip drew a form field where a prompt box should be.
          "field-sizing-content min-h-32 max-h-96 w-full resize-none bg-transparent px-4 py-4",
          "text-sm text-foreground outline-none placeholder:text-muted-foreground",
          className,
        )}
        onChange={(event) => {
          caret.trackCaret(event.currentTarget);
          onValueChange(event.currentTarget.value);
        }}
        onSelect={(event) => caret.trackCaret(event.currentTarget)}
        onKeyUp={(event) => caret.trackCaret(event.currentTarget)}
        onKeyDown={(event) => {
          if (caret.handleKeyDown(event)) return;
        }}
      />
      {/* On the sheet, not in a tray: `px-3` puts the button's edge on the
          text's 16px column so it reads as placed rather than parked. */}
      <div className="flex items-center gap-1 px-3 pb-3">
        <ComposerAddMenu />
      </div>
    </div>
  );
}
