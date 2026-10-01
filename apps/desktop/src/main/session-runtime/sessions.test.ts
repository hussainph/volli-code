import { describe, expect, it, vi } from "vite-plus/test";
import type { CodeModeBirth } from "@volli/shared";
import type {
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
} from "@volli/session-engine";
import type {
  ModelAccessSnapshot,
  McpToolDefinition,
  ModelSelection,
  SessionCommand,
  TicketEventActor,
} from "@volli/shared";

import { defaultModelRequiredForTier, mcpProviderToolName } from "@volli/shared";

import {
  anchoredOnParent,
  createSessions,
  STRUCTURED_ADAPTER_ID,
  StructuredSessionsError,
  type SessionSkillPorts,
  type SessionToolSurfacePorts,
  type SessionsOptions,
} from "./sessions";
import type { SessionGrantPorts } from "./delegation-policy";

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
  recorded: async () => null,
  record: async () => undefined,
};

const NO_GRANTS: SessionGrantPorts = {
  resolveBirth: () => ({ grants: [], delegation: null, parentSessionId: null }),
  recordBirth: () => undefined,
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
      readDefaultModel: async () => MODEL,
      readModelAnchor: async () => ({ selection: MODEL, tier: null }),
      ticketBelongsToProject: () => true,
      skills: NO_SKILLS,
      toolSurface: CODING_AND_ASK,
      grants: NO_GRANTS,
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
  it("freezes selected MCP definitions at root birth and gives a child its parent's exact frozen definitions", async () => {
    const parentTool: McpToolDefinition = {
      serverId: "server-1",
      toolName: "echo",
      providerName: mcpProviderToolName("server-1", "Fixture", "echo"),
      description: "Original description",
      inputSchema: { type: "object" },
    };
    const settingsTool: McpToolDefinition = {
      ...parentTool,
      description: "Changed after parent birth",
    };
    const records: Array<{
      sessionId: string;
      tools: readonly string[];
      mcpTools: readonly McpToolDefinition[];
    }> = [];
    const { sessions: door } = sessions({
      // This test is about MCP inheritance, not model inheritance: a parent
      // with no recorded anchor keeps the child's model off the stage.
      readModelAnchor: async () => ({ selection: null, tier: null }),
      toolSurface: {
        resolve: (_role, _grants, within, mcpTools = []) => [
          "read",
          ...mcpTools
            .map((tool) => tool.providerName)
            .filter((name) => within?.includes(name) ?? true),
        ],
        resolveMcp: () => [settingsTool],
        recorded: async () => ["read", parentTool.providerName],
        recordedMcp: async () => [parentTool],
        record: async (sessionId, tools, mcpTools = []) => {
          records.push({ sessionId, tools, mcpTools });
        },
      },
    });

    await door.create({
      operationId: "root",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "Root",
    });
    await door.create({
      operationId: "child",
      projectId: "project-1",
      ticketId: null,
      role: "subagent",
      parentSessionId: "parent-1",
      title: "Child",
    });

    expect(records).toEqual([
      {
        sessionId: "session-1",
        tools: ["read", settingsTool.providerName],
        mcpTools: [settingsTool],
      },
      {
        sessionId: "session-1",
        tools: ["read", parentTool.providerName],
        mcpTools: [parentTool],
      },
    ]);
  });

  it("asks once at birth whether the project offers classify, and freezes the answer into the surface (VC-478)", async () => {
    const asked: string[] = [];
    const records: Array<readonly string[]> = [];
    let configured = true;
    const { sessions: door } = sessions({
      toolSurface: {
        resolve: (_role, _grants, _within, _mcp, _codeMode, classify = false) => [
          "read",
          ...(classify ? (["classify"] as const) : []),
        ],
        resolveClassify: async (projectId) => {
          asked.push(projectId);
          return configured;
        },
        recorded: async () => null,
        record: async (_sessionId, tools) => {
          records.push(tools);
        },
      },
    });
    await door.create({
      operationId: "with",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "Born with a decision model",
    });
    // Turning the model off afterwards reaches the next Session only.
    configured = false;
    await door.create({
      operationId: "without",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "Born without",
    });
    expect(asked).toEqual(["project-1", "project-1"]);
    expect(records).toEqual([["read", "classify"], ["read"]]);
  });

  it("asks Code Mode once per birth, with the Session's own model, and hands both steps that one answer (VC-471)", async () => {
    const asked: unknown[] = [];
    const resolved: unknown[] = [];
    const recorded: unknown[] = [];
    const decision: CodeModeBirth = {
      mode: "both",
      nudge: false,
      offered: true,
      largeServers: new Set(),
    };
    const { sessions: door } = sessions({
      toolSurface: {
        codeModeAt: (model, mcpTools) => {
          asked.push([model, mcpTools]);
          return decision;
        },
        resolve: (_role, _grants, _within, _mcpTools, codeMode) => {
          resolved.push(codeMode);
          return ["read", "codemode"];
        },
        recorded: async () => null,
        record: async (_sessionId, _tools, _mcpTools, birth) => {
          recorded.push(birth);
        },
      },
    });
    await door.create({
      operationId: "root",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "Root",
    });
    expect(asked).toEqual([[MODEL, []]]);
    expect(resolved).toEqual([decision]);
    expect(recorded).toEqual([{ codeMode: decision }]);
    expect(resolved[0]).toBe(recorded[0] && (recorded[0] as { codeMode: unknown }).codeMode);
  });

  it("records no Code Mode decision where the host has none", async () => {
    const recorded: unknown[] = [];
    const { sessions: door } = sessions({
      toolSurface: {
        resolve: () => ["read"],
        recorded: async () => null,
        record: async (_sessionId, _tools, _mcpTools, birth) => {
          recorded.push(birth);
        },
      },
    });
    await door.create({
      operationId: "root",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "Root",
    });
    expect(recorded).toEqual([{}]);
  });

  it("asks the default-model port with the Role's tier AND the project — the chain's project rung (VC-126)", async () => {
    // The Role decides the rung (VC-53): a Ticket Session reads the `ticket`
    // tier, a project chat the `global` one. Spoken as a tier since VC-259,
    // because an override can name any rung and the port answers in one word.
    const asked: Array<[string, string | null]> = [];
    const { sessions: door } = sessions({
      readDefaultModel: async (tier, projectId) => {
        asked.push([tier, projectId]);
        return MODEL;
      },
    });

    await door.create({
      operationId: "operation-ticket",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      title: "VC-1",
    });
    await door.create({
      operationId: "operation-project",
      projectId: "project-2",
      ticketId: null,
      role: "project",
      title: "Board chat",
    });

    expect(asked).toEqual([
      ["ticket", "project-1"],
      ["global", "project-2"],
    ]);
  });

  it("create mints a Ticket Session and a Board Session through the one door — ticketId is the Role", async () => {
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
      role: "ticket",
      title: "VC-1",
    });
    const ticketless = await door.create({
      operationId: "operation-project",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "Board chat",
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

  it("forwards a client-minted id only inside the session.create intent (VC-358)", async () => {
    const REQUESTED = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const { commands, sessions: door } = sessions();

    const created = await door.create({
      ...startInput("operation-promote"),
      requestedSessionId: REQUESTED,
    });

    // The durable id IS the requested one — a promotion needs no swap,
    // because the client minted the id the ledger took.
    expect(created.sessionId).toBe(REQUESTED);
    expect(commands[0]).toMatchObject({
      // Still operation-derived: the requested id rides the intent, never
      // the key, so the engine's dedup sees one operation either way.
      commandId: "operation-promote:create",
      command: { kind: "session.create", requestedSessionId: REQUESTED },
    });
    // ONLY the create intent carries it — never the model record beside it.
    expect(commands[1]?.command).not.toHaveProperty("requestedSessionId");
  });

  it("keeps a create that names no id byte-identical to the legacy intent (VC-358)", async () => {
    const { commands, sessions: door } = sessions();

    const created = await door.create(startInput("operation-legacy"));

    // No id requested, so the ledger derives one, as it always has.
    expect(created.sessionId).toBe("session-1");
    expect(commands[0]?.command).toMatchObject({
      kind: "session.create",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      parentSessionId: null,
      title: "VC-1",
    });
    // Absent, not null: the key does not exist on a legacy create intent,
    // so what legacy callers write durably is unchanged.
    expect(commands[0]?.command).not.toHaveProperty("requestedSessionId");
  });

  it("restates the same requested id under the same command id on replay", async () => {
    // This layer's whole replay duty for a promoted chat: restate a
    // comparable intent. Whether a DIFFERING id is refused is the engine's
    // replay guard, which this facade never duplicates.
    const REQUESTED = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const { commands, sessions: door } = sessions();

    const first = await door.create({
      ...startInput("operation-promote-replay"),
      requestedSessionId: REQUESTED,
    });
    const replay = await door.create({
      ...startInput("operation-promote-replay"),
      requestedSessionId: REQUESTED,
    });

    expect(replay).toEqual(first);
    const creates = commands.filter((request) => request.command.kind === "session.create");
    expect(creates).toHaveLength(2);
    expect(creates[0]).toMatchObject({
      commandId: "operation-promote-replay:create",
      command: { requestedSessionId: REQUESTED },
    });
    expect(creates[1]).toMatchObject({
      commandId: "operation-promote-replay:create",
      command: { requestedSessionId: REQUESTED },
    });
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
      role: "ticket",
      title: null,
      actor: { kind: "session", sessionId: "driver-session", ticketId: "ticket-9" },
    });
    await door.create({
      operationId: "operation-human",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      title: null,
    });
    // No Ticket, no Ticket Event — planner history is Ticket history.
    await door.create({
      operationId: "operation-project",
      projectId: "project-1",
      ticketId: null,
      role: "project",
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
      role: "ticket",
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

  it("records birth grants before the frozen tool surface they authorize", async () => {
    const order: string[] = [];
    const delegation = {
      parentSessionId: "parent-session",
      depth: 1,
      maxDepth: 2,
      maxChildren: 3,
      claimToolCallId: "tool-call-1",
    } as const;
    const { sessions: door } = sessions({
      grants: {
        resolveBirth: (input) => {
          order.push(`resolve-grant:${input.role}`);
          expect(input.delegation).toEqual(delegation);
          return {
            grants: ["session.start"],
            delegation: input.delegation ?? null,
            parentSessionId: null,
          };
        },
        recordBirth: (_sessionId, birth) => {
          order.push(`record-grant:${birth.grants.join(",")}`);
        },
      },
      toolSurface: {
        resolve: (_role, grants) => {
          order.push(`resolve-surface:${grants?.join(",")}`);
          return ["read", "session.start"];
        },
        recorded: async () => null,
        record: () => {
          order.push("record-surface");
          return Promise.resolve();
        },
      },
    });

    await door.create({
      operationId: "operation-delegated",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      title: "Delegated work",
      delegation,
    });

    expect(order).toEqual([
      "resolve-grant:ticket",
      "resolve-surface:session.start",
      "record-grant:session.start",
      "record-surface",
    ]);
  });

  it("records the sanitized Agent Tool Surface before any attachment exists", async () => {
    const recorded: Array<{ sessionId: string; tools: readonly string[] }> = [];
    const { commands, sessions: door } = sessions({
      toolSurface: {
        resolve: () => ["read", "edit", "write", "execute", "ask_user", "web_fetch", "web_search"],
        recorded: async () => null,
        record: async (sessionId, tools) => {
          recorded.push({ sessionId, tools });
        },
      },
    });

    await door.create({
      operationId: "operation-tools",
      projectId: "project-1",
      ticketId: null,
      role: "project",
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

  it("resolves the surface for the Role the mint is creating (VC-162)", async () => {
    // Role determines the tool bundle, and `ticketId !== null` IS the Role on
    // start. Before this argument existed every Session resolved the same list
    // and Role-scoped availability was true only in CONTEXT.md.
    const roles: string[] = [];
    const door = () =>
      sessions({
        toolSurface: {
          resolve: (role) => {
            roles.push(role);
            return ["read"];
          },
          recorded: async () => null,
          record: async () => undefined,
        },
      }).sessions;

    await door().create({
      operationId: "operation-project",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "A Board chat",
    });
    await door().create({
      operationId: "operation-ticket",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      title: "Ticket work",
    });

    expect(roles).toEqual(["project", "ticket"]);
  });

  it("mints a Subagent Session as its own Role: stated on create, on the ladder root, bounded by its parent (VC-9, VC-431)", async () => {
    const modelTiers: string[] = [];
    const surfaceAsks: { role: string; within: readonly string[] | undefined }[] = [];
    const births: { role: string; parentSessionId: string | null }[] = [];
    const { commands, sessions: door } = sessions({
      // A parent that recorded NO anchor, which is the only condition under
      // which the Role's own rung is what a subagent resolves through.
      readModelAnchor: async () => ({ selection: null, tier: null }),
      readDefaultModel: async (tier) => {
        modelTiers.push(tier);
        return MODEL;
      },
      toolSurface: {
        resolve: (role, _grants, within) => {
          surfaceAsks.push({ role, within });
          return ["read", "edit", "write", "execute", "web_fetch"];
        },
        // The parent's own frozen surface, as the store recorded it: the child
        // may inherit web access only because the parent held it.
        recorded: async () => ["read", "edit", "write", "execute", "ask_user", "web_fetch"],
        record: async () => undefined,
      },
      grants: {
        resolveBirth: (input) => {
          births.push({
            role: input.role,
            parentSessionId: input.parentSessionId ?? null,
          });
          return { grants: [], delegation: null, parentSessionId: null };
        },
        recordBirth: () => undefined,
      },
    });

    const child = await door.create({
      operationId: "operation-child",
      projectId: "project-1",
      // Inherited from the parent, which is exactly why the Ticket cannot say
      // what Role this is.
      ticketId: "ticket-1",
      role: "subagent",
      parentSessionId: "parent-session",
      title: "Find the flaky test",
    });

    expect(child).toEqual({ sessionId: "session-1", model: MODEL });
    expect(commands[0]).toMatchObject({
      commandId: "operation-child:create",
      // The parent rides the create intent: a ledger fact, not a host table's.
      command: {
        kind: "session.create",
        ticketId: "ticket-1",
        role: "subagent",
        parentSessionId: "parent-session",
      },
    });
    // The LAST RESORT rung, and never `utility` (VC-431): a delegation is work
    // its parent asked for, so a subagent normally runs on the parent's own
    // anchor (`anchoredOnParent`), and this is only what a parent that
    // recorded no anchor leaves standing.
    // The port is asked in TIERS since VC-259 — a Role names no rung of its
    // own once a start may name one — so what arrives is the rung, mapped by
    // `modelPurposeForRole` at the one moment both facts are in hand.
    expect(modelTiers).toEqual(["global"]);
    expect(surfaceAsks).toEqual([
      {
        role: "subagent",
        within: ["read", "edit", "write", "execute", "ask_user", "web_fetch"],
      },
    ]);
    expect(births).toEqual([{ role: "subagent", parentSessionId: "parent-session" }]);
  });

  it("refuses a Subagent Session that names no parent, and a parent on any other Role, before anything durable exists", async () => {
    const { commands, sessions: door } = sessions();

    await expect(
      door.create({
        operationId: "operation-orphan",
        projectId: "project-1",
        ticketId: null,
        role: "subagent",
        title: null,
      }),
    ).rejects.toMatchObject({ code: "PARENT_REQUIRED" });
    // A Ticket Session with a parent is a caller that confused the two kinds
    // of child: a `session.start` peer carries delegation ancestry, not this.
    await expect(
      door.create({
        operationId: "operation-confused",
        projectId: "project-1",
        ticketId: "ticket-1",
        role: "ticket",
        parentSessionId: "parent-session",
        title: null,
      }),
    ).rejects.toMatchObject({ code: "PARENT_REQUIRED" });
    expect(commands).toEqual([]);
  });

  it("never re-resolves the surface for a Session that already exists", async () => {
    // The freeze, asserted where it is decided (VC-162). A grant recorded after
    // a Session exists is inert for it at EVERY later attachment — not merely
    // at the next one — because attaching does not consult the resolver at all.
    // A later grant reaches the next Session created.
    let resolves = 0;
    const { sessions: door } = sessions({
      toolSurface: {
        resolve: () => {
          resolves += 1;
          return ["read"];
        },
        recorded: async () => null,
        record: async () => undefined,
      },
    });

    await door.create({
      operationId: "operation-1",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "Frozen at birth",
    });
    await door.attach({ operationId: "operation-2", sessionId: "session-1" });
    await door.attach({ operationId: "operation-3", sessionId: "session-1" });

    expect(resolves).toBe(1);
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
    // In real data only a Board Session born before the model policy can
    // reach this branch (every mint above records at birth), but the rule is
    // stated for every Session rather than re-deriving the Role to scope it.
    const { commands, sessions: door } = sessions({
      readModelAnchor: async () => ({ selection: null, tier: null }),
    });

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
      readModelAnchor: async () => ({ selection: null, tier: null }),
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

  it("backfills from the global tier with no project — the rung every Role inherits", async () => {
    const asked: Array<[string, string | null]> = [];
    const { sessions: door } = sessions({
      readModelAnchor: async () => ({ selection: null, tier: null }),
      readDefaultModel: async (tier, projectId) => {
        asked.push([tier, projectId]);
        return MODEL;
      },
    });

    await door.attach({ operationId: "operation-backfill", sessionId: "session-legacy" });

    expect(asked).toEqual([["global", null]]);
  });

  it("refuses a backfill it cannot make honestly", async () => {
    const { commands, sessions: door } = sessions({
      readModelAnchor: async () => ({ selection: null, tier: null }),
      readDefaultModel: async () => null,
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
      // An exact-id override names no tier, so none is recorded.
      expect(commands[1]?.command).not.toHaveProperty("tier");
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
        readDefaultModel: async () => null,
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
        readDefaultModel: async () => null,
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

    /* ------------------------------- whenUnavailable: "record" (VC-133) --- */

    it("records an unavailable pin rather than refusing it, when asked to", async () => {
      // VC-112's Runtime clause, and the door an Automation Run comes through:
      // "a pinned model that has since become unavailable does not silently
      // fall back — let the Session fail through the existing error path." So
      // the Session EXISTS, carrying the model it was told to carry, and the
      // attach is what refuses it (`configuration_invalid`, which is `error`).
      const commands: SessionRuntimeCommandRequest[] = [];
      const created = await overrideSessions(commands).create({
        ...startInput("operation-retired-pin"),
        modelOverride: {
          model: { providerId: "acme", modelId: "retired" },
          reasoningLevel: "medium",
          whenUnavailable: "record",
        },
      });

      expect(created.model).toEqual({
        providerId: "acme",
        modelId: "retired",
        reasoningLevel: "medium",
      });
      // Durably, in the Session's own history — so the failure a person opens
      // names the model that caused it instead of an empty policy.
      expect(commands.map((request) => request.command.kind)).toEqual([
        "session.create",
        "model.select",
      ]);
      expect(commands[1]).toMatchObject({
        command: {
          kind: "model.select",
          selection: { providerId: "acme", modelId: "retired", reasoningLevel: "medium" },
        },
      });
    });

    it("records a level the model does not advertise rather than second-guessing it", async () => {
      // Same clause, the other half of a pin: a model that still exists but has
      // dropped the level this record pinned. One door, one answer — splitting
      // it would put half the failures in a toast and half in the Session.
      const commands: SessionRuntimeCommandRequest[] = [];
      const created = await overrideSessions(commands).create({
        ...startInput("operation-retired-level"),
        modelOverride: {
          model: { providerId: "anthropic", modelId: "claude-opus" },
          reasoningLevel: "xhigh",
          whenUnavailable: "record",
        },
      });

      expect(created.model).toEqual({
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "xhigh",
      });
    });

    it("never inspects Model Access at all for a recorded override", async () => {
      // Not merely tolerant of an unavailable answer: it does not ask. That is
      // what lets a Run start while the provider is unreachable, and what keeps
      // this arm free of a second availability policy that could drift.
      let inspections = 0;
      const { sessions: door } = sessions({
        inspectModelAccess: async () => {
          inspections += 1;
          return access;
        },
      });

      await door.create({
        ...startInput("operation-unasked"),
        modelOverride: {
          model: { providerId: "acme", modelId: "retired" },
          whenUnavailable: "record",
        },
      });

      expect(inspections).toBe(0);
    });

    it("still refuses a recorded override that names no model at all", async () => {
      // "Record it as asked" is not "invent one". A reasoning level with no
      // model and no default is unanswerable, and it refuses before anything
      // durable exists exactly as it always did.
      const { commands, sessions: door } = sessions({
        readDefaultModel: async () => null,
        inspectModelAccess: async () => access,
      });

      await expect(
        door.create({
          ...startInput("operation-record-no-model"),
          modelOverride: { reasoningLevel: "high", whenUnavailable: "record" },
        }),
      ).rejects.toMatchObject({ code: "DEFAULT_MODEL_REQUIRED" });
      expect(commands).toEqual([]);
    });

    it("keeps validation for every door that does not ask to record", async () => {
      // The default, and it is the human doors: a person who just picked a
      // model in a picker gets the immediate answer, with nothing started and
      // nothing to clean up.
      const commands: SessionRuntimeCommandRequest[] = [];
      await expect(
        overrideSessions(commands).create({
          ...startInput("operation-still-refuses"),
          modelOverride: { model: { providerId: "acme", modelId: "retired" } },
        }),
      ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
      expect(commands).toEqual([]);
    });
  });

  /**
   * A named tier (VC-259): the override names a KIND of work and the port
   * answers with the model the user configured for it. The Session is still
   * pinned to that model — `model.select` carries a selection, never a tier
   * name — so a later Settings change never moves a running Session.
   */
  describe("model tier override", () => {
    const FAST: ModelSelection = {
      providerId: "anthropic",
      modelId: "claude-opus",
      reasoningLevel: "low",
    };
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
      ],
    };

    it("asks the port for the named tier and records what it resolved to, level included", async () => {
      const asked: Array<[string, string | null]> = [];
      const { commands, sessions: door } = sessions({
        readDefaultModel: async (tier, projectId) => {
          asked.push([tier, projectId]);
          return tier === "fast" ? FAST : MODEL;
        },
      });

      const started = await door.start({
        ...startInput("operation-fast"),
        modelOverride: { tier: "fast" },
      });

      // The tier replaces the Role's rung: one question to the port, in the
      // tier's name, and with NO project — a named tier outranks the project's
      // pin, so the port is told to walk the tier ladder only.
      expect(asked).toEqual([["fast", null]]);
      expect(started.model).toEqual(FAST);
      // The pin is the model. The tier rides beside it as provenance — what
      // the header and `session list` say the model was asked for as.
      expect(commands[1]).toMatchObject({
        command: { kind: "model.select", selection: FAST, tier: "fast" },
      });
    });

    it("outranks the project's pinned model, which answers a question this start did not ask", async () => {
      // The port's own contract: a project id means "walk the project rung
      // first", null means "the tier ladder only". A named tier must arrive as
      // the second, or a pinned project would run every `tier: "fast"` Session
      // on its pin while the door's reply and the header still read `fast`.
      const PINNED = {
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "high",
      } as const;
      const asked: Array<[string, string | null]> = [];
      const { sessions: door } = sessions({
        readDefaultModel: async (tier, projectId) => {
          asked.push([tier, projectId]);
          return projectId === null ? FAST : PINNED;
        },
      });

      const started = await door.start({
        ...startInput("operation-tier-over-pin"),
        modelOverride: { tier: "fast" },
      });

      expect(asked).toEqual([["fast", null]]);
      expect(started.model).toEqual(FAST);
    });

    it("leaves the project's pin winning when no tier is named", async () => {
      const asked: Array<[string, string | null]> = [];
      const { sessions: door } = sessions({
        readDefaultModel: async (tier, projectId) => {
          asked.push([tier, projectId]);
          return MODEL;
        },
      });

      await door.start(startInput("operation-no-tier"));

      expect(asked).toEqual([["ticket", "project-1"]]);
    });

    it("never inspects Model Access for a bare tier — the row was validated when it was saved", async () => {
      let inspections = 0;
      const { sessions: door } = sessions({
        readDefaultModel: async () => FAST,
        inspectModelAccess: async () => {
          inspections += 1;
          return access;
        },
      });

      await door.create({
        ...startInput("operation-unasked-tier"),
        modelOverride: { tier: "deep" },
      });

      expect(inspections).toBe(0);
    });

    it("lets an explicit reasoning level override the tier's stored one, validated against the model", async () => {
      const { sessions: door } = sessions({
        readDefaultModel: async () => FAST,
        inspectModelAccess: async () => access,
      });

      const started = await door.start({
        ...startInput("operation-deep-high"),
        modelOverride: { tier: "deep", reasoningLevel: "high" },
      });

      expect(started.model).toEqual({ ...FAST, reasoningLevel: "high" });
    });

    it("refuses a level the tier's model cannot run, naming its levels", async () => {
      const { commands, sessions: door } = sessions({
        readDefaultModel: async () => FAST,
        inspectModelAccess: async () => access,
      });

      await expect(
        door.start({
          ...startInput("operation-deep-max"),
          modelOverride: { tier: "deep", reasoningLevel: "max" },
        }),
      ).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        message: expect.stringContaining("valid: low, medium, high"),
      });
      expect(commands).toEqual([]);
    });

    it("refuses a tier that resolves to nothing, naming the tier — never a substitute", async () => {
      const { commands, sessions: door } = sessions({ readDefaultModel: async () => null });

      await expect(
        door.start({ ...startInput("operation-empty-visual"), modelOverride: { tier: "visual" } }),
      ).rejects.toMatchObject({
        code: "DEFAULT_MODEL_REQUIRED",
        message: defaultModelRequiredForTier("visual"),
      });
      expect(commands).toEqual([]);
    });

    it("names the tier in the refusal even when a reasoning level rode along", async () => {
      const { commands, sessions: door } = sessions({
        readDefaultModel: async () => null,
        inspectModelAccess: async () => access,
      });

      await expect(
        door.start({
          ...startInput("operation-empty-fast-level"),
          modelOverride: { tier: "fast", reasoningLevel: "low" },
        }),
      ).rejects.toMatchObject({
        code: "DEFAULT_MODEL_REQUIRED",
        message: defaultModelRequiredForTier("fast"),
      });
      expect(commands).toEqual([]);
    });

    it("records the tier's answer as asked when told to, without inspecting", async () => {
      // An Automation Run's door (VC-133): the tier resolves at Run time and
      // the Session carries what it resolved to, with the attach as the judge.
      let inspections = 0;
      const { commands, sessions: door } = sessions({
        readDefaultModel: async () => FAST,
        inspectModelAccess: async () => {
          inspections += 1;
          return access;
        },
      });

      const created = await door.create({
        ...startInput("operation-recorded-tier"),
        modelOverride: { tier: "fast", reasoningLevel: "max", whenUnavailable: "record" },
      });

      expect(created.model).toEqual({ ...FAST, reasoningLevel: "max" });
      expect(commands[1]).toMatchObject({
        command: { kind: "model.select", selection: { ...FAST, reasoningLevel: "max" } },
      });
      expect(inspections).toBe(0);
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
    const { commands, sessions: door } = sessions({ readDefaultModel: async () => null });

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
      readDefaultModel: async () => null,
      recordSessionStarted: (event) => startedEvents.push(event),
    });

    await expect(
      door.create({
        operationId: "op",
        projectId: "project-1",
        ticketId: "ticket-1",
        role: "ticket",
        title: null,
      }),
    ).rejects.toMatchObject({ code: "DEFAULT_MODEL_REQUIRED" });
    expect(startedEvents).toEqual([]);
  });
});

/**
 * VC-431. A Subagent Session runs on its PARENT's anchor when the delegation
 * named nothing. The rung this replaced was `utility` — the slot for work
 * nobody asked for — which ran every un-named delegation on whatever cheap
 * background model that row held.
 *
 * The decision is pure and is tested directly: it is the whole of the rule,
 * and a harness between the assertion and the rule would only hide it. The
 * mint integration below covers the one thing purity cannot — that what a
 * child inherits is also what it RECORDS, so its own children read the same
 * answer.
 */
describe("anchoredOnParent — a subagent runs on its parent's anchor (VC-431)", () => {
  const PINNED: ModelSelection = {
    providerId: "anthropic",
    modelId: "claude-opus-5",
    reasoningLevel: "high",
  };
  const MODEL_OF_PINNED = { providerId: "anthropic", modelId: "claude-opus-5" };

  it("inherits the parent's rung AS A RUNG, not as the model it resolved to", () => {
    // The child therefore reads the user's current Deep row, rather than the
    // model its parent happened to resolve a moment ago. `selection` is
    // present and is deliberately NOT what comes back.
    expect(anchoredOnParent(undefined, { tier: "deep", selection: PINNED })).toEqual({
      tier: "deep",
    });
  });

  it("inherits an exact-id parent's model AND its level", () => {
    expect(anchoredOnParent(undefined, { tier: null, selection: PINNED })).toEqual({
      model: MODEL_OF_PINNED,
      reasoningLevel: "high",
    });
  });

  it("never inherits the Utility row as a rung, whatever an older build recorded", () => {
    // The model the parent is actually running, not the row no Session may be
    // started on.
    expect(anchoredOnParent(undefined, { tier: "utility", selection: PINNED })).toEqual({
      model: MODEL_OF_PINNED,
      reasoningLevel: "high",
    });
  });

  it("anchors to nothing for a parent that recorded nothing, leaving the Role's rung", () => {
    expect(anchoredOnParent(undefined, { tier: null, selection: null })).toBeUndefined();
  });

  it("anchors to nothing when a legacy Utility parent also recorded no model", () => {
    expect(anchoredOnParent(undefined, { tier: "utility", selection: null })).toBeUndefined();
  });

  it("lets the caller's own rung or model win, untouched", () => {
    const parent = { tier: "deep", selection: PINNED } as const;

    expect(anchoredOnParent({ tier: "fast" }, parent)).toEqual({ tier: "fast" });
    expect(anchoredOnParent({ model: MODEL_OF_PINNED }, parent)).toEqual({
      model: MODEL_OF_PINNED,
    });
  });

  it("rides a bare reasoning on an inherited rung, and on an inherited model", () => {
    // Naming only a level is naming no anchor: the parent's still applies, and
    // the caller's level wins over the rung's or the model's stored one.
    expect(
      anchoredOnParent({ reasoningLevel: "low" }, { tier: "deep", selection: PINNED }),
    ).toEqual({ tier: "deep", reasoningLevel: "low" });
    expect(anchoredOnParent({ reasoningLevel: "low" }, { tier: null, selection: PINNED })).toEqual({
      model: MODEL_OF_PINNED,
      reasoningLevel: "low",
    });
  });

  it("carries `whenUnavailable` onto either anchor, and onto no anchor at all", () => {
    // Where a refusal lands is the caller's to state, and is not part of the
    // model/rung alternative, so it survives every arm — including the one
    // that finds no anchor and hands the caller's own override back.
    expect(
      anchoredOnParent({ whenUnavailable: "record" }, { tier: "deep", selection: null }),
    ).toEqual({ tier: "deep", whenUnavailable: "record" });
    expect(
      anchoredOnParent({ whenUnavailable: "record" }, { tier: null, selection: PINNED }),
    ).toEqual({
      model: MODEL_OF_PINNED,
      reasoningLevel: "high",
      whenUnavailable: "record",
    });
    expect(
      anchoredOnParent(
        { reasoningLevel: "low", whenUnavailable: "record" },
        { tier: null, selection: null },
      ),
    ).toEqual({ reasoningLevel: "low", whenUnavailable: "record" });
  });
});

describe("a subagent's inherited anchor, through the one start door (VC-431)", () => {
  it("records the rung it inherited, so its own children inherit the same rung", async () => {
    const tiers: string[] = [];
    const { commands, sessions: door } = sessions({
      readModelAnchor: async () => ({ selection: MODEL, tier: "deep" }),
      readDefaultModel: async (tier) => {
        tiers.push(tier);
        return MODEL;
      },
    });

    await door.create({
      operationId: "operation-child",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "subagent",
      parentSessionId: "parent-session",
      title: "Find the flaky test",
    });

    // The Deep row was read, NOT the Subagent Role's own rung: the anchor is
    // an override, and an override names which rung `readDefaultModel` walks.
    expect(tiers).toEqual(["deep"]);
    // And the rung rides beside the resolved model, so the child's own
    // delegations read `deep` off it rather than falling to the Role's rung.
    expect(
      commands.find((request) => request.command.kind === "model.select")?.command,
    ).toMatchObject({ kind: "model.select", selection: MODEL, tier: "deep" });
  });

  it("refuses in words when the model it inherited is no longer available", async () => {
    // A parent pinned by exact id hands down that model, and an exact model is
    // validated against Model Access at start. Volli never silently falls back
    // to another model, so the delegating Session is told and nothing durable
    // is created.
    const { commands, sessions: door } = sessions({
      readModelAnchor: async () => ({ selection: MODEL, tier: null }),
      inspectModelAccess: async () => ({ models: [] }) as unknown as ModelAccessSnapshot,
    });

    await expect(
      door.create({
        operationId: "operation-child",
        projectId: "project-1",
        ticketId: "ticket-1",
        role: "subagent",
        parentSessionId: "parent-session",
        title: "Find the flaky test",
      }),
    ).rejects.toThrow(/not currently available/);
    expect(commands).toEqual([]);
  });

  it("asks nothing of a parent for a Session that has none", async () => {
    const asked: string[] = [];
    const { sessions: door } = sessions({
      readModelAnchor: async (sessionId) => {
        asked.push(sessionId);
        return { selection: MODEL, tier: "deep" };
      },
    });

    await door.create(startInput("operation-parentless"));

    // A Board or Ticket Session has no parent to inherit from, so the port is
    // never consulted and the Role's own rung stands.
    expect(asked).toEqual([]);
  });
});

function modelRecord(commands: SessionRuntimeCommandRequest[]) {
  return commands.find((request) => request.command.kind === "model.select")?.command;
}

describe("a decision model's choice of model, at birth (VC-432)", () => {
  const FAST: ModelSelection = {
    providerId: "anthropic",
    modelId: "haiku",
    reasoningLevel: "low",
  };
  const DEEP: ModelSelection = {
    providerId: "anthropic",
    modelId: "opus",
    reasoningLevel: "high",
  };
  const AUTO = { confidence: 0.8, alternatives: [{ selection: MODEL, probability: 0.15 }] };
  const access = {
    observedAt: 1,
    providers: [],
    models: [FAST, DEEP, MODEL].map((model) =>
      Object.assign({}, model, {
        label: model.modelId,
        state: "available",
        reasoningLevels: ["low", "medium", "high"],
        acceptsImageInput: false,
      }),
    ),
  } as unknown as ModelAccessSnapshot;
  const tiers = async (tier: string): Promise<ModelSelection> =>
    tier === "fast" ? FAST : tier === "deep" ? DEEP : MODEL;

  // A Session that has only just been created carries no model yet; only a
  // parent does. (The harness default answers every Session with MODEL, which
  // is how a REPLAYED start looks.)
  const FRESH = { selection: null, tier: null };
  const parentAnchored =
    (anchor: Awaited<ReturnType<SessionsOptions["readModelAnchor"]>>) => async (id: string) =>
      id === "parent-session" ? anchor : FRESH;
  const born = (overrides: Parameters<typeof sessions>[0] = {}) =>
    sessions({ readModelAnchor: parentAnchored({ selection: MODEL, tier: null }), ...overrides });

  function pick(overrides: Partial<SessionsOptions["autoSelect"] & object> = {}) {
    const asked: Array<Parameters<NonNullable<SessionsOptions["autoSelect"]>["decide"]>[0]> = [];
    return {
      asked,
      port: {
        available: () => true,
        decide: async (input) => {
          asked.push(input);
          return { selection: DEEP, auto: AUTO };
        },
        ...overrides,
      } satisfies NonNullable<SessionsOptions["autoSelect"]>,
    };
  }

  it("records the pick and why, offering only the approved pairs", async () => {
    const { asked, port } = pick();
    const { commands, sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      autoSelect: port,
    });

    const created = await door.create({
      ...startInput("operation-auto"),
      autoSelect: { request: "  rename a variable  " },
    });

    expect(created.model).toEqual(DEEP);
    expect(modelRecord(commands)).toEqual({ kind: "model.select", selection: DEEP, auto: AUTO });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      sessionId: "session-1",
      projectId: "project-1",
      request: "rename a variable",
      tierHint: null,
    });
    // The default first, then the tiers' own models; one pair once.
    expect(asked[0]?.candidates.map((candidate) => candidate.selection)).toEqual([
      MODEL,
      FAST,
      DEEP,
    ]);
  });

  it("freezes Code Mode for the automatic birth model, not the replaced default", async () => {
    const { port } = pick();
    const codeModeAt = vi.fn((): CodeModeBirth => ({
      mode: "both",
      nudge: false,
      offered: true,
      largeServers: new Set(),
    }));
    const { sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      autoSelect: port,
      toolSurface: { ...CODING_AND_ASK, codeModeAt },
    });
    await door.create({ ...startInput("operation-auto-codemode"), autoSelect: { request: "x" } });
    expect(codeModeAt).toHaveBeenCalledExactlyOnceWith(DEEP, []);
  });

  it("keeps the default's tier when the pick is the default itself", async () => {
    const { port } = pick({ decide: async () => ({ selection: MODEL, auto: AUTO }) });
    const { commands, sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      autoSelect: port,
    });
    await door.create({ ...startInput("operation-same"), autoSelect: { request: "x" } });
    expect(modelRecord(commands)).toEqual({ kind: "model.select", selection: MODEL, auto: AUTO });
  });

  it.each([
    ["a named model", { modelOverride: { model: DEEP } }],
    ["a named tier", { modelOverride: { tier: "fast" as const } }],
    ["a named reasoning level", { modelOverride: { reasoningLevel: "low" as const } }],
    ["no request", { autoSelect: { request: "   " } }],
  ])("never second-guesses a caller with %s", async (_name, extra) => {
    const { asked, port } = pick();
    const { sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      autoSelect: port,
    });
    await door.create({ ...startInput("operation-named"), autoSelect: { request: "x" }, ...extra });
    expect(asked).toEqual([]);
  });

  it("asks nothing and records nothing extra with no decision model, or no request offered", async () => {
    const { asked, port } = pick({ available: () => false });
    const withPort = born({ readDefaultModel: tiers, autoSelect: port });
    await withPort.sessions.create({
      ...startInput("operation-off"),
      autoSelect: { request: "x" },
    });
    expect(asked).toEqual([]);
    expect(modelRecord(withPort.commands)).toEqual({ kind: "model.select", selection: MODEL });

    const without = born({ readDefaultModel: tiers });
    await without.sessions.create({
      ...startInput("operation-none"),
      autoSelect: { request: "x" },
    });
    expect(modelRecord(without.commands)).toEqual({ kind: "model.select", selection: MODEL });

    const noHint = born({ readDefaultModel: tiers, autoSelect: port });
    await noHint.sessions.create(startInput("operation-no-hint"));
    expect(modelRecord(noHint.commands)).toEqual({ kind: "model.select", selection: MODEL });
    expect(asked).toEqual([]);
  });

  it.each([
    ["is unsure or missed", { decide: async () => null }],
    [
      "throws",
      {
        decide: async () => {
          throw new Error("down");
        },
      },
    ],
  ])("keeps the configured default when the decision %s", async (_name, overrides) => {
    const { port } = pick(overrides);
    const { commands, sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      autoSelect: port,
    });
    const created = await door.create({
      ...startInput("operation-miss"),
      autoSelect: { request: "x" },
    });
    expect(created.model).toEqual(MODEL);
    expect(modelRecord(commands)).toEqual({ kind: "model.select", selection: MODEL });
  });

  it("asks nothing when fewer than two pairs are approved", async () => {
    const { asked, port } = pick();
    const { sessions: door } = born({
      readDefaultModel: async () => MODEL,
      inspectModelAccess: async () => access,
      autoSelect: port,
    });
    await door.create({ ...startInput("operation-one"), autoSelect: { request: "x" } });
    // The port is still reached (it owns the "nothing to choose" answer), but
    // with a single candidate, so nothing can be sent.
    expect(asked.every((input) => input.candidates.length < 2)).toBe(true);
  });

  it("offers a tier's pair only when Model Access can run it, and never without an inspector", async () => {
    const { asked, port } = pick();
    const { sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () =>
        ({
          ...access,
          models: access.models.filter((model) => model.modelId !== "haiku"),
        }) as ModelAccessSnapshot,
      autoSelect: port,
    });
    await door.create({ ...startInput("operation-signed-out"), autoSelect: { request: "x" } });
    expect(asked[0]?.candidates.map((candidate) => candidate.selection)).toEqual([MODEL, DEEP]);

    const bare = pick();
    const { sessions: noInspector } = born({ readDefaultModel: tiers, autoSelect: bare.port });
    await noInspector.create({ ...startInput("operation-blind"), autoSelect: { request: "x" } });
    expect(bare.asked[0]?.candidates.map((candidate) => candidate.selection)).toEqual([MODEL]);
  });

  it("falls back, without a word, when the catalog cannot be read", async () => {
    const { asked, port } = pick();
    const { sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () => {
        throw new Error("catalog down");
      },
      autoSelect: port,
    });
    const created = await door.create({
      ...startInput("operation-catalog"),
      autoSelect: { request: "x" },
    });
    expect(created.model).toEqual(MODEL);
    expect(asked).toEqual([]);
  });

  it("states a replayed start's record again, whatever a second decision would say", async () => {
    const recorded = { confidence: 0.6, alternatives: [] };
    const { asked, port } = pick();
    const { commands, sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      // The person since changed its CURRENT model. A replay must restate
      // the original command, not that later selection.
      readModelAnchor: async () => ({ selection: DEEP, tier: "deep" }),
      readBirthModel: async (sessionId, commandId) => {
        expect(sessionId).toBe("session-1");
        expect(commandId).toBe("operation-replayed:model");
        return { selection: FAST, tier: null, auto: recorded };
      },
      autoSelect: port,
    });

    const created = await door.create({
      ...startInput("operation-replayed"),
      autoSelect: { request: "x" },
    });

    expect(asked).toEqual([]);
    expect(created.model).toEqual(FAST);
    expect(modelRecord(commands)).toEqual({
      kind: "model.select",
      selection: FAST,
      auto: recorded,
    });
  });

  it("restates a replayed start's record even once the decision model is off", async () => {
    const { port } = pick({ available: () => false });
    const { commands, sessions: door } = born({
      readDefaultModel: tiers,
      readBirthModel: async () => ({ selection: DEEP, tier: "deep", auto: AUTO }),
      autoSelect: port,
    });
    await door.create({ ...startInput("operation-replayed-off"), autoSelect: { request: "x" } });
    expect(modelRecord(commands)).toEqual({
      kind: "model.select",
      selection: DEEP,
      tier: "deep",
      auto: AUTO,
    });
  });

  it("falls back when the availability check throws, or the birth record cannot be read", async () => {
    const { port } = pick({
      available: () => {
        throw new Error("settings unreadable");
      },
    });
    const { sessions: door } = born({
      readDefaultModel: tiers,
      readBirthModel: async () => {
        throw new Error("projection unreadable");
      },
      autoSelect: port,
    });
    const created = await door.create({
      ...startInput("operation-throws"),
      autoSelect: { request: "x" },
    });
    expect(created.model).toEqual(MODEL);
  });

  it("bounds preparation and sends nothing if the catalog arrives after fallback", async () => {
    vi.useFakeTimers();
    try {
      const catalog = Promise.withResolvers<ModelAccessSnapshot>();
      const { asked, port } = pick();
      const { sessions: door } = born({
        readDefaultModel: tiers,
        inspectModelAccess: () => catalog.promise,
        autoSelect: port,
      });
      const created = door.create({
        ...startInput("operation-hung"),
        autoSelect: { request: "x" },
      });
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(created).resolves.toMatchObject({ model: MODEL });
      catalog.resolve(access);
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdraws slow inference at the deadline and ignores its late pick", async () => {
    vi.useFakeTimers();
    try {
      const answer =
        Promise.withResolvers<
          Awaited<ReturnType<NonNullable<SessionsOptions["autoSelect"]>["decide"]>>
        >();
      let signal: AbortSignal | undefined;
      const { port } = pick({
        decide: async (input) => {
          signal = input.signal;
          return answer.promise;
        },
      });
      const { commands, sessions: door } = born({
        readDefaultModel: tiers,
        inspectModelAccess: async () => access,
        autoSelect: port,
      });
      const created = door.create({
        ...startInput("operation-slow"),
        autoSelect: { request: "x" },
      });
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(created).resolves.toMatchObject({ model: MODEL });
      expect(signal?.aborted).toBe(true);
      answer.resolve({ selection: DEEP, auto: AUTO });
      await vi.advanceTimersByTimeAsync(0);
      expect(commands.filter((request) => request.command.kind === "model.select")).toEqual([
        expect.objectContaining({ command: { kind: "model.select", selection: MODEL } }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds concurrent attach until model, skills, grants and tools finish birth", async () => {
    const answer = Promise.withResolvers<void>();
    const deciding = Promise.withResolvers<void>();
    const surface = Promise.withResolvers<void>();
    const recording = Promise.withResolvers<void>();
    const order: string[] = [];
    let anchor: Awaited<ReturnType<SessionsOptions["readModelAnchor"]>> = FRESH;
    const { port } = pick({
      decide: async () => {
        deciding.resolve();
        await answer.promise;
        return { selection: DEEP, auto: AUTO };
      },
    });
    const { sessions: door } = born({
      readDefaultModel: tiers,
      readModelAnchor: async () => anchor,
      inspectModelAccess: async () => access,
      autoSelect: port,
      skills: {
        ...NO_SKILLS,
        index: async () => ({ name: "index", text: "skills" }),
        record: async () => {
          order.push("skills");
        },
      },
      grants: {
        ...NO_GRANTS,
        recordBirth: () => {
          order.push("grants");
        },
      },
      toolSurface: {
        ...CODING_AND_ASK,
        record: async () => {
          recording.resolve();
          await surface.promise;
          order.push("tools");
        },
      },
      runtime: {
        command: async (request) => {
          if (request.command.kind === "model.select") {
            anchor = { selection: request.command.selection, tier: null };
            order.push("model");
          }
          if (request.command.kind === "adapter.attach") order.push("attach");
          return result(request);
        },
      },
    });
    const birth = door.create({ ...startInput("operation-race"), autoSelect: { request: "x" } });
    await deciding.promise;
    const attached = door.attach({ operationId: "concurrent-attach", sessionId: "session-1" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    answer.resolve();
    await recording.promise;
    expect(order).toEqual(["model", "skills", "grants"]);
    surface.resolve();
    await Promise.all([birth, attached]);
    expect(order).toEqual(["model", "skills", "grants", "tools", "attach"]);
    expect(anchor.selection).toEqual(DEEP);
  });

  it("guards the durable-create publication window before the Session id is returned", async () => {
    const creating = Promise.withResolvers<void>();
    const created = Promise.withResolvers<void>();
    const readModelAnchor = vi.fn(async () => ({ selection: MODEL, tier: null }));
    const { sessions: door } = sessions({
      readModelAnchor,
      runtime: {
        command: async (request) => {
          if (request.command.kind === "session.create") {
            creating.resolve();
            await created.promise;
          }
          return result(request);
        },
      },
    });
    const birth = door.create(startInput("operation-publishing"));
    await creating.promise;
    const attach = door.attach({ sessionId: "session-1", operationId: "publishing-attach" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(readModelAnchor).not.toHaveBeenCalled();
    created.resolve();
    await Promise.all([birth, attach]);
    expect(readModelAnchor).toHaveBeenCalledOnce();
  });

  it("does not hold another Session behind a deciding birth", async () => {
    const deciding = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const { port } = pick({
      decide: async () => {
        deciding.resolve();
        await answer.promise;
        return { selection: DEEP, auto: AUTO };
      },
    });
    const { sessions: door, commands } = sessions({
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      autoSelect: port,
    });
    const birth = door.create({ ...startInput("operation-other"), autoSelect: { request: "x" } });
    await deciding.promise;
    await door.attach({ sessionId: "other-session", operationId: "other-attach" });
    expect(commands.at(-1)?.command.kind).toBe("adapter.attach");
    answer.resolve();
    await birth;
  });

  it("an incomplete birth is not legacy, and a successful retry releases its latch", async () => {
    let fail = true;
    const { sessions: door, commands } = born({
      toolSurface: {
        ...CODING_AND_ASK,
        record: async () => {
          if (fail) throw new Error("surface write failed");
        },
      },
    });
    const input = startInput("operation-incomplete");
    await expect(door.create(input)).rejects.toThrow("surface write failed");
    await expect(door.attach({ sessionId: "session-1", operationId: "too-early" })).rejects.toThrow(
      "surface write failed",
    );
    expect(commands.some((command) => command.command.kind === "adapter.attach")).toBe(false);
    fail = false;
    await door.create(input);
    await expect(
      door.attach({ sessionId: "session-1", operationId: "after-retry" }),
    ).resolves.toMatchObject({ state: "ready" });
  });

  it("never reclassifies a completed birth when its history read fails", async () => {
    const { asked, port } = pick();
    const commands: SessionRuntimeCommandRequest[] = [];
    let historyFails = false;
    const { sessions: door } = born({
      commands,
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      autoSelect: port,
      readBirthModel: async () => {
        if (historyFails) throw new Error("history unavailable");
        return null;
      },
      readBirthModelFromLedger: async (_sessionId, commandId) => {
        const intent = commands.find((command) => command.commandId === commandId)?.command;
        return intent?.kind === "model.select"
          ? { selection: intent.selection, tier: intent.tier ?? null, auto: intent.auto }
          : null;
      },
    });
    const input = { ...startInput("operation-history-failure"), autoSelect: { request: "x" } };
    const first = await door.create(input);
    historyFails = true;
    await expect(door.create(input)).resolves.toEqual(first);
    expect(asked).toHaveLength(1);
  });

  it("lets concurrent replays of one operation share one decision", async () => {
    const { asked, port } = pick();
    const { sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      autoSelect: port,
    });
    const input = { ...startInput("operation-concurrent"), autoSelect: { request: "x" } };
    await Promise.all([door.create(input), door.create(input)]);
    expect(asked).toHaveLength(1);
  });

  it("shares a birth through a slow model-record write, not just through inference", async () => {
    const written = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    const { asked, port } = pick();
    const { sessions: door } = born({
      readDefaultModel: tiers,
      inspectModelAccess: async () => access,
      autoSelect: port,
      readBirthModel: async () => null,
      runtime: {
        command: async (request) => {
          if (request.command.kind === "model.select") {
            writing.resolve();
            await written.promise;
          }
          return result(request);
        },
      },
    });
    const input = { ...startInput("operation-writing"), autoSelect: { request: "x" } };
    const first = door.create(input);
    await writing.promise;
    const replay = door.create(input);
    // Let the replay reach the birth while its durable write is pending.
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked).toHaveLength(1);
    written.resolve();
    await expect(Promise.all([first, replay])).resolves.toEqual([
      { sessionId: "session-1", model: DEEP },
      { sessionId: "session-1", model: DEEP },
    ]);
  });

  it("gives a subagent's decision the tier its parent runs on", async () => {
    const { asked, port } = pick();
    const { sessions: door } = born({
      readDefaultModel: tiers,
      readModelAnchor: parentAnchored({ selection: DEEP, tier: "deep" }),
      inspectModelAccess: async () => access,
      autoSelect: port,
    });
    await door.create({
      ...startInput("operation-child"),
      role: "subagent",
      parentSessionId: "parent-session",
      autoSelect: { request: "find the flaky test" },
    });
    expect(asked[0]?.tierHint).toBe("deep");
    // The child's fallback is its parent's anchor, which is the first candidate.
    expect(asked[0]?.candidates[0]?.selection).toEqual(DEEP);
  });

  it("reads a parent anchored on no agent tier as no hint", async () => {
    const { asked, port } = pick();
    const { sessions: door } = born({
      readDefaultModel: tiers,
      readModelAnchor: parentAnchored({ selection: DEEP, tier: "utility" }),
      inspectModelAccess: async () => access,
      autoSelect: port,
    });
    await door.create({
      ...startInput("operation-child-2"),
      role: "subagent",
      parentSessionId: "parent-session",
      autoSelect: { request: "x" },
    });
    expect(asked[0]?.tierHint).toBeNull();
  });
});

function startInput(operationId: string) {
  return {
    operationId,
    projectId: "project-1",
    ticketId: "ticket-1",
    role: "ticket" as const,
    title: "VC-1",
  };
}

function result(
  request: SessionRuntimeCommandRequest,
  status: "accepted" | "completed" | "rejected" = "completed",
): SessionRuntimeCommandResult {
  const sessionId =
    "sessionId" in request
      ? request.sessionId
      : request.command.kind === "session.create" && request.command.requestedSessionId
        ? // The engine honors a client-minted id (VC-358); the fixture does too.
          request.command.requestedSessionId
        : "session-1";
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
    refusal: null,
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
