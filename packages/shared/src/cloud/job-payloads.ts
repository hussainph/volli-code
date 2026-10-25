/**
 * What each runner job asks the runner to do: the kind-specific payloads of
 * `runnerJobs`, and the one codec both sides check them with.
 *
 * The backend checks a payload with {@link parseJobPayload} before it enqueues
 * a job (closed on write), and the runner checks it again before it acts: a
 * known kind whose payload does not parse is corruption, and the runner fails
 * that job with {@link INVALID_JOB_PAYLOAD} rather than guessing. A kind the
 * runner does not know at all is a different case: `unsupportedJobOutcome`.
 *
 * Payloads carry references and small facts, never bodies or machine paths:
 * a Session message travels as an encoded `SessionCommandIntent` whose
 * transcript reference names a body in the transcript artifact store (the
 * runner fetches one it does not hold before it submits), and a Working copy
 * is named by its ticket and id, never by where it sits on disk.
 *
 * The typed payloads are provisional until their first producer and the
 * runner that executes them ship; until then the owning ticket may still
 * reshape them here. Once a deployed backend has written a payload it is
 * frozen: a new field is optional, anything else is a new `format` or kind.
 * The kinds no ticket has typed yet stay opaque JSON objects.
 */

import { TICKET_STATUSES, type TicketStatus } from "../ticket";
import {
  isDerivedId,
  isUuid,
  type AutomationId,
  type SessionId,
  type TicketId,
  type UserId,
  type WorkingCopyId,
} from "./ids";
import { isPlainJson, type JobKind } from "./jobs";

/** Why a ticket's Working copy is being made on a runner. */
export const MATERIALIZE_REASONS = ["checkout_mode_changed", "session_start"] as const;
export type MaterializeReason = (typeof MATERIALIZE_REASONS)[number];

/** Clone or add the ticket's worktree, copy includes on a Mac, run setup. */
export interface WorkingCopyMaterializePayload {
  ticketId: TicketId;
  reason: MaterializeReason;
}

/** Why ignored content is removed from a Working copy (Done retention). */
export const TRIM_REASONS = ["done", "archived"] as const;
export type TrimReason = (typeof TRIM_REASONS)[number];

/** Remove ignored content (build output, dependencies) from one Working copy; keep the branch. */
export interface WorkingCopyTrimPayload {
  ticketId: TicketId;
  workingCopyId: WorkingCopyId;
  reason: TrimReason;
}

/** Why a Working copy's directory is removed. */
export const RECLAIM_REASONS = ["retention", "requested"] as const;
export type ReclaimReason = (typeof RECLAIM_REASONS)[number];

/** Remove one Working copy's directory; keep the branch. */
export interface WorkingCopyReclaimPayload {
  ticketId: TicketId;
  workingCopyId: WorkingCopyId;
  reason: ReclaimReason;
}

/** A person's (or agent's) command for a Session: `SessionRuntime.command`, idempotent by the job's `commandId`. */
export const SESSION_COMMAND_FORMAT = "volli.session-command/1";
/** Interrupt the Session's live executor; nothing is killed and the transcript stays for a later resume. */
export const SESSION_INTERRUPT_FORMAT = "volli.session-interrupt/1";
/** A queued message, released at the Session's next idle boundary (the runner decides when). */
export const SESSION_FOLLOW_UP_FORMAT = "volli.session-follow-up/1";

export interface SessionCommandJobPayload {
  format: typeof SESSION_COMMAND_FORMAT;
  /** An encoded `SessionCommandIntent` (`encodeSessionJson`), never `session.create`. */
  intent: string;
}

/** Why the backend interrupts a Session. */
export const SESSION_INTERRUPT_REASONS = ["ticket_left_active_columns"] as const;
export type SessionInterruptReason = (typeof SESSION_INTERRUPT_REASONS)[number];

/**
 * The backend cannot name the Session's live attachment, so the runner
 * resolves it and records `executor.interrupt` under the job's `commandId`.
 * A Session with nothing running completes the job as done.
 */
export interface SessionInterruptJobPayload {
  format: typeof SESSION_INTERRUPT_FORMAT;
  reason: SessionInterruptReason;
  from: TicketStatus;
  to: TicketStatus;
}

export interface SessionFollowUpJobPayload {
  format: typeof SESSION_FOLLOW_UP_FORMAT;
  /** An encoded `message.submit` intent; the job's `commandId` is the delivery command id. */
  intent: string;
}

/** Start a subagent Session for a parent Session's tool call (the job's `sessionId` is the parent). */
export interface SessionDelegatePayload {
  /** The parent's tool call: a frozen derived id, unique within the parent. */
  toolCallId: string;
  childSessionId: SessionId;
  /** The child's `session.create` command id, so a re-delivered job creates it once. */
  createCommandId: string;
  /** How deep the child is (1 for a child of a root Session). */
  depth: number;
}

