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
 * **A ROW INSPECTS; ONLY RUN RUNS** (VC-406 revision 05). The row's press used
 * to BE the launch, which made the block the one place in the app where a
 * single click spent a Session on work whose saved instructions were not on
 * screen — and made right-click the only route to the per-invocation model
 * override, so choosing one meant knowing the menu was there. A press now
 * opens an anchored inspection beside the row (a non-modal `Popover`: no
 * scrim, light-dismiss, Escape) holding the three things a launch is decided
 * from — the saved instructions, the model this invocation runs on, and one
 * explicit, labelled Run. Right-click opens the same inspection rather than a
 * second, differently-shaped menu; neither route starts anything by itself.
 *
 * **The rail runs; it does not author.** There is no form here for making an
 * Automation, and that is a ruling rather than an omission (VC-112): an
 * authoring form in a 300px rail would be a worse copy of the Automations page,
 * and the page is the one surface that owns the record's lifecycle. What the
 * rail offers instead is ONE door to that page, in the header row beside the
 * eyebrow — where the Sessions block keeps its own control (VC-257). The
 * inspection carries no second copy of that door, and no shortcut to Diffs.
 *
 * Four rules the drawing carries:
 *
 *  - **The column's own default is MARKED, not hidden.** The row this Ticket's
 *    column has ARMED leads the list and says so: pressing it is the same act
 *    the board performs on a Deliberate move into that column. Every other
 *    offered row is a hand-run of the same kind, and says which column offers
 *    it. With nothing armed there is no marked row, and no stand-in for one.
 *  - **It never presses what it has not read — and never blanks what it HAS**
 *    (VC-406). The rail re-reads on arrival and on every planning change, and
 *    until that read lands it starts nothing (`automation-run-menu.tsx` owns
 *    the rule, `armed-run.ts` makes the same refusal for a dropped card): a
 *    stale cache — including one whose re-read FAILED — would press the
 *    Automation the column used to arm, and the cache cannot tell "nothing
 *    armed" from "not asked yet", nor a value that was just confirmed from one
 *    that merely survived. What it does DRAW meanwhile is the last coherent
 *    read, with the caveat in the eyebrow: rows that were true a second ago are
 *    worth more than a skeleton over them, and the refusal is spent on the Run
 *    rather than on the reader's ability to see what is there. A first read
 *    that fails has nothing to retain, so it says so in the body and offers the
 *    one press that retries it.
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
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { LightningSlashIcon } from "@phosphor-icons/react/dist/csr/LightningSlash";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";

import { displayTicketId, type ModelSelection, type Ticket } from "@volli/shared";

