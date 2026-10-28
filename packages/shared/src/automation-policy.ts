/** Pure Automation validators shared by the local model and cloud rules. No app-model runtime imports. */
import type { ModelSelection } from "./model-selection";
import type {
  Automation,
  AutomationRuntime,
  AutomationRuntimeTier,
  ValidAutomationRuntime,
  AutomationTrigger,
  AutomationSkipReason,
} from "./automation";
import { parseAutomationSchedule, type AutomationSchedule } from "./automation-schedule";
import { isAgentModelTier } from "./model-access-policy";
import { parseSessionModel } from "./model-selection";
import { isTicketStatus, TICKET_STATUSES, type TicketStatus } from "./ticket";

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

/** Whether a Runtime is the valid whole model-and-reasoning pin a Run may use. */
export function isAutomationRuntimePin(runtime: AutomationRuntime): runtime is ModelSelection {
  return runtime !== null && !("kind" in runtime);
}

/** Whether a Runtime names a tier to be resolved when the Run starts. */
export function isAutomationRuntimeTier(
  runtime: AutomationRuntime,
): runtime is AutomationRuntimeTier {
  return runtime !== null && "kind" in runtime && runtime.kind === "tier";
}

/** Whether a Runtime is one a Run may start under — anything but the invalid row. */
export function isValidAutomationRuntime(
  runtime: AutomationRuntime,
): runtime is ValidAutomationRuntime {
  return runtime === null || isAutomationRuntimePin(runtime) || isAutomationRuntimeTier(runtime);
}

/**
 * A stored or transported Runtime, read in today's vocabulary.
 *
 * `null` is inherit. A whole pin is a pin. A tier a Run may START on is a
 * tier. Everything else — a partial pin, a tier from another build, bytes that
 * were never JSON — is the explicit invalid row with the raw value kept, and
 * never `null`: inherit still RUNS, so an unreadable Runtime coerced to it
 * would start a Session under a policy nobody chose. The one reader for the
 * SQLite column and any future transport, so the two cannot disagree about
 * which shapes are runnable.
 *
 * The tier test is the AGENT-facing one (VC-431), which is the same set the
 * save door and the editor check. `utility` is the slot for work nobody asked
 * for, so a record naming it — written by an older build, whose save door
 * still admitted it, or by a door that bypassed the editor — reads back as the
 * invalid row and REFUSES rather than starting a Session on the Utility row.
 * Narrowing the save door alone would have left those rows running.
 */
export function parseAutomationRuntime(raw: unknown): AutomationRuntime {
  if (raw === null) return null;
  if (typeof raw === "object" && (raw as { kind?: unknown }).kind === "tier") {
    const tier = (raw as { tier?: unknown }).tier;
    return isAgentModelTier(tier) ? { kind: "tier", tier } : { kind: "invalid", raw };
  }
  return parseSessionModel(raw) ?? { kind: "invalid", raw };
}

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
