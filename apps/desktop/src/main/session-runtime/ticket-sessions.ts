import type {
  ModelAccessSnapshot,
  ModelSelection,
  ReasoningLevel,
  SessionStartResult,
  TicketEventActor,
} from "@volli/shared";

import {
  attachStructuredSession,
  DEFAULT_MODEL_REQUIRED,
  recordModelSelection,
  requireDefaultModel,
  StructuredSessionsError,
  type StructuredSessionCommands,
} from "./structured-sessions";

/**
 * An invocation-time model override, within the user's configured policy — the
 * Automation Runtime contract's parameter shape, arriving today from `volli
 * session start`. Both halves are optional and merge onto the app default: a
 * bare reasoning override keeps the default model, a bare model override keeps
 * the default level when the chosen model supports it.
 */
export interface TicketSessionModelOverride {
  model?: { providerId: string; modelId: string };
  reasoningLevel?: ReasoningLevel;
}

export interface TicketSessionStartInput {
  operationId: string;
  projectId: string;
  ticketId: string;
  title: string | null;
  /**
   * Door-derived provenance for the `session_started` planner event: the
   * renderer's RPC door passes nothing (the human clicked), the agent socket
   * passes its `requestActor` result. Never self-declared by a caller.
   */
  actor?: TicketEventActor;
  modelOverride?: TicketSessionModelOverride;
}

export interface TicketSessionAttachInput {
  operationId: string;
  sessionId: string;
}

/** The durable identity a create-only call resolves — nothing about an executor. */
export interface SessionCreateResult {
  sessionId: string;
}

/** The start result plus the model policy the Session durably recorded. */
export type TicketSessionStartResult = SessionStartResult & { model: ModelSelection };

export interface TicketSessions {
  /**
   * Mint the durable Session and record its model policy — and STOP there.
   *
   * The optimistic-open half of a chat start (VC-16): both commands are local
   * DB writes, so the renderer gets an addressable Session id in milliseconds
   * and lands its tab, while `attach` — which materializes the Ticket worktree
   * and boots the Agent Runtime — follows as its own call off that critical
   * path. Same refusals as `start`: an unknown ticket or a missing default
   * model refuses before anything durable exists.
   */
  create(input: TicketSessionStartInput): Promise<SessionCreateResult>;
  start(input: TicketSessionStartInput): Promise<TicketSessionStartResult>;
  attach(input: TicketSessionAttachInput): Promise<SessionStartResult>;
}

export interface TicketSessionsOptions {
  runtime: StructuredSessionCommands;
  readDefaultModel(): ModelSelection | null;
  readBornTicketless(sessionId: string): Promise<boolean>;
  ticketBelongsToProject(projectId: string, ticketId: string): boolean;
  /**
   * What Model Access can actually run, consulted only when an override
   * arrives: the configured default was validated when it was saved
   * (`assertDefaultModelAvailable`), so the no-override path never pays for a
   * runtime inspection.
   */
  inspectModelAccess?(): Promise<ModelAccessSnapshot>;
  /**
   * Records the `session_started` ticket event. Living in `mint` — the one
   * shared creation path under BOTH `create` (the renderer's optimistic open)
   * and `start` (the agent socket) — is what makes every door's start land in
   * planner history identically, with the actor each door derived (VC-13
   * decision 3). Absent in tests means no planner write.
   */
  recordSessionStarted?(event: {
    ticketId: string;
    sessionId: string;
    actor: TicketEventActor;
  }): void;
}

/**
 * Resolves the model policy this start records: the app default, or the
 * default with an invocation-time override merged on. An override is validated
 * against Model Access — availability and the model's reasoning levels, the
 * `assertDefaultModelAvailable` rule — and refused before any Session exists;
 * the plain default path stays exactly the policy `requireDefaultModel` was.
 */
