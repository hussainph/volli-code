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
  skills: SessionSkillPorts;
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