import { useAutomationRunOfferRead, useOfferableModels } from "./automation-run-menu";
import { runAutomationOnTicket, type AutomationRunOutcome } from "./run-automation";
import {
  automationInspectMeta,
  railAutomationRows,
  railRowQualifier,
  runLaunchLabel,
  runModelChoices,
  SAVED_RUNTIME_CHOICE,
  type RailAutomationRow,
  type RailRunAction,
  type RunLaunchState,
} from "./ticket-rail-automations-model";
import type { ComposerModel } from "@renderer/components/chat/composer-ui";
import {
  RAIL_CONTROL,
  RAIL_PANEL_INSET,
  RailHeadingReadStatus,
  RailReadFaultBody,
  RailSectionHeadingRow,
} from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { ListRow, ListRowSkeleton, type LoadingBarWidth } from "@renderer/components/ui/list-row";
import { loadingRegionProps } from "@renderer/components/ui/loading-region";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
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
  // board card's own menu), plus what the last landed read said and what this
  // one is doing.
  const { offer, retained, feedback, retry } = useAutomationRunOfferRead(projectId, ticket.status);
  // What the list DRAWS: the fresh answer, or the last coherent one while a
  // re-read is out. Either way it came from a read that landed whole, so a
  // claim about the project made from it is a claim a read supports.
  const shown = offer.ready ? offer : retained;
  // Readable, not pressable. The rows are the last thing that was true; the
  // arming behind them may not be, and a Run is not something to spend on a
  // maybe (VC-112's refusal, kept exactly).
  const stale = !offer.ready && retained !== null;
  // `shown` is a landed read by construction — fresh or retained — so a claim
  // about the project made from it is one a read supports (`railReadCanClaimEmpty`'s
  // rule, already spent when the snapshot was kept).
  const empty = shown !== null && !shown.listsAny;
  const rows = shown === null ? NO_ROWS : railAutomationRows(shown);
  const launches = useRunLaunches();

  const run = (action: RailRunAction, modelOverride: ModelSelection | null): void => {
    // Nothing starts from an unread rail or an unarmed column: a press that
    // reached here named no record, because the rail knew of none to name.
    if (action.kind !== "automation" || stale) return;
    // Where the Run lands is the roster's business: its Session arrives there
    // through the same push every Session does, so nothing here re-reads.
    launches.start(action.automation.id, () =>
      runAutomationOnTicket({
        target: { kind: "automation", automationId: action.automation.id },
        automationName: action.automation.name,
        ticketId: ticket.id,
        ticketDisplayId,
        modelOverride,
      }),
    );
  };

  return (
    <section className={SECTION} aria-label="Automations" data-testid="ticket-rail-automations">
      {/* The door is in the header at every state, not only the empty one. It
          was the empty state's consolation prize before, which meant the one
          reader who could not reach the Automations page from here was the one
          whose project HAS Automations to arrange. */}
      <RailSectionHeadingRow
        label="Automations"
        // The caveat rides the row the block already owns, and only while rows
        // are on screen to caveat: no reserved strip, and no word beside it —
        // this eyebrow's budget is a label and its page door.
        status={
          <RailHeadingReadStatus
            feedback={feedback}
            onRetry={retry}
            testId="ticket-rail-automations-read-status"
          />
        }
      >
        <AutomationsPageDoor projectId={projectId} />
      </RailSectionHeadingRow>
      {/* A refused FIRST read knows nothing about this project: no rows to
          caveat, and the two sentences it could otherwise draw — "none here"
          and "this could not be read" — are opposite claims. The failure wins,
          and brings the one press that changes it. */}
      <RailReadFaultBody
        feedback={feedback}
        onRetry={retry}
        testId="ticket-rail-automations-error"
      />
      {shown === null ? (
        feedback?.kind === "reading" ? (
          <UnreadRows />
        ) : null
      ) : empty ? (
        // Visible and plain: one line, a report and never an action — the
        // header's own door is 20px above it, and a second copy of the same
        // door inside the empty state would be the same offer twice in one
        // glance.
        <p className="px-2 text-label text-muted-foreground">No automations in this project yet.</p>
      ) : (
        <AutomationOfferList
          rows={rows}
          models={models}
          enabledIds={enabledIds}
          launches={launches}
          stale={stale}
          onRun={run}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------ launch state */

/**
 * The block's ONE pending gate, and the failure that earns a Retry.
 *
 * ONE gate, per record, held by the BLOCK rather than by the popover that
 * shows it. Two reasons, and both are things that go wrong when the state
 * lives in the inspection: the row's own right edge says `Starting…` while a
 * launch is in flight, which is the acknowledgment that lets a person close
 * the popover instead of holding it open to watch; and a popover that is
 * closed and reopened would forget that a Run is already in flight, which is
 * precisely the moment a second press mints a second Session.
 *
 * The ref is the gate and the state is the drawing. A gate read from state
 * would be read from a closure that a press one frame earlier has already
 * invalidated — the double-press this exists to refuse is exactly the case
 * where those two disagree.
 *
 * NOTHING HERE LANDS A RUN. `runAutomationOnTicket` adopts the Session,
 * toasts its door and never navigates (VC-234); what this adds is the gate,
 * and a failure a person can press again. A launch that lands after the block
 * is gone updates nothing: `alive` is the whole of that rule, and it is why a
 * completion cannot reach for focus or navigation on a surface the person has
 * left.
 */
export interface RunLaunches {
  state(automationId: string): RunLaunchState;
  start(automationId: string, launch: () => Promise<AutomationRunOutcome>): void;
}

function useRunLaunches(): RunLaunches {
  const pending = React.useRef(new Set<string>());
  const [drawn, setDrawn] = React.useState<{
    pending: readonly string[];
    failed: readonly string[];
  }>({ pending: [], failed: [] });
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  return {
    state: (automationId) =>
      drawn.pending.includes(automationId)
        ? "pending"
        : drawn.failed.includes(automationId)
          ? "failed"
          : "idle",
    start: (automationId, launch) => {
      // The gate. A second press while the first is in flight is the same
      // launch pressed twice, and a Run is not an idempotent act on this side
      // of the wire.
      if (pending.current.has(automationId)) return;
      pending.current.add(automationId);
      setDrawn((previous) => ({
        pending: [...previous.pending, automationId],
        // A new attempt clears the last one's failure: the alert belongs to
        // the attempt that produced it.
        failed: previous.failed.filter((id) => id !== automationId),
      }));
      void launch().then(
        (outcome) => {
          pending.current.delete(automationId);
          if (!alive.current) return;
          setDrawn((previous) => ({
            pending: previous.pending.filter((id) => id !== automationId),
            // Model Access is not a retry: the recovery is configuration, and
            // Settings is already open on it.
            failed:
              outcome === "refused" || outcome === "failed"
                ? [...previous.failed.filter((id) => id !== automationId), automationId]
                : previous.failed.filter((id) => id !== automationId),
          }));
        },
        () => {
          // `runAutomationOnTicket` toasts its own transport failure and
          // resolves; a throw past it is unexpected, and the one thing that
          // must not survive it is a gate nothing will ever clear.
          pending.current.delete(automationId);
          if (!alive.current) return;
          setDrawn((previous) => ({
            pending: previous.pending.filter((id) => id !== automationId),
            failed: [...previous.failed.filter((id) => id !== automationId), automationId],
          }));
        },
      );
    },
  };
}

/**
 * The FIRST read's wait, at the list's own height.
 *
 * The rail re-reads on EVERY planning change — any board move, any label
 * edit, this Ticket's own status pill — and it used to draw that wait as one
 * line, "Reading automations…". A block that is three rows tall collapsing to
 * one line and re-expanding a moment later moves everything under it by a
 * hundred pixels, twice, for a read that almost always lands the same rows it
 * left.
 *
 * A re-read no longer reaches this at all: the rows it last read stay drawn
 * and the eyebrow carries the caveat, because a skeleton over retained data
 * hides the very thing the reader was looking at to say something they can
 * read in the heading instead. What is left here is the case with nothing to
 * retain — a first read, or an arrival on a project this block has not read —
 * drawn as two skeleton rows so the first landing moves as little as it can.
 * `ListRowSkeleton` is the roster's own placeholder, at the row's own inset
 * and height.
 */
const UNREAD_WIDTHS: readonly LoadingBarWidth[] = ["w-2/5", "w-3/4", "w-1/2"];

const NO_ROWS: readonly RailAutomationRow[] = [];

function UnreadRows() {
  const rows = 2;
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
  launches,
  stale,
  onRun,
}: {
  rows: readonly RailAutomationRow[];
  models: readonly ComposerModel[];
  enabledIds: readonly string[];
  launches: RunLaunches;
  /** Retained rows: read them, inspect them, launch nothing from them. */
  stale: boolean;
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
          launch={launches.state(row.automation.id)}
          stale={stale}
          onRun={onRun}
        />
      ))}
    </ul>
  );
}

