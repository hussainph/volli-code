/**
 * The ticket rail's Automations block (VC-129): one split button that runs an
 * Automation on THIS Ticket without leaving it, and this Ticket's Runs under
 * it, each a door back to its Session.
 *
 * **The rail runs; it does not author.** There is no form here for making an
 * Automation, and that is a ruling rather than an omission (VC-112): an
 * authoring form in a 300px rail would be a worse copy of the Automations page,
 * and the page is the one surface that owns the record's lifecycle. What the
 * rail offers instead is a door to that page — from the menu always, and from
 * the empty state's own sentence.
 *
 * Three rules the drawing carries:
 *
 *  - **The press follows the column.** The default action is whatever this
 *    Ticket's current column has ARMED, so pressing here is the same act the
 *    board performs on a Deliberate move into that column. With nothing armed
 *    the press becomes Run once, which needs no record at all.
 *  - **Never hidden when empty.** A project with no Automations still draws the
 *    button, says so in one line, and links to the page. Hidden-when-empty is
 *    how a feature never gets discovered.
 *  - **By hand is universal.** Running from here is unaffected by the
 *    machine-local switch (VC-112) — the switch governs what starts an
 *    Automation BESIDES a person. A switched-off Automation is offered with the
 *    page's own words beside it rather than dimmed or withheld.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { SlidersIcon } from "@phosphor-icons/react/dist/csr/Sliders";

import {
  unboundRunProblem,
  UNBOUND_RUN_LABEL,
  type Automation,
  type AutomationRun,
  type ModelSelection,
  type Ticket,
} from "@volli/shared";

import {
  runAutomationLabel,
  runModelLabel,
  runModelTitle,
  SWITCHED_OFF_NOTE,
} from "./automations-page-model";
import { InstructionsTextarea } from "./automation-editor";
import { openRunSession, runAutomationOnTicket } from "./run-automation";
import {
  modelOverrideRows,
  railRunLabel,
  ticketRailAutomations,
  type RailRunAction,
} from "./ticket-rail-automations-model";
import { composerModelSelection } from "@renderer/components/chat/chat-plane-model";
import { EffortPill } from "@renderer/components/chat/composer-effort-ui";
import {
  ComposerPickerStack,
  ModelPill,
  offerableModels,
  type ComposerModel,
} from "@renderer/components/chat/composer-ui";
import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { ListRow } from "@renderer/components/ui/list-row";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Segmented } from "@renderer/components/ui/segmented";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { usePromptTemplates } from "@renderer/hooks/use-prompt-templates";
import { relativeTime } from "@renderer/lib/relative-time";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { cn } from "@renderer/lib/utils";
import {
  selectArmings,
  selectAutomations,
  selectTicketRuns,
  useAutomationsStore,
} from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useWorkspaceStore } from "@renderer/stores/workspace";

const NO_MODELS: readonly ComposerModel[] = [];

/** The blank the pill reads as its resting "Model" label — the composer's own. */
const NO_PIN = { providerId: "", modelId: "", reasoningLevel: "" };

/** The same block shape the rail's other sections use, at the rail's own inset. */
const SECTION = cn("flex flex-col gap-1 pt-4", RAIL_PANEL_INSET);

/** Which Runtime a single invocation runs on: the resolved default, or this one pick. */
type OverrideChoice = "inherit" | "pin";

/**
 * The catalog a per-invocation override may name — signed-in, unhidden models,
 * read once per mount.
 *
 * The same read the Automation editor's pin control makes, for the same
 * catalog. An unreadable catalog costs the OVERRIDE and never the Run: with no
 * models the override menu has nothing to offer and every Run resolves its
 * Runtime the ordinary way, which is what it would have done anyway.
 */
function useOfferableModels(): readonly ComposerModel[] {
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
        if (!current) return;
        setModels(NO_MODELS);
      });
    return () => {
      current = false;
    };
  }, [inspect, hiddenModels]);
  return models;
}

