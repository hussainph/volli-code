/**
 * Automations V1 (VC-112, tracer VC-126): the record's domain vocabulary.
 *
 * An Automation is a saved, named way of starting work — its Trigger, its
 * Instructions and its Runtime. One Run opens one fresh chat Session; the Run
 * row remembers which Automation and which *resolved* model and reasoning
 * produced that Session.
 *
 * VC-128 adds the column Trigger and the column's own Arming beside it. They
 * are deliberately two different things and this file is where the difference
 * is stated once: a Trigger is a property of the *record* (which columns this
 * Automation is offered in), while Arming is a property of the *column*
 * (which single offered Automation that column fires on its own).
 *
 * Pure and shared on purpose, like `model-access-policy.ts` beside it: main
 * stores these records and validates writes; the renderer's editor reads the
 * same words, so a rule that existed in only one process would be two
 * policies wearing one name. Transport stays out — the Electron channel
 * catalog is desktop-owned (docs/BOUNDARIES.md), so nothing here names IPC.
 */

import type { ModelAccessSnapshot, ModelSelection } from "./agent-runtime";
import { parseAutomationSchedule, type AutomationSchedule } from "./automation-schedule";
import { isTicketStatus, TICKET_STATUSES, type TicketStatus } from "./ticket";

/**
 * Where an Automation is listed: every project, or exactly one (VC-112,
 * "Scope — two axes"). Ownership decides listing only; the Target of a Run is
 * the Ticket it is invoked on, never a property of the Automation record.
 */
export type AutomationOwnership = "global" | "project";

/**
 * A stored Runtime that is not an inheriting SQL NULL and is not a valid
 * current ModelSelection. This is a durable-corruption/future-version state,
 * not another spelling of inherit: treating it as `null` silently changes the
 * execution policy of a saved Automation. `raw` is preserved exactly so a
 * repair/export path can report what the row actually said.
 */
export interface InvalidAutomationRuntime {
  kind: "invalid";
  raw: unknown;
}

/** The saved Runtime is inheritance, a valid pin, or an explicit invalid row. */
export type AutomationRuntime = ModelSelection | InvalidAutomationRuntime | null;

/** Whether a Runtime is the valid whole model-and-reasoning pin a Run may use. */
export function isAutomationRuntimePin(runtime: AutomationRuntime): runtime is ModelSelection {
  return runtime !== null && !("kind" in runtime);
}

/**
 * What starts an Automation besides a person (VC-112, "Triggers").
 *
 * `none` is the default for a new Automation and a complete answer rather than
 * an inert one — run by hand is universal, so the Trigger says only what *else*
 * starts it. `columns` is VC-128's arm: a Ticket entering one of the named
 * columns. `schedule` is VC-130's: a due time in a stored IANA zone. Widening a
 * union is append-only, which is why the Trigger was spelled as one from the
 * start — the schedule arm is a third member here and a migration nowhere.
 *
 * VC-112 rules one Trigger per Automation, so this is a single value and never
 * a list. The columns *inside* a column Trigger are plural because "the same
 * work in Doing and in Needs Review" is one Automation, not two.
 *
 * The Trigger also decides the TARGET of the Run it starts, which is why the
 * two arms are not interchangeable: a column Trigger names a Ticket, so its Run
 * opens a Ticket Session; a schedule names the Project, so its Run opens a
 * Project Session (VC-112, "Scope — two axes").
 */
export type AutomationTrigger =
  | { kind: "none" }
  | { kind: "columns"; columns: readonly TicketStatus[] }
  | { kind: "schedule"; schedule: AutomationSchedule };

/** The Trigger a new Automation gets, and the one an unreadable stored value degrades to. */
export const NO_AUTOMATION_TRIGGER: AutomationTrigger = { kind: "none" };

/**
 * Reads a stored/transported Trigger, degrading anything unreadable to "Nothing
 * else".
 *
 * Deliberately the OPPOSITE stance to {@link AutomationRuntime}, and for a
 * reason worth stating: an unreadable Runtime must not become `null`, because
 * `null` still RUNS — it would silently change an Automation's execution policy
 * and then start a Session under it. An unreadable Trigger degrading to `none`
 * only ever *stops* something from starting on its own, and every Automation
 * remains runnable by hand. Failing toward "fires nothing" is the only safe
 * direction for a value that decides when work begins without a person.
 *
 * Duplicates and unknown column names are dropped, and the result is ordered by
 * {@link TICKET_STATUSES} so board order is the record's order too.
 */
