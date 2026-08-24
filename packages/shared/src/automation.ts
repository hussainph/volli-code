/**
 * Automations V1 (VC-112, tracer VC-126): the record's domain vocabulary.
 *
 * An Automation is a saved, named way of starting work — its Instructions and
 * its Runtime, with Triggers arriving in a later slice. One Run opens one
 * fresh chat Session; the Run row remembers which Automation and which
 * *resolved* model and reasoning produced that Session.
 *
 * Pure and shared on purpose, like `model-access-policy.ts` beside it: main
 * stores these records and validates writes; the renderer's editor reads the
 * same words, so a rule that existed in only one process would be two
 * policies wearing one name. Transport stays out — the Electron channel
 * catalog is desktop-owned (docs/BOUNDARIES.md), so nothing here names IPC.
 */

import type { ModelAccessSnapshot, ModelSelection } from "./agent-runtime";

/**
 * Where an Automation is listed: every project, or exactly one (VC-112,
 * "Scope — two axes"). Ownership decides listing only; the Target of a Run is
 * the Ticket it is invoked on, never a property of the Automation record.
 */
export type AutomationOwnership = "global" | "project";

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
   * The Runtime: one pinned model-and-reasoning selection, or `null` to
   * inherit through the project's runtime preferences and then the global
   * record. The two halves travel together by construction — a reasoning
   * level is a property of the model that offers it, so a type that could pin
   * one without the other could spell a pair that does not exist.
   */
  runtime: ModelSelection | null;
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
   * The Automation that produced this Run. `null` survives two futures this
   * schema admits from day one: an Unbound Run (VC-129's "Run once…", which
   * names no Automation), and a Run whose Automation was since deleted —
   * delete is a record delete, and history must not go with it.
   */
  automationId: string | null;
  /**
   * The Ticket the Run was invoked on. Nullable for exactly the reason
   * `sessions.ticket_id` is: deleting a Ticket orphans the record rather than
   * erasing the provenance of a Session that still exists.
   */
  ticketId: string | null;
  sessionId: string;
  /**
   * The model policy the Session was actually born with — the resolved
   * values, never the reference. Free at launch, impossible to reconstruct
   * later, and what makes the pin/inherit decision self-correcting.
   */
  model: ModelSelection;
  /** Epoch milliseconds. */
  createdAt: number;
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
  | "RUN_IN_FLIGHT"
  | "MODEL_REQUIRED"
  | "MODEL_UNAVAILABLE"
  | "RUN_FAILED";

/** What a save must carry. Everything else on {@link Automation} is minted by the store. */
export interface AutomationDraft {
  name: string;
  instructions: string;
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
