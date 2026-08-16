import { describe, expect, it } from "vite-plus/test";
import type {
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
} from "@volli/session-engine";
import type { ModelAccessSnapshot, SessionCommand, TicketEventActor } from "@volli/shared";

import { STRUCTURED_ADAPTER_ID } from "./structured-sessions";
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
      adapterId: STRUCTURED_ADAPTER_ID,
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

  it("records session_started in the shared creation path with the door's actor", async () => {
    const startedEvents: { ticketId: string; sessionId: string; actor: TicketEventActor }[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: { command: async (request) => result(request) },
      readDefaultModel,
      recordSessionStarted: (event) => startedEvents.push(event),
    });

    await ticketSessions.start({
      ...startInput("operation-event"),
      actor: { kind: "session", sessionId: "driver-session", ticketId: "ticket-9" },
    });

    expect(startedEvents).toEqual([
      {
        ticketId: "ticket-1",
        sessionId: "session-1",
        actor: { kind: "session", sessionId: "driver-session", ticketId: "ticket-9" },
      },
    ]);
  });

  it("attributes a start with no threaded actor to the human", async () => {
    const startedEvents: { actor: TicketEventActor }[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: { command: async (request) => result(request) },
      readDefaultModel,
      recordSessionStarted: (event) => startedEvents.push(event),
    });

    await ticketSessions.start(startInput("operation-user"));

    expect(startedEvents).toEqual([expect.objectContaining({ actor: { kind: "user" } })]);
  });

  it("never records session_started for a start that refuses before creating", async () => {
    const startedEvents: unknown[] = [];
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: { command: async (request) => result(request) },
      readDefaultModel: () => null,
      recordSessionStarted: (event) => startedEvents.push(event),
    });

    await expect(ticketSessions.start(startInput("operation-refused"))).rejects.toMatchObject({
      code: "DEFAULT_MODEL_REQUIRED",
    });
    expect(startedEvents).toEqual([]);
  });

  it("returns the model the Session durably recorded", async () => {
    const ticketSessions = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) =>
          result(request, request.command.kind === "adapter.attach" ? "accepted" : "completed"),
      },
      readDefaultModel,
    });

    const started = await ticketSessions.start(startInput("operation-model-out"));

    expect(started.model).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high",
    });
  });

  describe("invocation-time model override", () => {
    const access: ModelAccessSnapshot = {
      observedAt: 1,
      providers: [],
      models: [
        {
          providerId: "anthropic",
          modelId: "claude-opus",
          label: "Claude Opus",
          state: "available",
          reasoningLevels: ["low", "medium", "high"],
        },
        {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          label: "GPT",
          state: "available",
          reasoningLevels: ["high", "xhigh"],
        },
        {
          providerId: "anthropic",
          modelId: "claude-signed-out",
          label: "Signed out",
          state: "authentication-required",
          reasoningLevels: ["medium"],
        },
      ],
    };

    function overrideSessions(commands: SessionRuntimeCommandRequest[]) {
      return createTicketSessions({
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
        inspectModelAccess: async () => access,
      });
    }

    it("records a validated full override as the Session's own model policy", async () => {
      const commands: SessionRuntimeCommandRequest[] = [];
      const started = await overrideSessions(commands).start({
        ...startInput("operation-override"),
        modelOverride: {
          model: { providerId: "anthropic", modelId: "claude-opus" },
          reasoningLevel: "low",
        },
      });

      expect(started.model).toEqual({
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "low",
      });
      expect(commands[1]).toMatchObject({
        command: {
          kind: "model.select",
          selection: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "low" },
        },
      });
    });

    it("merges a reasoning-only override onto the configured default", async () => {
      const commands: SessionRuntimeCommandRequest[] = [];
      const started = await overrideSessions(commands).start({
        ...startInput("operation-reasoning"),
        modelOverride: { reasoningLevel: "xhigh" },
      });

      expect(started.model).toEqual({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
      });
    });

    it("carries the default's reasoning level onto a model-only override that supports it", async () => {
      const commands: SessionRuntimeCommandRequest[] = [];
      const started = await overrideSessions(commands).start({
        ...startInput("operation-model-only"),
        modelOverride: { model: { providerId: "anthropic", modelId: "claude-opus" } },
      });

      expect(started.model).toEqual({
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "high",
      });
    });

    it("refuses an override Model Access does not know, before creating anything", async () => {
      const commands: SessionRuntimeCommandRequest[] = [];
      await expect(
        overrideSessions(commands).start({
          ...startInput("operation-unknown"),
          modelOverride: { model: { providerId: "acme", modelId: "unknown" } },
        }),
      ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
      expect(commands).toEqual([]);
    });

    it("refuses a signed-out provider's model with the sign-in remedy", async () => {
      const commands: SessionRuntimeCommandRequest[] = [];
      await expect(
        overrideSessions(commands).start({
          ...startInput("operation-signed-out"),
          modelOverride: { model: { providerId: "anthropic", modelId: "claude-signed-out" } },
        }),
      ).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        message: expect.stringContaining("Sign in"),
      });
      expect(commands).toEqual([]);
    });

    it("refuses a reasoning level the chosen model cannot run, naming its levels", async () => {
      const commands: SessionRuntimeCommandRequest[] = [];
      await expect(
        overrideSessions(commands).start({
          ...startInput("operation-bad-level"),
          modelOverride: {
            model: { providerId: "anthropic", modelId: "claude-opus" },
            reasoningLevel: "xhigh",
          },
        }),
      ).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        message: expect.stringContaining("low, medium, high"),
      });
      expect(commands).toEqual([]);
    });

    it("requires a default or an explicit model before honoring a reasoning-only override", async () => {
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
        inspectModelAccess: async () => access,
      });

      await expect(
        ticketSessions.start({
          ...startInput("operation-no-base"),
          modelOverride: { reasoningLevel: "high" },
        }),
      ).rejects.toMatchObject({ code: "DEFAULT_MODEL_REQUIRED" });
      expect(commands).toEqual([]);
    });

    it("refuses an override it has no Model Access seam to validate against", async () => {
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
        readDefaultModel,
      });

      await expect(
        ticketSessions.start({
          ...startInput("operation-no-seam"),
          modelOverride: { reasoningLevel: "high" },
        }),
      ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
      expect(commands).toEqual([]);
    });
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