export function parseAutomationTrigger(raw: unknown): AutomationTrigger {
  if (typeof raw !== "object" || raw === null) return NO_AUTOMATION_TRIGGER;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "schedule") {
    // Same stance as the columns below, and it matters more here: an
    // unreadable schedule — a zone this build's ICU does not know, an hour
    // outside the clock — must not be repaired into a time nobody chose, since
    // the repair would start unattended work. `null` from the parser means
    // this Automation simply fires nothing until someone re-authors it.
    const schedule = parseAutomationSchedule((raw as { schedule?: unknown }).schedule);
    return schedule === null ? NO_AUTOMATION_TRIGGER : { kind: "schedule", schedule };
  }
  if (kind !== "columns") return NO_AUTOMATION_TRIGGER;
  const columns = (raw as { columns?: unknown }).columns;
  if (!Array.isArray(columns)) return NO_AUTOMATION_TRIGGER;
  const named = TICKET_STATUSES.filter((status) =>
    columns.some((candidate) => isTicketStatus(candidate) && candidate === status),
  );
  // A column Trigger naming nothing is not a column Trigger. Collapsing it here
  // means no surface has to spell "columns, but empty" as a third state.
  return named.length === 0 ? NO_AUTOMATION_TRIGGER : { kind: "columns", columns: named };
}

/** The columns a Trigger names, in board order — empty for every non-column Trigger. */
export function automationTriggerColumns(trigger: AutomationTrigger): readonly TicketStatus[] {
  return trigger.kind === "columns" ? trigger.columns : [];
}

/** The schedule a Trigger carries, or `null` for every non-schedule Trigger. */
export function automationTriggerSchedule(trigger: AutomationTrigger): AutomationSchedule | null {
  return trigger.kind === "schedule" ? trigger.schedule : null;
}

/** Whether this Automation is offered in `status` — i.e. its Trigger names that column. */
export function automationTriggersColumn(
  automation: Pick<Automation, "trigger">,
  status: TicketStatus,
): boolean {
  return automationTriggerColumns(automation.trigger).includes(status);
}

/**
 * The saved record. `id` is a UUID — never a local counter, never anything
 * machine-derived (docs/BOUNDARIES.md standing rule 1): when the record moves
 * from local SQLite to an account, that is a database migration, not a format
 * change, and only portable ids keep that sentence true.
 */
