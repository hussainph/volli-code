/**
 * What the ticket rail's Automations block OFFERS (VC-129), kept pure beside
 * the view that draws it — the same shape as `automations-page-model.ts` next
 * door, and in the coverage gate for the same reason: every decision here is
 * one a static view test would not catch going wrong.
 *
 * Four of them earn the module:
 *
 *  - **The default press follows the COLUMN.** The row marked Armed is
 *    whatever this Ticket's current column has armed — a rule about two
 *    records neither of which is the row (VC-112, "Board interaction") — and
 *    an arming row naming a deleted or no-longer-offered Automation is inert.
 *    Both facts live in `@volli/shared`; this module is where the rail asks.
 *  - **The block is never hidden.** A column with nothing armed still lists
 *    what it offers, and a project with no Automations at all still draws the
 *    block: a sentence and a door to the page rather than an absent block.
 *    Hidden-when-empty is how a feature never gets discovered. What an
 *    unarmed column does NOT get is a stand-in press (VC-406 retired the
 *    rail's Run once — see `RailRunAction`); it has no default, and says so.
 *  - **An UNREAD rail presses nothing.** "Nothing armed here" and "nobody has
 *    asked yet" are one value in the caches this reads (VC-112 makes arming
 *    machine-local, and every slice rests empty), and the difference decides
 *    what a click does: a cache left over from before someone re-armed the
 *    column elsewhere would run the Automation it USED to arm. So an unread
 *    rail says so and starts nothing — the same refusal to decide from an
 *    empty cache the board's own arrival makes (`armed-run.ts`), spent here
 *    on a press rather than on a drop.
 *  - **An override names a whole pair.** Model and reasoning travel together
 *    (VC-112), so a one-click override cannot offer a model and leave the
 *    level to a default nobody chose — a model that offers several levels
 *    offers them, and one that offers exactly one is a single item.
 */
import {
  armedAutomationFor,
  offeredAutomationsForColumn,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Automation,
  type ColumnArming,
  type ColumnAutomationOrder,
  type ModelSelection,
  type TicketStatus,
} from "@volli/shared";

import { SWITCHED_OFF_NOTE } from "./automations-page-model";
import { composerModelSelection } from "@renderer/components/chat/chat-plane-model";
import type { ComposerModel } from "@renderer/components/chat/composer-ui";

/**
 * What this column's DEFAULT press is — the record a Deliberate move into the
 * column would start — or why there is none.
 *
 * There is no `run-once` any more (VC-406). The rail used to answer an
 * unarmed column with "open the Run once form"; that form minted a chat
 * Session with a typed first message, which is `+ Chat ▾` one block up with a
 * worse text box, and the rail was its only host. An unarmed column now
 * simply has no default press, and says so with `none` rather than with an
 * offer to type.
 */
export type RailRunAction =
  | { kind: "automation"; automation: Automation }
  /** Nothing has been read yet, so nothing may be pressed yet. */
  | { kind: "unread" }
  /** Read, and this column arms nothing. */
  | { kind: "none" };

export interface TicketRailAutomations {
  /** This column's default press — the row the list marks Armed. */
  primary: RailRunAction;
  /**
   * Every column's Offered list, grouped and labelled (VC-329 item 5): the
   * whole answer to "what may this Ticket run", not just this column's slice
   * of it. Running a Doing Automation on a Todo Ticket is a hand-run — the
   * same act the caret already performed, minus the fumble — so no group row
   * moves the Ticket or arms anything: it reaches the same
   * `runAutomationOnTicket` the current column's rows always have.
   */
  groups: readonly AutomationGroup[];
  /** This column's Offered list in its authored rank — the caret menu's rows. */
  offered: readonly Automation[];
  /**
   * Whether this project lists any Automation at all. False is the empty state
   * the button stays visible for: it says so plainly and links to the page,
   * and Run once still runs, because an Unbound Run names no record.
   *
   * Only ever true once {@link TicketRailAutomations.ready} is: an unread rail
   * knows of no Automation and of no absence either, and the empty state's
   * sentence is a claim about the project rather than about the cache.
   */
  listsAny: boolean;
  /**
   * Whether this answer was decided from caches that have landed. False is not
   * an error state — it is the honest "not yet", and it lasts one read.
   */
  ready: boolean;
}

