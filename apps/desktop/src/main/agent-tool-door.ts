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
import type {
  TicketSessionDelegation,
  TicketSessionDelegationClaims,
} from "./session-runtime/delegation-policy";
import { sessionCreateCommandId } from "./session-runtime/sessions";
import { startSessionModelOverride, startSessionOperation } from "./session-runtime/start-session";
import type { StartSessionPorts } from "./session-runtime/start-session";

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
  /** Durable own-ticket claims for Ticket Role's birth grants (VC-183). */
  delegation: TicketSessionDelegationClaims;
  /** The caller's project policy, read per call — `ticket.await` judges its wait when it starts. */
  authorityPolicy: (projectId: string) => AuthorityPolicy;
  /** The post-commit wake bus (`ticket-wake.ts`, VC-85 slice C) `ticket.await` parks on. */
  subscribeTicketWake: SubscribeTicketWake;
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

  // Trusted caller identity plus the runtime's own call id, and never a fresh
  // random one. Every durable write in the start is keyed on this, so replaying
  // one tool call lands one Session, one kickoff and one `session_started`
  // rather than a second set of all three.
  const operationId = `${session.sessionId}:${request.toolCallId}`;
  const claimRef = { parentSessionId: session.sessionId, toolCallId: request.toolCallId };

  // Project Sessions retain the existing project-wide control bound. A Ticket
  // Session only reaches this handler because its frozen birth surface carried
  // a stored `session.start` grant, and that grant's scope is narrower than the
  // generic project lookup above: exactly its attached Ticket.
  let delegation: TicketSessionDelegation | undefined;
  if (session.role === "ticket") {
    if (resolved.ticket.id !== session.ticketId) {
      return refusal("This Ticket Session can only start Sessions on its own Ticket.");
    }
    const claimed = options.delegation.claimStart({
      ...claimRef,
      ticketId: session.ticketId,
      createCommandId: sessionCreateCommandId(operationId),
    });
    if (!claimed.ok) {
      return refusal(
        claimed.reason === "limit"
          ? `This Ticket Session has already started the ${claimed.maxChildren} Sessions its in-ticket delegation allows.`
          : "This Ticket Session was not granted in-ticket delegation when it started.",
      );
    }
    delegation = claimed.delegation;
  } else if (options.delegation.startGrantScope(session.sessionId) !== null) {
    // Born a Ticket Session, presenting as a ticketless one. Deleting a Ticket
    // sets `sessions.ticket_id` to NULL, and the frozen tool surface is replayed
    // rather than re-derived — so without this the Session would keep a
    // `session.start` it was granted under an own-ticket bound and be judged by
    // the project-wide one instead. The durable grant outlives the Ticket
    // precisely so this refusal can exist.
    return refusal(
      "This Session's start authority is scoped to its own Ticket, which is no longer attached, so nothing was started.",
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
        operationId,
        project: resolved.project,
        ticket: resolved.ticket,
        ...(message.value === undefined ? {} : { message: message.value }),
        ...(title.value === undefined ? {} : { title: title.value }),
        ...(() => {
          const built = startSessionModelOverride(override.model, override.reasoning);
          return built === undefined ? {} : { modelOverride: built };
        })(),
        ...(delegation === undefined ? {} : { delegation }),
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
    // A failure before the Session's create command is durable must not burn a
    // fan-out slot. Once create exists, replay owns recovery and the claim stays
    // put — a later retry records the same child's birth grant rather than
    // starting another Session. The ledger reads that evidence off the claim it
    // stored, so this call does not restate how a create id is spelled.
    if (delegation !== undefined) options.delegation.releaseIfUnstarted(claimRef);
    // A refusal the facade named is still an answer about the request, so the
    // model gets its words. Anything else is a host that could not carry out
    // the start at all, and that fails the call.
    if (error instanceof StructuredSessionsError) {
      return refusal(`Volli refused to start the Session: ${error.message}`);
    }
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
