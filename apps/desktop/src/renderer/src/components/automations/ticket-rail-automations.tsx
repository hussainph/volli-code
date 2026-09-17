/**
 * The ticket rail's Automations block (VC-129): one split button that runs an
 * Automation on THIS Ticket without leaving the current tab. VC-234 makes that
 * landing universal: success toasts with an "Open session" action and never
 * navigates.
 *
 * **One control, and nothing under it** (VC-406). The block used to stack
 * three things under its eyebrow: the split button, a visible list of every
 * column's Automations (each a ghost button with a play glyph), and this
 * Ticket's Runs. The list repeated, in the open, exactly the grouped rows the
 * button's own caret menu holds — every name twice in one glance, in two
 * drawings, and the block grew a row per Automation the project authored. The
 * Runs were doors back to their Sessions, and every one of those Sessions is
 * already a row in the Sessions roster above, wearing the bolt that says a Run
 * started it (`session-provenance-mark.tsx`); a second list of the same doors
 * under a different heading was the roster drawn twice. Both are gone. What is
 * left is the one thing the rail exists to offer here: the press.
 *
 * **The rail runs; it does not author.** There is no form here for making an
 * Automation, and that is a ruling rather than an omission (VC-112): an
 * authoring form in a 300px rail would be a worse copy of the Automations page,
 * and the page is the one surface that owns the record's lifecycle. What the
 * empty rail offers instead is ONE door to that page, in the header row beside
 * the eyebrow — where the Sessions block keeps its own control. It used to be a
 * text link under the empty state's sentence, which put the word "Automations"
 * two lines under the heading AUTOMATIONS (VC-257): the same noun twice in one
 * glance. Moving that existing door fixes the layout without expanding
 * navigation into populated or unread states.
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
 *    Run button, says so in one line, and puts its existing page door in the
 *    header. Hidden-when-empty is how a feature never gets discovered.
 *  - **By hand is universal.** Running from here is unaffected by the
 *    machine-local switch (VC-112) — the switch governs what starts an
 *    Automation BESIDES a person. A switched-off Automation is offered with the
 *    page's own words beside it rather than dimmed or withheld.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { SlidersIcon } from "@phosphor-icons/react/dist/csr/Sliders";

import {
  displayTicketId,
  unboundRunProblem,
  UNBOUND_RUN_LABEL,
  type ModelSelection,
  type Ticket,
} from "@volli/shared";

import {
  AutomationRunMenuItems,
  OffNote,
  useAutomationRunOffer,
  useOfferableModels,
} from "./automation-run-menu";
import { InstructionsTextarea } from "./automation-editor";
import { runAutomationOnTicket } from "./run-automation";
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
import {
  RAIL_CONTROL,
  RAIL_PANEL_INSET,
  RailSectionHeadingRow,
} from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Segmented } from "@renderer/components/ui/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { usePromptTemplates } from "@renderer/hooks/use-prompt-templates";
import { cn } from "@renderer/lib/utils";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** The blank the pill reads as its resting "Model" label — the composer's own. */
const NO_PIN = { providerId: "", modelId: "", reasoningLevel: "" };

