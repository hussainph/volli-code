/**
 * The Agent Tool Surface's door into main (VC-162).
 *
 * `agent-dispatch/` answers the socket; this answers named tool calls from
 * inside the Agent Runtime. They are two doors onto one set of verbs, not two
 * implementations of them: both reach the same application handler, and the
 * Verb Registry's `VerbEntry.handler` binding is what says so.
 *
 * ## What this door has that the socket cannot have
 *
 * A caller it did not have to believe. The socket derives `user` versus
 * `session` from `VOLLI_SESSION` in the request environment, which any process
 * running as the user can set; it attributes its caller and cannot authenticate
 * one. Here the caller arrives as {@link RuntimeSessionIdentity}, closed over by
 * the adapter from the attachment the call came through. Nothing in the tool's
 * input names a Session, a project or an actor, and nothing could: the schema
 * has no field for it.
 *
 * That is the property VC-92 built the control tier around, and it is what makes
 * the caller's project a *bound* rather than a filter. A Session may start work
 * on Tickets in the project it belongs to. It cannot name a Ticket in another
 * project, because the resolution below is scoped to the one project the
 * attachment is in, before any display id is parsed.
 *
 * ## Refusals are text
 *
 * The socket has an error-code vocabulary that `volli help exit-codes` renders
 * and scripts branch on. A model has none of that: it reads the result. So a
 * refusal here is an ordinary tool result carrying a sentence the model can act
 * on — the line `web_fetch` already draws between a refusal (the policy working,
 * the model's move) and a host that could not answer at all (a failed call).
 */

import type Database from "better-sqlite3";
import {
  autoTitleFromKickoff,
  DEFAULT_KICKOFF_MESSAGE,
  REASONING_LEVELS,
  shortSessionId,
} from "@volli/shared";
import type {
  AuthorityPolicy,
  Project,
  ReasoningLevel,
  RuntimeSessionIdentity,
  RuntimeVerbCall,
  RuntimeVerbResult,
  TicketEventActor,
  VerbToolKey,
} from "@volli/shared";

import { ticketForDisplayId } from "./agent-dispatch/resolution";
import { awaitTicketTool } from "./agent-await";
import type { SubscribeTicketWake } from "./agent-await";
import { StructuredSessionsError } from "./session-runtime/sessions";
import { startSessionModelOverride, startSessionOperation } from "./session-runtime/start-session";
import type { StartSessionPorts } from "./session-runtime/start-session";
import {
  sendSessionMessageOperation,
  stopSessionOperation,
  SuperviseSessionError,
} from "./session-runtime/supervise-session";
import type { SuperviseSessionPorts } from "./session-runtime/supervise-session";

/**
 * What the door reaches, resolved per call rather than captured.
 *
 * `projects` and `sessions` are functions because both change after this is
 * built: a project can be added while a Session runs, and the facade is
 * composed later in main's own startup order. Capturing either would freeze an
 * answer that is only true at boot.
 */
export interface AgentToolDoorOptions extends Omit<
  StartSessionPorts,
  "db" | "projects" | "sessions" | "actorTicketDisplay"
> {
  db: Database.Database;
  projects: () => readonly Project[];
  sessions: () => StartSessionPorts["sessions"] | null;
  actorTicketDisplay: StartSessionPorts["actorTicketDisplay"];
  /** The caller's project policy, read per call — `ticket.await` judges its wait when it starts. */
  authorityPolicy: (projectId: string) => AuthorityPolicy;
  /** The post-commit wake bus (`ticket-wake.ts`, VC-85 slice C) `ticket.await` parks on. */
  subscribeTicketWake: SubscribeTicketWake;
  /**
   * The supervision operations' ports (VC-86), resolved per call like the
   * Sessions facade: the runtime is composed after this door is. `null` reads
   * as "no structured runtime this launch" and each tool refuses in words.
   */
  supervise: () => SuperviseSessionPorts | null;
}

/** A refusal the model reads and can act on. Never a thrown error. */
function refusal(text: string): RuntimeVerbResult {
  return { text };
}