async function resolveModelSelection(
  options: TicketSessionsOptions,
  override: TicketSessionModelOverride | undefined,
): Promise<ModelSelection> {
  const base = options.readDefaultModel();
  if (
    override === undefined ||
    (override.model === undefined && override.reasoningLevel === undefined)
  ) {
    return requireDefaultModel(base, DEFAULT_MODEL_REQUIRED);
  }
  const model = override.model ?? (base === null ? undefined : base);
  if (model === undefined) {
    // A reasoning level alone cannot conjure a model to run at it.
    throw new StructuredSessionsError("DEFAULT_MODEL_REQUIRED", DEFAULT_MODEL_REQUIRED);
  }
  if (options.inspectModelAccess === undefined) {
    throw new StructuredSessionsError(
      "MODEL_UNAVAILABLE",
      "Model Access is unavailable, so a model override cannot be validated.",
    );
  }
  const access = await options.inspectModelAccess();
  const available = access.models.find(
    (candidate) => candidate.providerId === model.providerId && candidate.modelId === model.modelId,
  );
  if (available === undefined || available.state !== "available") {
    throw new StructuredSessionsError(
      "MODEL_UNAVAILABLE",
      available?.state === "authentication-required"
        ? `Sign in to ${model.providerId} before starting a session on ${model.providerId}/${model.modelId}.`
        : `Model ${model.providerId}/${model.modelId} is not currently available.`,
    );
  }
  // No explicit level falls back to the default's, then to Volli's central
  // "medium" (the no-default + --model case); either way the chosen model has
  // to actually run it, and the refusal names what it can run instead.
  const reasoningLevel = override.reasoningLevel ?? base?.reasoningLevel ?? "medium";
  if (!available.reasoningLevels.includes(reasoningLevel)) {
    throw new StructuredSessionsError(
      "MODEL_UNAVAILABLE",
      `Model ${model.providerId}/${model.modelId} does not support reasoning level "${reasoningLevel}" (valid: ${available.reasoningLevels.join(", ")}).`,
    );
  }
  return { providerId: model.providerId, modelId: model.modelId, reasoningLevel };
}

/** Product-owned Ticket Session commands over private adapter migration scaffolding. */
export function createTicketSessions(options: TicketSessionsOptions): TicketSessions {
  /** The shared create+model half; `start` attaches after it, `create` returns it as-is. */
  async function mint(
    input: TicketSessionStartInput,
  ): Promise<SessionCreateResult & { model: ModelSelection }> {
    if (!options.ticketBelongsToProject(input.projectId, input.ticketId)) {
      throw new StructuredSessionsError(
        "TICKET_NOT_IN_PROJECT",
        "The requested Ticket was not found in this project.",
      );
    }
    const model = await resolveModelSelection(options, input.modelOverride);
    const created = await options.runtime.command({
      commandId: `${input.operationId}:create`,
      command: {
        kind: "session.create",
        projectId: input.projectId,
        ticketId: input.ticketId,
        title: input.title,
      },
    });
    // The Session now exists durably, so planner history says so — whatever
    // the model record or a later attach do next, the app carries the recovery.
    options.recordSessionStarted?.({
      ticketId: input.ticketId,
      sessionId: created.sessionId,
      actor: input.actor ?? { kind: "user" },
    });
    await recordModelSelection(options.runtime, {
      commandId: `${input.operationId}:model`,
      sessionId: created.sessionId,
      model,
    });
    return { sessionId: created.sessionId, model };
  }

  return {
    async create(input) {
      const created = await mint(input);
      return { sessionId: created.sessionId };
    },

    async start(input) {
      const created = await mint(input);
      const attached = await attachStructuredSession(
        options.runtime,
        input.operationId,
        created.sessionId,
      );
      return { ...attached, model: created.model };
    },
    async attach(input) {
      if (await options.readBornTicketless(input.sessionId)) {
        throw new StructuredSessionsError(
          "SESSION_NOT_TICKET_SESSION",
          "The requested Session is not a Ticket Session",
          input.sessionId,
        );
      }
      return attachStructuredSession(options.runtime, input.operationId, input.sessionId);
    },
  };
}
