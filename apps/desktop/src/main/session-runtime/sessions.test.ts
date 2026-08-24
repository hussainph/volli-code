import { describe, expect, it } from "vite-plus/test";
import type {
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
} from "@volli/session-engine";
import type {
  ModelAccessSnapshot,
  ModelSelection,
  SessionCommand,
  TicketEventActor,
} from "@volli/shared";

import {
  createSessions,
  STRUCTURED_ADAPTER_ID,
  StructuredSessionsError,
  type SessionSkillPorts,
  type SessionToolSurfacePorts,
  type SessionsOptions,
} from "./sessions";

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

const CODING_AND_ASK: SessionToolSurfacePorts = {
  resolve: () => ["read", "edit", "write", "execute", "ask_user"],
  record: async () => undefined,
};

/**
 * One harness for both Roles: the module under test is the single start door,
 * so the fixtures stop being two parallel copies too.
 */
function sessions(
  overrides: Partial<SessionsOptions> & { commands?: SessionRuntimeCommandRequest[] } = {},
) {
  const commands = overrides.commands ?? [];
  return {
    commands,
    sessions: createSessions({
      readDefaultModel: () => MODEL,
      readModelSelection: async () => MODEL,
      ticketBelongsToProject: () => true,
      skills: NO_SKILLS,
      toolSurface: CODING_AND_ASK,
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

describe("Sessions", () => {
  it("asks the default-model port with the Role AND the project — the chain's project rung (VC-126)", async () => {
    const asked: Array<[string, string | null]> = [];
    const { sessions: door } = sessions({
      readDefaultModel: (role, projectId) => {
        asked.push([role, projectId]);
        return MODEL;
      },
    });

    await door.create({
      operationId: "operation-ticket",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
    });
    await door.create({
      operationId: "operation-project",
      projectId: "project-2",
      ticketId: null,
      title: "Project chat",
    });

    expect(asked).toEqual([
      ["ticket", "project-1"],
      ["project", "project-2"],
    ]);
  });

  it("create mints a Ticket Session and a project Session through the one door — ticketId is the Role", async () => {
    const ticketsAsked: string[] = [];
    const { commands, sessions: door } = sessions({
      ticketBelongsToProject: (_projectId, ticketId) => {
        ticketsAsked.push(ticketId);
        return true;
      },
    });

    const ticketed = await door.create({
      operationId: "operation-ticket",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
    });
    const ticketless = await door.create({
      operationId: "operation-project",
      projectId: "project-1",
      ticketId: null,
      title: "Project chat",
    });

    // Both are durable and addressable NOW — the attach follows separately,
    // off the caller's critical path (VC-16) — and each answer carries the
    // model policy the mint recorded, which is what a Run stores (VC-126).
    expect(ticketed).toEqual({ sessionId: "session-1", model: MODEL });
    expect(ticketless).toEqual({ sessionId: "session-1", model: MODEL });
    // The Role travels as the nullable ticketId itself; nothing re-derives it.
    expect(commands).toMatchObject([
      {
        commandId: "operation-ticket:create",
        command: { kind: "session.create", ticketId: "ticket-1" },
      },
      { commandId: "operation-ticket:model", command: { kind: "model.select" } },
      {
        commandId: "operation-project:create",
        command: { kind: "session.create", ticketId: null },
      },
      { commandId: "operation-project:model", command: { kind: "model.select" } },
    ]);
    // The Ticket guard is a Ticket concern: a ticketless create never asks it.
    expect(ticketsAsked).toEqual(["ticket-1"]);
  });

  it("records session_started for a Ticket create with the door's actor — and never for a ticketless one", async () => {
    // The renderer never calls `start` since VC-16 (create → attach is its
    // whole path), so the planner event has to ride the one creation path
    // under both doors — otherwise an app-UI start would vanish from history
    // while a CLI start recorded (VC-13 acceptance).
    const startedEvents: { ticketId: string; sessionId: string; actor: TicketEventActor }[] = [];
    const { sessions: door } = sessions({
      recordSessionStarted: (event) => startedEvents.push(event),
    });

    await door.create({
      operationId: "operation-cli",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: null,
      actor: { kind: "session", sessionId: "driver-session", ticketId: "ticket-9" },
    });
    await door.create({
      operationId: "operation-human",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: null,
    });
    // No Ticket, no Ticket Event — planner history is Ticket history.
    await door.create({
      operationId: "operation-project",
      projectId: "project-1",
      ticketId: null,
      title: null,
    });

    expect(startedEvents).toEqual([
      {
        ticketId: "ticket-1",
        sessionId: "session-1",
        actor: { kind: "session", sessionId: "driver-session", ticketId: "ticket-9" },
      },
      // A start with no threaded actor is the human's.
      { ticketId: "ticket-1", sessionId: "session-1", actor: { kind: "user" } },
    ]);
  });

  it("start creates, records model policy, and privately attaches the singular runtime in order", async () => {
    const attaches: SessionRuntimeCommandRequest[] = [];
    const { sessions: door } = sessions({
      runtime: {
        command: async (request) => {
          attaches.push(request);
          return result(
            request,
            request.command.kind === "adapter.attach" ? "accepted" : "completed",
          );
        },
      },
    });

    const started = await door.start({
      operationId: "operation-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
    });

    expect(started).toMatchObject({ sessionId: "session-1", state: "ready" });
    // The start returns the model the Session durably recorded — the agent
    // socket door reports it (VC-13) whichever Role started.
    expect(started.model).toEqual(MODEL);
    expect(attaches).toMatchObject([
      { commandId: "operation-1:create", command: { kind: "session.create" } },
      { commandId: "operation-1:model", sessionId: "session-1" },
      {
        commandId: "operation-1:start",
        sessionId: "session-1",
        command: { kind: "adapter.attach" },
      },
    ]);
    // The runtime a chat attaches stays behind the product facade.
    expect(JSON.stringify(started)).not.toMatch(/adapter|profile|pi|opencode/i);
  });

  it("records the sanitized Agent Tool Surface before any attachment exists", async () => {
    const recorded: Array<{ sessionId: string; tools: readonly string[] }> = [];
    const { commands, sessions: door } = sessions({
      toolSurface: {
        resolve: () => ["read", "edit", "write", "execute", "ask_user", "web_fetch", "web_search"],
        record: async (sessionId, tools) => {
          recorded.push({ sessionId, tools });
        },
      },
    });

    await door.create({
      operationId: "operation-tools",
      projectId: "project-1",
      ticketId: null,
      title: "Frozen surface",
    });

    expect(recorded).toEqual([
      {
        sessionId: "session-1",
        tools: ["read", "edit", "write", "execute", "ask_user", "web_fetch", "web_search"],
      },
    ]);
    expect(commands.some((request) => request.command.kind === "adapter.attach")).toBe(false);
  });

  it("reattaches an existing Session with no Role question asked — one attach for both Roles", async () => {
    // The old Ticket/project facades each guarded "is this Session mine?" — a
    // wrong-namespace mistake the single door makes unrepresentable, so the
    // guard (and its two error codes) is not moved here; it is gone.
    const { commands, sessions: door } = sessions();

    const attached = await door.attach({
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
    expect(JSON.stringify(attached)).not.toMatch(/adapter|profile|pi|opencode/i);
  });

  it("records the app default for any Session that never recorded a model — one rule, no Role read", async () => {
    // In real data only a project Session born before the model policy can
    // reach this branch (every mint above records at birth), but the rule is
    // stated for every Session rather than re-deriving the Role to scope it.
    const { commands, sessions: door } = sessions({ readModelSelection: async () => null });

    const attached = await door.attach({
      operationId: "operation-backfill",
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
      { commandId: "operation-backfill:start", sessionId: "session-legacy" },
    ]);
  });

  it("writes one backfill when two attaches race the same legacy Session", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    // Stands in for the Session Engine's own dedup: one command id is one
    // command, whether the second statement of it arrives while the first is
    // still in flight or long after it settled.
    const issued = new Map<string, Promise<SessionRuntimeCommandResult>>();
    const { sessions: door } = sessions({
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
      door.attach({ operationId: "attach-a", sessionId: "session-legacy" }),
      door.attach({ operationId: "attach-b", sessionId: "session-legacy" }),
    ]);

    expect(first).toMatchObject({ sessionId: "session-legacy", state: "ready" });
    expect(second).toMatchObject({ sessionId: "session-legacy", state: "ready" });
    expect(commands.filter((request) => request.command.kind === "model.select")).toHaveLength(1);
  });

  it("refuses a backfill it cannot make honestly", async () => {
    const { commands, sessions: door } = sessions({
      readModelSelection: async () => null,
      readDefaultModel: () => null,
    });

    await expect(
      door.attach({ operationId: "operation-no-default", sessionId: "session-legacy" }),
    ).rejects.toMatchObject({ code: "DEFAULT_MODEL_REQUIRED", sessionId: "session-legacy" });
    expect(commands).toEqual([]);
  });

  it("keeps a rejected attachment durable for explicit recovery", async () => {
    const { sessions: door } = sessions({
      runtime: { command: async (request) => result(request, "rejected") },
    });

    await expect(
      door.attach({ operationId: "operation-rejected", sessionId: "session-existing" }),
    ).resolves.toMatchObject({
      sessionId: "session-existing",
      state: "needs-recovery",
      receipt: { status: "rejected", code: "configuration_invalid" },
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
          acceptsImageInput: true,
        },
        {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          label: "GPT",
          state: "available",
          reasoningLevels: ["high", "xhigh"],
          acceptsImageInput: true,
        },
        {
          providerId: "anthropic",
          modelId: "claude-signed-out",
          label: "Signed out",
          state: "authentication-required",
          reasoningLevels: ["medium"],
          acceptsImageInput: true,
        },
      ],
    };

    function overrideSessions(commands: SessionRuntimeCommandRequest[]) {
      return sessions({ commands, inspectModelAccess: async () => access }).sessions;
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

    it("falls back to central medium for a model-only override when no default exists", async () => {
      // The no-default + --model case: nothing to merge a level from, so the
      // override runs at Volli's central "medium" — validated like any other.
      const { commands, sessions: door } = sessions({
        readDefaultModel: () => null,
        inspectModelAccess: async () => access,
      });

      const started = await door.start({
        ...startInput("operation-central-medium"),
        modelOverride: { model: { providerId: "anthropic", modelId: "claude-opus" } },
      });

      expect(started.model).toEqual({
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "medium",
      });
      expect(commands[1]).toMatchObject({
        command: { kind: "model.select", selection: { reasoningLevel: "medium" } },
      });
    });

    it("requires a default or an explicit model before honoring a reasoning-only override", async () => {
      const { commands, sessions: door } = sessions({
        readDefaultModel: () => null,
        inspectModelAccess: async () => access,
      });

      await expect(
        door.start({
          ...startInput("operation-no-base"),
          modelOverride: { reasoningLevel: "high" },
        }),
      ).rejects.toMatchObject({ code: "DEFAULT_MODEL_REQUIRED" });
      expect(commands).toEqual([]);
    });

    it("refuses an override it has no Model Access seam to validate against", async () => {
      const { commands, sessions: door } = sessions();

      await expect(
        door.start({
          ...startInput("operation-no-seam"),
          modelOverride: { reasoningLevel: "high" },
        }),
      ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
      expect(commands).toEqual([]);
    });
  });

  it("refuses a ticket outside the requested project before creating a Session", async () => {
    const { commands, sessions: door } = sessions({ ticketBelongsToProject: () => false });

    await expect(door.start(startInput("operation-cross-project"))).rejects.toMatchObject({
      code: "TICKET_NOT_IN_PROJECT",
      sessionId: null,
    });
    expect(commands).toEqual([]);
  });

  it("requires a user-configured default before creating a Session", async () => {
    const { commands, sessions: door } = sessions({ readDefaultModel: () => null });

    await expect(door.start(startInput("operation-no-default"))).rejects.toMatchObject({
      code: "DEFAULT_MODEL_REQUIRED",
      sessionId: null,
    });
    expect(commands).toEqual([]);
  });

  it("keeps the durable Session id when model policy cannot be recorded", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const { sessions: door } = sessions({
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

    await expect(door.start(startInput("operation-model-refused"))).rejects.toMatchObject({
      code: "MODEL_SELECTION_REJECTED",
      sessionId: "session-1",
    });
    expect(commands.map((request) => request.command.kind)).toEqual([
      "session.create",
      "model.select",
    ]);
  });

  it("preserves the durable Session for explicit recovery when attachment is rejected", async () => {
    const commands: SessionRuntimeCommandRequest[] = [];
    const { sessions: door } = sessions({
      commands,
      runtime: {
        command: async (request) => {
          commands.push(request);
          return result(
            request,
            request.command.kind === "adapter.attach" ? "rejected" : "completed",
          );
        },
      },
    });

    const started = await door.start(startInput("operation-recovery"));

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
    const { commands, sessions: door } = sessions();

    const first = await door.start(startInput("operation-replay"));
    const replay = await door.start(startInput("operation-replay"));

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

  describe("skills", () => {
    it("resolves named skills before creating and records them before attaching", async () => {
      const trail: string[] = [];
      const recorded: { sessionId: string; resources: readonly { name: string }[] }[] = [];
      const { sessions: door } = sessions({
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
            return result(
              request,
              request.command.kind === "adapter.attach" ? "accepted" : "completed",
            );
          },
        },
      });

      const started = await door.start({
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
      const { commands, sessions: door } = sessions({
        skills: {
          resolve: async () => {
            throw new StructuredSessionsError("SKILL_NOT_FOUND", "no such skill");
          },
          index: async () => null,
          record: async () => undefined,
        },
      });

      await expect(
        door.start({ ...startInput("operation-missing-skill"), skills: ["gone"] }),
      ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
      expect(commands).toEqual([]);
    });

    it("never resolves nor records when nothing is named and nothing opted in", async () => {
      const indexAsks: string[] = [];
      const { sessions: door } = sessions({
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
      });

      await expect(door.start(startInput("operation-plain"))).resolves.toMatchObject({
        sessionId: "session-1",
      });
      // The index IS asked — opt-in disclosure has no other trigger — but a
      // null answer leaves nothing to record.
      expect(indexAsks).toEqual(["project-1"]);
    });

    it("records the opt-in index even when the start names no skills", async () => {
      const recorded: { name: string; text: string }[][] = [];
      const { sessions: door } = sessions({
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

      await door.start({ ...startInput("operation-index"), ticketId: null });

      expect(recorded).toEqual([
        [{ name: "skills index", text: "- a (.agents/skills/a/SKILL.md)" }],
      ]);
    });

    it("records the index behind the named bodies, specific material first", async () => {
      const recorded: string[][] = [];
      const { sessions: door } = sessions({
        skills: {
          resolve: async (_projectId, names) => names.map((name) => ({ name, text: "body" })),
          index: async () => ({ name: "skills index", text: "index" }),
          record: async (_sessionId, resources) => {
            recorded.push(resources.map((resource) => resource.name));
          },
        },
      });

      await door.start({ ...startInput("operation-both"), skills: ["named"] });

      expect(recorded).toEqual([["named", "skills index"]]);
    });
  });

  it("never records session_started for a create that refuses before creating", async () => {
    const startedEvents: unknown[] = [];
    const { sessions: door } = sessions({
      readDefaultModel: () => null,
      recordSessionStarted: (event) => startedEvents.push(event),
    });

    await expect(
      door.create({ operationId: "op", projectId: "project-1", ticketId: "ticket-1", title: null }),
    ).rejects.toMatchObject({ code: "DEFAULT_MODEL_REQUIRED" });
    expect(startedEvents).toEqual([]);
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
