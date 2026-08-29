/**
 * The Automation editor (VC-126): the tracer's one authoring surface, a
 * dialog opened from the command palette. VC-127's nav page supersedes the
 * *entry point*; the form itself — name, Ownership, Instructions, Runtime —
 * is the record's whole editable shape either way.
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
  NO_AUTOMATION_TRIGGER,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type ModelSelection,
  type TicketStatus,
} from "@volli/shared";
import { errorMessage } from "@volli/shared";

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
 * The Trigger control's two answers in V1 (VC-112 rules three; "On a schedule"
 * arrives with the scheduler in VC-130). "Nothing else" is the default and a
 * complete answer rather than an inert one — run by hand is universal, so the
 * Trigger says only what ELSE starts this Automation.
 */
type TriggerChoice = "none" | "columns";

/**
 * The dialog itself, mounted once beside the command palette. It renders only
 * while the store says an editor is open, and everything in it resets by
 * REMOUNT (the `key` below): a dialog dismissed mid-draft starts blank next
 * time, which for a two-field form is less surprising than a resurrected
 * draft with no visible home.
 */
export function AutomationEditorDialog() {
  const editor = useAutomationsStore((state) => state.editor);
  if (editor === null) return null;
  return <AutomationEditorForm key={editor.projectId} projectId={editor.projectId} />;
}

function AutomationEditorForm({ projectId }: { projectId: string }) {
  const closeEditor = useAutomationsStore((state) => state.closeEditor);
  const save = useAutomationsStore((state) => state.save);

  // This id survives an invoke failure while the dialog stays mounted, so the
  // person's Retry repeats durable intent instead of creating a second record.
  const [commandId] = React.useState(() => crypto.randomUUID());
  const [name, setName] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [ownership, setOwnership] = React.useState<OwnershipChoice>("project");
  const [triggerChoice, setTriggerChoice] = React.useState<TriggerChoice>("none");
  const [columns, setColumns] = React.useState<readonly TicketStatus[]>([]);
  const [runtimeChoice, setRuntimeChoice] = React.useState<RuntimeChoice>("inherit");
  const [pin, setPin] = React.useState<ModelSelection | null>(null);
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

  const trigger =
    triggerChoice === "columns" && columns.length > 0
      ? ({ kind: "columns", columns } as const)
      : NO_AUTOMATION_TRIGGER;
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
    (runtimeChoice === "pin" && pin === null);

  const submit = async () => {
    if (incomplete || saving) return;
    setSaving(true);
    try {
      const refusal = await save({
        commandId,
        projectId: ownership === "project" ? projectId : null,
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
          <DialogTitle>New Automation</DialogTitle>
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
            <Segmented<OwnershipChoice>
              ariaLabel="Ownership"
              value={ownership}
              options={[
                { key: "project", label: "This project" },
                { key: "global", label: "All projects" },
              ]}
              onChange={setOwnership}
            />
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
          {/* The Trigger reads as a sentence the second control finishes:
              "Nothing else", or "Ticket enters" — and then which columns. The
              columns sit on their own row rather than beside the segmented
              pill, so the choice of ANSWER and the choice of COLUMNS are not
              one undifferentiated strip of five-plus chips. */}
          <div className="flex flex-col gap-2">
            <Segmented<TriggerChoice>
              ariaLabel="Trigger"
              value={triggerChoice}
              options={[
                { key: "none", label: "Nothing else" },
                { key: "columns", label: "Ticket enters" },
              ]}
              onChange={setTriggerChoice}
            />
            {triggerChoice === "columns" ? (
              <div className="flex flex-wrap gap-1.5">
                {TICKET_STATUSES.map((status) => {
                  const named = columns.includes(status);
                  return (
                    <Button
                      key={status}
                      variant="ghost"
                      role="checkbox"
                      aria-checked={named}
                      data-trigger-column={status}
                      className={cn(
                        "h-7 border px-2 text-ui",
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
            Create automation
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
      placeholder={"Type / for a Skill, @ for a file…"}
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
