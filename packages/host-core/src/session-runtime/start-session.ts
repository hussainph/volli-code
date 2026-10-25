import type { SessionOrigin } from "@volli/shared";
/**
 * Starting a Ticket Session, as one application act with two doors (VC-162).
 *
 * The Verb Registry's rule is that one verb has one binding — `VerbEntry.handler`
 * names it, and VC-167 wrote down why: *"when VC-162 flips `session.start` to a
 * `tool` access mode, the tool surface resolves the SAME `session.start` binding
 * rather than growing a second implementation of the verb."* This module is that
 * binding's application half: the host handler map's `session.start` entry
 * runs it (VC-923), and the socket's operator start and the Agent Tool
 * Surface both project that entry.
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
import { displayTicketId, sessionOriginFromActor } from "@volli/shared";
import type {
  AgentModelTier,
  ModelSelection,
  Project,
  ReasoningLevel,
  Ticket,
  TicketEventActor,
} from "@volli/shared";

import type { SessionStartedNotice } from "@volli/shared";
import type { SessionRuntime } from "@volli/session-engine";
import { attachRefusal } from "./attach-refusal";
import type { AutoTitleRequest } from "./auto-title";
import type { TicketSessionDelegation } from "./delegation-policy";
import type { Sessions, SessionModelOverride } from "./sessions";
import { hostLogger } from "../log/root";

const log = hostLogger("session-start");

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
   *
   * `delivery: "queue"` holds the message in the Session's durable follow-up
   * queue instead, under the same ids, to be released at its next ready attach
   * (VC-799). It answers once the queue has it, not when a turn ends. Rejects
   * when the runtime refused the message: see {@link kickoffSubmitter}.
   */
  submitSessionMessage?: (input: {
    sessionId: string;
    text: string;
    commandId: string;
    messageId: string;
    origin?: SessionOrigin;
    delivery?: "queue";
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
  origin?: SessionOrigin;
}

export type StartSessionResult = {
  sessionId: string;
  ticketDisplayId: string;
  model: ModelSelection;
  /** The title the Session was given, whether explicit or heuristic. */
  title: string;
} & (
  | {
      state: "ready";
      /** The kickoff went to the ready attach, detached. */
      kickoff: "submitted";
    }
  | {
      state: "needs-recovery";
      /**
       * Why the attach was not ready, in words (VC-659). A rejected attach
       * carries the diagnosis a person needs — a worktree that cannot be
       * prepared names its path, its branch and the branch the ticket expects —
       * so a door hands that on rather than a bare "needs recovery".
       */
      attachFailure: string;
      /**
       * Where the kickoff went (VC-799). `held`: it waits in the Session's
       * queue for its next ready attach. `unsent`: it could not be held, which
       * the log says.
       */
      kickoff: "held" | "unsent";
    }
);

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
    // This door starts Ticket Sessions and nothing else (VC-162).
    role: "ticket",
    title,
    actor: input.actor,
    origin: startOrigin(input),
    ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
    // The caller's own message is the request an automatic model choice reads
    // (VC-432); the stock kickoff says nothing about the work, so it offers
    // none. Ignored whenever the caller named a model, tier or level.
    ...(typeof input.message === "string" ? { autoSelect: { request: input.message } } : {}),
    ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
  });
  // The kickoff rides a ready attach, deliberately detached: the runtime
  // answers a `message.submit` when the TURN it started ends, and this reply is
  // due as the Session opens, not when the agent finishes. A refusal lands in
  // the log (`kickoffSubmitter` reads the receipt).
  //
  // A Session that needs recovery has nothing to run it on yet, so its kickoff
  // is HELD for the app's Retry instead (VC-799): queued in the Session's own
  // durable follow-up queue under the same derived ids, which releases it at
  // the next ready attach and shows it to a person meanwhile. A replayed start
  // queues under the same command id again, and the queue answers that from
  // its record rather than holding a second copy.
  const ids = kickoffIds(input.operationId);
  let held: "held" | "unsent" = "unsent";
  if (started.state === "ready") {
    void Promise.resolve()
      .then(() =>
        ports.submitSessionMessage?.({
          sessionId: started.sessionId,
          text: kickoff,
          origin: startOrigin(input),
          ...ids,
        }),
      )
      .catch((error: unknown) => {
        // One stable message an operator can grep for, with the Session it
        // was meant for as a field.
        log.error("kickoff was not delivered", { sessionId: started.sessionId, error });
      });
  } else {
    try {
      if (ports.submitSessionMessage !== undefined) {
        await ports.submitSessionMessage({
          sessionId: started.sessionId,
          text: kickoff,
          origin: startOrigin(input),
          ...ids,
          delivery: "queue",
        });
        held = "held";
      }
    } catch (error) {
      log.error("kickoff could not be held for the session's retry", {
        sessionId: started.sessionId,
        error,
      });
    }
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
    ...(started.state === "ready"
      ? { state: "ready" as const, kickoff: "submitted" as const }
      : {
          state: "needs-recovery" as const,
          attachFailure: attachRefusal(started.receipt),
          kickoff: held,
        }),
    model: started.model,
    title,
  };
}