/** The same block shape the rail's other sections use, at the rail's own inset. */
const SECTION = cn("flex flex-col gap-1", RAIL_PANEL_INSET);

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
  const ticketPrefix = useProjectsStore(
    (state) => state.projects.find((project) => project.id === projectId)?.ticketPrefix,
  );
  const ticketDisplayId =
    ticketPrefix === undefined ? "this ticket" : displayTicketId(ticketPrefix, ticket.ticketNumber);
  const [runOnce, setRunOnce] = React.useState<RunOnceRequest>(null);
  const models = useOfferableModels();

  // What this column offers, read on arrival and inert until that read lands
  // (`automation-run-menu.tsx` states the rule once, for this rail and for the
  // board card's own menu).
  const rail = useAutomationRunOffer(projectId, ticket.status);
  const empty = rail.ready && !rail.listsAny;

  const run = (action: RailRunAction, modelOverride: ModelSelection | null): void => {
    // Nothing bound starts from an unread rail: the press that reached here
    // named no record, because the rail knew of none to name.
    if (action.kind === "unread") return;
    if (action.kind === "run-once") {
      setRunOnce({ modelOverride });
      return;
    }
    // Where the Run lands is the roster's business: its Session arrives there
    // through the same push every Session does, so nothing here re-reads.
    void runAutomationOnTicket({
      target: { kind: "automation", automationId: action.automation.id },
      automationName: action.automation.name,
      ticketId: ticket.id,
      ticketDisplayId,
      modelOverride,
    });
  };

  return (
    <section className={SECTION} aria-label="Automations" data-testid="ticket-rail-automations">
      <RailSectionHeadingRow label="Automations">
        {empty ? <AutomationsPageDoor projectId={projectId} /> : null}
      </RailSectionHeadingRow>
      <AutomationRunControl
        rail={rail}
        models={models}
        enabledIds={enabledIds}
        onRun={run}
        onRunOnce={() => setRunOnce({ modelOverride: null })}
      />
      {empty ? (
        // Visible and plain: one line, a report and never an action — the
        // header's own door is 20px above it, and a second copy of the same
        // door inside the empty state would be the same offer twice in one
        // glance. The button above still presses — Run once names no record,
        // so an empty project is not an empty control. Both the sentence and
        // its page door wait for the read: "no automations here" is a claim
        // about the project, and an unread cache cannot make it.
        <p className="px-2 text-label text-muted-foreground">No automations in this project yet.</p>
      ) : null}
      <RunOnceDialog
        request={runOnce}
        onClose={() => setRunOnce(null)}
        projectId={projectId}
        ticketId={ticket.id}
        ticketDisplayId={ticketDisplayId}
        models={models}
      />
    </section>
  );
}

/**
 * The empty rail's one door to the Automations page, in the header row.
 *
 * An icon at `icon-xs` ghost — the rung the Sessions header's own control sits
 * at, level with a text-label eyebrow — and not a word, because the word is
 * already on the line: the eyebrow says AUTOMATIONS, and a control beside it
 * saying it again is the redundancy this replaces. The tooltip carries the
 * verb for anyone who hovers, and the label carries it for anyone who cannot.
 *
 * The glyph is the rail's own "leaves this surface" mark (`RailRowActions`'
 * Open in tab, the repository card's View PR): pressing it navigates the
 * workspace away from this Ticket, which is exactly what a Run from the button
 * under it never does (VC-234).
 */
function AutomationsPageDoor({ projectId }: { projectId: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open Automations"
          data-testid="ticket-rail-automations-page"
          onClick={() => useWorkspaceStore.getState().setNav(projectId, "automations")}
        >
          <ArrowSquareOutIcon weight="bold" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Open Automations</TooltipContent>
    </Tooltip>
  );
}