/**
 * One offered Automation: a row that INSPECTS, and an inspection that runs.
 *
 * THE BOLT SAYS THREE THINGS and the right edge says one (VC-406). The bolt
 * is `fill` on the armed row and outline on the rest — the weight pair the
 * app already uses to mark one item among its peers — and it wears a SLASH
 * (`LightningSlash`) on a record whose automatic triggers are off: nothing
 * fires this one by itself. The right edge then says only which column offers
 * the row, or `Armed` — or `Starting…` for as long as a launch this row
 * started is in flight, which is the one thing about the row that is happening
 * now. It used to say `Manual only · Doing`, and at 300px that phrase cost the
 * name half its width (`Review every b…`); the name is what a reader presses,
 * the qualifier is what they check, so the check moved into the glyph and the
 * words moved into the inspection, the row's hover title and its accessible
 * name. The switch's rule holds (VC-112): the row is offered, never dimmed,
 * never withheld.
 *
 * The name keeps a floor (`min-w-24`) and the qualifier YIELDS FIRST
 * (`max-w-20`, truncating): a qualifier must not outlive the thing it
 * qualifies (docs/DESIGN.md), and at the 240px floor the column's own words
 * are what a reader can most afford to lose.
 *
 * LEFT-CLICK AND RIGHT-CLICK OPEN THE SAME THING, and neither launches. A
 * press used to be the Run itself, with the per-invocation override hidden
 * behind a context menu — so the fast path spent a Session on instructions
 * that were not on screen, and the deliberate path was the one nobody could
 * see. One anchored inspection answers both now, and Run inside it is the only
 * thing that starts work.
 */
