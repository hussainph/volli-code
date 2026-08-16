import type { ModelSelection, SessionStartResult } from "@volli/shared";

import {
  attachStructuredSession,
  DEFAULT_MODEL_REQUIRED,
  recordModelSelection,
  requireDefaultModel,
  StructuredSessionsError,
  type SessionSkillPorts,
  type StructuredSessionCommands,
} from "./structured-sessions";

export interface TicketSessionStartInput {
  operationId: string;
  projectId: string;
  ticketId: string;
  title: string | null;
  /** Skill slugs to inject at attach time. Absent means none — never ambient. */
  skills?: readonly string[];
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
  skills: SessionSkillPorts;
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
      const model = requireDefaultModel(options.readDefaultModel(), DEFAULT_MODEL_REQUIRED);
      // Resolved before anything durable exists: a missing skill refuses the
      // start outright instead of stranding a Session that never attaches.
      const resources =
        input.skills !== undefined && input.skills.length > 0
          ? await options.skills.resolve(input.projectId, input.skills)
          : [];
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
      // Durable before the attach, so composing the system prompt — now and on
      // every recovery re-attach — reads this record, never the disk again.
      if (resources.length > 0) await options.skills.record(created.sessionId, resources);
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