export function TicketAutomationsPanel({
  projectId,
  ticket,
}: {
  projectId: string;
  ticket: Ticket;
}) {
  const automations = useAutomationsStore((state) => selectAutomations(state, projectId));
  const armings = useAutomationsStore((state) => selectArmings(state, projectId));
  const enabledIds = useAutomationsStore((state) => state.enabledIds);
  const runs = useAutomationsStore((state) => selectTicketRuns(state, ticket.id));
  const refresh = useAutomationsStore((state) => state.refresh);
  const refreshArming = useAutomationsStore((state) => state.refreshArming);
  const refreshEnablement = useAutomationsStore((state) => state.refreshEnablement);
  const refreshTicketRuns = useAutomationsStore((state) => state.refreshTicketRuns);
  const [runOnceOpen, setRunOnceOpen] = React.useState(false);
  const models = useOfferableModels();

  // Read on arrival and after any planning change, the way the Automations
  // page reads: opening a Ticket IS the moment a stale Offered list or a stale
  // arming would show, and this rail must not depend on some other surface
  // having been the one to notice a record created, armed or switched
  // elsewhere. Deliberately NOT `ensureLoaded`, which only fills a cache that
  // has never landed — that is the board arrival's rule, and it would leave
  // this button naming an Automation that was disarmed an hour ago.
  const planningVersion = useBoardStore((state) => state.lastPlanningChange.version);
  React.useEffect(() => {
    void refresh(projectId);
    void refreshArming(projectId);
    void refreshEnablement();
  }, [refresh, refreshArming, refreshEnablement, projectId, planningVersion]);

  // The Runs, on the same clock — a Run started from the board's armed window,
  // the palette or another window lands here without this rail having asked.
  React.useEffect(() => {
    void refreshTicketRuns(ticket.id);
  }, [refreshTicketRuns, ticket.id, planningVersion]);

  const rail = ticketRailAutomations({ automations, armings, status: ticket.status });

  const run = (action: RailRunAction, modelOverride: ModelSelection | null): void => {
    if (action.kind === "run-once") {
      setRunOnceOpen(true);
      return;
    }
    void runAutomationOnTicket({
      target: { kind: "automation", automationId: action.automation.id },
      ticketId: ticket.id,
      modelOverride,
    }).finally(() => void refreshTicketRuns(ticket.id));
  };

  return (
    <section className={SECTION} aria-label="Automations" data-testid="ticket-rail-automations">
      <div className="mb-1 flex items-center px-2">
        <SectionHeading>Automations</SectionHeading>
      </div>
      <AutomationRunControl
        rail={rail}
        models={models}
        enabledIds={enabledIds}
        onRun={run}
        onRunOnce={() => setRunOnceOpen(true)}
      />
      {rail.listsAny ? null : (
        // Visible, plain, and a door. The button above still presses — Run once
        // names no record, so an empty project is not an empty control.
        <>
          <p className="px-2 text-label text-muted-foreground">
            No automations in this project yet.
          </p>
          {/* The door OUT of the empty state is the page, because the rail
              never authors (VC-112) — and a link is the primitive for a
              control that is read rather than aimed at. */}
          <Button
            variant="link"
            size="sm"
            className="self-start"
            onClick={() => useWorkspaceStore.getState().setNav(projectId, "automations")}
          >
            Automations
          </Button>
        </>
      )}
      <TicketRuns projectId={projectId} runs={runs} />
      <RunOnceDialog
        open={runOnceOpen}
        onOpenChange={setRunOnceOpen}
        projectId={projectId}
        ticketId={ticket.id}
        models={models}
        onStarted={() => void refreshTicketRuns(ticket.id)}
      />
    </section>
  );
}

/**
 * The split button: `[⚡ Armed automation │ ▾]`.
 *
 * Drawn as `new-session-control.tsx` draws its own — the press-scale on the
 * wrapper so the pill depresses as one object, and the same two items on
 * right-click so turning to the caret is a convenience rather than the only
 * route. The right-click menu is also where the per-invocation model override
 * lives as a NESTED item (VC-112: the deliberate surfaces, never the drag).
 */
