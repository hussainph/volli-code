/**
 * The Automation editor: the app's ONE authoring surface (VC-112 — "only the
 * nav page authors, every other surface just runs"), reached from the
 * Automations page's New / Edit / Duplicate actions and from the command
 * palette's create. The form — name, Ownership, Trigger, Instructions,
 * Runtime — is the record's whole editable shape either way.
 *
 * It creates and it edits, off one field: `editor.automation` is the record
 * being edited or `null` for a create. The alternative — a second dialog for
 * edit — is how the one authoring surface quietly becomes two that drift.
 *
 * Ownership is EDITABLE ON CREATE ONLY. It decides where an Automation is
 * listed, and main treats it as identity (`updateAutomation` takes no
 * `projectId`): a record that could move between scopes would take its Run
 * history somewhere those Runs never happened.
 *
 * Two reuses are the point of this file, not conveniences:
 *
 *  - **Instructions get the chat composer's own grammar.** The box lives
 *    inside {@link ComposerPickerStack} with the same project-scoped supply
 *    the chat composer reads (`usePromptTemplates`, `useFileIndex`), so `/`
 *    offers the same templates and Skills and `@` the same files, inserted by
 *    the same picker. Expansion happens at RUN time in main, through the same
 *    shared function the composer's send uses — never at save.
 *  - **The Runtime pin is the composer's own two pills.** Model and reasoning
 *    travel together as one selection; the pill pair cannot spell a level its
 *    model does not offer, and main re-validates against Model Access at save.
 *
 * Save refusals render inline under the form — a rejected name or pin is a
 * correction to what is still on screen, not a failure behind anyone's back.
 */
import * as React from "react";

import {
  automationScheduleProblem,
  automationTriggerColumns,
  automationTriggerSchedule,
  errorMessage,
  hostTimeZone,
  isAutomationRuntimePin,
  NO_AUTOMATION_TRIGGER,
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

import {
  INSTRUCTIONS_PLACEHOLDER,
  MANUAL_TRIGGER_LABEL,
  ownershipLabel,
} from "./automations-page-model";
import { TimeZonePicker } from "./time-zone-picker";

import {
  ComposerPickerStack,
  ModelPill,
  offerableModels,
  useComposerCaretBinding,
  type ComposerModel,
} from "@renderer/components/chat/composer-ui";
import { EffortPill } from "@renderer/components/chat/composer-effort-ui";
import { composerModelSelection } from "@renderer/components/chat/chat-plane-model";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Segmented } from "@renderer/components/ui/segmented";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { usePromptTemplates } from "@renderer/hooks/use-prompt-templates";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { useAutomationsStore } from "@renderer/stores/automations";
import { cn } from "@renderer/lib/utils";

const NO_MODELS: readonly ComposerModel[] = [];

/** The blank the pill reads as its disabled "Model" resting label. */
const NO_PIN = { providerId: "", modelId: "", reasoningLevel: "" };

type OwnershipChoice = "project" | "global";
type RuntimeChoice = "inherit" | "pin";
/**
 * The Trigger control's three answers — the whole set VC-112 rules, complete
 * as of VC-130. "Only when I run it" is the default and a complete answer
 * rather than an inert one: run by hand is universal, so the Trigger says only
 * what ELSE starts this Automation.
 */
type TriggerChoice = "none" | "columns" | "schedule";

/** What a new schedule opens on: nine in the morning, here, every day. */
const DEFAULT_SCHEDULE_HOUR = 9;
const DEFAULT_SCHEDULE_WEEKDAY: ScheduleWeekday = "monday";

/** The preset control's own words, finishing the sentence "Every …". */
const SCHEDULE_PRESET_OPTIONS: readonly { key: AutomationSchedulePreset; label: string }[] = [
  { key: "hourly", label: "hour" },
  { key: "daily", label: "day" },
  { key: "weekdays", label: "weekday" },
  { key: "weekly", label: "week" },
];

/** Three letters each: seven segments have to fit beside the rest of the sentence. */
const WEEKDAY_OPTIONS: readonly { key: ScheduleWeekday; label: string }[] = SCHEDULE_WEEKDAYS.map(
  (weekday) => ({ key: weekday, label: `${weekday[0]!.toUpperCase()}${weekday.slice(1, 3)}` }),
);

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * The dialog itself, mounted once beside the command palette. It renders only
 * while the store says an editor is open, and everything in it resets by
 * REMOUNT (the `key` below): a dialog dismissed mid-draft starts blank next
 * time, which for a short form is less surprising than a resurrected draft
 * with no visible home. The key names the RECORD, so switching from one
 * Automation's Edit to another's without closing re-seeds the fields.
 */
