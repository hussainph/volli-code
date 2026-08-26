/**
 * Starting a Ticket Session, as one application act with two doors (VC-162).
 *
 * The Verb Registry's rule is that one verb has one binding — `VerbEntry.handler`
 * names it, and VC-167 wrote down why: *"when VC-162 flips `session.start` to a
 * `tool` access mode, the tool surface resolves the SAME `session.start` binding
 * rather than growing a second implementation of the verb."* This module is that
 * binding's application half, lifted out of `sessionStartVerb` so the socket and
 * the Agent Tool Surface can both reach it.
 *
 * What stayed behind in each door is exactly what differs between them: argv
 * parsing and an `AgentResponse` envelope on the socket side, a schema-checked
 * object and a block of text on the tool side. What moved here is everything
 * they were doing identically — the facade call, the kickoff, the auto-title
 * refinement, the mutation fan-out and the start notice.
 *
 * ## Caller identity is the real difference between the doors
 *
 * The socket ATTRIBUTES its caller and cannot authenticate one: `requestActor`
 * reads `VOLLI_SESSION` out of the request, and any process running as the user
 * can set it. The tool door binds instead — the calling Session is the one the
 * attachment belongs to, closed over by the adapter and never present in the
 * call. That is the whole of why VC-92 rules this verb off the socket, and it is
 * why {@link StartSessionInput.actor} is a parameter here rather than something
 * this module derives: each door owes its own honest answer, and neither is
 * allowed to make one up.
 *
 * ## Replay
 *
 * Every durable write below is keyed on {@link StartSessionInput.operationId},
 * so a caller that hands the same operation id twice gets one Session, one
 * kickoff and one planner event rather than two. The tool door derives that id
 * from the calling Session plus the runtime's own `toolCallId`, which is what
 * makes a replayed tool call idempotent without anything having to remember it
 * ran.
 *
 * The guarantee is stated exactly as far as it goes. One Session, one
 * `session_started`, one kickoff turn: those are durable facts and they are
 * deduplicated. A second auto-title refinement and a second toast are neither
 * durable nor corrupting — they cost a model call and a notification — and this
 * module does not claim to prevent them.
 */

import type Database from "better-sqlite3";
import { displayTicketId, errorMessage, shortSessionId } from "@volli/shared";
import type {
  ModelSelection,
  Project,
  ReasoningLevel,
  Ticket,
  TicketEventActor,
} from "@volli/shared";

import type { SessionStartedNotice } from "../../ipc/contract";
import type { AutoTitleRequest } from "./auto-title";
import type { TicketSessionDelegation } from "./delegation-store";
import type { Sessions, SessionModelOverride } from "./sessions";

/** The kickoff turn's ids, derived so a replayed start submits one message. */
function kickoffIds(operationId: string): { commandId: string; messageId: string } {
  return { commandId: `${operationId}:kickoff`, messageId: `${operationId}:kickoff-message` };
}

/**
 * Everything a start reaches outside itself. Each is optional on the terms the
 * socket door already established: a build with no runtime wires no notices,
 * and a start still lands durably without them.
 */
export interface StartSessionPorts {
  db: Database.Database;
  projects: readonly Project[];
  /**
   * The one facade verb a start needs. Narrowed deliberately: `create` and
   * `attach` are other doors' business, and a module that could reach them
   * would be a module that could grow a second way to open a Session.
   */
  sessions: Pick<Sessions, "start">;
  /**
   * Delivers the kickoff turn. Takes its ids rather than minting them, which is
   * the whole of this module's replay story: `message.submit` is deduplicated
   * by command id in the Session Engine, so a derived id makes a replayed start
   * submit the same turn instead of a second one.
   */
  submitSessionMessage?: (input: {
    sessionId: string;
    text: string;
    commandId: string;
    messageId: string;
  }) => Promise<void>;
  refineAutoTitle?: (input: AutoTitleRequest) => void;
  onMutation?: (input: { ticketId: string; projectId: string; kind: "session" }) => void;
  onSessionStarted?: (notice: SessionStartedNotice) => void;
  /** The display id of the Ticket the CALLING session is working, for the notice. */
  actorTicketDisplay?: (ticketId: string | null) => string | null;
  now: () => number;
}

