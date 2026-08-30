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
 * Four rules the drawing carries:
 *
 *  - **The press follows the column.** The default action is whatever this
 *    Ticket's current column has ARMED, so pressing here is the same act the
 *    board performs on a Deliberate move into that column. With nothing armed
 *    the press becomes Run once, which needs no record at all.
 *  - **It never presses what it has not read.** The rail re-reads on arrival,
 *    and until that read lands the control says so and starts nothing bound
 *    (`automation-run-menu.tsx` owns the rule, `armed-run.ts` makes the same
 *    refusal for a dropped card). A cold cache would offer Run once on an
 *    armed Ticket; a stale one — including one whose re-read FAILED — would
 *    press the Automation the column used to arm. All of it is wrong for one
 *    reason: the cache cannot tell "nothing armed" from "not asked yet", nor a
 *    value that was just confirmed from one that merely survived.
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
  type AutomationRun,
  type ModelSelection,
  type Ticket,
} from "@volli/shared";

import {
  AutomationRunMenuItems,
  OffNote,
  useAutomationRunOffer,
  useOfferableModels,
} from "./automation-run-menu";
import { runAutomationLabel, runModelLabel, runModelTitle } from "./automations-page-model";
import { InstructionsTextarea } from "./automation-editor";
import { openRunSession, runAutomationOnTicket } from "./run-automation";
import {
  modelOverrideRows,
  overridePressable,
  railRunLabel,
  RAIL_UNREAD_LABEL,
  type RailRunAction,
  type TicketRailAutomations,
} from "./ticket-rail-automations-model";
import { composerModelSelection } from "@renderer/components/chat/chat-plane-model";
import { EffortPill } from "@renderer/components/chat/composer-effort-ui";
import {
  ComposerPickerStack,
  ModelPill,
  type ComposerModel,
} from "@renderer/components/chat/composer-ui";
import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
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
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { ListRow } from "@renderer/components/ui/list-row";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Segmented } from "@renderer/components/ui/segmented";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { usePromptTemplates } from "@renderer/hooks/use-prompt-templates";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { selectTicketRuns, useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** The blank the pill reads as its resting "Model" label — the composer's own. */
const NO_PIN = { providerId: "", modelId: "", reasoningLevel: "" };

/** The same block shape the rail's other sections use, at the rail's own inset. */
const SECTION = cn("flex flex-col gap-1 pt-4", RAIL_PANEL_INSET);

/** Which Runtime a single invocation runs on: the resolved default, or this one pick. */
type OverrideChoice = "inherit" | "pin";

/**
 * The open Run once form, and what it opens HOLDING.
 *
 * `null` is closed. An open form carries the per-invocation override the menu
 * was on when it asked for one — choosing "Run on model ▸ Opus" where the
 * column arms nothing is still a person choosing a model for the Run they are
 * about to describe, and dropping it on the way to the dialog would answer that
 * choice with a form resting on "Default model".
 */
type RunOnceRequest = { modelOverride: ModelSelection | null } | null;

export function TicketAutomationsPanel({
  projectId,
  ticket,
}: {
  projectId: string;
  ticket: Ticket;
}) {
  const enabledIds = useAutomationsStore((state) => state.enabledIds);
  const runs = useAutomationsStore((state) => selectTicketRuns(state, ticket.id));
  const refreshTicketRuns = useAutomationsStore((state) => state.refreshTicketRuns);
  const [runOnce, setRunOnce] = React.useState<RunOnceRequest>(null);
  const models = useOfferableModels();

  // What this column offers, read on arrival and inert until that read lands
  // (`automation-run-menu.tsx` states the rule once, for this rail and for the
  // board card's own menu).
  const rail = useAutomationRunOffer(projectId, ticket.status);

  // The Runs, on the same clock — a Run started from the board's armed window,
  // the palette or another window lands here without this rail having asked.
  const planningVersion = useBoardStore((state) => state.lastPlanningChange.version);
  React.useEffect(() => {
    void refreshTicketRuns(ticket.id);
  }, [refreshTicketRuns, ticket.id, planningVersion]);

  const run = (action: RailRunAction, modelOverride: ModelSelection | null): void => {
    // Nothing bound starts from an unread rail: the press that reached here
    // named no record, because the rail knew of none to name.
    if (action.kind === "unread") return;
    if (action.kind === "run-once") {
      setRunOnce({ modelOverride });
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
        onRunOnce={() => setRunOnce({ modelOverride: null })}
      />
      {!rail.ready || rail.listsAny ? null : (
        // Visible, plain, and a door. The button above still presses — Run once
        // names no record, so an empty project is not an empty control. The
        // sentence waits for the read, though: "no automations here" is a claim
        // about the project, and an unread cache cannot make it.
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
        request={runOnce}
        onClose={() => setRunOnce(null)}
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
 * wrapper so the pill depresses as one object, and the same rows on right-click
 * so turning to the caret is a convenience rather than the only route. Those
 * rows are `automation-run-menu.tsx`'s, which the board card's own
 * `Automations ▸` submenu mounts too.
 *
 * The per-invocation override VC-112 names is reachable from BOTH deliberate
 * surfaces this control offers: the rail's own caret menu, and the nested item
 * in the context menu. Never from the drag path, which has no menu at all.
 *
 * While the rail is still reading, the default half is present, named and
 * disabled: never hidden, and never a press against a cache that has not
 * landed.
 */
function AutomationRunControl({
  rail,
  models,
  enabledIds,
  onRun,
  onRunOnce,
}: {
  rail: TicketRailAutomations;
  models: readonly ComposerModel[];
  enabledIds: readonly string[];
  onRun(action: RailRunAction, modelOverride: ModelSelection | null): void;
  onRunOnce(): void;
}) {
  const label = railRunLabel(rail.primary);
  const overrides = modelOverrideRows(models);
  const offered = rail.offered;
  // Present, named and unpressable while the reads land: the control is never
  // hidden (VC-112), and it never presses a default it has not read yet.
  const unread = rail.primary.kind === "unread";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="inline-flex w-full items-center rounded-full transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:scale-100!">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={unread}
            aria-label={unread ? label : `Run ${label} on this ticket`}
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
              {unread ? <div className={EMPTY_INLINE}>{RAIL_UNREAD_LABEL}</div> : null}
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
              {/* The override on the rail itself, beside the nested
                  context-menu one below (VC-112 names both). Absent while the
                  rail is still reading, and on a profile whose catalog offers
                  no model a Run could name — in both cases there is nothing for
                  a chosen model to be spent on. */}
              {overrides.length === 0 || !overridePressable(rail.primary, true) ? null : (
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
      {/* Right-click is the nested context-menu surface VC-112 names, drawn by
          the same component the board card's own `Automations ▸` submenu
          mounts — one answer to "what may this Ticket run", in two places. */}
      <ContextMenuContent className="w-56">
        <AutomationRunMenuItems
          rail={rail}
          enabledIds={enabledIds}
          models={models}
          onRun={onRun}
          onRunOnce={onRunOnce}
        />
      </ContextMenuContent>
    </ContextMenu>
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
 *
 * It opens holding whatever override asked for it. Choosing "Run on model ▸
 * Opus" on a column that arms nothing IS a per-invocation override being
 * chosen, and a form that then rested on "Default model" would have quietly
 * discarded the only part of the request the person had already made.
 */
function RunOnceDialog({
  request,
  onClose,
  projectId,
  ticketId,
  models,
  onStarted,
}: {
  request: RunOnceRequest;
  onClose(): void;
  projectId: string;
  ticketId: string;
  models: readonly ComposerModel[];
  onStarted(): void;
}) {
  if (request === null) return null;
  return (
    <RunOnceForm
      // Remounted per opening, so a second Run once starts from a blank form
      // rather than from the last one's words — and so the override it opens
      // holding is this request's, not the previous request's.
      key={`${request.modelOverride?.providerId ?? ""}:${request.modelOverride?.modelId ?? ""}:${request.modelOverride?.reasoningLevel ?? ""}`}
      projectId={projectId}
      ticketId={ticketId}
      models={models}
      modelOverride={request.modelOverride}
      onClose={onClose}
      onStarted={onStarted}
    />
  );
}

function RunOnceForm({
  projectId,
  ticketId,
  models,
  modelOverride,
  onClose,
  onStarted,
}: {
  projectId: string;
  ticketId: string;
  models: readonly ComposerModel[];
  modelOverride: ModelSelection | null;
  onClose(): void;
  onStarted(): void;
}) {
  const [instructions, setInstructions] = React.useState("");
  const [choice, setChoice] = React.useState<OverrideChoice>(
    modelOverride === null ? "inherit" : "pin",
  );
  const [pin, setPin] = React.useState<ModelSelection | null>(modelOverride);
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
