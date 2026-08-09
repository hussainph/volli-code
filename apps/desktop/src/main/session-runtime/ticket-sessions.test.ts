import { describe, expect, it } from "vite-plus/test";
import type {
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
} from "@volli/session-engine";
import type { SessionCommand } from "@volli/shared";

import { createTicketSessions } from "./ticket-sessions";

function result(
  request: SessionRuntimeCommandRequest,
  status: "accepted" | "completed" | "rejected" = "completed",
): SessionRuntimeCommandResult {
  const sessionId = "sessionId" in request ? request.sessionId : "session-1";
  return {
    sessionId,
    command: {
      id: request.commandId,
      sessionId,
      createdAt: 1,
      route: null,
      intent: intentFor(request),
    },
    receipt:
      status === "completed"
        ? {
            id: `receipt:${request.commandId}`,
            commandId: request.commandId,
            status,
            result:
              request.command.kind === "session.create"
                ? { kind: "session.created", sessionId }
                : request.command.kind === "model.select"
                  ? { kind: "model.selected", sessionId }
                  : { kind: "executor.start.requested", sessionId },
            recordedAt: 2,
            sequence: 2,
          }
        : status === "accepted"
          ? {
              id: `receipt:${request.commandId}`,
              commandId: request.commandId,
              status,
              result: { kind: "executor.start.requested", sessionId },
              acceptedAt: 2,
              recordedAt: 2,
              sequence: 2,
            }
          : {
              id: `receipt:${request.commandId}`,
              commandId: request.commandId,
              status,
              code: "configuration_invalid",
              detail: "Sign in is required.",
              recordedAt: 2,
              sequence: 2,
            },
    throughSequence: 2,
  };
}

function intentFor(request: SessionRuntimeCommandRequest): SessionCommand["intent"] {
  if (request.command.kind === "session.create" || request.command.kind === "model.select") {
    return { ...request.command };
  }
  if (request.command.kind === "adapter.attach") {
    return {
      kind: "executor.start",
      adapterId: request.command.adapterId,
      continuity: request.command.continuity,
    };
  }
  throw new Error(`Unexpected fixture command ${request.command.kind}`);
}

describe("Ticket Sessions", () => {
  it("creates, records model policy, and privately attaches the singular runtime in order", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(
            request,
            request.command.kind === "adapter.attach" ? "accepted" : "completed",
          );
        },
      },
      readDefaultModel: () => ({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    });

    const started = await ticketSessions.start({
      operationId: "operation-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
    });

    expect(started).toMatchObject({ sessionId: "session-1", state: "ready" });
    expect(commands.map((request) => request.command.kind)).toEqual([
      "session.create",
      "model.select",
      "adapter.attach",
    ]);
    expect(commands[1]).toMatchObject({
      commandId: "operation-1:model",
      sessionId: "session-1",
    });
    expect(JSON.stringify(started)).not.toMatch(/adapter|profile|pi/i);
  });

  it("keeps a durable Session when the saved model now needs authentication", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(
            request,
            request.command.kind === "adapter.attach" ? "rejected" : "completed",
          );
        },
      },
      readDefaultModel: () => ({
        providerId: "anthropic",
        modelId: "claude-sonnet",
        reasoningLevel: "high",
      }),
    });

    await expect(
      ticketSessions.start({
        operationId: "operation-auth",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: "VC-1",
      }),
    ).resolves.toMatchObject({ sessionId: "session-1", state: "needs-recovery" });
    expect(commands.map((request) => request.command.kind)).toEqual([
      "session.create",
      "model.select",
      "adapter.attach",
    ]);
  });

  it("keeps the durable Session id when model policy cannot be recorded", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(
            request,
            request.command.kind === "model.select" ? "rejected" : "completed",
          );
        },
      },
      readDefaultModel,
    });

    await expect(ticketSessions.start(startInput("operation-model-refused"))).rejects.toMatchObject(
      {
        code: "MODEL_SELECTION_REJECTED",
        sessionId: "session-1",
      },
    );
    expect(commands.map((request) => request.command.kind)).toEqual([
      "session.create",
      "model.select",
    ]);
  });

  it("preserves the durable Session for explicit recovery when attachment is rejected", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(
            request,
            request.command.kind === "adapter.attach" ? "rejected" : "completed",
          );
        },
      },
      readDefaultModel,
    });

    const started = await ticketSessions.start(startInput("operation-recovery"));

    expect(started).toMatchObject({
      sessionId: "session-1",
      state: "needs-recovery",
      receipt: { status: "rejected", code: "configuration_invalid" },
    });
    expect(commands.map((request) => request.commandId)).toEqual([
      "operation-recovery:create",
      "operation-recovery:model",
      "operation-recovery:start",
    ]);
  });

  it("replays the same operation through stable idempotency keys", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(
            request,
            request.command.kind === "adapter.attach" ? "accepted" : "completed",
          );
        },
      },
      readDefaultModel,
    });

    const first = await ticketSessions.start(startInput("operation-replay"));
    const replay = await ticketSessions.start(startInput("operation-replay"));

    expect(replay).toEqual(first);
    expect(commands.map((request) => request.commandId)).toEqual([
      "operation-replay:create",
      "operation-replay:model",
      "operation-replay:start",
      "operation-replay:create",
      "operation-replay:model",
      "operation-replay:start",
    ]);
  });

  it("reattaches an existing Ticket Session without exposing runtime identity", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(request, "accepted");
        },
      },
      readDefaultModel,
    });

    const attached = await ticketSessions.attach({
      operationId: "operation-attach",
      sessionId: "session-existing",
    });

    expect(attached).toMatchObject({ sessionId: "session-existing", state: "ready" });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandId: "operation-attach:start",
      sessionId: "session-existing",
      command: { kind: "adapter.attach" },
    });
    expect(JSON.stringify(attached)).not.toMatch(/adapter|profile|pi/i);
  });

  it("requires a user-configured default before creating a Session", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(request);
        },
      },
      readDefaultModel: () => null,
    });

    await expect(ticketSessions.start(startInput("operation-no-default"))).rejects.toMatchObject({
      code: "DEFAULT_MODEL_REQUIRED",
      sessionId: null,
    });
    expect(commands).toEqual([]);
  });

  it("refuses a ticket outside the requested project before creating a Session", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => false,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(request);
        },
      },
      readDefaultModel,
    });

    await expect(ticketSessions.start(startInput("operation-cross-project"))).rejects.toMatchObject(
      {
        code: "TICKET_NOT_IN_PROJECT",
        sessionId: null,
      },
    );
    expect(commands).toEqual([]);
  });

  it("refuses to cross-attach a ticketless Session through the Pi route", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => true,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(request);
        },
      },
      readDefaultModel,
    });

    await expect(
      ticketSessions.attach({ operationId: "operation-cross-attach", sessionId: "scratch" }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_TICKET_SESSION", sessionId: "scratch" });
    expect(commands).toEqual([]);
  });
});

function startInput(operationId: string) {
  return {
    operationId,
    projectId: "project-1",
    ticketId: "ticket-1",
    title: "VC-1",
  };
}

function readDefaultModel() {
  return {
    providerId: "openai-codex",
    modelId: "gpt-5.6-sol",
    reasoningLevel: "high" as const,
  };
}
