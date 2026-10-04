/** Composition ports, not a second engine or a second set of Session rules. */
import { describe, expect, expectTypeOf, it, vi, afterEach } from "vite-plus/test";
import type { HostCore } from "../index";
import type { createRuntimeAssembly } from "./assembly";
import { createSessions, type Sessions } from "./sessions";
import { createAutoTitler, type AutoTitler } from "./auto-title";
import { createPeekSummarizer } from "../session-control/peek-summary";
import { createDelegations } from "./delegate-session";
import { getProjectById } from "../db/projects-repo";
import { loadSkills } from "../skills";
import {
  createRuntimeSessionFacade,
  recoveredSessionClientPorts,
  recoveredSessionCommandPorts,
  type RuntimeSessionFacade,
} from "./facade";
import { createRuntimeSessionAgents } from "./agents";
import type { RecoveredSessionServices } from "./lifecycle";
import type { TicketSessionDelegationStore } from "./delegation-store";
import type { createRuntimeAutomations } from "./automations";

vi.mock("./sessions", async (original) => ({
  ...(await original<typeof import("./sessions")>()),
  createSessions: vi.fn(),
}));
vi.mock("./auto-title", () => ({ createAutoTitler: vi.fn() }));
vi.mock("../session-control/peek-summary", () => ({ createPeekSummarizer: vi.fn() }));
vi.mock("./delegate-session", () => ({ createDelegations: vi.fn() }));
vi.mock("../db/projects-repo", () => ({ getProjectById: vi.fn() }));
vi.mock("../skills", () => ({ loadSkills: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function fixture() {
  const sessions = { create: vi.fn() } as unknown as Sessions;
  const titler = { refine: vi.fn(async () => {}) } as AutoTitler;
  vi.mocked(createSessions).mockReturnValue(sessions);
  vi.mocked(createAutoTitler).mockReturnValue(titler);
  vi.mocked(createPeekSummarizer).mockReturnValue({ summarize: vi.fn(async () => null) });
  const engine = {
    getSession: vi.fn(),
    listEvents: vi.fn(async () => []),
    getOrRecordSessionInput: vi.fn(async () => ({})),
    observe: vi.fn(async () => {}),
    submit: vi.fn(async () => ({ receipt: { status: "completed" } })),
  };
  const runtime = { command: vi.fn(async () => ({})), projection: vi.fn() };
  const watch = {};
  const door = vi.fn(async () => ({ text: "ok" }));
  const agentServices = {
    createToolDoor: vi.fn<HostCore["agentServices"]["createToolDoor"]>(),
    createWatches: vi.fn<HostCore["agentServices"]["createWatches"]>(),
  };
  agentServices.createToolDoor.mockReturnValue(
    door as ReturnType<typeof agentServices.createToolDoor>,
  );
  agentServices.createWatches.mockReturnValue(
    watch as ReturnType<typeof agentServices.createWatches>,
  );
  const host = {
    database: { ok: true, db: {} },
    sessionEngine: engine,
    sessionWakeBus: { subscribe: vi.fn() },
    agentServices,
  } as unknown as HostCore;
  const assembly = {
    sessionRuntime: runtime,
    sessionToolSurface: {},
    piRuntimeHost: {},
    transcriptArtifacts: { read: vi.fn(async () => "artifact") },
  } as unknown as ReturnType<typeof createRuntimeAssembly>;
  const events = { publish: vi.fn() };
  const delegation = {} as TicketSessionDelegationStore;
  const facade = createRuntimeSessionFacade({
    host,
    assembly,
    homeDir: "/home",
    venue: { id: "remote", kind: "remote" },
    events,
    decisions: null,
    delegation,
  });
  const ready = { services: facade } as unknown as RecoveredSessionServices<RuntimeSessionFacade>;
  return {
    host,
    assembly,
    facade,
    ready,
    engine,
    runtime,
    events,
    sessions,
    delegation,
    agentServices,
    door,
    watch,
    titler,
  };
}

describe("lifted Session facade and recovered agent staging", () => {
  it("requires recovery proof at every public composition door", () => {
    expectTypeOf<RuntimeSessionFacade>().not.toExtend<
      Parameters<typeof recoveredSessionClientPorts>[0]
    >();
    expectTypeOf<RuntimeSessionFacade>().not.toExtend<
      Parameters<typeof recoveredSessionCommandPorts>[0]
    >();
    expectTypeOf<RuntimeSessionFacade>().not.toExtend<
      Parameters<ReturnType<typeof createRuntimeSessionAgents>["toolDoor"]>[0]
    >();
  });

  it("is inert, shares the supplied runtime/engine, and records injected venue without new writers", async () => {
    const f = fixture();
    expect(f.engine.getSession).not.toHaveBeenCalled();
    expect(f.engine.listEvents).not.toHaveBeenCalled();
    expect(f.runtime.command).not.toHaveBeenCalled();
    expect(createSessions).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: f.runtime, grants: f.delegation }),
    );
    expect(f.facade.sessionEngine).toBe(f.host.sessionEngine);
    const client = recoveredSessionClientPorts(f.ready);
    expect(client.sessionEngine).toBe(f.host.sessionEngine);
    expect(client.sessionRuntime).toBe(f.assembly.sessionRuntime);
    expect(client.summarizePeek).toBe(f.facade.peekSummarizer!.summarize);
    client.autoTitle!({} as Parameters<NonNullable<typeof client.autoTitle>>[0]);
    expect(f.titler.refine).toHaveBeenCalledOnce();
    await f.facade.sessionSkills!.record("s", [{ name: "a", text: "body" }]);
    expect(f.engine.getOrRecordSessionInput).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: {
          source: { kind: "system", id: "pi-runtime", detail: null },
          venue: { id: "remote", kind: "remote" },
        },
      }),
    );
    const titlePorts = vi.mocked(createAutoTitler).mock.calls[0]![0];
    await titlePorts.retitle("s", "title");
    expect(f.events.publish).toHaveBeenCalledWith("session-retitled", {
      sessionId: "s",
      title: "title",
    });
    await titlePorts.recordUsage("s", {} as Parameters<typeof titlePorts.recordUsage>[1]);
    expect(f.engine.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^usage:auto-title:/),
        provenance: {
          source: { kind: "system", id: "auto-title", detail: null },
          venue: { id: "remote", kind: "remote" },
        },
      }),
    );
  });

  it("keeps post-I/O skill policy and feeds CLI/tool kickoffs through one stable-id command", async () => {
    const f = fixture();
    vi.mocked(getProjectById)
      .mockReturnValueOnce({ path: "/repo" } as never)
      .mockReturnValueOnce({ skillModes: { a: "off" } } as never);
    vi.mocked(loadSkills).mockResolvedValue({
      ok: true,
      skills: [
        {
          name: "a",
          description: "a",
          body: "body",
          root: "/repo/.agents/skills/a",
          authorPolicy: { modelDiscoverable: true, userInvokable: true },
          effectivePolicy: { modelDiscoverable: true, userInvokable: true },
          policyDiagnostic: null,
        },
      ],
    });
    await expect(f.facade.sessionSkills!.resolve("p", ["a"])).rejects.toThrow(
      'The skill "a" was not found',
    );
    const ports = recoveredSessionCommandPorts(f.ready);
    expect(ports.sessionEngine).toBe(f.host.sessionEngine);
    expect(ports.submitSessionMessage).toBe(f.facade.submitKickoffMessage);
    await ports.submitSessionMessage!({
      sessionId: "s",
      commandId: "operation:command",
      messageId: "operation:message",
      text: "work",
    });
    expect(f.runtime.command).toHaveBeenCalledExactlyOnceWith({
      sessionId: "s",
      commandId: "operation:command",
      origin: undefined,
      command: {
        kind: "message.submit",
        message: { id: "operation:message", role: "user", parts: [{ type: "text", text: "work" }] },
      },
    });
  });

  it("exposes only recovery before ready; tools and lazy watches need the matching proof", async () => {
    const f = fixture();
    const delegated = {
      recover: vi.fn(async () => ({ answered: 0, reported: 0, skipped: 0 })),
      liveChildren: vi.fn(() => ["child"]),
    };
    vi.mocked(createDelegations).mockReturnValue(
      delegated as unknown as ReturnType<typeof createDelegations>,
    );
    const agents = createRuntimeSessionAgents({
      host: f.host,
      facade: f.facade,
      delegation: f.delegation,
      automations: { runner: null } as unknown as ReturnType<typeof createRuntimeAutomations>,
      mcpSettings: null,
      events: f.events,
      log: console,
    });
    expect(f.agentServices.createToolDoor).not.toHaveBeenCalled();
    expect(f.agentServices.createWatches).not.toHaveBeenCalled();
    const recovery = agents.recoveryDelegationsFor()!;
    expect(recovery).not.toHaveProperty("delegate");
    await recovery.recover([]);
    expect(delegated.recover).toHaveBeenCalledWith([]);
    expect(() => agents.toolDoor(f.facade as unknown as typeof f.ready)).toThrow(
      "different runtime",
    );
    expect(agents.toolDoor(f.ready)).toBe(f.door);
    expect(agents.toolDoor(f.ready)).toBe(f.door);
    expect(f.agentServices.createToolDoor).toHaveBeenCalledOnce();
    const toolPorts = f.agentServices.createToolDoor.mock.calls[0]![0];
    expect(toolPorts.submitSessionMessage).toBe(f.facade.submitKickoffMessage);
    expect(toolPorts.watches!()).toBe(f.watch);
    expect(toolPorts.watches!()).toBe(f.watch);
    expect(f.agentServices.createWatches).toHaveBeenCalledOnce();
    expect(f.agentServices.createWatches.mock.calls[0]![0].pendingSubagents!("s")).toEqual([
      "child",
    ]);
  });

  it("keeps degraded composition inert and refuses CLI Session ports without an engine", () => {
    const f = fixture();
    const facade = createRuntimeSessionFacade({
      host: { ...f.host, database: { ok: false, error: "unavailable" }, sessionEngine: null },
      assembly: {
        ...f.assembly,
        sessionRuntime: null,
        piRuntimeHost: null,
        sessionToolSurface: null,
      },
      homeDir: "/home",
      venue: { id: "local", kind: "local" },
      events: f.events,
      decisions: null,
      delegation: null,
    });
    expect(facade.sessions).toBeNull();
    expect(facade.sessionSkills).toBeNull();
    expect(facade.autoTitler).toBeNull();
    expect(facade.peekSummarizer).toBeNull();
    expect(facade.submitKickoffMessage).toBeUndefined();
    const ready = { services: facade } as unknown as typeof f.ready;
    expect(() => recoveredSessionCommandPorts(ready)).toThrow("engine is unavailable");
    const client = recoveredSessionClientPorts(ready);
    expect(client.sessionEngine).toBeNull();
    expect(client.sessionRuntime).toBeUndefined();
    expect(client.autoTitle).toBeUndefined();
    expect(client.summarizePeek).toBeUndefined();
  });
});
