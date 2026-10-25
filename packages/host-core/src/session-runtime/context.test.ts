import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionEngine } from "@volli/session-engine";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { hostMcpDispatch } from "../mcp/dispatch-policy";
import { createRuntimeContextResolver } from "./context";
import type { SessionToolSurfacePorts } from "./sessions";

let db: TestDb;
afterEach(() => db?.cleanup());
function fixture(brief?: Parameters<typeof createRuntimeContextResolver>[0]["brief"]) {
  db = openTestDb();
  insertProject(db.db, testProject({ id: "p", path: "/repo", ticketPrefix: "VC" }));
  insertTicket(db.db, testTicket("p", { id: "t", ticketNumber: 1 }));
  const getSession = vi.fn().mockResolvedValue({
    session: { id: "s", projectId: "p", ticketId: "t", role: "ticket", parentSessionId: null },
    modelSelection: { providerId: "scripted", modelId: "test", reasoningLevel: "off" },
  });
  const listEvents = vi.fn().mockResolvedValue([]);
  const getOrRecordSessionInput = vi.fn(async ({ input }) => input);
  const waitForBirth = vi.fn(async () => {});
  const resolve = vi.fn(() => ["read", "codemode"]);
  const surface = { resolve, resolveMcp: vi.fn(() => [] as unknown[]) };
  const context = createRuntimeContextResolver({
    db: db.db,
    sessionEngine: { getSession, listEvents, getOrRecordSessionInput } as unknown as SessionEngine,
    venue: { id: "test-host", kind: "remote" },
    mcpDispatch: hostMcpDispatch({ env: {}, packaged: true, log: vi.fn() }),
    waitForBirth,
    toolSurface: () => surface as unknown as SessionToolSurfacePorts,
    ...(brief === undefined ? {} : { brief }),
  });
  return {
    context,
    getSession,
    listEvents,
    getOrRecordSessionInput,
    waitForBirth,
    resolve,
    surface,
  };
}