function AutomationOfferRow({
  row,
  models,
  enabledIds,
  launch,
  stale,
  onRun,
}: {
  row: RailAutomationRow;
  models: readonly ComposerModel[];
  enabledIds: readonly string[];
  launch: RunLaunchState;
  stale: boolean;
  onRun(action: RailRunAction, modelOverride: ModelSelection | null): void;
}) {
  const [open, setOpen] = React.useState(false);
  const switchedOff = !enabledIds.includes(row.automation.id);
  const qualifier = railRowQualifier(row, launch === "pending");
  const Bolt = switchedOff ? LightningSlashIcon : LightningIcon;
  return (
    <li>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <ListRow
            data-testid="ticket-rail-automation-row"
            data-armed={row.armed ? "true" : undefined}
            data-triggers={switchedOff ? "off" : "on"}
            data-launch={launch}
            data-stale={stale ? "true" : undefined}
            // What the press DOES, said plainly: it opens the record, and the
            // Run inside it is its own labelled act.
            aria-label={`Inspect ${row.automation.name}`}
            title={`${row.automation.name} — ${automationInspectMeta(row, switchedOff)}`}
            onActivate={NOOP}
            // The same inspection, not a second menu of its own (VC-406): a
            // right-click that opened different controls would be a second
            // answer to what this row can be made to do.
            onContextMenu={(event) => {
              event.preventDefault();
              setOpen(true);
            }}
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
                  "max-w-20 min-w-0 shrink truncate text-label",
                  row.armed && launch !== "pending" ? "text-primary-text" : "text-muted-foreground",
                )}
              >
                {qualifier}
              </span>
            }
          />
        </PopoverTrigger>
        <AutomationInspectContent
          row={row}
          models={models}
          switchedOff={switchedOff}
          launch={launch}
          stale={stale}
          onRun={(modelOverride) =>
            onRun({ kind: "automation", automation: row.automation }, modelOverride)
          }
          onLanded={() => setOpen(false)}
        />
      </Popover>
    </li>
  );
}

/** A row that opens rather than acts still needs an activation target. */
const NOOP = () => {};

/**
 * The inspection: what this Automation would do, on what, and the one press
 * that does it.
 *
 * ANCHORED, NOT MODAL. A `Popover` beside the row it belongs to, with no
 * scrim: the rail stays legible and the rest of the app stays usable, which
 * is the whole difference between reading a record and being interrupted by
 * it. Radix supplies light-dismiss and Escape; the app's own `PopoverContent`
 * supplies the wheel claim, the surface and the reduced-motion gate.
 *
 * THE THREE THINGS A LAUNCH IS DECIDED FROM, together, because deciding is
 * what this surface is for: the record's SAVED instructions (read-only — the
 * rail runs, it does not author), the Runtime this invocation will use, and
 * one explicit Run. A failed launch says so here, keeps the model that was
 * chosen for it, and offers the press again as `Retry Run`.
 *
 * WHAT IT DOES NOT HOLD: a second door to the Automations page (the block's
 * heading already has one, 20px up), a Diffs shortcut, and any authoring
 * control. And it never opens by itself — no launch, no toast and no arriving
 * Session opens or closes it except the one rule below.
 *
 * A LANDED RUN CLOSES IT ONLY WHILE THE PERSON IS STILL FOLLOWING. Focus
 * inside the popover is what "still following" means: close it then, and Radix
 * hands focus back to the row that opened it. If the person has moved on — to
 * a chat, to another block, to another Ticket — a completion that arrives in
 * the background changes nothing on screen, because a background landing that
 * takes focus or navigation is the interruption VC-234 already refuses for
 * Runs.
 */