/** How an Automation came to run here. Arrivals today; schedule occurrences join with their producer. */
export interface AutomationArrivalRunPayload {
  trigger: "arrival";
  automationId: AutomationId;
  ticketId: TicketId;
  from: TicketStatus;
  /** The column the ticket arrived in. */
  status: TicketStatus;
  /** `armed`: the column's arming; `chosen`: a person picked this Automation on a deliberate move. */
  origin: "armed" | "chosen";
  /**
   * The armer whose credentials the run uses: always set for an armed run,
   * and for a pick of the column's own armed Automation. `null` when the run
   * is the picker's own work.
   */
  armedByUserId: UserId | null;
}

export type AutomationRunPayload = AutomationArrivalRunPayload;

/** A payload no owning ticket has typed yet: an opaque JSON object. */
export type JobPayloadObject = { readonly [field: string]: unknown };

/** Kind-specific payloads. Opaque kinds are typed by the ticket that owns them. */
export interface JobPayloads {
  "session.start": JobPayloadObject;
  "session.command": SessionCommandJobPayload | SessionInterruptJobPayload;
  "session.followUp": SessionFollowUpJobPayload;
  "session.notice": JobPayloadObject;
  "session.delegate": SessionDelegatePayload;
  "session.release": JobPayloadObject;
  "workingCopy.materialize": WorkingCopyMaterializePayload;
  "workingCopy.trim": WorkingCopyTrimPayload;
  "workingCopy.reclaim": WorkingCopyReclaimPayload;
  "workingCopy.refresh": JobPayloadObject;
  "environment.run": JobPayloadObject;
  "automation.run": AutomationRunPayload;
}

export type JobPayload<K extends JobKind> = JobPayloads[K];

/** The largest payload a job may carry, as JSON text. Bodies travel by reference. */
export const JOB_PAYLOAD_MAX_CHARS = 64 * 1024;

/** The failure code a runner reports for a known kind whose payload does not parse. */
export const INVALID_JOB_PAYLOAD = "invalid_job_payload";

/** Thrown by {@link parseJobPayload}. */
export class InvalidJobPayloadError extends Error {
  readonly code = INVALID_JOB_PAYLOAD;
  constructor(kind: string, detail: string) {
    super(`Invalid ${kind} job payload: ${detail}`);
    this.name = "InvalidJobPayloadError";
  }
}

type Row = Record<string, unknown>;

class Reader {
  constructor(
    private readonly kind: JobKind,
    readonly row: Row,
  ) {}

  fail(detail: string): never {
    throw new InvalidJobPayloadError(this.kind, detail);
  }

  /** Refuses any field the payload does not define: writers are closed. */
  only(...fields: string[]): this {
    for (const name of Object.keys(this.row)) {
      if (!fields.includes(name)) this.fail(`unexpected field ${JSON.stringify(name)}`);
    }
    return this;
  }

  uuid<T extends string>(name: string): T {
    const value = this.row[name];
    if (!isUuid(value)) this.fail(`${name} is not a UUID`);
    return value as T;
  }

  nullableUuid<T extends string>(name: string): T | null {
    return this.row[name] === null ? null : this.uuid<T>(name);
  }

  derived(name: string): string {
    const value = this.row[name];
    if (!isDerivedId(value)) this.fail(`${name} is not a non-empty id of at most 512 characters`);
    return value;
  }

  oneOf<const T extends readonly string[]>(name: string, values: T): T[number] {
    const value = this.row[name];
    if (typeof value !== "string" || !values.includes(value)) {
      this.fail(`${name} is not one of ${values.join(", ")}`);
    }
    return value;
  }

  positiveInteger(name: string): number {
    const value = this.row[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      this.fail(`${name} is not a positive integer`);
    }
    return value;
  }

  /**
   * An encoded Session command intent. Only its `kind` is checked here, so the
   * cloud vocabulary stays free of the Session codec: the producer encodes
   * the intent with that codec, and the runner decodes it with the same one
   * before it acts (a malformed intent fails as `INVALID_JOB_PAYLOAD` there).
   */
  intent(name: string, accept: (kind: string) => string | null): string {
    const value = this.row[name];
    if (typeof value !== "string") this.fail(`${name} is not encoded JSON text`);
    let intent: unknown;
    try {
      intent = JSON.parse(value);
    } catch {
      this.fail(`${name} is not JSON`);
    }
    const kind = (intent as { kind?: unknown } | null)?.kind;
    if (typeof kind !== "string" || kind.length === 0) {
      this.fail(`${name} is not a Session command intent`);
    }
    const refusal = accept(kind);
    if (refusal !== null) this.fail(refusal);
    return value;
  }
}