export function AutomationEditorDialog() {
  const editor = useAutomationsStore((state) => state.editor);
  if (editor === null) return null;
  return (
    <AutomationEditorForm
      key={`${editor.projectId}:${editor.automation?.id ?? "new"}`}
      projectId={editor.projectId}
      automation={editor.automation}
    />
  );
}

function AutomationEditorForm({
  projectId,
  automation,
}: {
  projectId: string;
  automation: Automation | null;
}) {
  const closeEditor = useAutomationsStore((state) => state.closeEditor);
  const save = useAutomationsStore((state) => state.save);
  const update = useAutomationsStore((state) => state.update);

  // This id survives an invoke failure while the dialog stays mounted, so the
  // person's Retry repeats durable intent instead of creating a second record.
  const [commandId] = React.useState(() => crypto.randomUUID());
  const [name, setName] = React.useState(automation?.name ?? "");
  // A new Automation opens an EMPTY box (VC-112). The placeholder is what
  // pushes toward `/skill`; seeding prose here is what that rule forbids.
  const [instructions, setInstructions] = React.useState(automation?.instructions ?? "");
  const [ownership, setOwnership] = React.useState<OwnershipChoice>(
    automation === null || automation.projectId !== null ? "project" : "global",
  );
  // Inherited by default (VC-112): workflows persist while models churn, so
  // the model must not be part of an Automation's identity. A stored pin that
  // no longer parses opens on "inherit" rather than pretending to be one.
  const [runtimeChoice, setRuntimeChoice] = React.useState<RuntimeChoice>(
    automation !== null && isAutomationRuntimePin(automation.runtime) ? "pin" : "inherit",
  );
  const [pin, setPin] = React.useState<ModelSelection | null>(
    automation !== null && isAutomationRuntimePin(automation.runtime) ? automation.runtime : null,
  );
  // The Trigger opens on what the record holds. A stored Trigger is already
  // canonical (main parses on the way in), so the columns seed straight from
  // it and an Automation offered nowhere opens on "Only when I run it".
  const [triggerChoice, setTriggerChoice] = React.useState<TriggerChoice>(() =>
    automation === null || automation.trigger.kind === "none" ? "none" : automation.trigger.kind,
  );
  const [columns, setColumns] = React.useState<readonly TicketStatus[]>(() =>
    automation === null ? [] : automationTriggerColumns(automation.trigger),
  );
  // The schedule's parts are held SEPARATELY rather than as the stored union,
  // so switching "every week" to "every hour" and back does not forget the hour
  // that was already chosen. The union is projected from them below, which is
  // what keeps the RECORD unable to spell "hourly, at 09:00".
  const storedSchedule = automation === null ? null : automationTriggerSchedule(automation.trigger);
  const [preset, setPreset] = React.useState<AutomationSchedulePreset>(
    storedSchedule?.preset ?? "daily",
  );
  const [weekday, setWeekday] = React.useState<ScheduleWeekday>(
    storedSchedule !== null && storedSchedule.preset === "weekly"
      ? storedSchedule.weekday
      : DEFAULT_SCHEDULE_WEEKDAY,
  );
  const [hour, setHour] = React.useState<number>(
    storedSchedule !== null && storedSchedule.preset !== "hourly"
      ? storedSchedule.hour
      : DEFAULT_SCHEDULE_HOUR,
  );
  const [minute, setMinute] = React.useState<number>(storedSchedule?.minute ?? 0);
  // The host's zone seeds a NEW schedule and is never read again: from the
  // moment it is stored, the stored zone wins and travelling moves nothing
  // (VC-112).
  const [timeZone, setTimeZone] = React.useState<string>(
    storedSchedule?.timeZone ?? hostTimeZone(),
  );
  const [problem, setProblem] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // The composer's own supply, project-scoped exactly as the chat composer
  // reads it — same templates, same ruled skills, same file index.
  const { templates, skills } = usePromptTemplates(projectId);
  const fileIndex = useFileIndex(projectId);

  // The pin picker's catalog: the same offerable set every composer shows.
  const access = useModelAccessClient();
  const inspect = access?.inspect;
  const hiddenModels = access?.hiddenModels;
  const [models, setModels] = React.useState<readonly ComposerModel[]>(NO_MODELS);
  React.useEffect(() => {
    if (inspect === undefined || hiddenModels === undefined) return;
    let current = true;
    void Promise.all([inspect({}), hiddenModels()])
      .then(([snapshot, hidden]) => {
        if (!current) return;
        setModels(offerableModels(snapshot.models, snapshot.providers, hidden));
      })
      .catch(() => {
        // An unreadable catalog costs the pin control, never the dialog:
        // inherit still saves, and the pill explains itself by being disabled.
        if (!current) return;
        setModels(NO_MODELS);
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
  // A schedule Run's Target is the Project, so a scheduled Automation has to
  // belong to one. On a CREATE that is settled by forcing the choice — the
  // control shows "This project" and stops offering the other answer, which is
  // legible in a way a refusal at Save is not. On an EDIT, Ownership is
  // identity and cannot move, so a globally listed record gets the shared
  // refusal below and the one action that resolves it.
  const ownershipChoice: OwnershipChoice = triggerChoice === "schedule" ? "project" : ownership;
  const savingProjectId =
    automation === null ? (ownershipChoice === "project" ? projectId : null) : automation.projectId;
  const scheduleProblem = automationScheduleProblem({ projectId: savingProjectId, trigger });
  const runtime = runtimeChoice === "pin" ? pin : null;
  const pinStops =
    pin === null
      ? []
      : (models.find(
          (model) => model.providerId === pin.providerId && model.modelId === pin.modelId,
        )?.reasoningLevels ?? []);
  // The store's own draft rule gates Save; main re-checks it on the write.
  const incomplete =
    name.trim().length === 0 ||
    instructions.trim().length === 0 ||
    // A column Trigger naming no column is not a column Trigger. Blocking Save
    // says so at the moment of the choice, rather than letting the record
    // collapse it to "Nothing else" behind the person's back.
    (triggerChoice === "columns" && columns.length === 0) ||
    scheduleProblem !== null ||
    (runtimeChoice === "pin" && pin === null);

  const submit = async () => {
    if (incomplete || saving) return;
    setSaving(true);
    try {
      const refusal =
        automation === null
          ? await save({
              commandId,
              projectId: savingProjectId,
              name,
              instructions,
              trigger,
              runtime,
            })
          : await update({
              commandId,
              automationId: automation.id,
              name,
              instructions,
              trigger,
              runtime,
            });
      if (refusal === null) closeEditor();
      else setProblem(refusal);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeEditor())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{automation === null ? "New Automation" : "Edit Automation"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Name"
              aria-label="Name"
              className="flex-1"
            />
            {/* Ownership decides WHERE this is listed, and main treats it as
                identity on update — so an existing record states it and does
                not offer to move it. */}
            {automation === null ? (
              <Segmented<OwnershipChoice>
                ariaLabel="Ownership"
                value={ownershipChoice}
                options={[
                  { key: "project", label: "This project" },
                  { key: "global", label: "All projects" },
                ]}
                // A schedule has to name the project it runs in, so while one
                // is chosen this states the only valid answer instead of
                // offering a second that Save would refuse.
                disabled={triggerChoice === "schedule"}
                onChange={setOwnership}
              />
            ) : (
              <span className="shrink-0 text-label text-muted-foreground">
                {ownershipLabel(automation)}
              </span>
            )}
          </div>
          {/* The Trigger: what starts this BESIDES a person. Running by hand
              is universal (VC-112), so it is never one of the answers. It
              reads as a sentence the second control finishes: "Only when I run
              it", or "Ticket enters" — and then which columns. The columns sit
              on their own row rather than beside the segmented pill, so the
              choice of ANSWER and the choice of COLUMNS are not one
              undifferentiated strip of five-plus chips. The schedule's own row
              (VC-130) sits in the same place for the same reason, and reads as
              the sentence VC-112 names: "Every [day] at [21:00] [zone]". */}
          <div className="flex flex-col gap-2">
            <Segmented<TriggerChoice>
              ariaLabel="Trigger"
              value={triggerChoice}
              options={[
                // One word across editor and page: the Automations page prints
                // this same constant on every row that names no column.
                { key: "none", label: MANUAL_TRIGGER_LABEL },
                { key: "columns", label: "Ticket enters" },
                { key: "schedule", label: "On a schedule" },
              ]}
              onChange={setTriggerChoice}
            />
            {triggerChoice === "schedule" ? (
              <div className="flex flex-wrap items-center gap-2">
                {/* The connecting words are the row's grammar, not copy under a
                    control: VC-112 asks for one row that reads as a sentence,
                    and "Every" / "at" are what make the controls a sentence
                    rather than a form. */}
                <span className="text-ui text-muted-foreground">Every</span>
                <Segmented<AutomationSchedulePreset>
                  ariaLabel="Schedule"
                  value={preset}
                  options={SCHEDULE_PRESET_OPTIONS}
                  onChange={setPreset}
                />
                {preset === "weekly" ? (
                  <Segmented<ScheduleWeekday>
                    ariaLabel="Day of the week"
                    value={weekday}
                    options={WEEKDAY_OPTIONS}
                    onChange={setWeekday}
                  />
                ) : null}
                <span className="text-ui text-muted-foreground">at</span>
                {preset === "hourly" ? (
                  // An hourly schedule has no hour to state — only the minute
                  // past each one. A time field here would ask for an hour the
                  // record cannot hold.
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    aria-label="Minutes past the hour"
                    className="w-20"
                    value={minute}
                    onChange={(event) => {
                      const next = Number(event.currentTarget.value);
                      // An out-of-range or half-typed value changes nothing:
                      // the record stores a real minute or the previous one.
                      if (Number.isInteger(next) && next >= 0 && next <= 59) setMinute(next);
                    }}
                  />
                ) : (
                  <Input
                    type="time"
                    aria-label="Time"
                    className="w-28"
                    value={`${twoDigits(hour)}:${twoDigits(minute)}`}
                    onChange={(event) => {
                      const [nextHour, nextMinute] = event.currentTarget.value.split(":");
                      if (nextHour === undefined || nextMinute === undefined) return;
                      setHour(Number(nextHour));
                      setMinute(Number(nextMinute));
                    }}
                  />
                )}
                <TimeZonePicker value={timeZone} onChange={setTimeZone} />
              </div>
            ) : null}
            {scheduleProblem === null ? null : (
              // A blocked state with one recovery action — one of the copy
              // rule's stated exceptions. Ownership is identity on an existing
              // record, so this is the only place the way out can be named.
              <p className="text-label text-muted-foreground">{scheduleProblem}</p>
            )}
            {triggerChoice === "columns" ? (
              <div className="flex flex-wrap gap-2">
                {TICKET_STATUSES.map((status) => {
                  const named = columns.includes(status);
                  return (
                    <Button
                      key={status}
                      variant="ghost"
                      size="sm"
                      role="checkbox"
                      aria-checked={named}
                      data-trigger-column={status}
                      className={cn(
                        "border px-2 text-ui",
                        named
                          ? "border-ring bg-accent text-foreground"
                          : "border-border text-muted-foreground",
                      )}
                      onClick={() =>
                        // Board order, never click order — the record stores
                        // board order, and a form that disagrees with what it
                        // saved is a form that has to be re-read after saving.
                        setColumns((current) =>
                          TICKET_STATUSES.filter((candidate) =>
                            candidate === status
                              ? !current.includes(status)
                              : current.includes(candidate),
                          ),
                        )
                      }
                    >
                      {TICKET_STATUS_LABELS[status]}
                    </Button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <ComposerPickerStack
            value={instructions}
            onValueChange={setInstructions}
            ready
            interactionOpen={false}
            promptTemplates={templates}
            skills={skills}
            // Verbs are chat operations (/compact); an Automation's
            // Instructions can invoke none of them.
            verbs={[]}
            files={fileIndex.getIndex()}
            onFilePickerOpen={fileIndex.refresh}
          >
            <InstructionsTextarea value={instructions} onValueChange={setInstructions} />
          </ComposerPickerStack>
          <div className="flex items-center gap-2">
            <Segmented<RuntimeChoice>
              ariaLabel="Runtime"
              value={runtimeChoice}
              options={[
                { key: "inherit", label: "Default model" },
                { key: "pin", label: "Pin" },
              ]}
              onChange={setRuntimeChoice}
            />
            {runtimeChoice === "pin" ? (
              <>
                <ModelPill
                  models={models}
                  selection={pin ?? NO_PIN}
                  disabled={false}
                  onChange={(next) => {
                    // A level the wire grammar does not spell cannot be
                    // recorded, so a pill that produced one changes nothing
                    // rather than half of it — the composer's own rule.
                    const picked = composerModelSelection(next);
                    if (picked !== null) setPin(picked);
                  }}
                />
                {pin !== null && pinStops.length > 1 ? (
                  <EffortPill
                    levels={pinStops}
                    value={pin.reasoningLevel}
                    onChange={(level) => {
                      const picked = composerModelSelection({ ...pin, reasoningLevel: level });
                      if (picked !== null) setPin(picked);
                    }}
                  />
                ) : null}
              </>
            ) : null}
          </div>
          {problem !== null ? (
            <p role="alert" className="text-label text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={closeEditor}>
            Cancel
          </Button>
          <Button disabled={incomplete || saving} onClick={() => void submit()}>
            {automation === null ? "Create automation" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Instructions box: a plain textarea wearing the stack's caret binding,
 * wired exactly as the chat's own textarea wires it — `handleKeyDown` first
 * (the picker's keys are its own), `trackCaret` on change, select and keyup.
 */
function InstructionsTextarea({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange(value: string): void;
}) {
  const caret = useComposerCaretBinding();
  return (
    <textarea
      ref={caret.ref}
      value={value}
      aria-label="Instructions"
      placeholder={INSTRUCTIONS_PLACEHOLDER}
      className={cn(
        "min-h-32 w-full resize-y rounded-lg border border-border bg-transparent px-3 py-2",
        "text-sm text-foreground outline-none placeholder:text-muted-foreground",
        "focus-visible:border-ring",
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
