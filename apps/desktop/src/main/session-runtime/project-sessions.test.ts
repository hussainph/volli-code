import { describe, expect, it } from "vite-plus/test";
import type {
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
} from "@volli/session-engine";
import type { ModelSelection, SessionCommand } from "@volli/shared";

import { createProjectSessions, type ProjectSessionsOptions } from "./project-sessions";
import {
  STRUCTURED_ADAPTER_ID,
  StructuredSessionsError,
  type SessionSkillPorts,
} from "./structured-sessions";

const MODEL: ModelSelection = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
  reasoningLevel: "high",
};

/** Skill ports for the Sessions these tests start: none named, none opted in. */
const NO_SKILLS: SessionSkillPorts = {
  resolve: async () => [],
  index: async () => null,
  record: async () => undefined,
};

function sessions(
  overrides: Partial<ProjectSessionsOptions> & { commands?: SessionRuntimeCommandRequest[] } = {},
) {
  const commands = overrides.commands ?? [];
  return {
    commands,
    projectSessions: createProjectSessions({
      readBornTicketless: async () => true,
      readDefaultModel: () => MODEL,
      readModelSelection: async () => MODEL,
      skills: NO_SKILLS,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(request);
        },
      },
      ...overrides,
    }),
  };
}

describe("project Sessions", () => {
  it("creates, records model policy, and privately attaches the singular runtime in order", async () => {
    const { commands, projectSessions } = sessions();

    const started = await projectSessions.start({
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
        commandId: "project-operation:model",
        sessionId: "session-1",
        command: { kind: "model.select", selection: MODEL },
      },
      {
        commandId: "project-operation:start",
        sessionId: "session-1",
        command: { kind: "adapter.attach" },
      },
    ]);
    // The runtime a project chat attaches stays behind the product facade.
    expect(JSON.stringify(started)).not.toMatch(/adapter|profile|pi|opencode/i);
  });

  it("resolves named skills before creating and records them before attaching", async () => {
    const trail: string[] = [];
    const recorded: { sessionId: string; resources: readonly { name: string }[] }[] = [];
    const { projectSessions } = sessions({
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
      runtime: {
        command: async (request) => {
          trail.push(request.command.kind);
          return result(request);
        },
      },
    });

    const started = await projectSessions.start({
      operationId: "project-skills",
      projectId: "project-1",
      title: null,
      skills: ["svg-logo-designer"],
    });

    expect(started).toMatchObject({ sessionId: "session-1", state: "ready" });
    expect(trail).toEqual([
      "resolve:project-1:svg-logo-designer",
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
    const { projectSessions } = sessions({
      commands,
      skills: {
        resolve: async () => {
          throw new StructuredSessionsError("SKILL_NOT_FOUND", "no such skill");
        },
        index: async () => null,
        record: async () => undefined,
      },
    });

    await expect(
      projectSessions.start({
        operationId: "project-missing-skill",
        projectId: "project-1",
        title: null,
        skills: ["gone"],
      }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    expect(commands).toEqual([]);
  });

  it("records the opt-in index even when the start names no skills", async () => {
    const recorded: { name: string; text: string }[][] = [];
    const { projectSessions } = sessions({
      skills: {
        resolve: async () => {
          throw new Error("resolve must not run");
        },
        index: async () => ({ name: "skills index", text: "- a (.agents/skills/a/SKILL.md)" }),
        record: async (_sessionId, resources) => {
          recorded.push(resources.map((resource) => ({ ...resource })));
        },
      },
    });

    await projectSessions.start({
      operationId: "project-index",
      projectId: "project-1",
      title: null,
    });

    expect(recorded).toEqual([[{ name: "skills index", text: "- a (.agents/skills/a/SKILL.md)" }]]);
  });

  it("refuses to start without a default model rather than choosing one", async () => {
    const { commands, projectSessions } = sessions({ readDefaultModel: () => null });

    await expect(
      projectSessions.start({
        operationId: "project-no-model",
        projectId: "project-1",
        title: null,
      }),
    ).rejects.toMatchObject({
      code: "DEFAULT_MODEL_REQUIRED",
      message: "Choose a default model in Settings before starting a Session.",
    });
    expect(commands).toEqual([]);
  });

  it("keeps the durable Session when its model policy could not be recorded", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const { projectSessions } = sessions({
      commands,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(
            request,
            request.command.kind === "model.select" ? "rejected" : "completed",
          );
        },
      },
    });

    await expect(
      projectSessions.start({
        operationId: "project-rejected-model",
        projectId: "project-1",
        title: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTION_REJECTED", sessionId: "session-1" });
    expect(commands.map((request) => request.command.kind)).toEqual([
      "session.create",
      "model.select",
    ]);
  });

  it("reattaches an existing project Session through the same private route", async () => {
    const { commands, projectSessions } = sessions();

    const attached = await projectSessions.attach({
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
    expect(JSON.stringify(attached)).not.toMatch(/adapter|profile|pi|opencode/i);
  });

  it("records the app default for a Session born before model policy existed", async () => {
    const { commands, projectSessions } = sessions({ readModelSelection: async () => null });

    const attached = await projectSessions.attach({
      operationId: "project-backfill",
      sessionId: "session-legacy",
    });

    expect(attached).toMatchObject({ sessionId: "session-legacy", state: "ready" });
    // The substitution is never silent: the default becomes this Session's own
    // durable selection before anything attaches.
    expect(commands).toMatchObject([
      {
        // Keyed on the Session, not the attach: see `modelBackfillCommandId`.
        commandId: "session-legacy:model-backfill",
        sessionId: "session-legacy",
        command: { kind: "model.select", selection: MODEL },
      },
      { commandId: "project-backfill:start", sessionId: "session-legacy" },
    ]);
  });

  it("writes one backfill when two attaches race the same legacy Session", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    // Stands in for the Session Engine's own dedup: one command id is one
    // command, whether the second statement of it arrives while the first is
    // still in flight or long after it settled.
    const issued = new Map<string, Promise<SessionRuntimeCommandResult>>();
    const { projectSessions } = sessions({
      readModelSelection: async () => null,
      runtime: {
        command: (request) => {
          const already = issued.get(request.commandId);
          if (already) return already;
          commands.push(request);
          const pending = Promise.resolve(result(request));
          issued.set(request.commandId, pending);
          return pending;
        },
      },
    });

    const [first, second] = await Promise.all([
      projectSessions.attach({ operationId: "attach-a", sessionId: "session-legacy" }),
      projectSessions.attach({ operationId: "attach-b", sessionId: "session-legacy" }),
    ]);

    expect(first).toMatchObject({ sessionId: "session-legacy", state: "ready" });
    expect(second).toMatchObject({ sessionId: "session-legacy", state: "ready" });
    expect(commands.filter((request) => request.command.kind === "model.select")).toHaveLength(1);
  });

  it("refuses a backfill it cannot make honestly", async () => {
    const { commands, projectSessions } = sessions({
      readModelSelection: async () => null,
      readDefaultModel: () => null,
    });

    await expect(
      projectSessions.attach({ operationId: "project-no-default", sessionId: "session-legacy" }),
    ).rejects.toMatchObject({
      code: "DEFAULT_MODEL_REQUIRED",
      sessionId: "session-legacy",
    });
    expect(commands).toEqual([]);
  });

  it("keeps a rejected project attachment durable for explicit recovery", async () => {
    const { projectSessions } = sessions({
      runtime: {
        command: async (request) => {
          const accepted = result(request);
          return {
            ...accepted,
            receipt: {
              id: `receipt:${request.commandId}`,
              commandId: request.commandId,
              status: "rejected",
              code: "configuration_invalid",
              detail: "Sign in is required.",
              recordedAt: 2,
              sequence: 2,
            },
          };
        },
      },
    });

    await expect(
      projectSessions.attach({ operationId: "project-rejected", sessionId: "session-existing" }),
    ).resolves.toMatchObject({
      sessionId: "session-existing",
      state: "needs-recovery",
      receipt: { status: "rejected", code: "configuration_invalid" },
    });
  });

  it("refuses to cross-attach a Ticket Session through the project route", async () => {
    const { commands, projectSessions } = sessions({ readBornTicketless: async () => false });

    await expect(
      projectSessions.attach({ operationId: "project-cross-attach", sessionId: "ticket-session" }),
    ).rejects.toThrow("not a project Session");
    expect(commands).toEqual([]);
  });
});

function result(
  request: SessionRuntimeCommandRequest,
  status: "accepted" | "completed" | "rejected" = "completed",
): SessionRuntimeCommandResult {
  const sessionId = "sessionId" in request ? request.sessionId : "session-1";
  const attaching = request.command.kind === "adapter.attach";
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
      status === "rejected"
        ? {
            id: `receipt:${request.commandId}`,
            commandId: request.commandId,
            status,
            code: "configuration_invalid",
            detail: "Sign in is required.",
            recordedAt: 2,
            sequence: 2,
          }
        : attaching
          ? {
              id: `receipt:${request.commandId}`,
              commandId: request.commandId,
              status: "accepted",
              result: { kind: "executor.start.requested", sessionId },
              acceptedAt: 2,
              recordedAt: 2,
              sequence: 2,
            }
          : {
              id: `receipt:${request.commandId}`,
              commandId: request.commandId,
              status: "completed",
              result:
                request.command.kind === "session.create"
                  ? { kind: "session.created", sessionId }
                  : { kind: "model.selected", sessionId },
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
