/**
 * What every structured Session start shares, whatever Role it runs under.
 *
 * There is one executor, so there is one adapter id and one profile; keeping
 * them here rather than in each facade is what stops a second copy from quietly
 * naming a different runtime. The model rule is shared for the same reason: a
 * Session records the configured default as its own durable, observable event
 * before any attachment exists.
 *
 * Which is the whole of what "substitute" is allowed to mean here. A Session
 * born before the policy existed has its default written at attach — the
 * project facade does exactly that — but it is written, as that Session's own
 * `model.select`, ahead of the attachment and visible in its history. What none
 * of this does is hand a model to a running attachment that the Session never
 * recorded: a model nobody wrote down is not a model this runtime will use.
 */

import type { SessionRuntime, SessionRuntimeCommandResult } from "@volli/session-engine";
import type { ModelSelection, SessionStartResult } from "@volli/shared";

/** The one adapter id and profile the structured product attaches. */
export const STRUCTURED_ADAPTER_ID = "pi";
export const STRUCTURED_PROFILE_ID = "native";

export type StructuredSessionsErrorCode =
  | "DEFAULT_MODEL_REQUIRED"
  | "MODEL_SELECTION_REJECTED"
  | "SESSION_NOT_TICKET_SESSION"
  | "SESSION_NOT_PROJECT_SESSION"
  | "TICKET_NOT_IN_PROJECT";

/** A refusal a caller can act on, never a bare string a surface has to parse. */
export class StructuredSessionsError extends Error {
  constructor(
    readonly code: StructuredSessionsErrorCode,
    message: string,
    readonly sessionId: string | null = null,
  ) {
    super(message);
    this.name = "StructuredSessionsError";
  }
}

/** The single Session Engine verb these facades are allowed to reach. */
export type StructuredSessionCommands = Pick<SessionRuntime, "command">;

/** The app default, or the refusal that names what the user has to choose. */
export function requireDefaultModel(
  model: ModelSelection | null,
  message: string,
  sessionId: string | null = null,
): ModelSelection {
  if (model === null) {
    throw new StructuredSessionsError("DEFAULT_MODEL_REQUIRED", message, sessionId);
  }
  return model;
}

/** Record the Session's model policy durably, or refuse before anything attaches. */
export async function recordModelSelection(
  runtime: StructuredSessionCommands,
  input: { commandId: string; sessionId: string; model: ModelSelection },
): Promise<void> {
  const selected = await runtime.command({
    commandId: input.commandId,
    sessionId: input.sessionId,
    command: { kind: "model.select", selection: input.model },
  });
  if (selected.receipt?.status !== "completed") {
    throw new StructuredSessionsError(
      "MODEL_SELECTION_REJECTED",
      "The selected model policy could not be recorded for this Session.",
      input.sessionId,
    );
  }
}

/** Attach the singular runtime. A rejected attachment stays durable for explicit recovery. */
export async function attachStructuredSession(
  runtime: StructuredSessionCommands,
  operationId: string,
  sessionId: string,
): Promise<SessionStartResult> {
  const attached = await runtime.command({
    commandId: `${operationId}:start`,
    sessionId,
    command: {
      kind: "adapter.attach",
      adapterId: STRUCTURED_ADAPTER_ID,
      profileId: STRUCTURED_PROFILE_ID,
      continuity: "fresh",
    },
  });
  return {
    sessionId,
    state: attachmentReady(attached) ? "ready" : "needs-recovery",
    receipt: attached.receipt,
    throughSequence: attached.throughSequence,
  };
}

function attachmentReady(result: SessionRuntimeCommandResult): boolean {
  return result.receipt?.status === "accepted" || result.receipt?.status === "completed";
}
