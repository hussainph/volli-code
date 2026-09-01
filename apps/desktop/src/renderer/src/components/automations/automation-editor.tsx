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
import * as React from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import {
  AUTOMATION_SCHEDULE_PRESET_LABELS,
  AUTOMATION_SCHEDULE_PRESETS,
  automationScheduleProblem,
  automationTriggerColumns,
  automationTriggerSchedule,
  errorMessage,
  hostTimeZone,
  isAutomationRuntimePin,
  NO_AUTOMATION_TRIGGER,
  SCHEDULE_WEEKDAY_LABELS,
  SCHEDULE_WEEKDAYS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Automation,
  type AutomationSchedule,
  type AutomationSchedulePreset,
  type AutomationTrigger,
  type ModelSelection,
  type ScheduleWeekday,
  type TicketStatus,
} from "@volli/shared";
import { reclampEffort } from "@volli/session-presentation";

import {
  ComposerPickerStack,
  offerableModels,
  useComposerCaretBinding,
  type ComposerModel,
} from "@renderer/components/chat/composer-ui";
import { composerModelSelection } from "@renderer/components/chat/chat-plane-model";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { usePromptTemplates } from "@renderer/hooks/use-prompt-templates";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { cn } from "@renderer/lib/utils";
import { useAutomationsStore } from "@renderer/stores/automations";

import { INSTRUCTIONS_PLACEHOLDER, MANUAL_TRIGGER_LABEL } from "./automations-page-model";
import { TimeZonePicker } from "./time-zone-picker";

const NO_MODELS: readonly ComposerModel[] = [];

type OwnershipChoice = "project" | "global";
type TriggerChoice = "none" | "columns" | "schedule";

const DEFAULT_SCHEDULE_HOUR = 9;
const DEFAULT_SCHEDULE_WEEKDAY: ScheduleWeekday = "monday";

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
          <label className="flex flex-col gap-1 text-label text-muted-foreground uppercase">
            Hour
            <ScheduleNumberInput value={hour} max={23} ariaLabel="Hour" onChange={onHourChange} />
          </label>
          <span aria-hidden className="h-6 text-ui leading-6 text-muted-foreground">
            :
          </span>
          <label className="flex flex-col gap-1 text-label text-muted-foreground uppercase">
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="text-label text-muted-foreground uppercase">{children}</h2>;
}

function TriggerChoice({
  value,
  selected,
  icon: Icon,
  onSelect,
  children,
}: {
  value: TriggerChoice;
  selected: TriggerChoice;
  icon: typeof PlayIcon;
  onSelect(value: TriggerChoice): void;
  children: React.ReactNode;
}) {
  const active = value === selected;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onSelect(value)}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-lg border px-2 text-left text-ui outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/45",
        active
          ? "border-ring bg-accent text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">{children}</span>
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full border",
          active ? "border-primary bg-primary" : "border-muted-foreground",
        )}
      />
    </button>
  );
}