export interface StartSessionInput {
  /** Keys every durable write. Deterministic for the tool door; random for the socket. */
  operationId: string;
  project: Project;
  ticket: Ticket;
  /** Replaces the default kickoff text, and names the Session when no title is given. */
  message?: string | undefined;
  /** An explicit, permanent title. Its presence is what suppresses auto-titling. */
  title?: string | undefined;
  modelOverride?: SessionModelOverride | undefined;
  /**
   * A claimed Ticket caller's frozen ancestry. Internal only: the tool door
   * derives it from its bound identity and the renderer cannot name it.
   */
  delegation?: TicketSessionDelegation | undefined;
  /** Derived by the door from what it can honestly know. Never self-declared. */
  actor: TicketEventActor;
}

export interface StartSessionResult {
  sessionId: string;
  ticketDisplayId: string;
  state: "ready" | "needs-recovery";
  model: ModelSelection;
  /** The title the Session was given, whether explicit or heuristic. */
  title: string;
}

/**
 * Start one Ticket Session and return as its attachment settles.
 *
 * Refusals are not translated here. `StructuredSessionsError` travels out
 * intact, because the two doors render it differently — the socket has a fixed
 * error-code vocabulary that `volli help exit-codes` is generated from, and the
 * tool door has only text a model reads. Collapsing them into one wording here
 * would have made one of those two worse.
 */
export async function startSessionOperation(
  ports: StartSessionPorts,
  input: StartSessionInput,
  compose: {
    defaultKickoff: string;
    autoTitle: (kickoff: string, displayId: string) => string;
  },
): Promise<StartSessionResult> {
  const displayId = displayTicketId(input.project.ticketPrefix, input.ticket.ticketNumber);
  const kickoff = typeof input.message === "string" ? input.message : compose.defaultKickoff;
  // An explicit title is already a person's (or an agent's) naming. Otherwise
  // the deterministic heuristic gives the Session a meaningful durable title
  // before its detached first exchange begins.
  const title =
    typeof input.title === "string" ? input.title.trim() : compose.autoTitle(kickoff, displayId);
  const started = await ports.sessions.start({
    operationId: input.operationId,
    projectId: input.project.id,
    ticketId: input.ticket.id,
    title,
    actor: input.actor,
    ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
    ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
  });
  // The kickoff rides only a ready attach — a Session that needs recovery holds
  // its first turn for the app's Retry — and it is deliberately detached: the
  // runtime answers a `message.submit` when the TURN it started ends, and this
  // reply is due as the Session opens, not when the agent finishes.
  if (started.state === "ready") {
    const ids = kickoffIds(input.operationId);
    void Promise.resolve()
      .then(() =>
        ports.submitSessionMessage?.({ sessionId: started.sessionId, text: kickoff, ...ids }),
      )
      .catch((error: unknown) => {
        // The short handle and the bare message, exactly as the socket door
        // logged this before the act was lifted out of it: an extraction that
        // changes what an operator greps for has changed behavior.
        console.error(
          `[volli] kickoff for session ${shortSessionId(started.sessionId)} was not delivered: ${errorMessage(error)}`,
        );
      });
  }
  // Only the heuristic door refines: a Session started with an explicit title is
  // a naming and gets zero title calls. Gated on the same `ready` the kickoff is
  // gated on — titling a Session held for recovery would spend a model call on a
  // conversation that has not happened.
  if (typeof input.title !== "string" && started.state === "ready") {
    ports.refineAutoTitle?.({
      sessionId: started.sessionId,
      firstMessage: kickoff,
      heuristicTitle: title,
    });
  }
  ports.onMutation?.({ ticketId: input.ticket.id, projectId: input.project.id, kind: "session" });
  ports.onSessionStarted?.({
    sessionId: started.sessionId,
    projectId: input.project.id,
    ticketId: input.ticket.id,
    ticketDisplayId: displayId,
    actor: input.actor.kind,
    actorTicket:
      input.actor.kind === "session"
        ? (ports.actorTicketDisplay?.(input.actor.ticketId) ?? null)
        : null,
    at: ports.now(),
  });
  return {
    sessionId: started.sessionId,
    ticketDisplayId: displayId,
    state: started.state,
    model: started.model,
    title,
  };
}

/** A model override built from the two halves a door may have been given. */
export function startSessionModelOverride(
  model: { providerId: string; modelId: string } | undefined,
  reasoning: ReasoningLevel | undefined,
): SessionModelOverride | undefined {
  if (model === undefined && reasoning === undefined) return undefined;
  return {
    ...(model === undefined ? {} : { model }),
    ...(reasoning === undefined ? {} : { reasoningLevel: reasoning }),
  };
}