/**
 * The split button: `[⚡ Armed automation │ ▾]`.
 *
 * Drawn as the repository card draws its publish row — a `ButtonGroup` of two
 * `outline` Buttons in the rail's one control recipe (`RAIL_CONTROL`), sized
 * to its label and parked at the left under the eyebrow, at the same `px-2`
 * the eyebrow and the roster's rows share. It used to be a `secondary` pill
 * stretched across the section, which is the shape of a list row here, not
 * of a button (VC-406): the one thing a reader must be able to tell at a
 * glance is which objects on this page are acts, and the rail's acts all
 * wear one costume now. The same rows come up on right-click, so turning to
 * the caret is a convenience rather than the only route; those rows are
 * `automation-run-menu.tsx`'s, which the board card's own `Automations ▸`
 * submenu mounts too.
 *
 * The name truncates rather than the group growing past the rail: the
 * longest Automation name a project can author is longer than the rail is
 * wide, and the full label stays in `title` — the card's own primary keeps
 * the same rule.
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
  // Present, named and unpressable while the reads land: the control is never
  // hidden (VC-112), and it never presses a default it has not read yet.
  const unread = rail.primary.kind === "unread";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* `max-w-full min-w-0` over the group's own `w-fit`: fit to the
            label, but never past the column — the primary inside shrinks
            and truncates before the caret can be pushed off the edge. */}
        <ButtonGroup
          aria-label="Run an automation on this ticket"
          className="max-w-full min-w-0 px-2"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={unread}
            title={label}
            aria-label={unread ? label : `Run ${label} on this ticket`}
            className={cn(RAIL_CONTROL, "min-w-0 shrink px-2 [&>span]:truncate")}
            onClick={() => onRun(rail.primary, null)}
          >
            <LightningIcon />
            <span>{label}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Other automations"
                className={cn(RAIL_CONTROL, "group")}
              >
                <CaretDownIcon
                  weight="bold"
                  className="size-3 transition-transform duration-150 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {unread ? <div className={EMPTY_INLINE}>{RAIL_UNREAD_LABEL}</div> : null}
              {/* Every column's offer, grouped and labelled (VC-329 item 5):
                  this Ticket's own column first, the rest in board order. A row
                  under another column's heading runs here, on THIS Ticket — the
                  same hand-run as ever, without the detour through the status
                  chip to make the column match. */}
              {rail.groups.map((group, index) => (
                <React.Fragment key={group.status}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel className="text-label text-muted-foreground">
                    {group.label}
                    {group.current ? " · this ticket" : ""}
                  </DropdownMenuLabel>
                  {group.automations.map((automation) => (
                    <DropdownMenuItem
                      key={automation.id}
                      onSelect={() => onRun({ kind: "automation", automation }, null)}
                    >
                      <LightningIcon />
                      <span className="min-w-0 flex-1 truncate">{automation.name}</span>
                      <OffNote automation={automation} enabledIds={enabledIds} />
                    </DropdownMenuItem>
                  ))}
                </React.Fragment>
              ))}
              {rail.groups.length > 0 ? <DropdownMenuSeparator /> : null}
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
        </ButtonGroup>
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
  ticketDisplayId,
  models,
}: {
  request: RunOnceRequest;
  onClose(): void;
  projectId: string;
  ticketId: string;
  ticketDisplayId: string;
  models: readonly ComposerModel[];
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
      ticketDisplayId={ticketDisplayId}
      models={models}
      modelOverride={request.modelOverride}
      onClose={onClose}
    />
  );
}

function RunOnceForm({
  projectId,
  ticketId,
  ticketDisplayId,
  models,
  modelOverride,
  onClose,
}: {
  projectId: string;
  ticketId: string;
  ticketDisplayId: string;
  models: readonly ComposerModel[];
  modelOverride: ModelSelection | null;
  onClose(): void;
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
  const changePinEffort = (reasoningLevel: string): void => {
    if (pin === null) return;
    const picked = composerModelSelection({ ...pin, reasoningLevel });
    if (picked !== null) setPin(picked);
  };
  const compactEffort =
    pin !== null && pinStops.length > 1
      ? { levels: pinStops, value: pin.reasoningLevel, onChange: changePinEffort }
      : undefined;
  // The shared rule, so this button and main's refusal are one policy.
  const incomplete = unboundRunProblem(instructions) !== null || (choice === "pin" && pin === null);

  const submit = (): void => {
    if (incomplete) return;
    onClose();
    void runAutomationOnTicket({
      target: { kind: "unbound", instructions },
      automationName: UNBOUND_RUN_LABEL,
      ticketId,
      ticketDisplayId,
      modelOverride: choice === "pin" ? pin : null,
    });
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{UNBOUND_RUN_LABEL}</DialogTitle>
        </DialogHeader>
        {/* DialogContent is a grid. This zero minimum lets the shared picker
            truncate inside the dialog instead of widening the grid track. */}
        <div data-composer-container="" className="@container/composer flex min-w-0 flex-col gap-2">
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
          <div className="flex flex-wrap items-center gap-2">
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
                  compactEffort={compactEffort}
                  onChange={(next) => {
                    const picked = composerModelSelection(next);
                    if (picked !== null) setPin(picked);
                  }}
                />
                {pin !== null && pinStops.length > 1 ? (
                  <EffortPill
                    levels={pinStops}
                    value={pin.reasoningLevel}
                    onChange={changePinEffort}
                    className="composer-separate-effort"
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={incomplete} onClick={submit}>
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
