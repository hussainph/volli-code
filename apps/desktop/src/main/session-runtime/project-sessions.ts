import type { SessionRuntime } from "@volli/session-engine";
import type { SessionStartResult } from "@volli/shared";

const LEGACY_PROJECT_ADAPTER_ID = "opencode";
const LEGACY_PROJECT_PROFILE_ID = "native";

export interface ProjectSessionStartInput {
  operationId: string;
  projectId: string;
  title: string | null;
}

export interface ProjectSessionAttachInput {
  operationId: string;
  sessionId: string;
}

export interface ProjectSessions {
  start(input: ProjectSessionStartInput): Promise<SessionStartResult>;
  attach(input: ProjectSessionAttachInput): Promise<SessionStartResult>;
}

export function createProjectSessions(options: {
  runtime: Pick<SessionRuntime, "command">;
  readBornTicketless(sessionId: string): Promise<boolean>;
}): ProjectSessions {
  return {
    async start(input) {
      const created = await options.runtime.command({
        commandId: `${input.operationId}:create`,
        command: {
          kind: "session.create",
          projectId: input.projectId,
          ticketId: null,
          title: input.title,
        },
      });
      return attachProjectSession(options.runtime, input.operationId, created.sessionId);
    },
    async attach(input) {
      if (!(await options.readBornTicketless(input.sessionId))) {
        throw new Error("The requested Session is not a project Session");
      }
      return attachProjectSession(options.runtime, input.operationId, input.sessionId);
    },
  };
}

async function attachProjectSession(
  runtime: Pick<SessionRuntime, "command">,
  operationId: string,
  sessionId: string,
): Promise<SessionStartResult> {
  const attached = await runtime.command({
    commandId: `${operationId}:start`,
    sessionId,
    command: {
      kind: "adapter.attach",
      adapterId: LEGACY_PROJECT_ADAPTER_ID,
      profileId: LEGACY_PROJECT_PROFILE_ID,
      continuity: "fresh",
    },
  });
  return {
    sessionId,
    state:
      attached.receipt?.status === "accepted" || attached.receipt?.status === "completed"
        ? "ready"
        : "needs-recovery",
    receipt: attached.receipt,
    throughSequence: attached.throughSequence,
  };
}
