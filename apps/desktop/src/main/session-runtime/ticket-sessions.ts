import type { ModelSelection, SessionStartResult } from "@volli/shared";

import {
  attachStructuredSession,
  DEFAULT_MODEL_REQUIRED,
  recordModelSelection,
  requireDefaultModel,
  StructuredSessionsError,
  type StructuredSessionCommands,
} from "./structured-sessions";

export interface TicketSessionStartInput {
  operationId: string;
  projectId: string;
  ticketId: string;
  title: string | null;
}

export interface TicketSessionAttachInput {
  operationId: string;
  sessionId: string;
}

/** The durable identity a create-only call resolves — nothing about an executor. */
export interface SessionCreateResult {
  sessionId: string;
}

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
  start(input: TicketSessionStartInput): Promise<SessionStartResult>;
  attach(input: TicketSessionAttachInput): Promise<SessionStartResult>;
}

export interface TicketSessionsOptions {
  runtime: StructuredSessionCommands;
  readDefaultModel(): ModelSelection | null;
  readBornTicketless(sessionId: string): Promise<boolean>;
  ticketBelongsToProject(projectId: string, ticketId: string): boolean;
}

/** Product-owned Ticket Session commands over private adapter migration scaffolding. */
export function createTicketSessions(options: TicketSessionsOptions): TicketSessions {
  /** The shared create+model half; `start` attaches after it, `create` returns it as-is. */
  async function mint(input: TicketSessionStartInput): Promise<SessionCreateResult> {
    if (!options.ticketBelongsToProject(input.projectId, input.ticketId)) {
      throw new StructuredSessionsError(
        "TICKET_NOT_IN_PROJECT",
        "The requested Ticket was not found in this project.",
      );
    }
    const model = requireDefaultModel(options.readDefaultModel(), DEFAULT_MODEL_REQUIRED);
    const created = await options.runtime.command({
      commandId: `${input.operationId}:create`,
      command: {
        kind: "session.create",
        projectId: input.projectId,
        ticketId: input.ticketId,
        title: input.title,
      },
    });
    await recordModelSelection(options.runtime, {
      commandId: `${input.operationId}:model`,
      sessionId: created.sessionId,
      model,
    });
    return { sessionId: created.sessionId };
  }

  return {
    create: mint,

    async start(input) {
      const created = await mint(input);
      return attachStructuredSession(options.runtime, input.operationId, created.sessionId);
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
