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

import { REASONING_LEVELS, type ModelSelection } from "../model-selection";
import { AUTOMATION_RUN_ATTENDANCE } from "../automation-policy";
import type { AutomationRunAttendance } from "../automation";
import { AUTOMATION_INSTRUCTIONS_MAX_CHARS } from "./automations";
import type { SessionStopActor } from "../session-ledger";
import {
  NOTICE_PROSE_LIMIT,
  SUBAGENT_ANSWER_NOTICE_LIMIT,
  SUBAGENT_OUTCOME_STATES,
  WATCH_ANSWER_NOTICE_LIMIT,
  type NoticeAnswer,
  type NoticeProse,
  type SubagentOutcomeState,
  type WatchChangeV1,
  type WatchTicketActor,
} from "../session-notice";
import {
  SUBAGENT_NOTICE_COMMAND_ID_SUFFIX,
  type SubagentNoticeReason,
} from "../session-host-notice";
import { SESSION_STOP_CATEGORIES, type SessionStopDetail } from "../session-stop";
import { TICKET_STATUSES, type TicketStatus } from "../ticket";
import { TICKET_SIGNAL_KINDS, TICKET_SIGNAL_VERDICTS } from "../ticket-events";
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

/**
 * Start a subagent Session for a parent Session's tool call. The job's
 * `sessionId` is the CHILD, claimed on the runner that will run it (which may
 * not be the parent's), so the job routes like every other Session job.
 */
export interface SessionDelegatePayload {
  parentSessionId: SessionId;
  /** The parent's tool call: a frozen derived id, unique within the parent. */
  toolCallId: string;
  /** The child's `session.create` command id, so a re-delivered job creates it once. */
  createCommandId: string;
  /** How deep the child is (1 for a child of a root Session). */
  depth: number;
  /** The brief, as a transcript artifact reference (the body stays in the artifact store). */
  kickoff: JobArtifactReference;
  title: string | null;
  /** The model the child runs on; `null` takes the runner's default for a subagent. */
  model: JobModelChoice | null;
}

/** A transcript artifact reference, as `TranscriptReference` in the Session ledger. */
export interface JobArtifactReference {
  id: string;
  mediaType: string | null;
  digest: string | null;
}

export interface JobModelChoice {
  providerId: string;
  modelId: string;
  reasoningLevel: string | null;
}

/**
 * A notice for a Session (VC-887): changes to work it watches, or its
 * subagent's answer. The runner composes the text (`composeSessionNotice`)
 * when it puts the notice into its outbox, so the payload carries structured
 * facts and other authors' words in their own fields, never pre-composed text.
 */
export const SESSION_NOTICE_FORMAT = "volli.session-notice/1";

/** The most changes one queued watch notice lists; later ones are counted in `overflow`. */
export const WATCH_NOTICE_MAX_CHANGES = 50;

/** The most pending subagents one watch change names. */
export const WATCH_CHANGE_MAX_PENDING = 100;

/** The longest Ticket display id a watch change carries. */
export const WATCH_DISPLAY_MAX_CHARS = 64;

/**
 * Changes to the work the job's Session watches, delivered as one notice. The
 * `commandId` keeps the local shape `watch:{watcherSessionId}:{uuid}` and is
 * also the job's id.
 */
export interface WatchNoticeJobPayload {
  format: typeof SESSION_NOTICE_FORMAT;
  notice: "watch";
  commandId: string;
  changes: WatchChangeV1[];
  /** Changes that arrived after `changes` was full: counted, not listed. */
  overflow: number;
}

/**
 * A subagent's outcome, delivered to its parent (the job's Session). The
 * `commandId` is the delegation's frozen `{operationId}:answer` (or a resumed
 * turn's `{operationId}:resume:{turnId}:answer`), so a parent hears one answer
 * whichever path delivers it first.
 *
 * Its backend producer is VC-696 (S5): the delegations projection enqueues it
 * when a child settles. This ticket (VC-887) types it, parses it and composes
 * it on the runner; nothing enqueues it before VC-696 lands.
 */
