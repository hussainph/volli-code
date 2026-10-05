/** The person-only CLI adapter, over the same start operation the named tool uses. */
import {
  AGENT_MODEL_TIERS,
  DEFAULT_KICKOFF_MESSAGE,
  REASONING_LEVELS,
  autoTitleFromKickoff,
  shortSessionId,
  isAgentModelTier,
  type ReasoningLevel,
} from "@volli/shared";
import {
  startSessionOperation,
  startSessionModelOverride,
  type StartSessionModelChoice,
} from "../session-runtime/start-session";
import { StructuredSessionsError } from "../session-runtime/sessions";
import { ticketForDisplayId } from "./resolution";
import { failure, type AgentVerbHandler } from "./context";

export const sessionStartVerb: AgentVerbHandler = async (context, request) => {
  const { options, projects } = context;
  const ticketId = request.args["id"];
  if (typeof ticketId !== "string")
    return failure("INVALID_REQUEST", "A Ticket display id is required.");
  const found = ticketForDisplayId(options.db, projects, ticketId);
  if (!found.ok) return found.response;
  if (options.sessions === undefined)
    return failure("APP_UNREACHABLE", "The Session runtime is unavailable.");
  const { model, tier, reasoning, title, message } = request.args;
  if (
    (title !== undefined && typeof title !== "string") ||
    (message !== undefined && typeof message !== "string")
  )
    return failure("INVALID_REQUEST", "Title and message must be strings.");
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
  try {
    const started = await startSessionOperation(
      { ...options, projects, sessions: options.sessions, now: context.now },
      {
        operationId: context.newId(),
        project: found.project,
        ticket: found.ticket,
        actor: { kind: "user" },
        message: message as string | undefined,
        title: title as string | undefined,
        modelOverride: startSessionModelOverride(choice, reasoning as ReasoningLevel | undefined),
      },
      { defaultKickoff: DEFAULT_KICKOFF_MESSAGE, autoTitle: autoTitleFromKickoff },
    );
    return {
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
    };
  } catch (error) {
    if (error instanceof StructuredSessionsError)
      return failure(
        error.code === "DEFAULT_MODEL_REQUIRED"
          ? "MODEL_REQUIRED"
          : error.code === "MODEL_UNAVAILABLE" || error.code === "MODEL_SELECTION_REJECTED"
            ? "MODEL_UNAVAILABLE"
            : "INVALID_REQUEST",
        error.message,
      );
    throw error;
  }
};
