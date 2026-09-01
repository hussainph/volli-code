/**
 * What the Automations page SAYS, kept pure beside the views that render it
 * (VC-127) — the same shape as `cli-status-model.ts` and its neighbours, and
 * in the coverage gate for the same reason: every decision here is one a view
 * test would not catch going wrong.
 *
 * Three of them earn the module on their own:
 *
 *  - **A Run prints the evidence it stored, never today's catalogue.** VC-112
 *    requires a Run to record the RESOLVED model and reasoning, precisely so
 *    the pin/inherit decision is self-correcting. Re-labelling a historical
 *    Run through the live Model Access snapshot would erase exactly that: a
 *    Run of a model this profile no longer has must still print the model it
 *    actually ran.
 *  - **Inherit is a sentence, not a blank.** An Automation with no pin is the
 *    default and the common case; showing an empty cell where the pinned rows
 *    show a model would read as missing data.
 *  - **A corrupt Runtime says so.** `InvalidAutomationRuntime` exists because
 *    a malformed row must not be silently re-read as inheritance; the page is
 *    where a person can see that and re-pin.
 */
import {
  automationOwnership,
  automationTriggerColumns,
  automationTriggerSchedule,
  columnRankAfterLaneDrop,
  isAutomationRuntimePin,
  isTicketStatus,
  scheduleSentence,
  TICKET_STATUS_LABELS,
  UNBOUND_RUN_LABEL,
} from "@volli/shared";
import type {
  Automation,
  AutomationRun,
  AutomationRuntime,
  AutomationSkippedOccurrence,
  AutomationTrigger,
  TicketStatus,
} from "@volli/shared";

/**
 * The Trigger every new Automation opens on, and the only one the record can
 * hold today (VC-112: "Nothing else — the default for a new Automation, and a
 * complete answer rather than an inert one").
 *
 * A named constant rather than a literal in the editor because it is one half
 * of a control that is about to grow: the column Trigger (VC-128) and the
 * schedule (VC-130) add answers BESIDE this one. Running by hand is universal
 * and is therefore never one of the answers — the Trigger says only what
 * *else* starts an Automation.
 */
export const MANUAL_TRIGGER_LABEL = "Only when I run it";

/**
 * What a switched-off Automation says where it is OFFERED in a menu row — the
 * column bolt's list (VC-128) and the ticket rail's own (VC-129).
 *
 * The Automations page states the same fact in a whole sentence under the name
 * ("Won't start on its own"), because a page row has a line to spend on it. A
 * menu row does not: the note rides beside the name in a 224px popover, so the
 * two words that fit are the two that get printed. What must not vary is the
 * PRESENTATION rule they both follow — an Automation that is off is still
 * listed, still offered and still runnable by hand (VC-112), so it is never
 * dimmed, never hidden, and never silently missing from a menu.
 */
export const SWITCHED_OFF_NOTE = "Switched off";

/**
 * The Trigger, in one line: what starts this Automation BESIDES a person.
 *
 * A row that named its own Trigger "Only when I run it" while the record said
 * "Ticket enters Doing" would be a page lying about the field it exists to
 * author, so the label is derived from the record rather than assumed — the
 * manual sentence is what a Trigger naming no column says, not what every row
 * says.
 *
 * The columns come out of the shared accessor, so they arrive in board order
 * with unknown names already dropped, and they are printed with the board's own
 * labels: a row saying "Needs Review" and a column header saying the same thing
 * are the same fact, and two spellings of it would read as two.
 *
 * It deliberately does not say whether any of those columns is ARMED. Arming is
 * the column's own choice and lives on the board's bolt; a record listed in
 * every project cannot have one answer to it (VC-128).
 */