function ColumnPicker({
  value,
  onChange,
}: {
  value: readonly TicketStatus[];
  onChange(value: readonly TicketStatus[]): void;
}) {
  const label =
    value.length === 0
      ? "Choose columns"
      : value.map((status) => TICKET_STATUS_LABELS[status]).join(", ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Columns"
          className="flex h-7 w-full min-w-0 items-center gap-2 rounded-control border border-border bg-transparent px-4 text-ui text-foreground shadow-raised outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {TICKET_STATUSES.map((status) => {
          const selected = value.includes(status);
          return (
            <button
              key={status}
              type="button"
              role="checkbox"
              aria-checked={selected}
              onClick={() =>
                onChange(
                  TICKET_STATUSES.filter((candidate) =>
                    candidate === status ? !selected : value.includes(candidate),
                  ),
                )
              }
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <CheckIcon className={cn("size-3.5", !selected && "invisible")} weight="bold" />
              {TICKET_STATUS_LABELS[status]}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function modelValue(model: Pick<ComposerModel, "providerId" | "modelId">): string {
  return `${model.providerId}/${model.modelId}`;
}

function RuntimeFields({
  models,
  pin,
  onChange,
}: {
  models: readonly ComposerModel[];
  pin: ModelSelection | null;
  onChange(pin: ModelSelection | null): void;
}) {
  const selectedModel =
    pin === null
      ? undefined
      : models.find(
          (model) => model.providerId === pin.providerId && model.modelId === pin.modelId,
        );
  const unavailableValue =
    pin !== null && selectedModel === undefined ? `unavailable:${modelValue(pin)}` : null;
  const value = pin === null ? "inherit" : (selectedModel?.id ?? unavailableValue!);
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
        <SelectTrigger className="w-full" aria-label="Runtime model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            <CpuIcon />
            Project default
          </SelectItem>
          {unavailableValue === null || pin === null ? null : (
            <SelectItem value={unavailableValue}>
              <CpuIcon />
              {pin.providerId} · {pin.modelId}
            </SelectItem>
          )}
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              <CpuIcon />
              {model.providerLabel} · {model.label}
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
          <SelectTrigger className="w-full" aria-label="Reasoning effort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {levels.map((level) => (
              <SelectItem key={level} value={level}>
                <CpuIcon />
                {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}

export function AutomationEditorPanel({
  projectId,
  automation,
  actions,
  history,
}: {
  projectId: string;
  automation: Automation | null;
  actions?: React.ReactNode;
  history?: React.ReactNode;
}) {
  const save = useAutomationsStore((state) => state.save);
  const update = useAutomationsStore((state) => state.update);
  const commandId = React.useRef(crypto.randomUUID());
  const [name, setName] = React.useState(automation?.name ?? "");
  const [instructions, setInstructions] = React.useState(automation?.instructions ?? "");
  const [ownership, setOwnership] = React.useState<OwnershipChoice>(
    automation === null || automation.projectId !== null ? "project" : "global",
  );
  const [pin, setPin] = React.useState<ModelSelection | null>(
    automation !== null && isAutomationRuntimePin(automation.runtime) ? automation.runtime : null,
  );
  const [triggerChoice, setTriggerChoice] = React.useState<TriggerChoice>(() =>
    automation === null || automation.trigger.kind === "none" ? "none" : automation.trigger.kind,
  );
  const [columns, setColumns] = React.useState<readonly TicketStatus[]>(() =>
    automation === null ? [] : automationTriggerColumns(automation.trigger),
  );
  const storedSchedule = automation === null ? null : automationTriggerSchedule(automation.trigger);
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

  const schedule: AutomationSchedule =
    preset === "hourly"
      ? { preset, minute, timeZone }
      : preset === "weekly"
        ? { preset, weekday, hour, minute, timeZone }
        : { preset, hour, minute, timeZone };
  const trigger: AutomationTrigger =
    triggerChoice === "schedule"
      ? { kind: "schedule", schedule }
      : triggerChoice === "columns" && columns.length > 0
        ? { kind: "columns", columns }
        : NO_AUTOMATION_TRIGGER;
  const ownershipChoice: OwnershipChoice = triggerChoice === "schedule" ? "project" : ownership;
  const savingProjectId =
    automation === null ? (ownershipChoice === "project" ? projectId : null) : automation.projectId;
  const scheduleProblem = automationScheduleProblem({ projectId: savingProjectId, trigger });
  const incomplete =
    name.trim().length === 0 ||
    instructions.trim().length === 0 ||
    (triggerChoice === "columns" && columns.length === 0) ||
    scheduleProblem !== null;

  async function submit(): Promise<void> {
    if (incomplete || saving) return;
    setSaving(true);
    try {
      const refusal =
        automation === null
          ? await save({
              commandId: commandId.current,
              projectId: savingProjectId,
              name,
              instructions,
              trigger,
              runtime: pin,
            })
          : await update({
              commandId: commandId.current,
              automationId: automation.id,
              name,
              instructions,
              trigger,
              runtime: pin,
            });
      if (refusal === null) {
        commandId.current = crypto.randomUUID();
        setProblem(null);
      } else {
        setProblem(refusal);
      }
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-slot="automation-editor" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-border px-6 py-4">
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          aria-label="Name"
          placeholder="Name this automation"
          className="min-w-0 flex-1 bg-transparent text-heading font-semibold text-foreground outline-none placeholder:text-muted-foreground"
        />
        {actions}
        <Button size="sm" disabled={incomplete || saving} onClick={() => void submit()}>
          {automation === null ? "Create automation" : "Save changes"}
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_20rem]">
        <main className="min-h-0 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-content flex-col gap-6">
            <section className="flex min-h-0 flex-col gap-2">
              <SectionLabel>Instructions</SectionLabel>
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
                  className="min-h-48 rounded-xl bg-card px-4 py-4 shadow-raised"
                />
              </ComposerPickerStack>
            </section>
            {history}
          </div>
        </main>

        <aside className="min-h-0 overflow-y-auto border-l border-border bg-rail/30">
          <section className="flex flex-col gap-2 border-b border-border p-4">
            <SectionLabel>Ownership</SectionLabel>
            {automation === null ? (
              <Select
                value={ownershipChoice}
                disabled={triggerChoice === "schedule"}
                onValueChange={(value) => setOwnership(value as OwnershipChoice)}
              >
                <SelectTrigger className="w-full" aria-label="Ownership">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">
                    <FolderOpenIcon />
                    This project
                  </SelectItem>
                  <SelectItem value="global">
                    <GlobeIcon />
                    All projects
                  </SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <div className="flex h-7 items-center gap-2 text-ui text-foreground">
                {automation.projectId === null ? <GlobeIcon /> : <FolderOpenIcon />}
                {automation.projectId === null ? "All projects" : "This project"}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2 border-b border-border p-4">
            <SectionLabel>Trigger</SectionLabel>
            <div role="radiogroup" aria-label="Trigger" className="flex flex-col gap-1">
              <TriggerChoice
                value="none"
                selected={triggerChoice}
                icon={PlayIcon}
                onSelect={setTriggerChoice}
              >
                {MANUAL_TRIGGER_LABEL}
              </TriggerChoice>
              <TriggerChoice
                value="columns"
                selected={triggerChoice}
                icon={ArrowRightIcon}
                onSelect={setTriggerChoice}
              >
                Ticket enters
              </TriggerChoice>
              <TriggerChoice
                value="schedule"
                selected={triggerChoice}
                icon={ClockIcon}
                onSelect={setTriggerChoice}
              >
                On a schedule
              </TriggerChoice>
            </div>

            {triggerChoice === "columns" ? (
              <ColumnPicker value={columns} onChange={setColumns} />
            ) : null}

            {triggerChoice === "schedule" ? (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2">
                <Select
                  value={preset}
                  onValueChange={(value) => setPreset(value as AutomationSchedulePreset)}
                >
                  <SelectTrigger className="w-full" aria-label="Schedule">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTOMATION_SCHEDULE_PRESETS.map((value) => (
                      <SelectItem key={value} value={value}>
                        <ClockIcon />
                        {AUTOMATION_SCHEDULE_PRESET_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {preset === "weekly" ? (
                  <Select
                    value={weekday}
                    onValueChange={(value) => setWeekday(value as ScheduleWeekday)}
                  >
                    <SelectTrigger className="w-full" aria-label="Day of the week">
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
                ) : null}
                {preset === "hourly" ? (
                  <label className="flex items-center justify-between gap-2 text-ui text-muted-foreground">
                    Minutes past the hour
                    <ScheduleNumberInput
                      value={minute}
                      max={59}
                      ariaLabel="Minutes past the hour"
                      onChange={setMinute}
                    />
                  </label>
                ) : (
                  <TimeField
                    hour={hour}
                    minute={minute}
                    onHourChange={setHour}
                    onMinuteChange={setMinute}
                  />
                )}
                <TimeZonePicker
                  value={timeZone}
                  onChange={setTimeZone}
                  className="w-full max-w-none"
                />
              </div>
            ) : null}
            {scheduleProblem === null ? null : (
              <p className="text-label text-muted-foreground">{scheduleProblem}</p>
            )}
          </section>

          <section className="flex flex-col gap-2 p-4">
            <SectionLabel>Runtime</SectionLabel>
            <RuntimeFields models={models} pin={pin} onChange={setPin} />
          </section>
        </aside>
      </div>
      {problem === null ? null : (
        <p role="alert" className="border-t border-border px-6 py-2 text-label text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * The Instructions box with the shared composer's caret binding. Exported for
 * Run once, whose unbound Instructions use the same grammar without becoming
 * another Automation authoring surface.
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
    <textarea
      ref={caret.ref}
      value={value}
      aria-label="Instructions"
      placeholder={INSTRUCTIONS_PLACEHOLDER}
      className={cn(
        "min-h-32 w-full resize-y rounded-lg border border-border bg-transparent px-4 py-2",
        "text-sm text-foreground outline-none placeholder:text-muted-foreground",
        "focus-visible:border-ring",
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
  );
}
