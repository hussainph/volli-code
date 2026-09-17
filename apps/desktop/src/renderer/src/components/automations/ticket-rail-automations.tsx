/**
 * The ticket rail's Automations block (VC-129): what this Ticket can be made
 * to run, and one press to run it, without leaving the current tab. VC-234
 * makes that landing universal: success toasts with an "Open session" action
 * and never navigates.
 *
 * **ONE LIST, CAPPED** (VC-406). The block has been three shapes. It began as
 * a split button under an eyebrow, with a second visible list of every
 * column's Automations under THAT (each a ghost button with a play glyph) and
 * this Ticket's Runs under that again — three stacked drawings, every name
 * printed twice, and nothing in the geometry saying which of them was a
 * button. The correction deleted both lists and left the split button alone,
 * which fixed the clutter by making the block say almost nothing: one name,
 * and everything else behind a caret a reader has no reason to open.
 *
 * What it is now is the middle answer. The offer is a LIST, because a list is
 * what the offer IS — several named things, one of which is this column's
 * default. It is bounded by HEIGHT rather than by hiding rows: `max-h` and a
 * scroller, so a project with thirty Automations costs the same vertical space
 * as a project with three, and the roster underneath never moves. The rows are
 * `ListRow`s, the same object the Sessions roster is built from, so "a row
 * opens the thing it names" is one rule on this page rather than a convention
 * per block. Run once is the one BUTTON here, wearing the rail's one control
 * recipe — which is what makes it read as an act rather than as one more row.
 *
 * A Run's Session is listed once, in the roster below, wearing the bolt that
 * says a Run started it (`session-provenance-mark.tsx`). This block never
 * lists Runs.
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
 *  - **The column's own default is MARKED, not hidden.** The row this Ticket's
 *    column has ARMED leads the list and says so: pressing it is the same act
 *    the board performs on a Deliberate move into that column. Every other
 *    offered row is a hand-run of the same kind, and says which column offers
 *    it. With nothing armed there is no marked row and nothing is lost — Run
 *    once needs no record at all.
 *  - **It never presses what it has not read.** The rail re-reads on arrival,
 *    and until that read lands the control says so and starts nothing bound
 *    (`automation-run-menu.tsx` owns the rule, `armed-run.ts` makes the same
 *    refusal for a dropped card). A cold cache would offer Run once on an
 *    armed Ticket; a stale one — including one whose re-read FAILED — would
 *    press the Automation the column used to arm. All of it is wrong for one
 *    reason: the cache cannot tell "nothing armed" from "not asked yet", nor a
 *    value that was just confirmed from one that merely survived.
 *  - **Never hidden when empty.** A project with no Automations still draws
 *    the block, its Run once button and its page door, and says the absence in
 *    one line. Hidden-when-empty is how a feature never gets discovered.
 *  - **By hand is universal.** Running from here is unaffected by the
 *    machine-local switch (VC-112) — the switch governs what starts an
 *    Automation BESIDES a person. A switched-off Automation is offered with the
 *    page's own words beside it rather than dimmed or withheld.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
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

import { OffNote, useAutomationRunOffer, useOfferableModels } from "./automation-run-menu";
import { InstructionsTextarea } from "./automation-editor";
import { runAutomationOnTicket } from "./run-automation";
import {
  modelOverrideRows,
  railAutomationRows,
  RAIL_UNREAD_LABEL,
  type RailAutomationRow,
  type RailRunAction,
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
import { ListRow } from "@renderer/components/ui/list-row";
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
 * Whether the Run once form is open.
 *
 * It used to be an object carrying a per-invocation override, because the
 * caret menu could pick a model on the WAY to the form — a menu that answered
 * the Runtime question and then opened a dialog asking it again (VC-406). The
 * offer is a list now and Run once is a plain button, so there is one place
 * that question is answered: the form's own Runtime control.
 */
