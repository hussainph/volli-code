import { describe, expect, it } from "vite-plus/test";
import type {
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
} from "@volli/session-engine";
import type { SessionCommand } from "@volli/shared";

import {
  STRUCTURED_ADAPTER_ID,
  StructuredSessionsError,
  type SessionSkillPorts,
} from "./structured-sessions";
import { createTicketSessions } from "./ticket-sessions";

/** Skill ports for the Sessions these tests start: none named, none opted in. */
const NO_SKILLS: SessionSkillPorts = {
  resolve: async () => [],
  index: async () => null,
  record: async () => undefined,
};

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
  it("create mints the durable Session and records model policy WITHOUT attaching — the optimistic-open half", async () => {
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
      skills: NO_SKILLS,
    });

    const created = await ticketSessions.create({
      operationId: "operation-create",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
    });

    // The Session is durable and addressable NOW — the chat pane lands on this
    // id while the attach (worktree ensure + Agent Runtime) follows separately,
    // off the renderer's critical path (VC-16).
    expect(created).toEqual({ sessionId: "session-1" });
    expect(commands.map((request) => request.command.kind)).toEqual([
      "session.create",
      "model.select",
    ]);
    expect(commands.map((request) => request.commandId)).toEqual([
      "operation-create:create",
      "operation-create:model",
    ]);
  });

  it("create refuses a ticket outside the project and a missing default model, exactly as start does", async () => {
    const refusingTicket = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => false,
      runtime: { command: async (request) => result(request) },
      readDefaultModel,
      skills: NO_SKILLS,
    });
    await expect(
      refusingTicket.create({
        operationId: "op",
        projectId: "project-1",
        ticketId: "ticket-elsewhere",
        title: null,
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_IN_PROJECT" });

    const commands: SessionRuntimeCommandRequest[] = [];
    const noModel = createTicketSessions({
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(request);
        },
      },
      readDefaultModel: () => null,
      skills: NO_SKILLS,
    });
    await expect(
      noModel.create({ operationId: "op", projectId: "project-1", ticketId: "t", title: null }),
    ).rejects.toMatchObject({ code: "DEFAULT_MODEL_REQUIRED" });
    // Refused before anything durable: no session.create ever reached the runtime.
    expect(commands).toEqual([]);
  });

  it("creates, records model policy, and privately attaches the singular runtime in order", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      skills: NO_SKILLS,
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
      skills: NO_SKILLS,
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
      skills: NO_SKILLS,
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
      skills: NO_SKILLS,
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
      skills: NO_SKILLS,
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
      skills: NO_SKILLS,
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
      skills: NO_SKILLS,
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
      skills: NO_SKILLS,
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
      skills: NO_SKILLS,
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

  it("resolves named skills before creating and records them before attaching", async () => {
    const trail: string[] = [];
    const recorded: { sessionId: string; resources: readonly { name: string }[] }[] = [];
    const ticketSessions = createTicketSessions({
      skills: {
        resolve: async (projectId, names) => {
          trail.push(`resolve:${projectId}:${names.join(",")}`);
          return names.map((name) => ({ name, text: `body of ${name}` }));
        },
        index: async (projectId, injectedNames) => {
          trail.push(`index:${projectId}:${injectedNames.join(",")}`);
          return null;
        },
        record: async (sessionId, resources) => {
          trail.push("record");
          recorded.push({ sessionId, resources });
        },
      },
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) => {
          trail.push(request.command.kind);
          return result(
            request,
            request.command.kind === "adapter.attach" ? "accepted" : "completed",
          );
        },
      },
      readDefaultModel,
    });

    const started = await ticketSessions.start({
      ...startInput("operation-skills"),
      skills: ["svg-logo-designer"],
    });

    expect(started).toMatchObject({ sessionId: "session-1", state: "ready" });
    // Resolve fails BEFORE anything durable exists; record lands before the
    // attach so the first system prompt already reads the durable record.
    expect(trail).toEqual([
      "resolve:project-1:svg-logo-designer",
      // Asked with the resolved names, so the index never re-lists a skill
      // whose full body already rides this Session.
      "index:project-1:svg-logo-designer",
      "session.create",
      "model.select",
      "record",
      "adapter.attach",
    ]);
    expect(recorded).toEqual([
      {
        sessionId: "session-1",
        resources: [{ name: "svg-logo-designer", text: "body of svg-logo-designer" }],
      },
    ]);
  });

  it("refuses a start naming a missing skill before anything durable exists", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const ticketSessions = createTicketSessions({
      skills: {
        resolve: async () => {
          throw new StructuredSessionsError("SKILL_NOT_FOUND", "no such skill");
        },
        index: async () => null,
        record: async () => undefined,
      },
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
      ticketSessions.start({ ...startInput("operation-missing-skill"), skills: ["gone"] }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    expect(commands).toEqual([]);
  });

  it("never resolves nor records when nothing is named and nothing opted in", async () => {
    const indexAsks: string[] = [];
    const ticketSessions = createTicketSessions({
      skills: {
        resolve: async () => {
          throw new Error("resolve must not run");
        },
        index: async (projectId) => {
          indexAsks.push(projectId);
          return null;
        },
        record: async () => {
          throw new Error("record must not run");
        },
      },
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) =>
          result(request, request.command.kind === "adapter.attach" ? "accepted" : "completed"),
      },
      readDefaultModel,
    });

    await expect(ticketSessions.start(startInput("operation-plain"))).resolves.toMatchObject({
      sessionId: "session-1",
    });
    // The index IS asked — opt-in disclosure has no other trigger — but a null
    // answer leaves nothing to record.
    expect(indexAsks).toEqual(["project-1"]);
  });

  it("records the opt-in index even when the start names no skills", async () => {
    const recorded: { name: string; text: string }[][] = [];
    const ticketSessions = createTicketSessions({
      skills: {
        resolve: async () => {
          throw new Error("resolve must not run");
        },
        index: async () => ({ name: "skills index", text: "- a (.agents/skills/a/SKILL.md)" }),
        record: async (_sessionId, resources) => {
          recorded.push(resources.map((resource) => ({ ...resource })));
        },
      },
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) =>
          result(request, request.command.kind === "adapter.attach" ? "accepted" : "completed"),
      },
      readDefaultModel,
    });

    await ticketSessions.start(startInput("operation-index"));

    expect(recorded).toEqual([[{ name: "skills index", text: "- a (.agents/skills/a/SKILL.md)" }]]);
  });

  it("records the index behind the named bodies, specific material first", async () => {
    const recorded: string[][] = [];
    const ticketSessions = createTicketSessions({
      skills: {
        resolve: async (_projectId, names) => names.map((name) => ({ name, text: "body" })),
        index: async () => ({ name: "skills index", text: "index" }),
        record: async (_sessionId, resources) => {
          recorded.push(resources.map((resource) => resource.name));
        },
      },
      readBornTicketless: async () => false,
      ticketBelongsToProject: () => true,
      runtime: {
        command: async (request) =>
          result(request, request.command.kind === "adapter.attach" ? "accepted" : "completed"),
      },
      readDefaultModel,
    });

    await ticketSessions.start({ ...startInput("operation-both"), skills: ["named"] });

    expect(recorded).toEqual([["named", "skills index"]]);
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
