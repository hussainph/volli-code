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
 * Whether a person was at the door that asked for this Run (VC-112, VC-133).
 *
 * ── ATTENDANCE FOLLOWS THE TRIGGER, AND THE DOOR IS WHERE THE TRIGGER LANDS ─
 * VC-112 rules it in one line — "Nothing declares itself attended or
 * unattended. A column move is attended because a person is right there; a
 * schedule is not" — and explicitly WITHDRAWS the per-Automation attendance
 * switch that would have let a record claim otherwise. So this is never
 * authored, never a setting, and never inferred from window focus: it is a
 * property of the invocation, decided by whichever door accepted it.
 *
 * V1 has exactly four such doors, and each one knows its own answer without
 * asking anything:
 *
 *  - **attended** — the renderer's Ticket-scoped Run door (`automations/ipc.ts`)
 *    behind the rail's split button, the board card's context menu, the armed
 *    column's drop window, and the command palette; and the renderer's "Run now"
 *    on a Skipped occurrence. A person clicked something to get here.
 *  - **unattended** — the schedule timer (`main/index.ts`), which is the case
 *    VC-112 names; and the agent's Run verb (`agent-tool-door.ts`), where the
 *    caller is another Session that has gone on to its own work and can neither
 *    see a permission prompt nor answer one.
 *
 * ── WHY IT IS DURABLE RATHER THAN PROCESS-LOCAL ───────────────────────────
 * A Run plan is accepted durably BEFORE its Session work happens, and
 * `AutomationRunner.recover()` replays plans whose process died in between. The
 * process that must decide whether to notify is therefore not always the
 * process that took the request, so a `Set` of unattended Session ids in memory
 * would answer "attended" for every recovered Run — silently, and only after a
 * crash, which is the worst way to lose a notification.
 *
 * ── AND WHY THE UNKNOWN ANSWER IS `attended` ──────────────────────────────
 * Runs recorded before this ticket carry nothing here. They are read as
 * `attended`, which is the answer that NEVER notifies. The degrade direction is
 * chosen the same way every other one in this file is: a wrong `unattended`
 * would raise a notification about work a person is already watching, teaching
 * them that these notifications are noise, and VC-112 is explicit that this is
 * how a person learns to switch a feature off. A wrong `attended` costs one
 * missed notification on a historical Run and nothing else.
 */
export const AUTOMATION_RUN_ATTENDANCE = ["attended", "unattended"] as const;

export type AutomationRunAttendance = (typeof AUTOMATION_RUN_ATTENDANCE)[number];

export function isAutomationRunAttendance(value: unknown): value is AutomationRunAttendance {
  return (
    typeof value === "string" && (AUTOMATION_RUN_ATTENDANCE as readonly string[]).includes(value)
  );
}

/**
 * A stored or transported attendance read in today's vocabulary — absent,
 * unreadable, or from a build that spelled it differently all become
 * `attended`.
 *
 * One function so the column read, the plan read and the wire guard cannot
 * disagree about what an old row means. See {@link AUTOMATION_RUN_ATTENDANCE}
 * for why silence is the safe answer rather than the lossy one.
 */
