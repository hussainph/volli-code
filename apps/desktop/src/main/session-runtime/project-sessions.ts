/**
 * Product-owned project Session commands: a chat with a project and no Ticket.
 *
 * The Role is the only thing that separates this from a Ticket Session. Both
 * create durable identity first, both record a model policy before anything
 * attaches, and both attach the one structured runtime — so everything they
 * share lives in `structured-sessions.ts` and what remains here is the Role.
 *
 * `attach` carries one migration duty. Project Sessions predate the model
 * policy this runtime requires, so a Session born before it has nothing
 * recorded. Rather than substitute a model silently at attach time, the app
 * default is recorded as this Session's own `model.select` — the same durable,
 * observable event a Session created today writes at birth.
 */

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

export interface ProjectSessionStartInput {
  operationId: string;
  projectId: string;
  title: string | null;
  /** Skill slugs to inject at attach time. Absent means none — never ambient. */
  skills?: readonly string[];
}

export interface ProjectSessionAttachInput {
  operationId: string;
  sessionId: string;
}

export interface ProjectSessions {
  start(input: ProjectSessionStartInput): Promise<SessionStartResult>;
  attach(input: ProjectSessionAttachInput): Promise<SessionStartResult>;
}

export interface ProjectSessionsOptions {
  runtime: StructuredSessionCommands;
  readDefaultModel(): ModelSelection | null;
  readBornTicketless(sessionId: string): Promise<boolean>;
  /** This Session's durable model policy, or `null` when it has never recorded one. */
  readModelSelection(sessionId: string): Promise<ModelSelection | null>;
  skills: SessionSkillPorts;
}

export function createProjectSessions(options: ProjectSessionsOptions): ProjectSessions {
  return {
    async start(input) {
      const model = requireDefaultModel(options.readDefaultModel(), DEFAULT_MODEL_REQUIRED);
      // Named bodies resolved before anything durable exists, then the
      // best-effort opt-in index behind them — see ticket-sessions.ts.
      const explicit =
        input.skills !== undefined && input.skills.length > 0
          ? await options.skills.resolve(input.projectId, input.skills)
          : [];
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
          ticketId: null,
          title: input.title,
        },
      });
      await recordModelSelection(options.runtime, {
        commandId: `${input.operationId}:model`,
        sessionId: created.sessionId,
        model,
      });
      if (resources.length > 0) await options.skills.record(created.sessionId, resources);
      return attachStructuredSession(options.runtime, input.operationId, created.sessionId);
    },
    async attach(input) {
      if (!(await options.readBornTicketless(input.sessionId))) {
        throw new StructuredSessionsError(
          "SESSION_NOT_PROJECT_SESSION",
          "The requested Session is not a project Session",
          input.sessionId,
        );
      }
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
