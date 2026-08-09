import { describe, expect, it } from "vite-plus/test";
import type {
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
} from "@volli/session-engine";
import type { SessionCommand } from "@volli/shared";

import { createProjectSessions } from "./project-sessions";

describe("temporary project Sessions", () => {
  it("keeps the legacy executor behind a product-owned start operation", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const sessions = createProjectSessions({
      readBornTicketless: async () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(request);
        },
      },
    });

    const started = await sessions.start({
      operationId: "project-operation",
      projectId: "project-1",
      title: "Scratch",
    });

    expect(started).toMatchObject({ sessionId: "session-1", state: "ready" });
    expect(commands).toMatchObject([
      {
        commandId: "project-operation:create",
        command: {
          kind: "session.create",
          projectId: "project-1",
          ticketId: null,
          title: "Scratch",
        },
      },
      {
        commandId: "project-operation:start",
        sessionId: "session-1",
        command: { kind: "adapter.attach" },
      },
    ]);
    expect(JSON.stringify(started)).not.toMatch(/adapter|profile|opencode/i);
  });

  it("reattaches an existing project Session through the same private route", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const sessions = createProjectSessions({
      readBornTicketless: async () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(request);
        },
      },
    });

    const attached = await sessions.attach({
      operationId: "project-reattach",
      sessionId: "session-existing",
    });

    expect(attached).toMatchObject({ sessionId: "session-existing", state: "ready" });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandId: "project-reattach:start",
      sessionId: "session-existing",
      command: { kind: "adapter.attach" },
    });
  });

  it("refuses to cross-attach a Ticket Session through the compatibility route", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const sessions = createProjectSessions({
      readBornTicketless: async () => false,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(request);
        },
      },
    });

    await expect(
      sessions.attach({ operationId: "project-cross-attach", sessionId: "ticket-session" }),
    ).rejects.toThrow("not a project Session");
    expect(commands).toEqual([]);
  });
});

function result(request: SessionRuntimeCommandRequest): SessionRuntimeCommandResult {
  const sessionId = "sessionId" in request ? request.sessionId : "session-1";
  const intent: SessionCommand["intent"] =
    request.command.kind === "session.create"
      ? request.command
      : request.command.kind === "adapter.attach"
        ? {
            kind: "executor.start",
            adapterId: request.command.adapterId,
            continuity: request.command.continuity,
          }
        : (() => {
            throw new Error(`Unexpected fixture command ${request.command.kind}`);
          })();
  const receipt =
    request.command.kind === "adapter.attach"
      ? {
          id: `receipt:${request.commandId}`,
          commandId: request.commandId,
          status: "accepted" as const,
          result: { kind: "executor.start.requested" as const, sessionId },
          acceptedAt: 2,
          recordedAt: 2,
          sequence: 2,
        }
      : {
          id: `receipt:${request.commandId}`,
          commandId: request.commandId,
          status: "completed" as const,
          result: { kind: "session.created" as const, sessionId },
          recordedAt: 2,
          sequence: 2,
        };
  return {
    sessionId,
    command: {
      id: request.commandId,
      sessionId,
      createdAt: 1,
      route: null,
      intent,
    },
    receipt,
    throughSequence: 2,
  };
}