export interface SubagentNoticeJobPayload {
  format: typeof SESSION_NOTICE_FORMAT;
  notice: "subagent";
  commandId: string;
  childSessionId: SessionId;
  title: string;
  state: SubagentOutcomeState;
  reason: SubagentNoticeReason | null;
  stoppedBy: SessionStopActor | null;
  stopDetail: SessionStopDetail | null;
  /** The child's final message, cut at `SUBAGENT_ANSWER_NOTICE_LIMIT`. */
  answer: NoticeAnswer;
}

export type SessionNoticeJobPayload = WatchNoticeJobPayload | SubagentNoticeJobPayload;

/** The longest Session title a job carries. */
export const JOB_TITLE_MAX_CHARS = 200;

/** Legacy enqueue-only arrival shape. Kept until the board arrival producer is upgraded. */
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

/** Producer-minted identity: retained across supersede and lease retries. */
interface AutomationRunJobBase {
  runId: string;
  sessionId: SessionId;
  dueAt: number;
  /** Superseded occurrences represented by the associated gap, not extra Runs to execute. */
  missedCount: number;
  attendance: AutomationRunAttendance;
  modelOverride: ModelSelection | null;
  requestedBySessionId: SessionId | null;
}

/** The executable contract. The clock/Run producer upgrades arrivals before the executor advertises the capability. */
export type AutomationRunJobPayload =
  | (AutomationRunJobBase & AutomationArrivalRunPayload)
  | (AutomationRunJobBase & {
      trigger: "schedule";
      automationId: AutomationId;
      ticketId: null;
      armedByUserId: UserId;
      attendance: "unattended";
      modelOverride: null;
      requestedBySessionId: null;
    })
  | (AutomationRunJobBase & {
      trigger: "manual";
      ticketId: TicketId | null;
      armedByUserId: null;
    } & (
        | { automationId: AutomationId }
        | { automationId: null; ticketId: TicketId; instructions: string }
      ));

/** Legacy arrivals are parseable, but MUST NOT be executed without producer-minted ids. */
export type AutomationRunPayload = AutomationArrivalRunPayload | AutomationRunJobPayload;

/** The executor uses this AFTER parseJobPayload; legacy arrivals are upgraded or drained, never executed. */
export function isExecutableAutomationRun(
  payload: AutomationRunPayload,
): payload is AutomationRunJobPayload {
  return "runId" in payload;
}

/** A payload no owning ticket has typed yet: an opaque JSON object. */
export type JobPayloadObject = { readonly [field: string]: unknown };

/** Kind-specific payloads. Opaque kinds are typed by the ticket that owns them. */
export interface JobPayloads {
  "session.start": JobPayloadObject;
  "session.command": SessionCommandJobPayload | SessionInterruptJobPayload;
  "session.followUp": SessionFollowUpJobPayload;
  "session.notice": SessionNoticeJobPayload;
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
  private readonly kind: JobKind;
  readonly row: Row;
  private readonly prefix: string;

  constructor(kind: JobKind, row: Row, prefix = "") {
    this.kind = kind;
    this.row = row;
    this.prefix = prefix;
  }

  fail(detail: string): never {
    throw new InvalidJobPayloadError(this.kind, `${this.prefix}${detail}`);
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

  text(name: string, max: number): string {
    const value = this.row[name];
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
      this.fail(`${name} is not text of 1 to ${max} characters`);
    }
    return value;
  }

  nullableText(name: string, max: number): string | null {
    return this.row[name] === null ? null : this.text(name, max);
  }