/**
 * `value` as the payload of a `kind` job, or {@link InvalidJobPayloadError}.
 * Typed kinds are checked field by field (no extra fields); opaque kinds must
 * be a plain JSON object. Every payload is bounded by {@link JOB_PAYLOAD_MAX_CHARS}.
 */
export function parseJobPayload<K extends JobKind>(kind: K, value: unknown): JobPayload<K> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidJobPayloadError(kind, "not a JSON object");
  }
  if (!isPlainJson(value)) throw new InvalidJobPayloadError(kind, "not plain JSON");
  if (JSON.stringify(value).length > JOB_PAYLOAD_MAX_CHARS) {
    throw new InvalidJobPayloadError(kind, `larger than ${JOB_PAYLOAD_MAX_CHARS} characters`);
  }
  const r = new Reader(kind, value as Row);
  return parseTyped(kind, r) as JobPayload<K>;
}

function parseTyped(kind: JobKind, r: Reader): JobPayloads[JobKind] {
  switch (kind) {
    case "workingCopy.materialize":
      r.only("ticketId", "reason");
      return {
        ticketId: r.uuid<TicketId>("ticketId"),
        reason: r.oneOf("reason", MATERIALIZE_REASONS),
      } satisfies WorkingCopyMaterializePayload;
    case "workingCopy.trim":
      r.only("ticketId", "workingCopyId", "reason");
      return {
        ticketId: r.uuid<TicketId>("ticketId"),
        workingCopyId: r.uuid<WorkingCopyId>("workingCopyId"),
        reason: r.oneOf("reason", TRIM_REASONS),
      } satisfies WorkingCopyTrimPayload;
    case "workingCopy.reclaim":
      r.only("ticketId", "workingCopyId", "reason");
      return {
        ticketId: r.uuid<TicketId>("ticketId"),
        workingCopyId: r.uuid<WorkingCopyId>("workingCopyId"),
        reason: r.oneOf("reason", RECLAIM_REASONS),
      } satisfies WorkingCopyReclaimPayload;
    case "session.command":
      return parseSessionCommand(r);
    case "session.followUp":
      r.only("format", "intent");
      r.oneOf("format", [SESSION_FOLLOW_UP_FORMAT]);
      return {
        format: SESSION_FOLLOW_UP_FORMAT,
        intent: r.intent("intent", (intentKind) =>
          intentKind === "message.submit" ? null : "intent is not message.submit",
        ),
      } satisfies SessionFollowUpJobPayload;
    case "session.delegate":
      r.only("toolCallId", "childSessionId", "createCommandId", "depth");
      return {
        toolCallId: r.derived("toolCallId"),
        childSessionId: r.uuid<SessionId>("childSessionId"),
        createCommandId: r.derived("createCommandId"),
        depth: r.positiveInteger("depth"),
      } satisfies SessionDelegatePayload;
    case "automation.run":
      r.only("trigger", "automationId", "ticketId", "from", "status", "origin", "armedByUserId");
      r.oneOf("trigger", ["arrival"]);
      return parseArrival(r);
    case "session.start":
    case "session.notice":
    case "session.release":
    case "workingCopy.refresh":
    case "environment.run":
      return r.row;
  }
}

function parseSessionCommand(r: Reader): SessionCommandJobPayload | SessionInterruptJobPayload {
  const format = r.oneOf("format", [SESSION_COMMAND_FORMAT, SESSION_INTERRUPT_FORMAT]);
  if (format === SESSION_INTERRUPT_FORMAT) {
    r.only("format", "reason", "from", "to");
    return {
      format,
      reason: r.oneOf("reason", SESSION_INTERRUPT_REASONS),
      from: r.oneOf("from", TICKET_STATUSES),
      to: r.oneOf("to", TICKET_STATUSES),
    };
  }
  r.only("format", "intent");
  return {
    format,
    intent: r.intent("intent", (intentKind) =>
      intentKind === "session.create" ? "intent creates a Session; use session.start" : null,
    ),
  };
}

function parseArrival(r: Reader): AutomationArrivalRunPayload {
  const origin = r.oneOf("origin", ["armed", "chosen"]);
  const armedByUserId = r.nullableUuid<UserId>("armedByUserId");
  if (origin === "armed" && armedByUserId === null) r.fail("an armed run names its armer");
  return {
    trigger: "arrival",
    automationId: r.uuid<AutomationId>("automationId"),
    ticketId: r.uuid<TicketId>("ticketId"),
    from: r.oneOf("from", TICKET_STATUSES),
    status: r.oneOf("status", TICKET_STATUSES),
    origin,
    armedByUserId,
  };
}