type RunOnceRequest = boolean;

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
  const [runOnce, setRunOnce] = React.useState<RunOnceRequest>(false);
  const models = useOfferableModels();

  // What this column offers, read on arrival and inert until that read lands
  // (`automation-run-menu.tsx` states the rule once, for this rail and for the
  // board card's own menu).
  const rail = useAutomationRunOffer(projectId, ticket.status);
  const empty = rail.ready && !rail.listsAny;
  const rows = railAutomationRows(rail);

  const run = (action: RailRunAction, modelOverride: ModelSelection | null): void => {
    // Nothing bound starts from an unread rail: the press that reached here
    // named no record, because the rail knew of none to name.
    if (action.kind === "unread") return;
    if (action.kind === "run-once") {
      setRunOnce(true);
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
      {/* The door is in the header at every state, not only the empty one. It
          was the empty state's consolation prize before, which meant the one
          reader who could not reach the Automations page from here was the one
          whose project HAS Automations to arrange. */}
      <RailSectionHeadingRow label="Automations">
        <AutomationsPageDoor projectId={projectId} />
      </RailSectionHeadingRow>
      {!rail.ready ? (
        // Named, and pressing nothing. The rail has not read yet, so it knows
        // of no Automation — and of no absence either, which is why this is not
        // the empty sentence (`ticket-rail-automations-model.ts`).
        <p
          className="px-2 text-label text-muted-foreground"
          data-testid="ticket-rail-automations-unread"
        >
          {RAIL_UNREAD_LABEL}
        </p>
      ) : empty ? (
        // Visible and plain: one line, a report and never an action — the
        // header's own door is 20px above it, and a second copy of the same
        // door inside the empty state would be the same offer twice in one
        // glance. Run once below still presses: it names no record, so an
        // empty project is not an empty block.
        <p className="px-2 text-label text-muted-foreground">No automations in this project yet.</p>
      ) : (
        <AutomationOfferList rows={rows} models={models} enabledIds={enabledIds} onRun={run} />
      )}
      <RunOnceControl onRunOnce={() => setRunOnce(true)} />
      <RunOnceDialog
        open={runOnce}
        onClose={() => setRunOnce(false)}
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
 * The offer, as a list: one row per Automation this Ticket may be made to run.
 *
 * A `ListRow` per row, deliberately the SAME object the Sessions roster under
 * it is built from. The rail's rule is that a row opens the thing it names, and
 * an Automations block that invented its own row — a ghost button with a play
 * glyph, which is what this block used to draw — made "is that a button or an
 * item" a question a reader had to answer twice per page.
 *
 * WHAT A ROW SAYS AT ITS RIGHT EDGE is which column offers it, except for the
 * one this Ticket's own column has armed, which says so instead. That is the
 * useful disambiguation at rail width: the armed row is the press the board
 * would make on a Deliberate move, and every other row is a hand-run of a
 * different lane's Automation onto this Ticket. Naming the current column on
 * the armed row as well would spend the same pixels repeating the status pill
 * two blocks up.
 *
 * THE CAP IS THE POINT. `max-h-40` is five rows and a scroller — enough that a
 * typical project shows its whole offer without scrolling, and bounded so that
 * a project which arms every column cannot push the Sessions roster off the
 * resting view. Hiding all but one row behind a caret bounds the height too,
 * and answers the block's own question ("what can I run here?") by refusing to.
 */
function AutomationOfferList({
  rows,
  models,
  enabledIds,
  onRun,
}: {
  rows: readonly RailAutomationRow[];
  models: readonly ComposerModel[];
  enabledIds: readonly string[];
  onRun(action: RailRunAction, modelOverride: ModelSelection | null): void;
}) {
  return (
    <ul
      data-testid="ticket-rail-automation-list"
      aria-label="Automations this ticket can run"
      // `max-h-40` with its own scroller, and `overscroll-contain` so reaching
      // the end of this list does not carry on scrolling the whole Now page
      // out from under the pointer.
      className="max-h-40 overflow-y-auto overscroll-contain"
    >
      {rows.map((row) => (
        <AutomationOfferRow
          key={`${row.columnLabel}:${row.automation.id}`}
          row={row}
          models={models}
          enabledIds={enabledIds}
          onRun={onRun}
        />
      ))}
    </ul>
  );
}

/**
 * One offered Automation.
 *
 * The bolt is `fill` on the armed row and outline on the rest — the weight
 * pair the app already uses to mark one item among its peers, and the reason
 * the armed row needs no second badge beside its trailing word.
 *
 * Right-click carries the per-invocation override (VC-112). It is PER ROW
 * here, which is strictly more than the old caret offered: that menu could
 * only re-run the split button's own default on another model, so choosing a
 * model for any other column's Automation meant running it first and changing
 * it never. The drag path still has no menu and still takes no override.
 */
function AutomationOfferRow({
  row,
  models,
  enabledIds,
  onRun,
}: {
  row: RailAutomationRow;
  models: readonly ComposerModel[];
  enabledIds: readonly string[];
  onRun(action: RailRunAction, modelOverride: ModelSelection | null): void;
}) {
  const action: RailRunAction = { kind: "automation", automation: row.automation };
  const overrides = modelOverrideRows(models);
  // Read here as well as inside `OffNote`, because the separator between the
  // note and the column belongs to the pair rather than to either one.
  const switchedOff = !enabledIds.includes(row.automation.id);
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ListRow
            data-testid="ticket-rail-automation-row"
            data-armed={row.armed ? "true" : undefined}
            aria-label={`Run ${row.automation.name} on this ticket`}
            onActivate={() => onRun(action, null)}
            leading={
              <LightningIcon
                weight={row.armed ? "fill" : undefined}
                className={cn(
                  "size-4 shrink-0",
                  row.armed ? "text-primary" : "text-muted-foreground",
                )}
              />
            }
            primary={
              <span className="min-w-0 flex-1 truncate text-ui" title={row.automation.name}>
                {row.automation.name}
              </span>
            }
            // ONE PHRASE, not two words that happen to be adjacent. Where the
            // record is switched off the row says "Manual only · Doing", which
            // reads as one qualifier; the two set side by side with a plain
            // gap read as two competing labels, and at the 240px floor as one
            // run-on string. The note itself stays — running BY HAND is
            // unaffected by the machine-local switch (VC-112), so it qualifies
            // the row rather than dimming or withholding it.
            trailing={
              <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
                <OffNote automation={row.automation} enabledIds={enabledIds} />
                {switchedOff ? <span aria-hidden>·</span> : null}
                <span className={row.armed ? "text-primary-text" : undefined}>
                  {row.armed ? "Armed" : row.columnLabel}
                </span>
              </span>
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem icon={LightningIcon} onSelect={() => onRun(action, null)}>
            <span className="min-w-0 flex-1 truncate">Run {row.automation.name}</span>
          </ContextMenuItem>
          {/* Absent on a profile whose catalog offers no model a Run could
              name: an override with nothing to pick is a menu that reads as
              broken rather than as inapplicable. */}
          {overrides.length === 0 ? null : (
            <>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger icon={CpuIcon}>Run on model</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {overrides.map(({ model, selections }) =>
                    selections.length === 1 ? (
                      <ContextMenuItem
                        key={model.id}
                        icon={CpuIcon}
                        onSelect={() => onRun(action, selections[0] ?? null)}
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
                              onSelect={() => onRun(action, selection)}
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
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/**
 * Run once — the block's one button, and the only act here that is not a row.
 *
 * It wears `RAIL_CONTROL`, the recipe every act on a rail page wears, sized to
 * its label and parked at the left under the list at the same `px-2` the
 * eyebrow and the rows share. That is the whole reason it is a button and the
 * offers are rows: a reader must be able to tell an act from an item without
 * reading either, and on this page the answer is the costume.
 *
 * It takes no pre-chosen model. It opens a FORM, and the form has a Runtime
 * control in it — a menu that set the model on the way to a dialog that asks
 * for the model again was two places to answer one question.
 *
 * Never hidden, never disabled, and unaffected by an unread rail: an Unbound
 * Run names no record, so there is nothing here a stale cache could get wrong.
 */
function RunOnceControl({ onRunOnce }: { onRunOnce(): void }) {
  return (
    <div className="px-2 pt-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="ticket-rail-run-once"
        className={cn(RAIL_CONTROL, "min-w-0 shrink px-2 [&>span]:truncate")}
        onClick={onRunOnce}
      >
        <PlayIcon />
        <span>{UNBOUND_RUN_LABEL}…</span>
      </Button>
    </div>
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
 * It opens on the resolved default every time. The Runtime is chosen HERE, in
 * the form, and nowhere on the way to it — a control that pre-answered the
 * question this form asks would be two places to answer one question, and the
 * loser would be whichever the reader looked at second.
 */
function RunOnceDialog({
  open,
  onClose,
  projectId,
  ticketId,
  ticketDisplayId,
  models,
}: {
  open: RunOnceRequest;
  onClose(): void;
  projectId: string;
  ticketId: string;
  ticketDisplayId: string;
  models: readonly ComposerModel[];
}) {
  // Unmounted when closed, which is also what remounts it per opening: a
  // second Run once starts from a blank form rather than from the last one's
  // words.
  if (!open) return null;
  return (
    <RunOnceForm
      projectId={projectId}
      ticketId={ticketId}
      ticketDisplayId={ticketDisplayId}
      models={models}
      onClose={onClose}
    />
  );
}

function RunOnceForm({
  projectId,
  ticketId,
  ticketDisplayId,
  models,
  onClose,
}: {
  projectId: string;
  ticketId: string;
  ticketDisplayId: string;
  models: readonly ComposerModel[];
  onClose(): void;
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