function AutomationInspectContent({
  row,
  models,
  switchedOff,
  launch,
  stale,
  onRun,
  onLanded,
}: {
  row: RailAutomationRow;
  models: readonly ComposerModel[];
  switchedOff: boolean;
  launch: RunLaunchState;
  /**
   * The rows behind this inspection are the last read, not the current one.
   * Everything here is still worth reading — the instructions are the record's
   * own — but the Run is refused until a whole fresh read lands: what a press
   * would spend is the arming this column had, which is the one part of the
   * answer a failed re-read leaves unproven.
   */
  stale: boolean;
  onRun(modelOverride: ModelSelection | null): void;
  onLanded(): void;
}) {
  const choices = runModelChoices(models);
  const [choiceId, setChoiceId] = React.useState(SAVED_RUNTIME_CHOICE);
  const chosen = choices.find((choice) => choice.id === choiceId) ?? choices[0];
  const content = React.useRef<HTMLDivElement | null>(null);
  const wasPending = React.useRef(false);

  // The landing rule, read from the DOM because "still following" is a fact
  // about where the person's attention is, not about what this component
  // remembers. A launch that ends while focus is elsewhere leaves the popover
  // exactly as it is.
  React.useEffect(() => {
    const landed = wasPending.current && launch === "idle";
    wasPending.current = launch === "pending";
    if (!landed) return;
    const node = content.current;
    if (node !== null && node.contains(document.activeElement)) onLanded();
  }, [launch, onLanded]);

  return (
    <PopoverContent
      ref={content}
      align="start"
      side="left"
      className="flex w-72 flex-col gap-2 p-3"
      data-testid="ticket-rail-automation-inspect"
      aria-label={`${row.automation.name} — automation`}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="truncate text-ui font-medium">{row.automation.name}</h3>
        <p className="truncate text-label text-muted-foreground">
          {automationInspectMeta(row, switchedOff)}
        </p>
      </div>
      {/* The saved instructions, as they are stored. Read-only, scrolling
          rather than growing: a record with a page of instructions must not
          push the Run out of the popover. */}
      <pre
        data-testid="ticket-rail-automation-instructions"
        className="max-h-32 overflow-y-auto overscroll-contain rounded-row bg-muted/40 px-2 py-1.5 text-label whitespace-pre-wrap text-foreground/90"
      >
        {row.automation.instructions}
      </pre>
      {choices.length === 0 ? null : (
        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0 text-label text-muted-foreground">Run on</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className={cn(RAIL_CONTROL, "min-w-0 gap-1.5 font-normal")}
                aria-label="Run on model"
                data-testid="ticket-rail-automation-model"
              >
                <span className="min-w-0 truncate">{chosen?.label}</span>
                <CaretDownIcon weight="bold" className="size-3 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={choiceId} onValueChange={setChoiceId}>
                {choices.map((choice) => (
                  <DropdownMenuRadioItem key={choice.id} value={choice.id}>
                    {choice.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {stale ? (
        <p
          role="status"
          data-testid="ticket-rail-automation-stale"
          className="text-label text-muted-foreground"
        >
          Run waits for a fresh read.
        </p>
      ) : null}
      {launch === "failed" ? (
        // The toast said what went wrong and is gone; this says the Run did
        // not start, beside the press that tries again with the same choices.
        <p role="alert" className="text-label text-destructive">
          Couldn’t start the Session.
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          size="sm"
          className="gap-1.5"
          disabled={launch === "pending" || stale}
          // The record's name is in the accessible name and not on the face:
          // the popover's own heading says it 60px above, and a button that
          // repeated it would be the same words twice in one small surface.
          aria-label={`Run ${row.automation.name}`}
          data-testid="ticket-rail-automation-run"
          onClick={() => onRun(chosen?.selection ?? null)}
        >
          <PlayIcon weight="fill" className="size-3" />
          {runLaunchLabel(launch)}
        </Button>
      </div>
    </PopoverContent>
  );
}