export function ticketRailAutomations(input: {
  automations: readonly Automation[];
  armings: readonly ColumnArming[];
  status: TicketStatus;
  /**
   * Every column's authored rank, so each GROUP of the cross-column answer is
   * ordered the way its own lane arranges — one rank per column, not one for
   * the whole menu.
   */
  orders: readonly ColumnAutomationOrder[];
  /**
   * This column's authored rank (VC-132) — the order its lane arranges, so the
   * menu and the lane are one list read twice. Deliberately NOT the drag's
   * pinned shape: the pin exists to protect what digit `1` means, and this menu
   * has no digits. Optional; a caller that reads only the cross-column groups
   * may omit it.
   */
  rankedAutomationIds?: readonly string[];
  /** Whether the reads behind `automations`/`armings` have landed for this rail. */
  ready: boolean;
}): TicketRailAutomations {
  if (!input.ready)
    return {
      primary: { kind: "unread" },
      groups: [],
      offered: [],
      listsAny: false,
      ready: false,
    };
  const armed = armedAutomationFor(input.automations, input.armings, input.status);
  return {
    primary: armed === null ? { kind: "none" } : { kind: "automation", automation: armed },
    groups: automationGroupsFor({
      automations: input.automations,
      orders: input.orders,
      status: input.status,
    }),
    offered: offeredAutomationsForColumn(
      input.automations,
      input.status,
      input.rankedAutomationIds ?? [],
    ),
    listsAny: input.automations.length > 0,
    ready: true,
  };
}

/** One column's slice of the cross-column answer: its label, and what it offers. */
export interface AutomationGroup {
  status: TicketStatus | "any";
  /** The column's own display label — the board's words, not a machine id. */
  label: string;
  /** Whether this group is the Ticket's own column — drawn first when it is. */
  current: boolean;
  automations: readonly Automation[];
}

/**
 * Every column's Offered list, grouped and labelled, for a menu that answers
 * "what may this Ticket run" across ALL columns (VC-329 item 5).
 *
 * Membership stays the record's Trigger — a schedule names the PROJECT, so it
 * appears in no group and keeps its own doors. Triggerless records can be run
 * on any ticket and have their own final group. Order is the Ticket's own column first (the nearest answer
 * stays nearest), then board order, each group in its column's authored rank —
 * the same {@link offeredAutomationsForColumn} the lane arranges, read once per
 * column. A column offering nothing contributes no group, so an unarranged
 * project reads as a short menu rather than a wall of empty headings.
 */
export function automationGroupsFor(input: {
  automations: readonly Automation[];
  orders: readonly ColumnAutomationOrder[];
  status: TicketStatus;
}): readonly AutomationGroup[] {
  const groups: AutomationGroup[] = [];
  for (const status of TICKET_STATUSES) {
    const automations = offeredAutomationsForColumn(
      input.automations,
      status,
      input.orders.find((order) => order.status === status)?.rankedAutomationIds ?? [],
    );
    if (automations.length === 0) continue;
    groups.push({
      status,
      label: TICKET_STATUS_LABELS[status],
      current: status === input.status,
      automations,
    });
  }
  const manual = input.automations.filter((automation) => automation.trigger.kind === "none");
  if (manual.length > 0) {
    groups.push({ status: "any", label: "Any column", current: false, automations: manual });
  }
  return [...groups.filter((group) => group.current), ...groups.filter((group) => !group.current)];
}

/**
 * One row of the rail's Automations list (VC-406): what it is, whose column
 * offers it, and whether it is the one this Ticket's column has ARMED.
 *
 * The rail draws the offer as a list rather than as a name inside a split
 * button with the rest behind a caret. A caret menu answers "what else?" only
 * for a reader who already suspects there is an else; the block's whole job is
 * to say what this Ticket can be made to do, and a list says it without being
 * asked. The list is height-capped instead (the view's business), which is the
 * honest way to bound a block that grows with the project rather than hiding
 * all but one of its rows.
 */
