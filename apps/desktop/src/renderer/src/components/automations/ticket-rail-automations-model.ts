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
  UNBOUND_RUN_LABEL,
  type Automation,
  type ColumnArming,
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
  /** This column's Offered list, armed one first — the caret menu's rows. */
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

/** What this Ticket's rail offers, given its project's records and its own column. */
export function ticketRailAutomations(input: {
  automations: readonly Automation[];
  armings: readonly ColumnArming[];
  status: TicketStatus;
  /** Whether the reads behind `automations`/`armings` have landed for this rail. */
  ready: boolean;
}): TicketRailAutomations {
  if (!input.ready)
    return { primary: { kind: "unread" }, offered: [], listsAny: false, ready: false };
  const armed = armedAutomationFor(input.automations, input.armings, input.status);
  return {
    primary: armed === null ? { kind: "run-once" } : { kind: "automation", automation: armed },
    offered: offeredAutomationsForColumn(input.automations, input.status, armed?.id ?? null),
    listsAny: input.automations.length > 0,
    ready: true,
  };
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