function AutomationRunControl({
  rail,
  models,
  enabledIds,
  onRun,
  onRunOnce,
}: {
  rail: ReturnType<typeof ticketRailAutomations>;
  models: readonly ComposerModel[];
  enabledIds: readonly string[];
  onRun(action: RailRunAction, modelOverride: ModelSelection | null): void;
  onRunOnce(): void;
}) {
  const label = railRunLabel(rail.primary);
  const overrides = modelOverrideRows(models);
  const offered = rail.offered;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="inline-flex w-full items-center rounded-full transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:scale-100!">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label={`Run ${label} on this ticket`}
            className="min-w-0 flex-1 justify-start rounded-r-none pr-1 active:scale-100!"
            onClick={() => onRun(rail.primary, null)}
          >
            <LightningIcon />
            <span className="min-w-0 truncate">{label}</span>
          </Button>
          <span aria-hidden className="h-3 w-px bg-border" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                aria-label="Other automations"
                // Only the seam and the press are restated: `icon-sm` already
                // carries this segment's whole geometry, and a width beside it
                // would be the primitive's own size written twice.
                className="group rounded-l-none active:scale-100!"
              >
                <CaretDownIcon
                  weight="bold"
                  className="size-3 transition-transform duration-150 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {offered.map((automation) => (
                <DropdownMenuItem
                  key={automation.id}
                  onSelect={() => onRun({ kind: "automation", automation }, null)}
                >
                  <LightningIcon />
                  <span className="min-w-0 flex-1 truncate">{automation.name}</span>
                  <OffNote automation={automation} enabledIds={enabledIds} />
                </DropdownMenuItem>
              ))}
              {offered.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={onRunOnce}>
                <PlayIcon />
                {UNBOUND_RUN_LABEL}…
              </DropdownMenuItem>
              {overrides.length === 0 ? null : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <CpuIcon />
                    Run on model
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {overrides.map(({ model, selections }) =>
                      selections.length === 1 ? (
                        <DropdownMenuItem
                          key={model.id}
                          onSelect={() => onRun(rail.primary, selections[0] ?? null)}
                        >
                          <CpuIcon />
                          {model.label}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuSub key={model.id}>
                          <DropdownMenuSubTrigger>
                            <CpuIcon />
                            {model.label}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {selections.map((selection) => (
                              <DropdownMenuItem
                                key={selection.reasoningLevel}
                                onSelect={() => onRun(rail.primary, selection)}
                              >
                                <SlidersIcon />
                                {selection.reasoningLevel}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      ),
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {offered.map((automation) => (
          <ContextMenuItem
            key={automation.id}
            icon={LightningIcon}
            onSelect={() => onRun({ kind: "automation", automation }, null)}
          >
            <span className="min-w-0 flex-1 truncate">{automation.name}</span>
            <OffNote automation={automation} enabledIds={enabledIds} />
          </ContextMenuItem>
        ))}
        {offered.length > 0 ? <ContextMenuSeparator /> : null}
        <ContextMenuItem icon={PlayIcon} onSelect={onRunOnce}>
          {UNBOUND_RUN_LABEL}…
        </ContextMenuItem>
        {/* The nested override item VC-112 names. Model and reasoning travel
            together, so a model offering several levels opens onto them rather
            than running at one nobody chose. */}
        {overrides.length === 0 ? null : (
          <ContextMenuSub>
            <ContextMenuSubTrigger icon={CpuIcon}>Run on model</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {overrides.map(({ model, selections }) =>
                selections.length === 1 ? (
                  <ContextMenuItem
                    key={model.id}
                    icon={CpuIcon}
                    onSelect={() => onRun(rail.primary, selections[0] ?? null)}
                  >
                    {model.label}
                  </ContextMenuItem>
                ) : (
                  <ContextMenuSub key={model.id}>
                    <ContextMenuSubTrigger icon={CpuIcon}>{model.label}</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {selections.map((selection) => (
                        <ContextMenuItem
                          key={selection.reasoningLevel}
                          icon={SlidersIcon}
                          onSelect={() => onRun(rail.primary, selection)}
                        >
                          {selection.reasoningLevel}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                ),
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * What a switched-off Automation says here — the page's own words, so one
 * record does not read as two states on two surfaces. It is still offered and
 * still runs: the switch decides what starts it BESIDES a person (VC-112).
 */
function OffNote({
  automation,
  enabledIds,
}: {
  automation: Automation;
  enabledIds: readonly string[];
}) {
  if (enabledIds.includes(automation.id)) return null;
  return (
    <span className="ml-auto shrink-0 text-label text-muted-foreground">{SWITCHED_OFF_NOTE}</span>
  );
}

/**
 * This Ticket's Runs, newest first, each a door back to its Session — the
 * Automations page's own history row at rail width, opened through the same
 * `openRunSession` a fresh Run uses. A history row that navigated differently
 * from the launch it records would be two answers to "where does this Run live".
 */
function TicketRuns({ projectId, runs }: { projectId: string; runs: readonly AutomationRun[] }) {
  if (runs.length === 0) return null;
  return (
    <ul className="flex flex-col" data-testid="ticket-rail-runs">
      {runs.map((run) => (
        <li key={run.id}>
          <ListRow
            density="two-line"
            onActivate={() =>
              openRunSession({ sessionId: run.sessionId, projectId, ticketId: run.ticketId })
            }
            leading={<LightningIcon className="size-4 shrink-0 text-muted-foreground" />}
            primary={runAutomationLabel(run)}
            secondary={
              // The RESOLVED model this Session was born with, printed from the
              // Run's own row rather than re-labelled through today's catalogue.
              <span className="truncate" title={runModelTitle(run)}>
                {runModelLabel(run)}
              </span>
            }
            trailing={
              <span className="shrink-0 text-label text-muted-foreground">
                {relativeTime(run.createdAt)}
              </span>
            }
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Run once: Instructions, an optional Runtime for this one invocation, and a
 * Run that saves nothing.
 *
 * It writes no file and mints no record beyond the Run itself, so there is
 * nothing afterwards to name, disable or delete (VC-112, "One-time work"). That
 * is why the form has no Name and no Trigger: this is not a small authoring
 * surface, it is the absence of one.
 *
 * The Instructions box is the editor's, imported rather than re-drawn — same
 * `/` templates and Skills, same `@` files, same expansion at launch. A second
 * box wired slightly differently would be a second grammar wearing one name.
 */
function RunOnceDialog({
  open,
  onOpenChange,
  projectId,
  ticketId,
  models,
  onStarted,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  projectId: string;
  ticketId: string;
  models: readonly ComposerModel[];
  onStarted(): void;
}) {
  if (!open) return null;
  return (
    <RunOnceForm
      projectId={projectId}
      ticketId={ticketId}
      models={models}
      onClose={() => onOpenChange(false)}
      onStarted={onStarted}
    />
  );
}

function RunOnceForm({
  projectId,
  ticketId,
  models,
  onClose,
  onStarted,
}: {
  projectId: string;
  ticketId: string;
  models: readonly ComposerModel[];
  onClose(): void;
  onStarted(): void;
}) {
  const [instructions, setInstructions] = React.useState("");
  const [choice, setChoice] = React.useState<OverrideChoice>("inherit");
  const [pin, setPin] = React.useState<ModelSelection | null>(null);
  const { templates, skills } = usePromptTemplates(projectId);
  const fileIndex = useFileIndex(projectId);

  const pinStops =
    pin === null
      ? []
      : (models.find(
          (model) => model.providerId === pin.providerId && model.modelId === pin.modelId,
        )?.reasoningLevels ?? []);
  // The shared rule, so this button and main's refusal are one policy.
  const incomplete = unboundRunProblem(instructions) !== null || (choice === "pin" && pin === null);

  const submit = (): void => {
    if (incomplete) return;
    onClose();
    void runAutomationOnTicket({
      target: { kind: "unbound", instructions },
      ticketId,
      modelOverride: choice === "pin" ? pin : null,
    }).finally(onStarted);
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{UNBOUND_RUN_LABEL}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <ComposerPickerStack
            value={instructions}
            onValueChange={setInstructions}
            ready
            interactionOpen={false}
            promptTemplates={templates}
            skills={skills}
            // Verbs are chat operations (/compact); a Run's Instructions can
            // invoke none of them — the editor's own rule.
            verbs={[]}
            files={fileIndex.getIndex()}
            onFilePickerOpen={fileIndex.refresh}
          >
            <InstructionsTextarea value={instructions} onValueChange={setInstructions} />
          </ComposerPickerStack>
          <div className="flex items-center gap-2">
            <Segmented<OverrideChoice>
              ariaLabel="Runtime"
              value={choice}
              options={[
                { key: "inherit", label: "Default model" },
                { key: "pin", label: "This run" },
              ]}
              onChange={setChoice}
            />
            {choice === "pin" ? (
              <>
                <ModelPill
                  models={models}
                  selection={pin ?? NO_PIN}
                  disabled={false}
                  onChange={(next) => {
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
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={incomplete} onClick={submit}>
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