export interface RailAutomationRow {
  automation: Automation;
  /** The column that offers it, in the board's own words — or "Any column". */
  columnLabel: string;
  /** Whether this row is this column's armed default — what a Deliberate move would start. */
  armed: boolean;
}

/**
 * The groups flattened into rows, this Ticket's own column first.
 *
 * Flattened, not drawn as grouped sections with their own headings: at rail
 * width a heading per column costs a row per column, and in a project that
 * arms every lane the headings would outnumber the Automations. Each row names
 * its own column at the right instead, which is the same fact at a quarter of
 * the height and stays true when the list is scrolled halfway.
 *
 * ONE ROW PER RECORD, which is where this parts company with the menu it
 * replaces. The groups repeat a record that several columns offer, and that is
 * right for a MENU: the heading is the subject there, and "what may I run from
 * Done" is a question worth listing twice to answer. Here every row reaches
 * the same `runAutomationOnTicket` with the same Automation id, so two rows
 * for one record are two identical presses wearing different words — the
 * reader is invited to choose between them and there is nothing to choose.
 * The first occurrence wins, and since the Ticket's own column is ordered
 * first, the column a row names is the NEAREST one that offers it.
 *
 * ARMED IS STILL A PROPERTY OF THE PAIR, not of the Automation. A row is the
 * armed one only where it sits under the Ticket's OWN column — matching on id
 * alone would mark a record armed on a Ticket whose column arms nothing, which
 * is a claim that pressing it is what the board would have done.
 */
export function railAutomationRows(rail: TicketRailAutomations): readonly RailAutomationRow[] {
  const armedId = rail.primary.kind === "automation" ? rail.primary.automation.id : null;
  const seen = new Set<string>();
  const rows: RailAutomationRow[] = [];
  for (const group of rail.groups) {
    for (const automation of group.automations) {
      if (seen.has(automation.id)) continue;
      seen.add(automation.id);
      rows.push({
        automation,
        columnLabel: group.label,
        armed: group.current && automation.id === armedId,
      });
    }
  }
  return rows;
}

/**
 * What a surface that names the default press labels it — the Automation's
 * name, the wait, or the plain fact that nothing is armed.
 */
export function railRunLabel(action: RailRunAction): string {
  if (action.kind === "automation") return action.automation.name;
  return action.kind === "unread" ? RAIL_UNREAD_LABEL : RAIL_UNARMED_LABEL;
}

/**
 * What the control says while it is still reading. A sentence about the app's
 * own state rather than a name it might be about to change its mind on — the
 * one thing it must not print in this moment is a name someone could press.
 */
export const RAIL_UNREAD_LABEL = "Reading automations…";

/** What an unarmed column's default press is called where one is named at all. */
export const RAIL_UNARMED_LABEL = "Nothing armed";

/**
 * Whether a per-invocation override has a Run to spend itself ON.
 *
 * The override picks a Runtime for a menu's DEFAULT press, so it is offered
 * exactly where that press names a record. An unread rail names none yet and
 * an unarmed column names none at all — a "Run on model" that opened onto
 * nothing would be a control that reads as broken rather than as absent.
 */
export function overridePressable(primary: RailRunAction): boolean {
  return primary.kind === "automation";
}

/**
 * One model's per-invocation override rows.
 *
 * `selections` is every whole pair this model can be run at, in the catalog's
 * own order — never a model without a level. A level the wire grammar cannot
 * spell is dropped rather than sent (the composer's own rule, through
 * {@link composerModelSelection}), and a model left with none is not offered:
 * an override that could not be delivered is not a choice.
 */
export interface ModelOverrideRow {
  model: ComposerModel;
  selections: readonly ModelSelection[];
}

/** The nested override menu's rows, out of the models a picker may offer. */
export function modelOverrideRows(models: readonly ComposerModel[]): readonly ModelOverrideRow[] {
  return models.flatMap((model) => {
    const selections = model.reasoningLevels.flatMap((reasoningLevel) => {
      const selection = composerModelSelection({
        providerId: model.providerId,
        modelId: model.modelId,
        reasoningLevel,
      });
      return selection === null ? [] : [selection];
    });
    return selections.length === 0 ? [] : [{ model, selections }];
  });
}