  nested<T>(name: string, read: (reader: Reader) => T): T {
    const value = this.row[name];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.fail(`${name} is not an object`);
    }
    return read(new Reader(this.kind, value as Row, `${this.prefix}${name}.`));
  }

  /** A string of 0 to `max` characters. */
  string(name: string, max: number): string {
    const value = this.row[name];
    if (typeof value !== "string" || value.length > max) {
      this.fail(`${name} is not a string of at most ${max} characters`);
    }
    return value;
  }

  nullableNested<T>(name: string, read: (reader: Reader) => T): T | null {
    return this.row[name] === null ? null : this.nested(name, read);
  }

  /** A list of at most `max` items, each read by `read` under `name[i]`. */
  list<T>(name: string, max: number, read: (reader: Reader, index: string) => T): T[] {
    const value = this.row[name];
    if (!Array.isArray(value) || value.length > max) {
      this.fail(`${name} is not a list of at most ${max} items`);
    }
    const items = value as unknown[];
    const row: Row = Object.fromEntries(items.map((item, i) => [`${name}[${i}]`, item]));
    const reader = new Reader(this.kind, row, this.prefix);
    return items.map((_, i) => read(reader, `${name}[${i}]`));
  }

  /** A non-negative safe integer (epoch milliseconds, counts). */
  count(name: string): number {
    const value = this.row[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      this.fail(`${name} is not a non-negative integer`);
    }
    return value;
  }

  nullableCount(name: string): number | null {
    return this.row[name] === null ? null : this.count(name);
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
      r.only(
        "parentSessionId",
        "toolCallId",
        "createCommandId",
        "depth",
        "kickoff",
        "title",
        "model",
      );
      return {
        parentSessionId: r.uuid<SessionId>("parentSessionId"),
        toolCallId: r.derived("toolCallId"),
        createCommandId: r.derived("createCommandId"),
        depth: r.positiveInteger("depth"),
        kickoff: r.nested("kickoff", (k) => {
          k.only("id", "mediaType", "digest");
          return {
            id: k.derived("id"),
            mediaType: k.nullableText("mediaType", 200),
            digest: k.nullableText("digest", 200),
          };
        }),
        title: r.nullableText("title", JOB_TITLE_MAX_CHARS),
        model:
          r.row.model === null
            ? null
            : r.nested("model", (m) => {
                m.only("providerId", "modelId", "reasoningLevel");
                return {
                  providerId: m.text("providerId", 200),
                  modelId: m.text("modelId", 200),
                  reasoningLevel: m.nullableText("reasoningLevel", 50),
                };
              }),
      } satisfies SessionDelegatePayload;
    case "automation.run":
      return parseAutomationRun(r);
    case "session.notice":
      return parseSessionNotice(r);
    case "session.start":
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

function parseAutomationRun(r: Reader): AutomationRunPayload {
  const trigger = r.oneOf("trigger", ["arrival", "schedule", "manual"]);
  const arrivalFields = ["from", "status", "origin"];
  const common = ["trigger", "automationId", "ticketId", "armedByUserId"];
  // The existing gated producer writes legacy arrivals. Partial executable metadata
  // is corruption, not permission to mint new identities on the runner.
  if (trigger === "arrival" && !("runId" in r.row)) {
    r.only(...common, ...arrivalFields);
    return parseArrival(r);
  }
  r.only(
    ...common,
    "runId",
    "sessionId",
    "dueAt",
    "missedCount",
    "attendance",
    "modelOverride",
    "requestedBySessionId",
    ...(trigger === "arrival"
      ? arrivalFields
      : trigger === "manual" && r.row.automationId === null
        ? ["instructions"]
        : []),
  );
  const base: AutomationRunJobBase = {
    runId: r.uuid("runId"),
    sessionId: r.uuid<SessionId>("sessionId"),
    dueAt: r.count("dueAt"),
    missedCount: r.count("missedCount"),
    attendance: r.oneOf("attendance", AUTOMATION_RUN_ATTENDANCE),
    requestedBySessionId: r.nullableUuid<SessionId>("requestedBySessionId"),
    modelOverride: r.nullableNested("modelOverride", (m) => {
      m.only("providerId", "modelId", "reasoningLevel");
      return {
        providerId: m.text("providerId", 200),
        modelId: m.text("modelId", 200),
        reasoningLevel: m.oneOf("reasoningLevel", REASONING_LEVELS),
      };
    }),
  };
  if (trigger === "arrival") return { ...base, ...parseArrival(r) };
  if (trigger === "schedule") {
    if (r.row.ticketId !== null) r.fail("a schedule targets the project");
    if (
      base.attendance !== "unattended" ||
      base.modelOverride !== null ||
      base.requestedBySessionId !== null
    )
      r.fail("a schedule is unattended and has no caller override or watch");
    return {
      ...base,
      attendance: "unattended",
      modelOverride: null,
      requestedBySessionId: null,
      trigger,
      automationId: r.uuid<AutomationId>("automationId"),
      ticketId: null,
      armedByUserId: r.uuid<UserId>("armedByUserId"),
    };
  }
  if (r.row.armedByUserId !== null) r.fail("a manual run uses the caller's credentials");
  const manual = {
    ...base,
    trigger,
    ticketId: r.nullableUuid<TicketId>("ticketId"),
    armedByUserId: null,
  } as const;
  if (r.row.automationId !== null)
    return { ...manual, automationId: r.uuid<AutomationId>("automationId") };
  const instructions = r.text("instructions", AUTOMATION_INSTRUCTIONS_MAX_CHARS);
  if (instructions.trim().length === 0) r.fail("instructions are blank");
  if (manual.ticketId === null) r.fail("an unbound run targets a ticket");
  return { ...manual, ticketId: manual.ticketId, automationId: null, instructions };
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

function parseSessionNotice(r: Reader): SessionNoticeJobPayload {
  r.oneOf("format", [SESSION_NOTICE_FORMAT]);
  const notice = r.oneOf("notice", ["watch", "subagent"]);
  const commandId = r.derived("commandId");
  if (notice === "watch") {
    r.only("format", "notice", "commandId", "changes", "overflow");
    if (!commandId.startsWith("watch:")) r.fail("commandId is not a watch notice id");
    return {
      format: SESSION_NOTICE_FORMAT,
      notice,
      commandId,
      changes: r.list("changes", WATCH_NOTICE_MAX_CHANGES, (list, at) =>
        list.nested(at, readChange),
      ),
      overflow: r.count("overflow"),
    };
  }
  r.only(
    "format",
    "notice",
    "commandId",
    "childSessionId",
    "title",
    "state",
    "reason",
    "stoppedBy",
    "stopDetail",
    "answer",
  );
  if (!commandId.endsWith(SUBAGENT_NOTICE_COMMAND_ID_SUFFIX)) {
    r.fail("commandId is not a subagent answer id");
  }
  return {
    format: SESSION_NOTICE_FORMAT,
    notice,
    commandId,
    childSessionId: r.uuid<SessionId>("childSessionId"),
    title: r.string("title", JOB_TITLE_MAX_CHARS),
    state: r.oneOf("state", SUBAGENT_OUTCOME_STATES),
    reason: r.row.reason === null ? null : r.oneOf("reason", ["app-relaunched"]),
    stoppedBy: r.nullableNested("stoppedBy", readStopActor),
    stopDetail: r.nullableNested("stopDetail", readStopDetail),
    answer: r.nested("answer", (a) => readAnswer(a, SUBAGENT_ANSWER_NOTICE_LIMIT)),
  };
}

function readChange(r: Reader): WatchChangeV1 {
  const subject = r.oneOf("subject", ["session", "ticket"]);
  const occurred = () => r.nullableCount("occurredAt");
  if (subject === "ticket") {
    const fact = r.oneOf("fact", ["ticket-moved", "ticket-commented", "ticket-signaled"]);
    const base = () => ({
      subject,
      ticketId: r.uuid<TicketId>("ticketId"),
      display: r.text("display", WATCH_DISPLAY_MAX_CHARS),
      by: r.nested("by", readTicketActor),
      occurredAt: occurred(),
    });
    const common = ["subject", "fact", "ticketId", "display", "by", "occurredAt"];
    switch (fact) {
      case "ticket-moved":
        r.only(...common, "from", "to");
        return {
          ...base(),
          fact,
          from: r.oneOf("from", TICKET_STATUSES),
          to: r.oneOf("to", TICKET_STATUSES),
        };
      case "ticket-commented":
        r.only(...common, "comment");
        return {
          ...base(),
          fact,
          comment: r.nullableNested("comment", readProse(NOTICE_PROSE_LIMIT)),
        };
      case "ticket-signaled":
        r.only(...common, "signalKind", "verdict", "detail");
        return {
          ...base(),
          fact,
          signalKind: r.oneOf("signalKind", TICKET_SIGNAL_KINDS),
          verdict: r.oneOf("verdict", TICKET_SIGNAL_VERDICTS),
          detail: r.nullableNested("detail", readProse(NOTICE_PROSE_LIMIT)),
        };
    }
  }
  const fact = r.oneOf("fact", [
    "turn-completed",
    "turn-interrupted",
    "signaled-done",
    "signaled-blocked",
    "stopped",
  ]);
  const base = () => ({
    subject,
    sessionId: r.uuid<SessionId>("sessionId"),
    title: r.row.title === null ? null : r.string("title", JOB_TITLE_MAX_CHARS),
    occurredAt: occurred(),
  });
  const pending = () =>
    r.list("pendingSubagents", WATCH_CHANGE_MAX_PENDING, (list, at) => list.uuid<SessionId>(at));
  const lastMessage = () =>
    r.nested("lastMessage", (a) => readAnswer(a, WATCH_ANSWER_NOTICE_LIMIT));
  const common = ["subject", "fact", "sessionId", "title", "occurredAt"];
  switch (fact) {
    case "turn-completed":
      r.only(...common, "pendingSubagents", "lastMessage");
      return { ...base(), fact, pendingSubagents: pending(), lastMessage: lastMessage() };
    case "turn-interrupted":
      r.only(...common, "pendingSubagents", "stopDetail", "lastMessage");
      return {
        ...base(),
        fact,
        pendingSubagents: pending(),
        stopDetail: r.nullableNested("stopDetail", readStopDetail),
        lastMessage: lastMessage(),
      };
    case "signaled-done":
    case "signaled-blocked":
      r.only(...common, "pendingSubagents", "reason");
      return {
        ...base(),
        fact,
        pendingSubagents: pending(),
        reason: r.nullableNested("reason", readProse(NOTICE_PROSE_LIMIT)),
      };
    case "stopped":
      r.only(...common, "by", "reason");
      return {
        ...base(),
        fact,
        by: r.nested("by", readStopActor),
        reason: r.nullableNested("reason", readProse(NOTICE_PROSE_LIMIT)),
      };
  }
}

function readProse(max: number): (r: Reader) => NoticeProse {
  return (r) => {
    r.only("text", "totalChars");
    const text = r.string("text", max);
    const totalChars = r.count("totalChars");
    if (totalChars < text.length) r.fail("totalChars is shorter than text");
    return { text, totalChars };
  };
}

function readAnswer(r: Reader, max: number): NoticeAnswer {
  const state = r.oneOf("state", ["unread", "none", "unreadable", "text"]);
  switch (state) {
    case "unread":
    case "none":
      r.only("state");
      return { state };
    case "unreadable":
      r.only("state", "error");
      return { state, error: r.nullableText("error", 1_000) };
    case "text":
      r.only("state", "message");
      return { state, message: r.nested("message", readProse(max)) };
  }
}

function readStopActor(r: Reader): SessionStopActor {
  const kind = r.oneOf("kind", ["session", "user", "watchdog"]);
  if (kind === "session") {
    r.only("kind", "sessionId");
    return { kind, sessionId: r.uuid<SessionId>("sessionId") };
  }
  r.only("kind");
  return { kind };
}

function readTicketActor(r: Reader): WatchTicketActor {
  const kind = r.oneOf("kind", ["person", "session", "automation", "volli", "unauthenticated"]);
  if (kind === "session") {
    r.only("kind", "sessionId");
    return { kind, sessionId: r.nullableUuid<SessionId>("sessionId") };
  }
  r.only("kind");
  return { kind };
}

function readStopDetail(r: Reader): SessionStopDetail {
  r.only("category", "message", "providerType", "httpStatus", "retry", "resetsAt");
  return {
    category: r.oneOf("category", SESSION_STOP_CATEGORIES),
    message: r.row.message === null ? null : r.string("message", NOTICE_PROSE_LIMIT),
    providerType: r.row.providerType === null ? null : r.string("providerType", 200),
    httpStatus: r.nullableCount("httpStatus"),
    retry: r.oneOf("retry", ["not-retried", "exhausted"]),
    resetsAt: r.nullableCount("resetsAt"),
  };
}