export function parseAutomationRunAttendance(value: unknown): AutomationRunAttendance {
  return isAutomationRunAttendance(value) ? value : "attended";
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
  /**
   * Whether a person was at the door that asked for this Run — the fact the
   * notification rule turns on (VC-112's "Notification rule", VC-133).
   *
   * Stored on the Run rather than derived later because there is nothing to
   * derive it FROM once the invocation is over: the Automation's own Trigger
   * cannot answer it (running by hand is universal in V1, so a scheduled
   * Automation is regularly run by a person standing right there), and the
   * Session records who launched it but not whether they stayed.
   */
  attendance: AutomationRunAttendance;
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
 * matching. `MODEL_REQUIRED` is the Session start's own refusal passing
 * through — the existing error path, never a new one.
 */
export type AutomationRunRefusalCode =
  | "AUTOMATION_NOT_FOUND"
  | "AUTOMATION_NOT_IN_PROJECT"
  | "TICKET_NOT_FOUND"
  /** A Run that names the Project as its Target, and no such project (VC-130). */
  | "PROJECT_NOT_FOUND"
  | "RUN_IN_FLIGHT"
  | "MODEL_REQUIRED"
  /**
   * Retained vocabulary, no longer minted by the Run door (VC-133).
   *
   * A Run's Runtime is now RECORDED as asked and refused by the attach, so an
   * unavailable pin arrives as a Session in `error` rather than as this code —
   * VC-112's "let the Session fail through the existing error path". The word
   * stays because rejections carrying it are durable: a Run an earlier build
   * refused this way is still in the ledger, and replaying its command id must
   * still answer with the code that was stored.
   */
  | "MODEL_UNAVAILABLE"
  /** An Unbound Run arrived with nothing to say (VC-129). */
  | "INSTRUCTIONS_REQUIRED"
  | "RUN_FAILED";

/* --------------------------------------------- unbound Runs (VC-129) ----- */

/**
 * What a Run names: a saved Automation, or nothing but the Instructions it
 * carries (VC-112, "One-time work").
 *
 * A union rather than a nullable id beside a nullable prose field, because the
 * two states this spells are the only two that exist: a bound Run reads its
 * Instructions from the record it names, and an UNBOUND Run has no record to
 * read them from. A pair of optional fields could spell "neither" (a Run with
 * nothing to send) and "both" (a Run whose own Instructions silently outrank
 * the Automation it claims to be) — neither is a thing anyone can mean.
 *
 * An Unbound Run writes no file and saves no record beyond the Run itself, so
 * there is nothing afterwards to name, disable or delete. That is a property of
 * this shape, not of the surface that produced it: nothing here can be saved,
 * so no surface holding one has to promise not to save it.
 */
export type AutomationRunTarget =
  | { kind: "automation"; automationId: string }
  | { kind: "unbound"; instructions: string };

/**
 * The Automation a target names, or `null` for an Unbound Run — the value that
 * lands in {@link AutomationRun.automationId}.
 *
 * Stated once so a Run's own record, the durable plan behind it and any retry
 * guard agree about what "names no Automation" is spelled as.
 */
export function automationRunTargetId(target: AutomationRunTarget): string | null {
  return target.kind === "automation" ? target.automationId : null;
}

/**
 * What an Unbound Run is called wherever something must print a name: its
 * history row, and the title of the Session it opens.
 *
 * One constant rather than a literal per surface. A Run row reading "Run once"
 * beside a Session called something else would look like two facts about two
 * pieces of work, when there is one — and the reason the name is a constant at
 * all is that an Unbound Run has no record to take a name from.
 */
export const UNBOUND_RUN_LABEL = "Run once";

/**
 * Why an Unbound Run cannot start, or `null` when it can.
 *
 * The same rule {@link automationDraftProblem} states for a saved record's
 * Instructions, and the same reason: a Run delivers its Instructions as its
 * Session's first message, and the message layer already refuses blank text —
 * so the Run refuses first, with a sentence about the thing the person is
 * looking at. Shared for the same reason the draft rule is: the dialog's
 * disabled Run button and main's refusal are one policy, not two that agree
 * today.
 *
 * There is deliberately no name rule beside it. Naming an Unbound Run is the
 * one thing it does not do.
 */
export function unboundRunProblem(instructions: string): string | null {
  if (instructions.trim().length === 0) {
    return "Write Instructions before running — a Run delivers them as its Session's first message.";
  }
  return null;
}

/* ------------------------------------------- one Run request's identity -- */

/**
 * What a Run request ASKED FOR, beside the ids that already travel with it —
 * the half of a Run's intent that a plan's resolved fields cannot recover.
 *
 * A Run command id is durable intent, so two requests carrying the same id must
 * either be the same request (replay its receipt) or a conflict (refuse). The
 * Automation and the Ticket are not enough to decide that any more (VC-129):
 * every Unbound Run names no Automation, so a second one with DIFFERENT
 * Instructions would otherwise read as a retry of the first and silently replay
 * work nobody asked for. The per-invocation override is here for the same
 * reason — running the same Instructions on another model is a second Run.
 *
 * Deliberately the caller's words rather than the plan's `text`: `text` is the
 * composer's expansion at request time, and a template edited between the two
 * calls would turn one honest retry into a conflict.
 *
 * `instructions` is `null` for a bound Run, whose Instructions live in the
 * record it names — which is also what a plan written before this field existed
 * normalizes to (see the engine's plan reader).
 */
export interface AutomationRunRequestIdentity {
  instructions: string | null;
  modelOverride: ModelSelection | null;
}

/** One Run request's identity, read off the target and the invocation's override. */
export function automationRunRequestIdentity(input: {
  target: AutomationRunTarget;
  modelOverride: ModelSelection | null;
}): AutomationRunRequestIdentity {
  return {
    instructions: input.target.kind === "unbound" ? input.target.instructions : null,
    modelOverride: input.modelOverride,
  };
}

/** Whether two Run requests are the same intent — field by field, no JSON order. */
export function sameAutomationRunRequestIdentity(
  left: AutomationRunRequestIdentity,
  right: AutomationRunRequestIdentity,
): boolean {
  if (left.instructions !== right.instructions) return false;
  if (left.modelOverride === null || right.modelOverride === null) {
    return left.modelOverride === right.modelOverride;
  }
  return (
    left.modelOverride.providerId === right.modelOverride.providerId &&
    left.modelOverride.modelId === right.modelOverride.modelId &&
    left.modelOverride.reasoningLevel === right.modelOverride.reasoningLevel
  );
}

/**
 * The key a caller holding a durable command id across a lost reply files it
 * under: the whole intent, so pressing again after CHANGING something asks for
 * a new Run rather than replaying the old one's receipt.
 *
 * It is the renderer's half of the rule main enforces with
 * {@link sameAutomationRunRequestIdentity} — one statement of "the same Run",
 * rather than a key that agrees with the durable comparison only by luck.
 * `\u0000` cannot appear in any of the parts, so no two different intents can
 * spell one key.
 */
export function automationRunRetryKey(input: {
  target: AutomationRunTarget;
  ticketId: string;
  modelOverride: ModelSelection | null;
}): string {
  const identity = automationRunRequestIdentity(input);
  const override =
    identity.modelOverride === null
      ? "inherit"
      : `${identity.modelOverride.providerId}/${identity.modelOverride.modelId}/${identity.modelOverride.reasoningLevel}`;
  return [
    automationRunTargetId(input.target) ?? "unbound",
    identity.instructions ?? "",
    input.ticketId,
    override,
  ].join("\u0000");
}

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

/* ------------------------------------- the column's own order (VC-132) ---- */

/**
 * One column's authored rank for its Offered list: which Automation reads as
 * `1`, which as `2`, and so on when a card is dragged over it.
 *
 * Machine-local for the same reason {@link ColumnArming} is, and the reason is
 * sharper here than it looks: the digit printed in the lane view must be the
 * digit that works mid-drag, and the drag's digits are pinned by an arming that
 * never travels. An order that travelled while the arming it is read against
 * did not would print one digit on this machine and mean another on the next.
 *
 * Keyed by `(projectId, status)` like the arming, because a rank is a property
 * of the COLUMN: one Automation offered in two columns holds a rank in each,
 * and neither is visible in the record they both point at.
 *
 * The list is stale-TOLERANT rather than pruned. An id naming an Automation
 * this column no longer offers is inert on read (it is filtered against the
 * Offered list), so an edit made anywhere else never has to be chased with a
 * second write to keep a rank honest.
 */
export interface ColumnAutomationOrder {
  projectId: string;
  status: TicketStatus;
  /** Automation ids, best rank first. Ids this column no longer offers are inert. */
  rankedAutomationIds: readonly string[];
  /** Epoch milliseconds the order was last written. */
  orderedAt: number;
}

/**
 * How many Offered rows can carry a digit, and therefore how many landing
 * targets a column can grow under ⌥ (VC-132).
 *
 * Nine because the accelerators are `1`–`9`: a row past the ninth has no key to
 * press and no target to aim at, which is a smaller lie than a tenth row that
 * looks identical to the nine above it and answers no digit. Rank 10+ stays
 * authorable in the lane and runnable by hand from every surface that lists it.
 */
export const MAX_OFFERED_DIGITS = 9;

/**
 * The Automations `status` offers, in AUTHORED rank order (CONTEXT, "Offered
 * list").
 *
 * Membership is the record's Trigger; order is the column's own rank
 * ({@link ColumnAutomationOrder}) followed by whatever order the caller was
 * handed for the ids that rank names nothing about (main lists name-ordered,
 * project's own before global) — so a project that has never been arranged
 * still reads as a stable `1`…`n`.
 *
 * Uncapped and UNPINNED on purpose. This is the list a surface shows when it is
 * choosing a record rather than pressing a digit: the column's bolt menu picks
 * what to arm, and arming an Automation ranked tenth is an ordinary thing to
 * want. The pinned, digit-capped shape the drag reads is
 * {@link offeredAutomationsInDigitOrder}.
 */
export function offeredAutomationsForColumn(
  automations: readonly Automation[],
  status: TicketStatus,
  rankedAutomationIds: readonly string[] = [],
): readonly Automation[] {
  const offered = automations.filter((automation) => automationTriggersColumn(automation, status));
  const byId = new Map(offered.map((automation) => [automation.id, automation]));
  const ranked: Automation[] = [];
  for (const id of rankedAutomationIds) {
    const automation = byId.get(id);
    // An id this column no longer offers, or one named twice, contributes
    // nothing rather than failing the read — see ColumnAutomationOrder.
    if (automation === undefined) continue;
    ranked.push(automation);
    byId.delete(id);
  }
  // Anything the rank never named keeps the caller's order, appended.
  for (const automation of offered) {
    if (byId.has(automation.id)) ranked.push(automation);
  }
  return ranked;
}

/**
 * The DRAG-TIME list for `status`: the digits `1`–`9`, in the order they read.
 *
 * Two things happen to the authored rank here, and the ORDER of the two is the
 * rule rather than an implementation detail:
 *
 *  1. **The effective armed Automation is pinned to digit `1`.** That is what
 *     makes `1` safe to press while learning — in an armed column it reproduces
 *     exactly what a plain drop would do. `effectiveArmedAutomationId` is the
 *     armed record **that is also switched on here**: an armed Automation this
 *     machine has switched off starts nothing on a plain drop, so pinning it
 *     would make `1` promise a Run that never comes.
 *  2. **…before the nine-digit cap**, not after. An armed Automation whose
 *     authored rank is past the ninth would otherwise be sliced out of the very
 *     list whose digit `1` it owns.
 *
 * Applied at READ time rather than written into the stored rank, so disarming
 * returns the Automation to its authored slot instead of wherever the pin last
 * left it, and the stored order never has to know about arming at all.
 *
 * Enablement changes the PIN and never the membership or the order: a switched
 * off Automation keeps its row and its digit, because renumbering the rows
 * below it would poison the muscle memory the digits exist to build (and an
 * ⌥-pick of it is a hand-run, which VC-112 rules is universal).
 *
 * An `effectiveArmedAutomationId` this column does not offer is ignored rather
 * than an error — the same stale-arming tolerance {@link armedAutomationFor}
 * has, whose armed-first shape this generalises.
 */
export function offeredAutomationsInDigitOrder(input: {
  automations: readonly Automation[];
  status: TicketStatus;
  rankedAutomationIds?: readonly string[];
  /** The armed record that is also switched on here, or `null`. */
  effectiveArmedAutomationId?: string | null;
}): readonly Automation[] {
  const ranked = offeredAutomationsForColumn(
    input.automations,
    input.status,
    input.rankedAutomationIds ?? [],
  );
  const armed = ranked.find((automation) => automation.id === input.effectiveArmedAutomationId);
  if (armed === undefined) return ranked.slice(0, MAX_OFFERED_DIGITS);
  return [armed, ...ranked.filter((automation) => automation.id !== armed.id)].slice(
    0,
    MAX_OFFERED_DIGITS,
  );
}

/**
 * The rank to STORE after a lane drop, given the lane's new drawn order.
 *
 * The lane draws the pinned, capped list; the record stores the authored,
 * uncapped one. Two rows are therefore on screen that this write must not
 * disturb — the armed row pinned to slot 1, and everything ranked past the
 * ninth, which is not drawn at all — so the arithmetic is "refill the slots the
 * lane actually moved" rather than "take the lane's list as the new order":
 *
 *  - every authored slot holding one of `reorderedIds` takes the next id from
 *    `reorderedIds`, in the lane's new order;
 *  - every other slot keeps its own occupant, which is exactly how the armed
 *    row keeps its authored rank (so disarming returns it there) and how a
 *    row past the digit cap keeps its place under rows it cannot see.
 *
 * `reorderedIds` may name ids `authoredIds` does not; those are dropped, since
 * the authored list is what the record stores.
 */
export function columnRankAfterLaneDrop(
  authoredIds: readonly string[],
  reorderedIds: readonly string[],
): readonly string[] {
  const authored = new Set(authoredIds);
  const moved = reorderedIds.filter((id) => authored.has(id));
  const movedSet = new Set(moved);
  let next = 0;
  return authoredIds.map((id) => (movedSet.has(id) ? (moved[next++] as string) : id));
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
 * The Automation `status` would fire on its own RIGHT HERE: armed, and switched
 * on on this machine (VC-132).
 *
 * Two switches decide it and both are machine-local, which is why one function
 * says so once: arming names WHICH Automation a column fires, enablement says
 * whether this machine fires that Automation at all. A column armed with an
 * Automation nobody switched on here starts nothing on a plain drop — so this,
 * and not {@link armedAutomationFor}, is what the drag picker pins to digit `1`
 * and what an open picker preselects.
 */
export function effectiveArmedAutomationFor(input: {
  automations: readonly Automation[];
  armings: readonly ColumnArming[];
  enabledAutomationIds: readonly string[];
  status: TicketStatus;
}): Automation | null {
  const armed = armedAutomationFor(input.automations, input.armings, input.status);
  if (armed === null) return null;
  return input.enabledAutomationIds.includes(armed.id) ? armed : null;
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