/**
 * The runtime durably refused a kickoff: its receipt is `rejected`, and that
 * receipt is already in the Session's own ledger, where a watcher reads it.
 * A caller that settles on the ledger reports this rather than settling on
 * it, so the earliest durable outcome stays the one that counts.
 */
export class KickoffRefusedError extends Error {
  constructor(code: string, detail: string | null) {
    super(`The kickoff was refused (${code})${detail === null ? "" : `: ${detail}`}`);
    this.name = "KickoffRefusedError";
  }
}

/**
 * The kickoff port every start door is handed: one user `message.submit`
 * under the ids its caller derived, with the runtime's receipt READ (VC-799).
 *
 * A refusal rejects with a {@link KickoffRefusedError} in the refusal's own
 * words, into the caller's log or report, so a kickoff the runtime refused on
 * a ready attach is never silent. Only `rejected` is a refusal: an `unknown`
 * receipt may still have reached the executor, and calling that a failure
 * would tell a parent its child failed while the child runs.
 */
export function kickoffSubmitter(
  runtime: Pick<SessionRuntime, "command">,
): NonNullable<StartSessionPorts["submitSessionMessage"]> {
  return async ({ sessionId, text, commandId, messageId, origin, delivery }) => {
    const { receipt } = await runtime.command({
      origin,
      commandId,
      sessionId,
      command: {
        kind: "message.submit",
        ...(delivery === undefined ? {} : { delivery }),
        message: { id: messageId, role: "user", parts: [{ type: "text", text }] },
      },
    });
    if (receipt?.status === "rejected") throw new KickoffRefusedError(receipt.code, receipt.detail);
  };
}

/**
 * Which model a door was asked for, if any: an exact id, or a tier (VC-259).
 *
 * A union rather than two optional fields because the two are alternatives —
 * {@link SessionModelOverride} says so in its own type — and a door that has
 * validated its input already knows which one it holds.
 */
export type StartSessionModelChoice =
  | { model: { providerId: string; modelId: string } }
  | { tier: AgentModelTier };

/** A model override built from the halves a door may have been given. */
export function startSessionModelOverride(
  choice: StartSessionModelChoice | undefined,
  reasoning: ReasoningLevel | undefined,
): SessionModelOverride | undefined {
  if (choice === undefined && reasoning === undefined) return undefined;
  const level = reasoning === undefined ? {} : { reasoningLevel: reasoning };
  if (choice === undefined) return level;
  return "tier" in choice ? { tier: choice.tier, ...level } : { model: choice.model, ...level };
}

function startOrigin(input: StartSessionInput): SessionOrigin | undefined {
  return input.origin ?? sessionOriginFromActor(input.actor);
}