export interface Automation {
  id: string;
  /** `null` is global Ownership; a project id scopes it to that project's surfaces. */
  projectId: string | null;
  name: string;
  /**
   * The prompt this Automation sends when it opens its Session: prose plus
   * the chat composer's own grammar — `/` for prompt templates and Skills,
   * `@` for file references — resolved at launch exactly as the composer
   * resolves them at send. Nothing is ever appended: the Runtime Brief
   * already carries the Ticket's context.
   */
  instructions: string;
  /**
   * What starts this Automation besides a person. A column Trigger makes it
   * *offered* in the columns it names; whether any of those columns actually
   * fires it on arrival is that column's own Arming, not this field.
   */
  trigger: AutomationTrigger;
  /**
   * The Runtime: one pinned model-and-reasoning selection, or `null` to
   * inherit through the project's runtime preferences and then the global
   * record. The two halves travel together by construction — a reasoning
   * level is a property of the model that offers it, so a type that could pin
   * one without the other could spell a pair that does not exist.
   */
  runtime: AutomationRuntime;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** The listing axis, stated once so no surface derives it from `projectId` ad hoc. */
export function automationOwnership(
  automation: Pick<Automation, "projectId">,
): AutomationOwnership {
  return automation.projectId === null ? "global" : "project";
}

/**
 * One invocation of an Automation against one Ticket, and the durable record
 * of which Automation and which *resolved* model and reasoning produced a
 * given Session. `id` is a UUID for the same standing rule as the Automation's.
 */
export interface AutomationRun {
  id: string;
  /**
   * The Automation that produced this Run. A bound Run keeps this reference
   * after that Automation is deleted; `null` is reserved for an Unbound Run.
   */
  automationId: string | null;
  /** The bound Automation's name at launch, retained after record deletion. */
  automationName: string | null;
  /**
   * The Ticket the Run was invoked on, or `null` when it named none.
   *
   * Two different facts share this one `null`, and they are the same fact from
   * the Session's point of view — `ticketId !== null` IS the Role a Session was
   * born under (`main/session-runtime/sessions.ts`). A Ticket deleted after the
   * Run orphans the reference rather than erasing the provenance of a Session
   * that still exists; a schedule Run (VC-130) never had one, because its
   * Target is the Project. One nullable field, one rule, and the Run history
   * files both through the Session's own project.
   */
  ticketId: string | null;
  sessionId: string;
  /**
   * The model policy the Session was actually born with — the resolved
   * values, never the reference. Free at launch, impossible to reconstruct
   * later, and what makes the pin/inherit decision self-correcting.
   */
  model: ResolvedAutomationModel;
  /** Epoch milliseconds. */
  createdAt: number;
}

/**
 * The values a Run resolved at launch. Unlike a live `ModelSelection`,
 * `reasoningLevel` remains a string: a later build that no longer recognizes a
 * historical provider level must display the exact fact it recorded rather
 * than rewriting it to a current default.
 */
export interface ResolvedAutomationModel {
  providerId: string;
  modelId: string;
  reasoningLevel: string;
}

/** A durable acknowledgement that a command reached the Automation core. */
export interface AutomationCommandReceipt {
  /** UUID minted by the core, never a local counter. */
  id: string;
  /** UUID supplied by the caller and used to replay a retried command safely. */
  commandId: string;
  status: "accepted" | "completed" | "rejected";
  /** Epoch milliseconds. */
  recordedAt: number;
}

/**
 * Why a Run request was refused, as vocabulary rather than prose: transports
 * carry a code beside the sentence so surfaces classify without string
 * matching. `MODEL_REQUIRED` and `MODEL_UNAVAILABLE` are the Session start's
 * own refusals passing through — the existing error path, never a new one.
 */
export type AutomationRunRefusalCode =
  | "AUTOMATION_NOT_FOUND"
  | "AUTOMATION_NOT_IN_PROJECT"
  | "TICKET_NOT_FOUND"
  /** A Run that names the Project as its Target, and no such project (VC-130). */
  | "PROJECT_NOT_FOUND"
  | "RUN_IN_FLIGHT"
  | "MODEL_REQUIRED"
  | "MODEL_UNAVAILABLE"
  | "RUN_FAILED";

/** What a save must carry. Everything else on {@link Automation} is minted by the store. */
export interface AutomationDraft {
  name: string;
  instructions: string;
  trigger: AutomationTrigger;
  runtime: ModelSelection | null;
}

/**
 * Why a draft cannot be saved, or `null` when it can. One rule per field and
 * both stated here so the editor's disabled Save and main's write refusal are
 * one policy: a nameless Automation cannot be listed, run, or spoken about,
 * and empty Instructions would open a Session with nothing to say — the
 * message layer already refuses blank text, so the save refuses first.
 */
export function automationDraftProblem(draft: {
  name: string;
  instructions: string;
}): string | null {
  if (draft.name.trim().length === 0) return "Name this Automation before saving it.";
  if (draft.instructions.trim().length === 0) {
    return "Write Instructions before saving — a Run delivers them as its Session's first message.";
  }
  return null;
}

/**
 * Why a Runtime pin cannot be stored, or `null` when it can.
 *
 * Validated when the pin is SET, against that model's own reasoning levels
 * (`ModelAccessModel.reasoningLevels`), so an unspellable pair never reaches
 * the record. Availability is checked at the same moment for the reason the
 * app default checks it (`assertDefaultModelAvailable`): signed-out is a
 * state to recover from before saving, not a choice to honour. A pin that
 * *later* becomes unavailable is deliberately not this function's business —
 * the Run fails through the Session start's existing error path rather than
 * silently falling back.
 */
export function automationPinProblem(
  access: ModelAccessSnapshot,
  pin: ModelSelection,
): string | null {
  const model = access.models.find(
    (candidate) => candidate.providerId === pin.providerId && candidate.modelId === pin.modelId,
  );
  if (model === undefined || model.state === "unavailable") {
    return "This model is not currently available.";
  }
  if (model.state === "authentication-required") {
    return "Sign in to this provider before pinning this model.";
  }
  if (!model.reasoningLevels.includes(pin.reasoningLevel)) {
    return `This model does not support reasoning level "${pin.reasoningLevel}" (valid: ${model.reasoningLevels.join(", ")}).`;
  }
  return null;
}

/**
 * Why a schedule cannot be saved on THIS record, or `null` when it can.
 *
 * One rule, and it is a consequence of VC-112 rather than a new constraint: a
 * schedule Run's Target is the Project, so the schedule has to name which
 * Project it runs in. A global Automation is *listed* in every project and
 * belongs to none of them, so a schedule on one could only mean "fire in every
 * project" — which is a backlog of Runs on every launch, the exact thing
 * VC-130 forbids — or nothing at all, which is a switch that silently does
 * nothing. Neither is a product.
 *
 * Stated here so the editor's blocked Save and main's write refusal are one
 * policy rather than two that drift. Ownership is identity on update
 * (`updateAutomation` takes no `projectId`), so on an existing global record
 * this is a refusal rather than something the form can fix — which is why the
 * sentence names the way out: duplicate it into a project.
 */
export function automationScheduleProblem(draft: {
  projectId: string | null;
  trigger: AutomationTrigger;
}): string | null {
  if (draft.trigger.kind !== "schedule" || draft.projectId !== null) return null;
  return "A schedule runs in one project, so it can't be set on an Automation listed in all projects. Duplicate it into this project first.";
}

/* -------------------------------- skipped occurrences (VC-130) ------------ */

/**
 * Why a due time went by without anyone watching it — the two answers the
 * scheduler's pure policy can reach on its own.
 *
 * They are split from the rest of {@link AutomationSkipReason} because they are
 * derived rather than observed, and each is a CLAIM ABOUT THIS PROCESS that
 * must be true:
 *
 *  - `app-closed` — the due time is older than the moment this host started
 *    watching, so nothing here could have started it. The ordinary case, and
 *    the one VC-130 names.
 *  - `not-observed` — the app was running and still did not reach the due time
 *    in the grace window: a laptop asleep at 21:00, a machine too busy to run
 *    a timer, a process suspended by the OS. Its own answer rather than
 *    `app-closed`, because "Volli wasn't running" would be false, and a
 *    history that says a false thing about why work did not happen is worse
 *    than one that says a vague true thing.
 */
export type AutomationMissedReason = { kind: "app-closed" } | { kind: "not-observed" };

/**
 * Why a due time passed without a Run.
 *
 * A closed union rather than prose, for the reason every other refusal in this
 * file is vocabulary: a surface classifies without matching strings. The two
 * unobserved answers above, plus the one the host observed and the one every
 * tolerant reader needs:
 *
 *  - `run-refused` — the scheduler was awake and asked, and the Run door said
 *    no (no default model, an earlier Run still working). Recorded because
 *    VC-112's rule is that a skip and a silence must never look the same, and
 *    a refusal that only reached a log would be a silence.
 *  - `unknown` — a stored reason THIS build cannot read. It still reads as a
 *    skip, which is the half that matters; inventing `app-closed` for it would
 *    be asserting a cause we do not know.
 *
 * `code` stays a bare string on purpose, exactly as a Run's recorded
 * `reasoningLevel` does: it is historical evidence, and a build that no longer
 * knows a refusal code must print what happened rather than rewrite it.
 */
export type AutomationSkipReason =
  | AutomationMissedReason
  | { kind: "run-refused"; code: string; error: string }
  | { kind: "unknown" };

/**
 * A due time that passed without a Run, recorded (VC-112, "Skipped
 * occurrence").
 *
 * It is a RECORD rather than a log line for one reason: VC-112 requires a
 * skip to offer "Run now" from the Run history afterwards, so it has to be
 * something a surface can list, name and act on. It snapshots the Automation's
 * name for the same reason a Run does — the history outlives the record.
 *
 * `id` is a UUID (docs/BOUNDARIES.md standing rule 1).
 */
export interface AutomationSkippedOccurrence {
  id: string;
  automationId: string;
  /** The bound Automation's name when the skip was recorded. */
  automationName: string;
  /** The project the schedule would have run in — a schedule Run's Target. */
  projectId: string;
  /**
   * The LATEST due time this skip covers, in epoch milliseconds.
   *
   * One row per gap rather than one per occurrence, and `missedCount` says how
   * wide the gap was. An app closed over a weekend owes an hourly schedule
   * around fifty rows under the other spelling, which would bury the Run
   * history it is filed in — and every one of those rows would offer a "Run
   * now" that must not be pressed fifty times, since replaying is precisely
   * what VC-112 forbids.
   */
  dueAt: number;
  /** How many occurrences the gap covered; 1 in the ordinary case. */
  missedCount: number;
  reason: AutomationSkipReason;
  /** Epoch milliseconds. */
  recordedAt: number;
}

/** A stored/transported skip reason, read in today's vocabulary. */
export function parseAutomationSkipReason(raw: unknown): AutomationSkipReason {
  if (typeof raw !== "object" || raw === null) return { kind: "unknown" };
  const record = raw as Record<string, unknown>;
  if (record["kind"] === "app-closed") return { kind: "app-closed" };
  if (record["kind"] === "not-observed") return { kind: "not-observed" };
  if (record["kind"] !== "run-refused") return { kind: "unknown" };
  const code = record["code"];
  const error = record["error"];
  if (typeof code !== "string" || typeof error !== "string") return { kind: "unknown" };
  return { kind: "run-refused", code, error };
}

/* ------------------------------------------------- arming (VC-128) -------- */

/**
 * One column's Arming: the single Automation it fires on its own when a Ticket
 * arrives there by Deliberate move.
 *
 * Arming is a property of the COLUMN, not of the Automation, which is why this
 * is its own record keyed by `(projectId, status)` rather than a flag on
 * {@link Automation}: one Automation may be armed in one column and merely
 * offered in another, and neither column's choice is visible in the record they
 * both point at.
 *
 * It is machine-local by construction: it is the choice ONE machine made about
 * one column, so it is absent from git, from a project directory, and from the
 * record VC-112 says will one day move to an account — a new machine sees the
 * Automations and fires nothing until someone turns something on there.
 *
 * Machine-local names where the ANSWER lives, not how it is written. Arming a
 * column is user intent that decides whether work starts without a person, so
 * the write is an ordinary durable command with an event and a receipt (the
 * host's `automation.set-arming`); only this projection stays local. The same
 * split governs an Automation's enabled set, and the two switches are
 * deliberately one pattern.
 */
export interface ColumnArming {
  projectId: string;
  status: TicketStatus;
  automationId: string;
  /**
   * Epoch milliseconds. Evidence of when this column was armed, and the reason
   * arming can be shown as an act rather than a static flag. It is NOT consulted
   * to decide whether a Run starts: arming is not retroactive because the only
   * thing that ever starts a Run is an arrival observed after the fact, never a
   * sweep of the tickets already sitting in the column.
   */
  armedAt: number;
}

/**
 * The Automations `status` offers, armed one first (CONTEXT, "Offered list").
 *
 * Membership is the record's Trigger; order is the Arming plus whatever order
 * the caller was handed (main lists name-ordered, project's own before global).
 * The digit accelerators and hand-dragged ranking are VC-132's; this is the
 * list they will rank.
 */
export function offeredAutomationsForColumn(
  automations: readonly Automation[],
  status: TicketStatus,
  armedAutomationId: string | null,
): readonly Automation[] {
  const offered = automations.filter((automation) => automationTriggersColumn(automation, status));
  const armed = offered.find((automation) => automation.id === armedAutomationId);
  if (armed === undefined) return offered;
  return [armed, ...offered.filter((automation) => automation.id !== armed.id)];
}

/**
 * The Automation `status` fires on its own, or `null` for an unarmed column.
 *
 * Two facts must both hold, and this is the one place that is stated: the
 * column names an Automation, and that Automation still exists AND still offers
 * itself here. Dropping the column from a Trigger therefore disarms it without
 * a second write to keep in step — a stale arming row is inert rather than a
 * surprise, which matters because the row outlives an edit made on this machine
 * and an Automation edited on any surface.
 */
export function armedAutomationFor(
  automations: readonly Automation[],
  armings: readonly ColumnArming[],
  status: TicketStatus,
): Automation | null {
  const arming = armings.find((candidate) => candidate.status === status);
  if (arming === undefined) return null;
  const automation = automations.find((candidate) => candidate.id === arming.automationId);
  if (automation === undefined) return null;
  return automationTriggersColumn(automation, status) ? automation : null;
}

/**
 * How long an armed column waits before it starts its Run, in milliseconds
 * (VC-112, "Board interaction").
 *
 * 3500 ms is the whole safety story for an act nobody confirmed: long enough to
 * read the sentence and reach the one control, short enough that a deliberate
 * move does not feel held up. Exactly one control lives in this window —
 * Cancel, which keeps the move and starts nothing. Sending the Ticket back is
 * the board's ordinary undo and is deliberately not offered here: two buttons
 * inside 3.5 seconds is a choice nobody can make in time.
 */
export const ARMED_RUN_DELAY_MS = 3500;

/**
 * Whether a committed move is an ARRIVAL in `to` — the only thing an Arming
 * ever reacts to.
 *
 * A reorder inside one column is not an arrival, so a card dragged up its own
 * column can never start a Run however armed that column is. Stated here rather
 * than at the drag, because every Deliberate move — drag, context menu, the
 * ticket rail's status pill — must answer it identically.
 */
export function isColumnArrival(from: TicketStatus, to: TicketStatus): boolean {
  return from !== to;
}
