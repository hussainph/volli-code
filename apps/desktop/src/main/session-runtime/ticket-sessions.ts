import type { ModelSelection, SessionStartResult } from "@volli/shared";

import {
  attachStructuredSession,
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

export interface TicketSessions {
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
  return {
    async start(input) {
      if (!options.ticketBelongsToProject(input.projectId, input.ticketId)) {
        throw new StructuredSessionsError(
          "TICKET_NOT_IN_PROJECT",
          "The requested Ticket was not found in this project.",
        );
      }
      const model = requireDefaultModel(
        options.readDefaultModel(),
        "Choose a default model in Settings before starting a Ticket Session.",
      );
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
