/**
 * The one Session-start module: how a structured Session begins, whatever its
 * Role. `ticketId: string | null` IS the Role on start — the same nullable
 * field `session.create` records durably — so the Role is stated once, by the
 * caller, instead of being re-derived by parallel Ticket/project facades.
 *
 * There is one executor, so there is one adapter id; keeping it here rather
 * than at each caller is what stops a second copy from quietly naming a
 * different runtime. The model rule is shared for the same reason: a Session
 * records the configured default as its own durable, observable event before
 * any attachment exists.
 *
 * Which is the whole of what "substitute" is allowed to mean here. A Session
 * born before the policy existed has its default written at attach — `attach`
 * below does exactly that — but it is written, as that Session's own
 * `model.select`, ahead of the attachment and visible in its history. What none
 * of this does is hand a model to a running attachment that the Session never
 * recorded: a model nobody wrote down is not a model this runtime will use.
 */

import type { SessionRuntime, SessionRuntimeCommandResult } from "@volli/session-engine";
import type {
  ModelAccessSnapshot,
  ModelSelection,
  PromptResource,
  ReasoningLevel,
  SessionStartResult,
  TicketEventActor,
} from "@volli/shared";

/**
 * The one adapter id the structured product attaches under.
 *
 * The runtime supplies it to the command itself; this constant is what every
 * *other* reader of a durable attachment compares against — including the boot
 * sweep, which retires every local open attachment that does not match. It is
 * declared in this module, which carries no runtime dependency, so those
 * readers can name the id without importing Pi; `PI_ADAPTER_ID` aliases it so
 * the two cannot drift.
 */
export const STRUCTURED_ADAPTER_ID = "pi";

/**
 * The refusal, once, for both Roles. Two wordings of one rule would read as two
 * rules — a person meeting it on a project chat and again on a Ticket has no way
 * to tell that the second is the same missing setting as the first.
 */
export const DEFAULT_MODEL_REQUIRED =
  "Choose a default model in Settings before starting a Session.";

export type StructuredSessionsErrorCode =
  | "DEFAULT_MODEL_REQUIRED"
  | "MODEL_SELECTION_REJECTED"
  // An invocation-time model override Model Access cannot honor: a model it
  // does not know, a provider that needs sign-in first, or a reasoning level
  // the chosen model cannot run. Refused before any Session exists.
  | "MODEL_UNAVAILABLE"
  | "SKILL_NOT_FOUND"
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

/** The single Session Engine verb this module is allowed to reach. */
export type StructuredSessionCommands = Pick<SessionRuntime, "command">;

/**
 * How a start turns skills into the durable resources the runtime injects —
 * all halves implemented by the composition root, because only it holds the
 * project table and the Session Engine.
 *
 * `resolve` and `index` both run BEFORE `session.create`, and their failure
 * policies differ on purpose. A skill the user NAMED that is not on disk
 * refuses the start while there is still nothing durable to strand —
 * `resolve` throws {@link StructuredSessionsError} with `SKILL_NOT_FOUND`.
 * The `index` — the opt-in metadata disclosure nobody named — is best-effort:
 * an unreadable skills directory costs the index, never the chat, because a
 * broken opt-in must not brick every Session in the project. `injectedNames`
 * are the skills already resolved in full; the index skips them rather than
 * telling the model to go read what it was already handed.
 *
 * `record` runs after create and before attach, writing everything resolved
 * as the Session's own `prompt-resources` input: the attach composes the
 * system prompt from that record, never from a second disk read, so a
 * restart-recovery re-attach months later injects the same bytes this start
 * did — index included.
 */
export interface SessionSkillPorts {
  resolve(projectId: string, names: readonly string[]): Promise<readonly PromptResource[]>;
  index(projectId: string, injectedNames: readonly string[]): Promise<PromptResource | null>;
  record(sessionId: string, resources: readonly PromptResource[]): Promise<void>;
}

/**
 * The backfill's command id, derived from the Session rather than the attach.
 *
 * The read that decides whether to backfill and the write that performs it are
 * not one atomic step, so two attaches racing the same legacy Session — a Retry
 * pressed while the first is still in flight, two surfaces mounting it at once —
 * can both see nothing recorded and both write. An operation-scoped id would
 * make those two writes look like two different intents and leave the Session
 * with a duplicate `model.select` in its durable history. Keyed on the Session,
 * they are one intent stated twice, which is precisely what command dedup exists
 * to collapse.
 */
function modelBackfillCommandId(sessionId: string): string {
  return `${sessionId}:model-backfill`;
}

export interface SessionStartInput {
  operationId: string;
  projectId: string;
  /** The Role: a Ticket Session when set, a project Session when null. */
  ticketId: string | null;
  title: string | null;
  /** Skill slugs to inject at attach time. Absent means none — never ambient. */
  skills?: readonly string[];
  /**
   * Door-derived provenance for the `session_started` planner event: the
   * renderer's RPC door passes nothing (the human clicked), the agent socket
   * passes its `requestActor` result. Never self-declared by a caller.
   */
  actor?: TicketEventActor;
  modelOverride?: SessionModelOverride;
}