/** One optional string field, trimmed, or a refusal naming the field. */
function optionalText(
  input: Readonly<Record<string, unknown>>,
  field: string,
): { ok: true; value: string | undefined } | { ok: false; text: string } {
  const raw = input[field];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, text: `\`${field}\` must be a non-empty string when given.` };
  }
  return { ok: true, value: raw };
}

/** The model override halves, validated the way the socket door validates them. */
function readModelOverride(input: Readonly<Record<string, unknown>>):
  | { ok: true; model?: { providerId: string; modelId: string }; reasoning?: ReasoningLevel }
  | {
      ok: false;
      text: string;
    } {
  const rawModel = input.model;
  let model: { providerId: string; modelId: string } | undefined;
  if (rawModel !== undefined && rawModel !== null) {
    const candidate = rawModel as { providerId?: unknown; modelId?: unknown };
    if (typeof candidate.providerId !== "string" || typeof candidate.modelId !== "string") {
      return { ok: false, text: "`model` needs both `providerId` and `modelId` as strings." };
    }
    model = { providerId: candidate.providerId, modelId: candidate.modelId };
  }
  const rawReasoning = input.reasoning;
  let reasoning: ReasoningLevel | undefined;
  if (rawReasoning !== undefined && rawReasoning !== null) {
    if (!(REASONING_LEVELS as readonly unknown[]).includes(rawReasoning)) {
      return {
        ok: false,
        text: `\`reasoning\` must be one of: ${REASONING_LEVELS.join(", ")}.`,
      };
    }
    reasoning = rawReasoning as ReasoningLevel;
  }
  return {
    ok: true,
    ...(model === undefined ? {} : { model }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/**
 * The calling Session, as the actor a planner event records.
 *
 * Always `session`, and never `user`: something called a tool, and the one
 * thing this door knows for certain is which Session's attachment it came
 * through. The socket's "no env means the user did it" \u2014 the highest-trust
 * actor granted by absence of evidence \u2014 has no equivalent here, because there
 * is no absence to read.
 */
function callerActor(session: RuntimeSessionIdentity): TicketEventActor {
  return { kind: "session", sessionId: session.sessionId, ticketId: session.ticketId };
}

async function startSessionTool(
  options: AgentToolDoorOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  // Starting a Session is not withdrawable mid-flight: by the time an abort
  // could be read the Session either durably exists or never did, and a
  // half-honoured cancel would strand the very record the operation id
  // protects. The wait family is where the signal earns its keep.
  _signal: AbortSignal,
): Promise<RuntimeVerbResult> {
  const sessions = options.sessions();
  if (sessions === null) {
    return refusal("Volli's Session runtime is not available this launch, so nothing was started.");
  }
  const ticketArg = request.input.ticket;
  if (typeof ticketArg !== "string" || ticketArg.trim().length === 0) {
    return refusal("`ticket` must be a Ticket display id, for example VC-12.");
  }
  const message = optionalText(request.input, "message");
  if (!message.ok) return refusal(message.text);
  const title = optionalText(request.input, "title");
  if (!title.ok) return refusal(title.text);
  const override = readModelOverride(request.input);
  if (!override.ok) return refusal(override.text);

  // Scoped to the caller's own project BEFORE the display id is parsed. This is
  // the authority bound, not a convenience: a Session cannot name a Ticket
  // outside the project its attachment belongs to, because no other project is
  // ever a candidate.
  const project = options.projects().find(({ id }) => id === session.projectId);
  if (project === undefined) {
    return refusal("This Session's project is no longer registered, so nothing was started.");
  }
  const resolved = ticketForDisplayId(options.db, [project], ticketArg.trim());
  if (!resolved.ok) {
    const reason = resolved.response.ok ? "" : ` ${resolved.response.error.message}`;
    return refusal(
      `No Ticket ${ticketArg.trim()} in this project, so nothing was started.${reason}`,
    );
  }

  try {
    const started = await startSessionOperation(
      {
        db: options.db,
        projects: options.projects(),
        sessions,
        submitSessionMessage: options.submitSessionMessage,
        refineAutoTitle: options.refineAutoTitle,
        onMutation: options.onMutation,
        onSessionStarted: options.onSessionStarted,
        actorTicketDisplay: options.actorTicketDisplay,
        now: options.now,
      },
      {
        // Trusted caller identity plus the runtime's own call id, and never a
        // fresh random one. Every durable write in the start is keyed on this,
        // so replaying one tool call lands one Session, one kickoff and one
        // `session_started` rather than a second set of all three.
        operationId: `${session.sessionId}:${request.toolCallId}`,
        project: resolved.project,
        ticket: resolved.ticket,
        ...(message.value === undefined ? {} : { message: message.value }),
        ...(title.value === undefined ? {} : { title: title.value }),
        ...(() => {
          const built = startSessionModelOverride(override.model, override.reasoning);
          return built === undefined ? {} : { modelOverride: built };
        })(),
        actor: callerActor(session),
      },
      { defaultKickoff: DEFAULT_KICKOFF_MESSAGE, autoTitle: autoTitleFromKickoff },
    );
    // The short public handle, exactly as the socket answers with: a full UUID
    // is not a thing any other Volli surface accepts back, so handing one to a
    // model would be handing it an id it cannot use.
    const handle = shortSessionId(started.sessionId);
    return {
      text: [
        `Started Session ${handle} on ${started.ticketDisplayId}, titled ${JSON.stringify(started.title)}.`,
        `Model: ${started.model.providerId}/${started.model.modelId} at reasoning ${started.model.reasoningLevel}.`,
        started.state === "ready"
          ? "It is attached and its kickoff turn has been submitted. It runs on its own from here and does not report back into this Session; use `volli session peek` to look in on it."
          : "It was created but its attachment needs recovery, so no kickoff was submitted. A person can retry it from the app.",
      ].join("\n"),
    };
  } catch (error) {
    // A refusal the facade named is still an answer about the request, so the
    // model gets its words. Anything else is a host that could not carry out
    // the start at all, and that fails the call.
    if (error instanceof StructuredSessionsError) {
      return refusal(`Volli refused to start the Session: ${error.message}`);
    }
    throw error;
  }
}

/** One required string field, trimmed, or a refusal naming the field. */
function requiredText(
  input: Readonly<Record<string, unknown>>,
  field: string,
  example: string,
): { ok: true; value: string } | { ok: false; text: string } {
  const raw = input[field];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, text: `\`${field}\` must be ${example}.` };
  }
  return { ok: true, value: raw.trim() };
}

async function stopSessionTool(
  options: AgentToolDoorOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  // Not withdrawable mid-flight for the same reason a start is not: by the
  // time an abort could be read, the stop fact either durably exists or never
  // did, and a half-honoured cancel would strand the record.
  _signal: AbortSignal,
): Promise<RuntimeVerbResult> {
  const ports = options.supervise();
  if (ports === null) {
    return refusal("Volli's Session runtime is not available this launch, so nothing was stopped.");
  }
  const handle = requiredText(
    request.input,
    "session",
    "a short session id, as `volli session list` prints it",
  );
  if (!handle.ok) return refusal(handle.text);
  const reason = optionalText(request.input, "reason");
  if (!reason.ok) return refusal(reason.text);
  try {
    const outcome = await stopSessionOperation(ports, {
      // The caller's identity plus the runtime's own call id (VC-162's
      // discipline): a replayed tool call finds its own stop already recorded
      // instead of writing a second one.
      operationId: `${session.sessionId}:${request.toolCallId}`,
      callerSessionId: session.sessionId,
      projectId: session.projectId,
      handle: handle.value,
      ...(reason.value === undefined ? {} : { reason: reason.value }),
    });
    const acts =
      outcome.interrupted && outcome.released
        ? "Its open turn was interrupted and its executor released."
        : outcome.released
          ? "Its executor was released; no turn was open."
          : "Nothing was live to interrupt or release.";
    return {
      text: [
        outcome.previouslyStopped
          ? `Session ${outcome.handle}${outcome.title === null ? "" : ` (${JSON.stringify(outcome.title)})`} was already recorded as stopped; retried its live executor.`
          : `Stopped Session ${outcome.handle}${outcome.title === null ? "" : ` (${JSON.stringify(outcome.title)})`}, recorded as stopped by this Session.`,
        acts,
        ...outcome.failures,
        "Its history stays openable, and a person can reattach it.",
      ].join(" "),
    };
  } catch (error) {
    if (error instanceof SuperviseSessionError) return refusal(error.message);
    throw error;
  }
}

async function sendSessionTool(
  options: AgentToolDoorOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  _signal: AbortSignal,
): Promise<RuntimeVerbResult> {
  const ports = options.supervise();
  if (ports === null) {
    return refusal("Volli's Session runtime is not available this launch, so nothing was sent.");
  }
  const handle = requiredText(
    request.input,
    "session",
    "a short session id, as `volli session list` prints it",
  );
  if (!handle.ok) return refusal(handle.text);
  const message = requiredText(request.input, "message", "the steering text to deliver");
  if (!message.ok) return refusal(message.text);
  try {
    const outcome = await sendSessionMessageOperation(ports, {
      operationId: `${session.sessionId}:${request.toolCallId}`,
      callerSessionId: session.sessionId,
      projectId: session.projectId,
      handle: handle.value,
      message: message.value,
    });
    return {
      text: [
        `Steering delivered into Session ${outcome.handle}${outcome.title === null ? "" : ` (${JSON.stringify(outcome.title)})`}, marked as coming from this Session.`,
        outcome.midTurn
          ? "A turn was open, so the model reads it mid-stream."
          : "No turn was open, so it opens one.",
        "Nothing reports back into this Session; use `volli session peek` to observe the effect.",
      ].join(" "),
    };
  } catch (error) {
    if (error instanceof SuperviseSessionError) return refusal(error.message);
    throw error;
  }
}

/**
 * The verb-to-handler binding for this door, total over what a bundle can hold.
 *
 * A `Record` over {@link VerbToolKey} rather than a switch with a default, so
 * the day a second verb takes a `tool` access mode this file stops compiling
 * until it has a handler. That is the same discipline `AGENT_VERB_TABLE` holds
 * for the socket, and the reason is the same: a declared verb with no binding
 * is a tool a Session is handed and then cannot call.
 */
type VerbToolHandlers = Record<
  VerbToolKey,
  (
    options: AgentToolDoorOptions,
    session: RuntimeSessionIdentity,
    request: RuntimeVerbCall,
    signal: AbortSignal,
  ) => Promise<RuntimeVerbResult>
>;

const VERB_TOOL_HANDLERS: VerbToolHandlers = {
  "session.start": startSessionTool,
  "session.stop": stopSessionTool,
  "session.send": sendSessionTool,
  "ticket.await": (options, session, request, signal) =>
    awaitTicketTool(
      {
        db: options.db,
        projects: options.projects,
        authorityPolicy: options.authorityPolicy,
        subscribeTicketWake: options.subscribeTicketWake,
      },
      session,
      request,
      signal,
    ),
};

/**
 * The one closure the Pi adapter hands every attachment that holds a verb.
 *
 * Named so main can declare the binding before it can build it: the door is
 * composed from the Sessions facade, which is composed after the adapter that
 * calls the door.
 */
export type AgentToolDoor = (
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  signal: AbortSignal,
) => Promise<RuntimeVerbResult>;

/** Build the one closure the Pi adapter hands every attachment that holds a verb. */
export function createAgentToolDoor(options: AgentToolDoorOptions): AgentToolDoor {
  return async (session, request, signal) => {
    const handler = VERB_TOOL_HANDLERS[request.verb];
    if (handler === undefined) {
      // Unreachable through a resolved surface, and refused rather than
      // asserted: a tool array is built from the same registry this table is
      // total over, so arriving here means the two disagreed.
      return refusal(`${request.verb} is not a verb this build can run.`);
    }
    return handler(options, session, request, signal);
  };
}
