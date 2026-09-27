/**
 * The ticket rail's Automations block (VC-129): what this Ticket can be made
 * to run, and one press to run it, without leaving the current tab. VC-234
 * makes that landing universal: success toasts with an "Open session" action
 * and never navigates.
 *
 * **ONE LIST, CAPPED** (VC-406). The block has been four shapes. It began as
 * a split button under an eyebrow, with a second visible list of every
 * column's Automations under THAT (each a ghost button with a play glyph) and
 * this Ticket's Runs under that again — three stacked drawings, every name
 * printed twice, and nothing in the geometry saying which of them was a
 * button. The correction deleted both lists and left the split button alone,
 * which fixed the clutter by making the block say almost nothing. The third
 * shape made the offer a LIST with a Run once button under it.
 *
 * What it is now is that list, alone. The offer is a list because a list is
 * what the offer IS — several named things, one of which is this column's
 * default. It is bounded by HEIGHT rather than by hiding rows: `max-h` and a
 * scroller, so a project with thirty Automations costs the same vertical space
 * as a project with three, and the roster underneath never moves. The rows are
 * `ListRow`s, the same object the Sessions roster is built from, so "a row
 * opens the thing it names" is one rule on this page rather than a convention
 * per block. There is no button: the block ends where its last row does.
 *
 * **RUN ONCE IS GONE** (VC-406, reversing VC-112's "One-time work" for this
 * surface). Stripped to what it did, it minted a chat Session with a typed
 * first message, in the background, wearing the bolt — which is `+ Chat ▾` in
 * the Sessions eyebrow one block up, with a worse text box (a dialog rather
 * than the composer) and a Runs-history row named "Run once". The rail was
 * its only host. The block's question is "what SAVED things can this Ticket
 * be made to run", and the rows answer it alone; a one-off is a chat and
 * typing. Main still starts an Unbound Run for the CLI; nothing here asks it to.
 *
 * A Run's Session is listed once, in the roster below, wearing the bolt that
 * says a Run started it (`session-provenance-mark.tsx`). This block never
 * lists Runs.
 *
 * **The rail runs; it does not author.** There is no form here for making an
 * Automation, and that is a ruling rather than an omission (VC-112): an
 * authoring form in a 300px rail would be a worse copy of the Automations page,
 * and the page is the one surface that owns the record's lifecycle. What the
 * rail offers instead is ONE door to that page, in the header row beside the
 * eyebrow — where the Sessions block keeps its own control (VC-257).
 *
 * Four rules the drawing carries:
 *
 *  - **The column's own default is MARKED, not hidden.** The row this Ticket's
 *    column has ARMED leads the list and says so: pressing it is the same act
 *    the board performs on a Deliberate move into that column. Every other
 *    offered row is a hand-run of the same kind, and says which column offers
 *    it. With nothing armed there is no marked row, and no stand-in for one.
 *  - **It never presses what it has not read.** The rail re-reads on arrival
 *    and on every planning change, and until that read lands the block holds
 *    its shape and starts nothing (`automation-run-menu.tsx` owns the rule,
 *    `armed-run.ts` makes the same refusal for a dropped card). A stale cache
 *    — including one whose re-read FAILED — would press the Automation the
 *    column used to arm, and the cache cannot tell "nothing armed" from "not
 *    asked yet", nor a value that was just confirmed from one that merely
 *    survived.
 *  - **Never hidden when empty.** A project with no Automations still draws
 *    the block and its page door, and says the absence in one line.
 *    Hidden-when-empty is how a feature never gets discovered.
 *  - **By hand is universal.** Running from here is unaffected by the
 *    machine-local switch (VC-112) — the switch governs what starts an
 *    Automation BESIDES a person. A switched-off Automation is offered, never
 *    dimmed or withheld; its bolt wears a slash, and the words are in its
 *    hover title.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { LightningSlashIcon } from "@phosphor-icons/react/dist/csr/LightningSlash";
import { SlidersIcon } from "@phosphor-icons/react/dist/csr/Sliders";

import { displayTicketId, type ModelSelection, type Ticket } from "@volli/shared";

import { useAutomationRunOffer, useOfferableModels } from "./automation-run-menu";
import { SWITCHED_OFF_NOTE } from "./automations-page-model";
import { runAutomationOnTicket } from "./run-automation";
import {
  modelOverrideRows,
  railAutomationRows,
  type RailAutomationRow,
  type RailRunAction,
} from "./ticket-rail-automations-model";
import type { ComposerModel } from "@renderer/components/chat/composer-ui";
import {
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
import { ListRow, ListRowSkeleton, type LoadingBarWidth } from "@renderer/components/ui/list-row";
import { loadingRegionProps } from "@renderer/components/ui/loading-region";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** The same block shape the rail's other sections use, at the rail's own inset. */
const SECTION = cn("flex flex-col gap-1", RAIL_PANEL_INSET);

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
  const models = useOfferableModels();

  // What this column offers, read on arrival and inert until that read lands
  // (`automation-run-menu.tsx` states the rule once, for this rail and for the
  // board card's own menu).
  const rail = useAutomationRunOffer(projectId, ticket.status);
  const empty = rail.ready && !rail.listsAny;
  const rows = railAutomationRows(rail);
  // How many rows the block held the last time it was read, so the wait
  // between reads is drawn at the list's own height (see `UnreadRows`).
  const lastRowCount = React.useRef<number | null>(null);
  if (rail.ready) lastRowCount.current = rows.length;

  const run = (action: RailRunAction, modelOverride: ModelSelection | null): void => {
    // Nothing starts from an unread rail or an unarmed column: a press that
    // reached here named no record, because the rail knew of none to name.
    if (action.kind !== "automation") return;
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
        <UnreadRows count={lastRowCount.current} />
      ) : empty ? (
        // Visible and plain: one line, a report and never an action — the
        // header's own door is 20px above it, and a second copy of the same
        // door inside the empty state would be the same offer twice in one
        // glance.
        <p className="px-2 text-label text-muted-foreground">No automations in this project yet.</p>
      ) : (
        <AutomationOfferList rows={rows} models={models} enabledIds={enabledIds} onRun={run} />
      )}
    </section>
  );
}

