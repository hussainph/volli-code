/**
 * The person-only CLI adapter over the map's start command (VC-923): the same
 * `session.start` entry the named tool reaches. The socket keeps what is its
 * own: argv validation, the Ticket's resolution across the projects it sees,
 * a random operation id (NDJSON v1 carries none), and its error vocabulary.
 */
import {
  AGENT_MODEL_TIERS,
  REASONING_LEVELS,
  shortSessionId,
  isAgentModelTier,
  type AgentResponse,
  type ReasoningLevel,
} from "@volli/shared";
import {
  startSessionModelOverride,
  type StartSessionModelChoice,
} from "../session-runtime/start-session";
import { StructuredSessionsError } from "../session-runtime/sessions";
import { SessionRuntimeUnavailableError } from "../handlers/host-handlers";
import { ticketForDisplayId } from "./resolution";
import { failure } from "./context";
import type { SocketDecode } from "./projection";

export const sessionStartDecode: SocketDecode<"session.start"> = (context, request) => {
  const { options, projects } = context;
  const ticketId = request.args["id"];
  if (typeof ticketId !== "string")
    return failure("INVALID_REQUEST", "A Ticket display id is required.");
  const found = ticketForDisplayId(options.db, projects, ticketId);
  if (!found.ok) return found.response;
  const { model, tier, reasoning, title, message } = request.args;
  if (
    (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) ||
    (message !== undefined && (typeof message !== "string" || message.trim().length === 0))
  )
    return failure("INVALID_REQUEST", "Title and message must be nonempty strings.");
  if (model !== undefined && tier !== undefined)
    return failure("INVALID_REQUEST", "Model and tier are alternatives.");
  let choice: StartSessionModelChoice | undefined;
  if (model !== undefined) {
    if (typeof model !== "string" || model.indexOf("/") <= 0 || model.endsWith("/"))
      return failure("INVALID_REQUEST", "Model must be provider/model.");
    const at = model.indexOf("/");
    choice = { model: { providerId: model.slice(0, at), modelId: model.slice(at + 1) } };
  }
  if (tier !== undefined) {
    if (!isAgentModelTier(tier))
      return failure("INVALID_REQUEST", `Tier must be one of: ${AGENT_MODEL_TIERS.join(", ")}.`);
    choice = { tier };
  }
  if (reasoning !== undefined && !(REASONING_LEVELS as readonly unknown[]).includes(reasoning))
    return failure("INVALID_REQUEST", "Unknown reasoning level.");
  const modelOverride = startSessionModelOverride(choice, reasoning as ReasoningLevel | undefined);
  return {
    input: {
      operationId: context.newId(),
      projectId: found.project.id,
      ticketId: found.ticket.id,
      ...(typeof message === "string" ? { message } : {}),
      ...(typeof title === "string" ? { title } : {}),
      ...(modelOverride === undefined ? {} : { modelOverride }),
    },
    // The person, proven by the operator token: the only caller the dispatch
    // lets reach this verb (`operatorCli`).
    call: { actor: { kind: "user" } },
    reply: (started) => ({
      v: 1,
      ok: true,
      data: {
        sessionId: started.sessionId,
        session: shortSessionId(started.sessionId),
        ticket: started.ticketDisplayId,
        state: started.state,
        title: started.title,
        model: `${started.model.providerId}/${started.model.modelId}`,
        reasoning: started.model.reasoningLevel,
      },
    }),
  };
};

/** The start's own vocabulary for what the facade refused, and for a launch with no runtime. */
export function sessionStartFailure(error: unknown): AgentResponse | undefined {
  if (error instanceof StructuredSessionsError)
    return failure(
      error.code === "DEFAULT_MODEL_REQUIRED"
        ? "MODEL_REQUIRED"
        : error.code === "MODEL_UNAVAILABLE" || error.code === "MODEL_SELECTION_REJECTED"
          ? "MODEL_UNAVAILABLE"
          : "INVALID_REQUEST",
      error.message,
    );
  if (error instanceof SessionRuntimeUnavailableError)
    return failure("APP_UNREACHABLE", "The Session runtime is unavailable.");
  return undefined;
}