/**
 * An invocation-time model override, within the user's configured policy — the
 * Automation Runtime contract's parameter shape, arriving today from `volli
 * session start`. Both halves are optional and merge onto the app default: a
 * bare reasoning override keeps the default model, a bare model override keeps
 * the default level when the chosen model supports it.
 */
export interface SessionModelOverride {
  model?: { providerId: string; modelId: string };
  reasoningLevel?: ReasoningLevel;
}

/** The durable identity a create-only call resolves — nothing about an executor. */
export interface SessionCreateResult {
  sessionId: string;
}

/** The start result plus the model policy the Session durably recorded. */
export type SessionStartOutcome = SessionStartResult & { model: ModelSelection };

export interface Sessions {
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
  create(input: SessionStartInput): Promise<SessionCreateResult>;
  /** Mint and attach in one call — the agent socket's door (VC-13). */
  start(input: SessionStartInput): Promise<SessionStartOutcome>;
  /**
   * Another attachment attempt on the Session that already exists — any
   * Session, whichever Role it was born under. The Role guard the old
   * per-Role facades ran here is gone, not moved: with one attach door there
   * is no wrong namespace left to catch.
   */
  attach(input: SessionAttachInput): Promise<SessionStartResult>;
}

export interface SessionAttachInput {
  operationId: string;
  sessionId: string;
}

export interface SessionsOptions {
  runtime: StructuredSessionCommands;
  readDefaultModel(): ModelSelection | null;
  ticketBelongsToProject(projectId: string, ticketId: string): boolean;
  /** This Session's durable model policy, or `null` when it has never recorded one. */
  readModelSelection(sessionId: string): Promise<ModelSelection | null>;
  skills: SessionSkillPorts;
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
   * decision 3). A Ticket concern: a ticketless mint records nothing, because
   * planner history is Ticket history. Absent in tests means no planner write.
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
  options: SessionsOptions,
  override: SessionModelOverride | undefined,
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

/** Product-owned Session start commands over private adapter migration scaffolding. */
export function createSessions(options: SessionsOptions): Sessions {
  /** The shared create+model half; `start` attaches after it, `create` returns it as-is. */
  async function mint(
    input: SessionStartInput,
  ): Promise<SessionCreateResult & { model: ModelSelection }> {
    if (
      input.ticketId !== null &&
      !options.ticketBelongsToProject(input.projectId, input.ticketId)
    ) {
      throw new StructuredSessionsError(
        "TICKET_NOT_IN_PROJECT",
        "The requested Ticket was not found in this project.",
      );
    }
    const model = await resolveModelSelection(options, input.modelOverride);
    // Resolved before anything durable exists: a missing skill refuses the
    // start outright instead of stranding a Session that never attaches.
    const explicit =
      input.skills !== undefined && input.skills.length > 0
        ? await options.skills.resolve(input.projectId, input.skills)
        : [];
    // The metadata index rides behind the named bodies — specific material
    // first, then what else is installed. Best-effort by the port's contract:
    // null costs the index, never the start.
    const index = await options.skills.index(
      input.projectId,
      explicit.map((resource) => resource.name),
    );
    const resources = index === null ? explicit : [...explicit, index];
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
    if (input.ticketId !== null) {
      options.recordSessionStarted?.({
        ticketId: input.ticketId,
        sessionId: created.sessionId,
        actor: input.actor ?? { kind: "user" },
      });
    }
    await recordModelSelection(options.runtime, {
      commandId: `${input.operationId}:model`,
      sessionId: created.sessionId,
      model,
    });
    // Durable inside MINT, not beside the attach: VC-16 split the start so a
    // chat can open optimistically — `create` lands the tab and `attach`
    // follows separately — and the record has to exist before whichever
    // attach eventually composes the system prompt from it.
    if (resources.length > 0) await options.skills.record(created.sessionId, resources);
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
      // One rule for every Session: nothing recorded gets the default recorded
      // at attach. Only a Session born before the model policy existed can
      // reach the branch in real data — every mint above records at birth — so
      // this is the legacy migration duty, stated without a Role read.
      if ((await options.readModelSelection(input.sessionId)) === null) {
        const model = requireDefaultModel(
          options.readDefaultModel(),
          DEFAULT_MODEL_REQUIRED,
          input.sessionId,
        );
        await recordModelSelection(options.runtime, {
          commandId: modelBackfillCommandId(input.sessionId),
          sessionId: input.sessionId,
          model,
        });
      }
      return attachStructuredSession(options.runtime, input.operationId, input.sessionId);
    },
  };
}

/** The app default, or the refusal that names what the user has to choose. */
function requireDefaultModel(
  model: ModelSelection | null,
  message: string,
  sessionId: string | null = null,
): ModelSelection {
  if (model === null) {
    throw new StructuredSessionsError("DEFAULT_MODEL_REQUIRED", message, sessionId);
  }
  return model;
}

/** Attach the singular runtime. A rejected attachment stays durable for explicit recovery. */
async function attachStructuredSession(
  runtime: StructuredSessionCommands,
  operationId: string,
  sessionId: string,
): Promise<SessionStartResult> {
  const attached = await runtime.command({
    commandId: `${operationId}:start`,
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
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

/** Record the Session's model policy durably, or refuse before anything attaches. */
async function recordModelSelection(
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
