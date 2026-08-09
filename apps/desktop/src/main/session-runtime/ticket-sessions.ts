import type { SessionRuntime, SessionRuntimeCommandResult } from "@volli/session-engine";
import type { ModelSelection, SessionStartResult } from "@volli/shared";

const STRUCTURED_ADAPTER_ID = "pi";
const STRUCTURED_PROFILE_ID = "native";

export type TicketSessionsErrorCode =
  | "DEFAULT_MODEL_REQUIRED"
  | "MODEL_SELECTION_REJECTED"
  | "SESSION_NOT_TICKET_SESSION"
  | "TICKET_NOT_IN_PROJECT";

export class TicketSessionsError extends Error {
  constructor(
    readonly code: TicketSessionsErrorCode,
    message: string,
    readonly sessionId: string | null = null,
  ) {
    super(message);
    this.name = "TicketSessionsError";
  }
}

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
  runtime: Pick<SessionRuntime, "command">;
  readDefaultModel(): ModelSelection | null;
  readBornTicketless(sessionId: string): Promise<boolean>;
  ticketBelongsToProject(projectId: string, ticketId: string): boolean;
}

/** Product-owned Ticket Session commands over private adapter migration scaffolding. */
export function createTicketSessions(options: TicketSessionsOptions): TicketSessions {
  return {
    async start(input) {
      if (!options.ticketBelongsToProject(input.projectId, input.ticketId)) {
        throw new TicketSessionsError(
          "TICKET_NOT_IN_PROJECT",
          "The requested Ticket was not found in this project.",
        );
      }
      const model = options.readDefaultModel();
      if (model === null) {
        throw new TicketSessionsError(
          "DEFAULT_MODEL_REQUIRED",
          "Choose a default model in Settings before starting a Ticket Session.",
        );
      }
      const created = await options.runtime.command({
        commandId: `${input.operationId}:create`,
        command: {
          kind: "session.create",
          projectId: input.projectId,
          ticketId: input.ticketId,
          title: input.title,
        },
      });
      const selected = await options.runtime.command({
        commandId: `${input.operationId}:model`,
        sessionId: created.sessionId,
        command: { kind: "model.select", selection: model },
      });
      if (selected.receipt?.status !== "completed") {
        throw new TicketSessionsError(
          "MODEL_SELECTION_REJECTED",
          "The selected model policy could not be recorded for this Session.",
          created.sessionId,
        );
      }
      return attachTicketSession(options.runtime, input.operationId, created.sessionId);
    },
    async attach(input) {
      if (await options.readBornTicketless(input.sessionId)) {
        throw new TicketSessionsError(
          "SESSION_NOT_TICKET_SESSION",
          "The requested Session is not a Ticket Session",
          input.sessionId,
        );
      }
      return attachTicketSession(options.runtime, input.operationId, input.sessionId);
    },
  };
}

async function attachTicketSession(
  runtime: TicketSessionsOptions["runtime"],
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