/**
 * The wait, at the list's own height.
 *
 * The rail re-reads on EVERY planning change — any board move, any label
 * edit, this Ticket's own status pill — and it used to draw that wait as one
 * line, "Reading automations…". A block that is three rows tall collapsing to
 * one line and re-expanding a moment later moves everything under it by a
 * hundred pixels, twice, for a read that almost always lands the same rows it
 * left. So the wait is drawn as the rows it is waiting for: as many skeleton
 * rows as the LAST ready render held, and two before anything has been read,
 * so a re-read moves nothing and a first read moves as little as it can.
 * `ListRowSkeleton` is the roster's own placeholder, at the row's own inset
 * and height.
 */
const UNREAD_WIDTHS: readonly LoadingBarWidth[] = ["w-2/5", "w-3/4", "w-1/2"];

function UnreadRows({ count }: { count: number | null }) {
  const rows = Math.max(count ?? 2, 1);
  return (
    <div
      className="flex flex-col"
      data-testid="ticket-rail-automations-unread"
      {...loadingRegionProps("automations")}
    >
      {Array.from({ length: rows }, (_, index) => (
        <ListRowSkeleton
          key={index}
          mark
          primaryWidth={UNREAD_WIDTHS[index % UNREAD_WIDTHS.length] ?? "w-1/2"}
          trailingWidth="w-12"
        />
      ))}
    </div>
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
 * THE BOLT SAYS THREE THINGS and the right edge says one (VC-406). The bolt
 * is `fill` on the armed row and outline on the rest — the weight pair the
 * app already uses to mark one item among its peers — and it wears a SLASH
 * (`LightningSlash`) on a record whose automatic triggers are off: nothing
 * fires this one by itself. The right edge then says only which column offers
 * the row, or `Armed`. It used to say `Manual only · Doing`, and at 300px that
 * phrase cost the name half its width (`Review every b…`); the name is what a
 * reader presses, the qualifier is what they check, so the check moved into
 * the glyph and the words moved into the row's hover title and accessible
 * name, where a reader who wants them can still ask. The switch's rule holds
 * (VC-112): the row is offered, never dimmed, never withheld.
 *
 * The name keeps a floor (`min-w-24`) so no width can reduce it to four
 * letters while the qualifier stays whole — a qualifier must not outlive the
 * thing it qualifies (docs/DESIGN.md).
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
  const switchedOff = !enabledIds.includes(row.automation.id);
  const column = row.armed ? "Armed" : row.columnLabel;
  const Bolt = switchedOff ? LightningSlashIcon : LightningIcon;
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ListRow
            data-testid="ticket-rail-automation-row"
            data-armed={row.armed ? "true" : undefined}
            data-triggers={switchedOff ? "off" : "on"}
            aria-label={`Run ${row.automation.name} on this ticket${switchedOff ? " (manual only)" : ""}`}
            title={`${row.automation.name} — ${switchedOff ? `${SWITCHED_OFF_NOTE} · ` : ""}${column}`}
            onActivate={() => onRun(action, null)}
            leading={
              <Bolt
                weight={row.armed ? "fill" : undefined}
                className={cn(
                  "size-4 shrink-0",
                  row.armed ? "text-primary" : "text-muted-foreground",
                )}
              />
            }
            primary={
              <span className="min-w-24 flex-1 truncate text-ui">{row.automation.name}</span>
            }
            trailing={
              <span
                className={cn(
                  "shrink-0 text-label",
                  row.armed ? "text-primary-text" : "text-muted-foreground",
                )}
              >
                {column}
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
