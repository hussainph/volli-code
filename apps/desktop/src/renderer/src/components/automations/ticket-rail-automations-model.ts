/**
 * What the ticket rail's Automations block OFFERS (VC-129), kept pure beside
 * the view that draws it — the same shape as `automations-page-model.ts` next
 * door, and in the coverage gate for the same reason: every decision here is
 * one a static view test would not catch going wrong.
 *
 * Four of them earn the module:
 *
 *  - **The default press follows the COLUMN.** A split button whose press is
 *    whatever this Ticket's current column has armed is a rule about two
 *    records neither of which is the button (VC-112, "Board interaction"), and
 *    an arming row naming a deleted or no-longer-offered Automation is inert.
 *    Both facts live in `@volli/shared`; this module is where the rail asks.
 *  - **The button is never dead and never hidden.** A column with nothing
 *    armed, and a project with no Automations at all, both still press: the
 *    press becomes **Run once**, which needs no record to exist. Hidden-when-
 *    empty is how a feature never gets discovered, so the empty case is a
 *    sentence and a door to the page rather than an absent control.
 *  - **An UNREAD rail presses nothing.** "Nothing armed here" and "nobody has
 *    asked yet" are one value in the caches this reads (VC-112 makes arming
 *    machine-local, and every slice rests empty), and the difference decides
 *    what a click does: a Ticket whose column IS armed would otherwise offer a
 *    clickable **Run once** for the frame before its reads land, and a cache
 *    left over from before someone re-armed the column elsewhere would run the
 *    Automation it USED to arm. So an unread rail says so and starts nothing
 *    bound — the same refusal to decide from an empty cache the board's own
 *    arrival makes (`armed-run.ts`), spent here on a press rather than on a
 *    drop. Only **Run once** survives it, because it names no record at all.
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
  UNBOUND_RUN_LABEL,
  type Automation,
  type ColumnArming,
  type ColumnAutomationOrder,
  type ModelSelection,
  type TicketStatus,
} from "@volli/shared";

import { composerModelSelection } from "@renderer/components/chat/chat-plane-model";
import type { ComposerModel } from "@renderer/components/chat/composer-ui";

/**
 * What one press of the rail's control starts.
 *
 * `run-once` carries no Instructions: it is the ANSWER "open the Run once
 * form", not the Run itself. An Unbound Run has to be typed before it can
 * start, and a shape that could hold half-typed Instructions here would be a
 * second draft of the dialog's own state.
 */
export type RailRunAction =
  | { kind: "automation"; automation: Automation }
  | { kind: "run-once" }
  /** Nothing has been read yet, so nothing may be pressed yet. */
  | { kind: "unread" };

export interface TicketRailAutomations {
  /** The split button's default press. */
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
    primary: armed === null ? { kind: "run-once" } : { kind: "automation", automation: armed },
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

/** What the control's default half is labelled — the Automation's name, "Run once", or the wait. */
export function railRunLabel(action: RailRunAction): string {
  if (action.kind === "automation") return action.automation.name;
  return action.kind === "unread" ? RAIL_UNREAD_LABEL : UNBOUND_RUN_LABEL;
}

/**
 * What the control says while it is still reading. A sentence about the app's
 * own state rather than a name it might be about to change its mind on — the
 * one thing it must not print in this moment is a name someone could press.
 */
export const RAIL_UNREAD_LABEL = "Reading automations…";

/**
 * Whether a per-invocation override has a Run to spend itself ON.
 *
 * The override picks a Runtime for THIS menu's default press, so it is offered
 * exactly where that press exists: an Automation to run, or a Run once form to
 * open holding the pick. An unread rail has neither yet, and a surface with no
 * Run once form (the board card) has none where the column arms nothing — a
 * "Run on model" that opened onto nothing would be a control that reads as
 * broken rather than as absent.
 */
export function overridePressable(primary: RailRunAction, canRunOnce: boolean): boolean {
  if (primary.kind === "automation") return true;
  return primary.kind === "run-once" && canRunOnce;
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