/* ------------------------------------------------- the inspect popover (VC-406) */

/**
 * What a row's Run control is doing, as one value.
 *
 * The rail's press used to BE the Run: a click started work, and the only way
 * to read an Automation's saved instructions before spending a Session on it
 * was to open the Automations page. Revision 05 splits the two — the row opens
 * an anchored inspection, and the Run inside it is an explicit, labelled act —
 * which gives the launch three states worth drawing rather than none.
 */
export type RunLaunchState = "idle" | "pending" | "failed";

/** What the row's right edge says while a launch it started is in flight. */
export const RAIL_PENDING_LABEL = "Starting…";

/**
 * What the explicit Run control says in each state.
 *
 * `Retry Run` rather than `Run` after a failure, because the two are not the
 * same offer: one is a first attempt and the other is a second one on an
 * intent that is still the same intent (`automationRunRetryKey` keeps the
 * durable command id, so a retried lost reply repeats the Run rather than
 * opening a second Session).
 */
export function runLaunchLabel(state: RunLaunchState): string {
  if (state === "pending") return RAIL_PENDING_LABEL;
  return state === "failed" ? "Retry Run" : "Run";
}

/**
 * The ONE thing a row's right edge says: the wait, `Armed`, or the column that
 * offers it.
 *
 * The wait outranks the other two for the duration of a launch, because it is
 * the only one of the three that is about something happening now — and it is
 * the row's own acknowledgment that a press was heard, which is what keeps the
 * inspect popover from having to stay open to prove it.
 */
export function railRowQualifier(row: RailAutomationRow, pending: boolean): string {
  if (pending) return RAIL_PENDING_LABEL;
  return row.armed ? "Armed" : row.columnLabel;
}

/**
 * The inspection's one meta line: how this record would start, in which
 * column, and whether anything besides a person may start it.
 *
 * The words are the ones the row's hover title already carried (VC-406 moved
 * them off the row's face); the popover is where they are read rather than
 * hovered for.
 */
export function automationInspectMeta(row: RailAutomationRow, switchedOff: boolean): string {
  const lead = `${row.armed ? "Armed" : "Manual launch"} · ${row.columnLabel}`;
  return switchedOff ? `${lead} · ${SWITCHED_OFF_NOTE}` : lead;
}

/** One row of the inspection's model control: the saved Runtime, or a whole pair. */
export interface RunModelChoice {
  /** Stable identity for the control's own selection state. */
  id: string;
  label: string;
  /** `null` is the record's own saved Runtime — no override at all. */
  selection: ModelSelection | null;
}

/** The id of the no-override row, so a caller need not spell it. */
export const SAVED_RUNTIME_CHOICE = "saved";

/**
 * The inspection's model control, flattened: the saved Runtime first, then
 * every whole model+level pair a Run could actually name.
 *
 * FLAT rather than the context menu's nested shape, because this control is a
 * single field inside a popover rather than a menu with room to open sideways:
 * a model offering several levels contributes one row per level, and a model
 * offering exactly one contributes its own name alone.
 *
 * EMPTY when the catalog offers nothing (an unreadable catalog, a profile with
 * every model hidden). A control whose only row is "Saved model" is a field
 * with nothing to choose, and the popover drops it rather than drawing one —
 * the same rule the context menu's override already followed.
 */
export function runModelChoices(models: readonly ComposerModel[]): readonly RunModelChoice[] {
  const rows = modelOverrideRows(models);
  if (rows.length === 0) return [];
  return [
    { id: SAVED_RUNTIME_CHOICE, label: "Saved model", selection: null },
    ...rows.flatMap(({ model, selections }) =>
      selections.map((selection) => ({
        id: `${model.id}\u0000${selection.reasoningLevel}`,
        label:
          selections.length === 1 ? model.label : `${model.label} · ${selection.reasoningLevel}`,
        selection,
      })),
    ),
  ];
}