export function triggerLabel(trigger: AutomationTrigger): string {
  // A schedule prints its whole sentence, ZONE INCLUDED. VC-112 requires the
  // stored zone to be shown always, and this row is where "always" is most
  // easily lost: a reader who cannot see the zone cannot tell whether 21:00 is
  // theirs, and travelling is exactly when that matters.
  const schedule = automationTriggerSchedule(trigger);
  if (schedule !== null) return scheduleSentence(schedule);
  const columns = automationTriggerColumns(trigger);
  if (columns.length === 0) return MANUAL_TRIGGER_LABEL;
  // The same verb the editor's second choice uses, finished by the columns —
  // one sentence across the two surfaces rather than a label and a paraphrase.
  return `Ticket enters ${columns.map((status) => TICKET_STATUS_LABELS[status]).join(", ")}`;
}

/**
 * The Instructions placeholder. It names the grammar rather than describing
 * it, and it leads with `/skill` on purpose: VC-112 asks for a placeholder
 * that "pushes toward `/skill` rather than prose", because the reusable half
 * of an Automation belongs in git as a Skill, where it is reviewed in a pull
 * request and travels between machines on its own.
 */
export const INSTRUCTIONS_PLACEHOLDER = "/skill … — or @ a file. Keep the prose in the Skill.";

/** Where an Automation is listed. The two words the Ownership control uses. */
export function ownershipLabel(automation: Pick<Automation, "projectId">): string {
  return automationOwnership(automation) === "global" ? "All projects" : "This project";
}

/**
 * A model and its reasoning level, in one line — the one spelling of the pair.
 *
 * Model and reasoning travel together (VC-112), so they are printed together
 * or not at all: there is deliberately no spelling of this that shows one
 * without the other, because a type that could would be a type that can name a
 * pair no model offers. One formatter rather than one per caller, so a pinned
 * Runtime and the Run it produced cannot drift into two typographies of the
 * same fact.
 */
function modelPairLabel(pair: { modelId: string; reasoningLevel: string }): string {
  return `${pair.modelId} · ${pair.reasoningLevel}`;
}

/** The Runtime, in one line: the inherited default, a pin, or a corrupt row saying so. */
export function runtimeLabel(runtime: AutomationRuntime): string {
  if (runtime === null) return "Default model";
  if (!isAutomationRuntimePin(runtime)) return "Unreadable runtime";
  return modelPairLabel(runtime);
}

/**
 * A Run's resolved model and reasoning, printed from the Run's own row.
 *
 * Never resolved against the live catalogue: this is what the Session was
 * born with, and a level a current build no longer recognizes still prints
 * exactly as recorded rather than as today's default.
 */
export function runModelLabel(run: Pick<AutomationRun, "model">): string {
  return modelPairLabel(run.model);
}

/** The provider behind that model, for the row's title attribute. */
export function runModelTitle(run: Pick<AutomationRun, "model">): string {
  return `${run.model.providerId} / ${modelPairLabel(run.model)}`;
}

/**
 * What a Run row names as its Automation. A bound Run keeps the name it was
 * launched under even after the record is deleted — deleting an Automation
 * deletes the record, and the history of what it did is not the record.
 */
export function runAutomationLabel(
  run: Pick<AutomationRun, "automationId" | "automationName">,
): string {
  return run.automationName ?? UNBOUND_RUN_LABEL;
}

/**
 * One project's Automations, split by Ownership with its own first.
 *
 * The order main already returns (own, then global, name-ordered within each)
 * is preserved rather than re-sorted: two orderings of one list is two
 * policies wearing one name, and main's is the one the palette also shows.
 */
export function groupByOwnership(automations: readonly Automation[]): {
  project: Automation[];
  global: Automation[];
} {
  return {
    project: automations.filter((automation) => automation.projectId !== null),
    global: automations.filter((automation) => automation.projectId === null),
  };
}