describe("shared attach context", () => {
  it("waits for birth before reading, backfills without grants or Code Mode, and uses host venue", async () => {
    const f = fixture();
    const birth = Promise.withResolvers<void>();
    f.waitForBirth.mockReturnValue(birth.promise);
    const attaching = f.context("s");
    expect(f.getSession).not.toHaveBeenCalled();
    birth.resolve();
    expect(await attaching).toMatchObject({ role: "ticket", ticketId: "t", toolSurface: ["read"] });
    expect(f.resolve).toHaveBeenCalledWith("ticket", []);
    expect(
      f.getOrRecordSessionInput.mock.calls.every(
        ([input]) => input.provenance.venue.id === "test-host",
      ),
    ).toBe(true);
  });

  it("reuses frozen tools, resources and brief; never reselects today's tool surface", async () => {
    const f = fixture();
    f.listEvents.mockResolvedValue([
      { payload: { kind: "turn.started" } },
      {
        payload: {
          kind: "session.input.recorded",
          input: { kind: "tool-surface", tools: ["read"], mcpManagementNames: "server" },
        },
      },
      {
        payload: {
          kind: "session.input.recorded",
          input: { kind: "prompt-resources", resources: [{ name: "skill", text: "old" }] },
        },
      },
    ]);
    f.getOrRecordSessionInput.mockResolvedValue({ kind: "runtime-brief", text: "frozen brief" });
    expect(await f.context("s")).toMatchObject({
      brief: "frozen brief",
      promptResources: [{ name: "skill", text: "old" }],
    });
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("replays executable additions separately from the cold declaration and copy epoch", async () => {
    const f = fixture();
    const birth = { kind: "tool-surface", tools: ["read"] };
    const cold = { ...birth, tools: ["read", "write"], refreshDescriptions: true };
    const warm = { ...cold, tools: ["read", "edit", "write"] };
    f.listEvents.mockResolvedValue([
      inputEvent(birth),
      {
        id: "cold",
        payload: {
          kind: "session.tools.refreshed",
          trigger: "cold-turn",
          added: ["write"],
          changed: [],
          delta: { refreshDescriptions: true },
        },
      },
      {
        id: "warm",
        payload: {
          kind: "session.tools.refreshed",
          trigger: "warm-turn",
          added: ["edit"],
          changed: [],
          delta: {},
        },
      },
    ]);
    expect(await f.context("s")).toMatchObject({
      toolRefreshAnnouncements: [{ id: "warm", namespaces: [{ name: "volli", count: 1 }] }],
      toolSurface: warm.tools,
      declarationSurface: cold,
      refreshDescriptions: true,
    });
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it.each(["project", "subagent"])("briefs the Session's own %s role", async (role) => {
    const f = fixture();
    f.getSession.mockResolvedValue({
      session: { projectId: "p", ticketId: null, role, parentSessionId: "parent" },
      modelSelection: { providerId: "p", modelId: "m" },
    });
    expect(await f.context("s")).toMatchObject({ role, ticketId: null });
  });

  it("refuses an absent Session and corrupt durable input", async () => {
    const f = fixture();
    f.getSession.mockResolvedValueOnce(null);
    expect(await f.context("s")).toBeNull();
    f.getOrRecordSessionInput.mockResolvedValue({ kind: "prompt-resources", resources: [] });
    await expect(f.context("s")).rejects.toThrow("Recorded Agent Tool Surface");
    f.listEvents.mockResolvedValue([
      {
        payload: {
          kind: "session.input.recorded",
          input: { kind: "tool-surface", tools: ["read"] },
        },
      },
    ]);
    await expect(f.context("s")).rejects.toThrow("Recorded runtime brief");
  });
});

function inputEvent(input: unknown) {
  return { payload: { kind: "session.input.recorded", input } };
}
it("never retroactively grants today's MCP selection to a legacy Session", async () => {
  const f = fixture();
  f.surface.resolveMcp.mockReturnValue([{ serverId: "server", name: "read" }]);
  expect(await f.context("s")).not.toHaveProperty("mcpTools");
  const frozen = f.getOrRecordSessionInput.mock.calls[0]![0].input;
  expect(frozen).toMatchObject({ kind: "tool-surface", tools: ["read"] });
  expect(frozen).not.toHaveProperty("mcpTools");
  f.listEvents.mockResolvedValue([inputEvent(frozen)]);
  expect(await f.context("s")).not.toHaveProperty("mcpTools");
  expect(f.surface.resolveMcp).not.toHaveBeenCalled();
});
it("binds the durable winner when another first attach already recorded the surface", async () => {
  const f = fixture();
  const tool = {
    serverId: "server",
    name: "read",
    description: "reader",
    inputSchema: { type: "object" },
  };
  const frozen = {
    kind: "tool-surface",
    tools: ["write", "ask_user"],
    mcpTools: [tool],
    codeMode: { marker: "winner" },
    askUserQuestions: true,
  };
  f.getOrRecordSessionInput.mockImplementation(async ({ input }) =>
    input.kind === "tool-surface" ? frozen : input,
  );
  expect(await f.context("s")).toMatchObject({
    toolSurface: ["write", "ask_user"],
    mcpTools: [expect.objectContaining(tool)],
    codeMode: { marker: "winner" },
    askUserQuestions: true,
  });
  expect(f.surface.resolveMcp).not.toHaveBeenCalled();
});
it.each([undefined, true] as const)(
  "reattaches with the frozen ask_user declaration marker %s, not today's surface",
  async (askUserQuestions) => {
    const f = fixture();
    f.listEvents.mockResolvedValue([
      inputEvent({
        kind: "tool-surface",
        tools: ["read", "ask_user"],
        ...(askUserQuestions === undefined ? {} : { askUserQuestions }),
      }),
    ]);
    const attached = await f.context("s");
    expect(attached?.toolSurface).toEqual(["read", "ask_user"]);
    if (askUserQuestions === undefined) {
      expect(attached).not.toHaveProperty("askUserQuestions");
    } else {
      expect(attached).toHaveProperty("askUserQuestions", true);
    }
    expect(f.resolve).not.toHaveBeenCalled();
  },
);
it.each(["project", "ticket"] as const)(
  "keeps legacy %s steering authority on backfill",
  async (role) => {
    const f = fixture();
    f.getSession.mockResolvedValue({
      session: {
        id: "s",
        projectId: "p",
        ticketId: role === "ticket" ? "t" : null,
        role,
        parentSessionId: null,
      },
      modelSelection: { providerId: "scripted", modelId: "test", reasoningLevel: "off" },
    });
    f.resolve.mockReturnValue(["read", "codemode", "session.send", "session.delegate", "watch"]);
    const expected =
      role === "ticket"
        ? ["read", "session.delegate", "watch"]
        : ["read", "session.send", "session.delegate", "watch"];
    expect((await f.context("s"))?.toolSurface).toEqual(expected);
    const frozen = f.getOrRecordSessionInput.mock.calls[0]![0].input;
    expect(frozen.tools).toEqual(expected);
    f.listEvents.mockResolvedValue([inputEvent(frozen)]);
    f.resolve.mockClear();
    expect((await f.context("s"))?.toolSurface).toEqual(frozen.tools);
    expect(f.resolve).not.toHaveBeenCalled();
  },
);

it("backfills a legacy ask_user surface without opting into a new declaration", async () => {
  const f = fixture();
  f.resolve.mockReturnValue(["read", "ask_user", "codemode"]);
  expect(await f.context("s")).not.toHaveProperty("askUserQuestions");
  const frozen = f.getOrRecordSessionInput.mock.calls[0]![0].input;
  expect(frozen.tools).toEqual(["read", "ask_user"]);
  expect(frozen).not.toHaveProperty("askUserQuestions");
  f.listEvents.mockResolvedValue([inputEvent(frozen)]);
  expect(await f.context("s")).not.toHaveProperty("askUserQuestions");
});
it("cannot backfill an in-flight birth: the barrier must actually wait", async () => {
  const f = fixture();
  const birth = Promise.withResolvers<void>();
  f.waitForBirth.mockReturnValue(birth.promise);
  const attach = f.context("s");
  await Promise.resolve();
  await Promise.resolve();
  expect(f.getSession).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
  f.listEvents.mockResolvedValue([
    inputEvent({
      kind: "tool-surface",
      tools: ["read"],
      mcpTools: [],
      codeMode: { marker: "frozen" },
    }),
  ]);
  birth.resolve();
  expect(await attach).toMatchObject({ toolSurface: ["read"], codeMode: { marker: "frozen" } });
  expect(f.resolve).not.toHaveBeenCalled();
});
it("refuses unavailable project/model, orphan tickets and malformed subagent ancestry", async () => {
  const f = fixture();
  f.getSession.mockResolvedValueOnce({ session: { projectId: "missing" }, modelSelection: {} });
  expect(await f.context("s")).toBeNull();
  expect(f.listEvents).not.toHaveBeenCalled();
  expect(f.getOrRecordSessionInput).not.toHaveBeenCalled();
  f.getSession.mockResolvedValueOnce({ session: { projectId: "p" }, modelSelection: null });
  expect(await f.context("s")).toBeNull();
  f.getSession.mockResolvedValueOnce({
    session: { projectId: "p", ticketId: "missing", role: "ticket" },
    modelSelection: {},
  });
  expect(await f.context("s")).toBeNull();
  insertProject(db.db, testProject({ id: "other", path: "/other", ticketPrefix: "OT" }));
  insertTicket(db.db, testTicket("other", { id: "foreign" }));
  f.getSession.mockResolvedValueOnce({
    session: { projectId: "p", ticketId: "foreign", role: "ticket" },
    modelSelection: {},
  });
  expect(await f.context("s")).toBeNull();
  f.getSession.mockResolvedValueOnce({
    session: { projectId: "p", role: "subagent", ticketId: "t", parentSessionId: null },
    modelSelection: {},
  });
  expect(await f.context("s")).toBeNull();
  for (const ticketId of ["t", "foreign", "missing", null]) {
    f.getSession
      .mockResolvedValueOnce({
        session: { projectId: "p", role: "subagent", ticketId, parentSessionId: "parent" },
        modelSelection: {},
      })
      .mockResolvedValueOnce(null);
    expect(await f.context("s")).toMatchObject({
      role: "subagent",
      ticketId: ticketId === "t" ? "t" : null,
    });
  }
  delete (f.surface as { resolveMcp?: unknown }).resolveMcp;
  f.getSession.mockResolvedValueOnce({
    session: { projectId: "p", role: "ticket", ticketId: null },
    modelSelection: {},
  });
  expect(await f.context("s")).toMatchObject({ role: "project" });
});

it("uses the chosen store's first brief without a SQLite project, and then binds only the durable winner", async () => {
  const brief = vi.fn(async () => "cloud brief");
  const f = fixture(brief);
  db.db.prepare("DELETE FROM tickets").run();
  db.db.prepare("DELETE FROM projects").run();
  expect(await f.context("s")).toMatchObject({
    role: "ticket",
    ticketId: "t",
    brief: "cloud brief",
  });
  expect(brief).toHaveBeenCalledTimes(1);
  f.listEvents.mockResolvedValue([
    {
      payload: { kind: "session.input.recorded", input: { kind: "tool-surface", tools: ["read"] } },
    },
    {
      payload: {
        kind: "session.input.recorded",
        input: { kind: "runtime-brief", text: "frozen cloud brief" },
      },
    },
  ]);
  brief.mockRejectedValue(new Error("offline"));
  expect(await f.context("s")).toMatchObject({ brief: "frozen cloud brief" });
  expect(brief).toHaveBeenCalledTimes(1);
  f.listEvents.mockResolvedValue([]);
  brief.mockResolvedValue("proposed brief");
  f.getOrRecordSessionInput.mockImplementation(async ({ input }) =>
    input.kind === "runtime-brief"
      ? { kind: "runtime-brief", text: "competing durable winner" }
      : input,
  );
  expect(await f.context("s")).toMatchObject({ brief: "competing durable winner" });
});

it.each([
  {
    role: "project",
    ticketId: null,
    parentSessionId: null,
    expected: { role: "project", ticketId: null },
  },
  {
    role: "ticket",
    ticketId: null,
    parentSessionId: null,
    expected: { role: "project", ticketId: null },
  },
  {
    role: "subagent",
    ticketId: "t",
    parentSessionId: "parent",
    expected: { role: "subagent", ticketId: "t", parentSessionId: "parent" },
  },
  {
    role: "subagent",
    ticketId: null,
    parentSessionId: "parent",
    expected: { role: "subagent", ticketId: null, parentSessionId: "parent" },
  },
  { role: "subagent", ticketId: "t", parentSessionId: null, expected: null },
])("preserves cloud attach identity for $role/$ticketId/$parentSessionId", async (input) => {
  const f = fixture(async () => "brief");
  f.getSession.mockResolvedValue({
    session: {
      id: "s",
      projectId: "p",
      role: input.role,
      ticketId: input.ticketId,
      parentSessionId: input.parentSessionId,
    },
    modelSelection: { providerId: "scripted", modelId: "test", reasoningLevel: "off" },
  });
  const attached = await f.context("s");
  if (input.expected === null) expect(attached).toBeNull();
  else expect(attached).toMatchObject(input.expected);
});

it("refuses first attach clearly when the selected store cannot read its brief", async () => {
  const f = fixture(async () => {
    throw new Error("Volli Cloud is unreachable; this ticket's brief can't be read.");
  });
  await expect(f.context("s")).rejects.toThrow("Volli Cloud is unreachable");
});