/**
 * The name a Duplicate lands under.
 *
 * Duplicate exists so "same work, different Trigger" is one click rather than
 * copy and paste (VC-112's tripwire), which means the copy has to be
 * *distinguishable at a glance* from its source — two rows reading "Review
 * sweep" would make the feature worse than the copy-and-paste it replaces.
 * Suffix rather than prefix so the copy sorts beside its original, and the
 * counter starts at 2 because the first copy is simply "(copy)".
 *
 * `taken` is every name already listed under this project, so duplicating the
 * duplicate does not collide either.
 */
export function duplicateName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const base = `${name} (copy)`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} (copy ${n})`;
    if (!used.has(candidate)) return candidate;
  }
}

/* ------------------------------------------------- the lane view (VC-132) */

/**
 * One lane row's drag identity: the column AND the Automation.
 *
 * Composite because one Automation can be offered in two columns and hold a
 * different rank in each — two rows, one record — and dnd-kit needs one id per
 * draggable in a context. It is also what tells a drop which lane it happened
 * in without the view having to remember.
 */
export function laneRowId(status: TicketStatus, automationId: string): string {
  return `${status}:${automationId}`;
}

/** The lane and the Automation behind a {@link laneRowId}, or `null` for anything else. */
export function parseLaneRowId(id: string): { status: TicketStatus; automationId: string } | null {
  const separator = id.indexOf(":");
  if (separator === -1) return null;
  const status = id.slice(0, separator);
  const automationId = id.slice(separator + 1);
  if (!isTicketStatus(status) || automationId.length === 0) return null;
  return { status, automationId };
}

/**
 * What a lane drop asks the record to store, or `null` for a drop that asks
 * for nothing.
 *
 * Three drops ask for nothing, and each is a rule rather than an edge case:
 *
 *  - **A drop on nothing** (`overId` null — the pointer left the lanes) is a
 *    cancelled gesture.
 *  - **A drop into ANOTHER lane.** A lane's membership is the Automation's
 *    Trigger, which is authored in the editor; dragging a row between lanes
 *    would silently rewrite a field of the record from a surface that is
 *    arranging digits. Rank is what a lane owns.
 *  - **A drop on its own slot**, which changes no order at all.
 *
 * `visibleIds` is what the lane DRAWS as draggable, in drawn order: the armed
 * row pinned to slot 1 is not among them, and neither is anything ranked past
 * the digit cap. {@link columnRankAfterLaneDrop} is what puts the moved rows
 * back into the authored list without disturbing either.
 */
export function laneDropRank(input: {
  authoredIds: readonly string[];
  visibleIds: readonly string[];
  activeId: string;
  overId: string | null;
}): { status: TicketStatus; rankedAutomationIds: readonly string[] } | null {
  const active = parseLaneRowId(input.activeId);
  const over = input.overId === null ? null : parseLaneRowId(input.overId);
  if (active === null || over === null || over.status !== active.status) return null;
  const from = input.visibleIds.indexOf(active.automationId);
  const to = input.visibleIds.indexOf(over.automationId);
  if (from === -1 || to === -1 || from === to) return null;
  const reordered = [...input.visibleIds];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved as string);
  return {
    status: active.status,
    rankedAutomationIds: columnRankAfterLaneDrop(input.authoredIds, reordered),
  };
}

/**
 * Every Run is a door back to its Session, including one whose Ticket is gone.
 *
 * There is deliberately no predicate here saying otherwise. `automation_runs`
 * orphans `ticket_id` exactly as `sessions.ticket_id` does, and a project's
 * history is scoped through the Run's Session rather than through a live
 * Ticket — so a Run outlives its Ticket, keeps its row, and still opens the
 * Session it started. Where that Session opens is `run-automation.ts`'s
 * `openRunSession`: the ticket workspace when there is a Ticket, and Home —
 * the project's own place for a Session that belongs to no Ticket — when there
 * is not. The same is true of a Run that never named one (VC-130).
 */

/**
 * What a by-hand Run from a listing surface is aimed at — VC-112's second scope
 * axis, decided by the Trigger.
 *
 * The rule it encodes is the ticket's own: a schedule Run's Target is the
 * Project, so it opens a Project Session. Pressing Play on a scheduled record
 * therefore runs the Project rather than asking which Ticket — anything else
 * would make the by-hand Run a different piece of work from the one the
 * schedule starts, on the surface a person uses to check what the schedule
 * does. Every other Trigger names a Ticket and the page asks for one.
 *
 * A pure function beside the page for the gate's sake: this is the only place
 * the Target is chosen in the renderer, and choosing it wrong is a Session
 * opened at the wrong scope with nothing on screen to say so.
 */
export function listingRunTarget(automation: Pick<Automation, "trigger">): "project" | "ticket" {
  return automationTriggerSchedule(automation.trigger) === null ? "ticket" : "project";
}

/* --------------------------------- Skipped occurrences (VC-130) ----------- */

/**
 * One row of the Run history: something that ran, or a due time that did not.
 *
 * They share the history because they are the same story told in order — what
 * this project's Automations have been doing — and VC-112 requires a skip to be
 * startable "from the Run history". They stay two KINDS because they are two
 * records with two actions: a Run opens the Session it made, a skip offers to
 * start the one it did not. Flattening them into one row shape would need a
 * null Session id, which is how a skip quietly starts looking like a broken Run.
 */
export type AutomationHistoryEntry =
  | { kind: "run"; at: number; run: AutomationRun }
  | { kind: "skip"; at: number; skip: AutomationSkippedOccurrence };

/**
 * The project's Runs and Skipped occurrences in one list, newest first.
 *
 * A skip is filed at its DUE time rather than at the moment it was recorded,
 * and that is the whole reason this is a function rather than two lists
 * rendered one after the other: an app opened on Monday records Friday's miss
 * on Monday, and a history that filed it under Monday would sit it above Runs
 * that really did happen in between. What the reader wants to place is when the
 * work was supposed to happen.
 */
export function automationHistory(
  runs: readonly AutomationRun[],
  skips: readonly AutomationSkippedOccurrence[],
): AutomationHistoryEntry[] {
  const entries: AutomationHistoryEntry[] = [
    ...runs.map((run) => ({ kind: "run" as const, at: run.createdAt, run })),
    ...skips.map((skip) => ({ kind: "skip" as const, at: skip.dueAt, skip })),
  ];
  return entries.toSorted((left, right) => right.at - left.at);
}

/**
 * What a Skipped occurrence says it is — the sentence that keeps a skip from
 * looking like a silence (VC-112).
 *
 * Every arm leads with the word "Skipped", including the one whose stored
 * reason this build cannot read: the CAUSE may be unknown, but the fact that
 * something did not run is exactly what must never be quiet.
 */
export function skipReasonLabel(skip: Pick<AutomationSkippedOccurrence, "reason">): string {
  switch (skip.reason.kind) {
    case "app-closed":
      return "Skipped — Volli wasn’t running";
    // Said as what was observed rather than as a cause: the app WAS running and
    // still did not reach the due time — a sleeping machine, a busy one, a
    // suspended process. Printing "Volli wasn't running" here would be a
    // sentence the reader could disprove.
    case "not-observed":
      return "Skipped — Volli didn’t wake in time";
    case "run-refused":
      return `Skipped — ${skip.reason.error}`;
    case "unknown":
      return "Skipped — reason unreadable";
  }
}

/**
 * How many occurrences one skip row stands for, when it stands for more than
 * one.
 *
 * Empty for the ordinary single miss, because "1 occurrence" is noise beside a
 * row that already says "Skipped". A weekend of an hourly schedule is one row
 * saying it stood for fifty — the honest number, and the reason "Run now"
 * starts ONE Run rather than fifty (VC-112: never replayed).
 */
export function skipCountLabel(skip: Pick<AutomationSkippedOccurrence, "missedCount">): string {
  return skip.missedCount > 1 ? `${skip.missedCount} occurrences` : "";
}
