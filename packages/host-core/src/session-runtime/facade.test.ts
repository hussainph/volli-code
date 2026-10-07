/** Composition ports, not a second engine or a second set of Session rules. */
import { describe, expect, expectTypeOf, it, vi, afterEach } from "vite-plus/test";
import { EMPTY_MODEL_ACCESS_DEFAULTS } from "@volli/shared";
import { readModelAccessDefaults } from "./model-access-preferences";
import type { DegradedHostCore, LiveHostCore } from "../index";
import type { createRuntimeAssembly } from "./assembly";
import { createSessions, type Sessions } from "./sessions";
import { createAutoTitler, type AutoTitler } from "./auto-title";
import { createPeekSummarizer } from "../session-control/peek-summary";
import { createDelegations } from "./delegate-session";
import { getProjectById, getProjectAuthorityPolicy, listProjects } from "../db/projects-repo";
import { getTicket, getTicketBrief } from "../db/tickets-repo";
import { recordSessionStartedOnce } from "../db/events-repo";
import { getComment } from "../db/comments-repo";
import { listAutomationsForProject } from "../db/automations-repo";
import { loadSkills } from "../skills";
import { createHostAgentToolDoor, createHostAgentWatches } from "../agent-services";
import {
  createRuntimeSessionFacade,
  recoveredRuntimeSessionServices,
  recoveredSessionAutomationPorts,
  recoveredSessionClientPorts,
  recoveredSessionCommandPorts,
  type RuntimeSessionFacade,
} from "./facade";
import type { RuntimeSessionAgents } from "./agents";
import { createSessionRuntimeLifecycle } from "./lifecycle";
import type { TicketSessionDelegationStore } from "./delegation-store";
import type { createRuntimeAutomations } from "./automations";

vi.mock("./sessions", async (original) => ({
  ...(await original<typeof import("./sessions")>()),
  createSessions: vi.fn(),
}));
vi.mock("./auto-title", () => ({ createAutoTitler: vi.fn() }));
vi.mock("../session-control/peek-summary", () => ({ createPeekSummarizer: vi.fn() }));
vi.mock("./delegate-session", () => ({ createDelegations: vi.fn() }));
vi.mock("../db/projects-repo", () => ({
  getProjectById: vi.fn(),
  listProjects: vi.fn(() => []),
  getProjectAuthorityPolicy: vi.fn(),
}));
vi.mock("../db/tickets-repo", () => ({ getTicket: vi.fn(), getTicketBrief: vi.fn() }));
vi.mock("../db/events-repo", () => ({ recordSessionStartedOnce: vi.fn() }));
vi.mock("../db/comments-repo", () => ({ getComment: vi.fn() }));
vi.mock("../db/automations-repo", () => ({ listAutomationsForProject: vi.fn(() => []) }));
vi.mock("../skills", () => ({ loadSkills: vi.fn() }));
vi.mock("../agent-services", () => ({
  createHostAgentToolDoor: vi.fn(),
  createHostAgentWatches: vi.fn(),
}));
vi.mock("./model-access-preferences", () => ({ readModelAccessDefaults: vi.fn() }));
afterEach(() => vi.resetAllMocks());

/** The degraded variant carries only its failure: no Session service survives it. */
function degradedHost(error: string): DegradedHostCore {
  return {
    kind: "degraded",
    dataDir: "/data",
    dbPath: "/data/volli.db",
    database: { ok: false, error },
    databaseFailure: { kind: "other" },
    start: async () => {},
    stop: async (reason) => ({ reason, clean: true }),
    warnIfFollowUpCleanCloseSkipped: () => {},
  };
}
async function proofFor(facade: RuntimeSessionFacade) {
  const owner = createSessionRuntimeLifecycle({
    // This port-composition test has no runtime to recover. The real lifecycle
    // still issues and revokes the proof; no structural cast can issue one.
    host: degradedHost("test"),
    ports: {
      power: { on: vi.fn(), removeListener: vi.fn() },
      attention: { deliver: vi.fn() },
      events: { publish: vi.fn() },
      log: console,
    } as never,
    runtime: null,
    rpc: () => null,
    observability: null,
    delegation: null,
    delegationsFor: () => null,
    services: () => facade,
    installQuitHold: () => {},
    stopProducers: () => {},
  });
  return { ready: await owner.ready(), owner };
}
async function fixture() {
  vi.mocked(createDelegations).mockReturnValue({
    recover: vi.fn(),
    watching: vi.fn(),
    rearm: vi.fn(async () => {}),
  } as never);
  const sessions = { create: vi.fn() } as unknown as Sessions;
  const titler = { refine: vi.fn(async () => {}) } as AutoTitler;
  vi.mocked(createSessions).mockReturnValue(sessions);
  vi.mocked(createAutoTitler).mockReturnValue(titler);
  vi.mocked(createPeekSummarizer).mockReturnValue({ summarize: vi.fn(async () => null) });
  const engine = {
    getSession: vi.fn().mockResolvedValue(null),
    listEvents: vi.fn<LiveHostCore["sessionEngine"]["listEvents"]>().mockResolvedValue([]),
    getOrRecordSessionInput: vi.fn(async () => ({})),
    observe: vi.fn(async () => {}),
    submit: vi.fn(async () => ({ receipt: { status: "completed" } })),
  };
  const runtime = { command: vi.fn(async () => ({})), projection: vi.fn() };
  const watch = { dispose: vi.fn() };
  const door = vi.fn(async () => ({ text: "ok" }));
  // The agent tool door and watches are host-core constructors, not host fields.
  const agentServices = {
    createToolDoor: vi.mocked(createHostAgentToolDoor),
    createWatches: vi.mocked(createHostAgentWatches),
  };
  agentServices.createToolDoor.mockReturnValue(
    door as ReturnType<typeof agentServices.createToolDoor>,
  );
  agentServices.createWatches.mockReturnValue(
    watch as unknown as ReturnType<typeof agentServices.createWatches>,
  );
  const host = {
    kind: "live",
    database: { ok: true, db: {} },
    sessionEngine: engine,
    sessionWakeBus: { subscribe: vi.fn() },
    detachedWork: { track: vi.fn() },
  } as unknown as LiveHostCore;
  const pi = {
    inspectModelAccess: vi.fn(async () => ({
      observedAt: 0,
      models: [] as { providerId: string; modelId: string; acceptsImageInput: boolean }[],
      providers: [],
    })),
  };
  const assembly = {
    sessionRuntime: runtime,
    sessionToolSurface: {},
    piRuntimeHost: pi,
    transcriptArtifacts: { read: vi.fn(async () => "artifact") },
  } as unknown as ReturnType<typeof createRuntimeAssembly>;
  const events = { publish: vi.fn() };
  const delegation = {
    subagentDelegation: vi.fn<TicketSessionDelegationStore["subagentDelegation"]>(),
  } as unknown as TicketSessionDelegationStore;
  const facade = createRuntimeSessionFacade({
    host,
    assembly,
    homeDir: "/home",
    venue: { id: "remote", kind: "remote" },
    events,
    decisions: null,
    delegation,
  });
  const { ready, owner } = await proofFor(facade);
  return {
    host,
    assembly,
    facade,
    ready,
    owner,
    engine,
    runtime,
    events,
    sessions,
    delegation,
    agentServices,
    door,
    watch,
    titler,
    pi,
  };
}

describe("lifted Session facade and recovered agent staging", () => {
  it("stops constructed agent watches and delegation subscriptions exactly once", async () => {
    const f = await fixture();
    const unsubscribe = vi.fn();
    vi.mocked(f.host.sessionWakeBus.subscribe).mockReturnValue(unsubscribe);
    const agents = stage(f);
    agents.recoveryDelegationsFor();
    agents.toolDoor(f.ready);
    f.agentServices.createToolDoor.mock.lastCall![1].watches!();
    agents.stop();
    agents.stop();
    expect(f.watch.dispose).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();

    expect(agents.recoveryDelegationsFor()).toBeNull();
    expect(f.agentServices.createToolDoor.mock.lastCall![1].watches!()).toBeNull();
    expect(f.agentServices.createToolDoor.mock.lastCall![1].delegate!()).toBeNull();

    const idle = await fixture();
    const idleAgents = stage(idle);
    idleAgents.toolDoor(idle.ready);
    const idlePorts = idle.agentServices.createToolDoor.mock.lastCall![1];
    idleAgents.stop();
    // An in-flight tool must not lazily create fresh subscriptions after stop.
    expect(idlePorts.watches!()).toBeNull();
    expect(idlePorts.delegate!()).toBeNull();
    expect(idleAgents.recoveryDelegationsFor()).toBeNull();
    expect(idle.watch.dispose).not.toHaveBeenCalled();
    expect(idle.agentServices.createWatches).toHaveBeenCalledOnce();
  });

  it("requires recovery proof at every public composition door", () => {
    expectTypeOf<RuntimeSessionFacade>().not.toExtend<
      Parameters<typeof recoveredSessionClientPorts>[0]
    >();
    expectTypeOf<RuntimeSessionFacade>().not.toExtend<
      Parameters<typeof recoveredSessionCommandPorts>[0]
    >();
    expectTypeOf<RuntimeSessionFacade>().not.toExtend<
      Parameters<RuntimeSessionAgents["toolDoor"]>[0]
    >();
  });

  it("is inert, shares the supplied runtime/engine, and records injected venue without new writers", async () => {
    const f = await fixture();
    expect(f.facade).not.toHaveProperty("sessions");
    expect(f.facade).not.toHaveProperty("sessionEngine");
    expect(f.facade).not.toHaveProperty("runtime");
    expect(f.engine.getSession).not.toHaveBeenCalled();
    expect(f.engine.listEvents).not.toHaveBeenCalled();
    expect(f.runtime.command).not.toHaveBeenCalled();
    expect(createSessions).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: f.runtime, grants: f.delegation }),
    );
    expect(recoveredRuntimeSessionServices(f.ready).sessionEngine).toBe(f.host.sessionEngine);
    const client = recoveredSessionClientPorts(f.ready);
    expect(client.sessionEngine).toBe(f.host.sessionEngine);
    expect(client.sessionRuntime).toBe(f.assembly.sessionRuntime);
    expect(client.summarizePeek).toBe(
      recoveredRuntimeSessionServices(f.ready).peekSummarizer!.summarize,
    );
    client.autoTitle!({} as Parameters<NonNullable<typeof client.autoTitle>>[0]);
    expect(f.titler.refine).toHaveBeenCalledOnce();
    await recoveredRuntimeSessionServices(f.ready).sessionSkills!.record("s", [
      { name: "a", text: "body" },
    ]);
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
    const f = await fixture();
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
    await expect(
      recoveredRuntimeSessionServices(f.ready).sessionSkills!.resolve("p", ["a"]),
    ).rejects.toThrow('The skill "a" was not found');
    const ports = recoveredSessionCommandPorts(f.ready);
    expect(ports.sessionEngine).toBe(f.host.sessionEngine);
    expect(ports.submitSessionMessage).toBe(
      recoveredRuntimeSessionServices(f.ready).submitKickoffMessage,
    );
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

  it("pins project/default visual policy and reads birth intent without executor rehydration", async () => {
    const f = await fixture();
    const model = { providerId: "p", modelId: "m", reasoningLevel: "high" as const };
    const ports = vi.mocked(createSessions).mock.calls[0]![0];
    vi.mocked(getProjectById).mockReturnValueOnce({ sessionModel: model } as never);
    await expect(ports.readDefaultModel!("visual", "project")).resolves.toEqual(model);
    expect(f.pi.inspectModelAccess).not.toHaveBeenCalled();
    vi.mocked(readModelAccessDefaults).mockReturnValue({
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: model,
    });
    f.pi.inspectModelAccess.mockResolvedValueOnce({
      observedAt: 0,
      models: [{ providerId: "p", modelId: "m", acceptsImageInput: true }],
      providers: [],
    });
    await expect(ports.readDefaultModel!("visual", null)).resolves.toEqual(model);
    await expect(ports.readDefaultModel!("visual", null)).resolves.toBeNull();
    expect(getProjectById).toHaveBeenCalledOnce();
    const intent = { kind: "model.select", selection: model, tier: "deep" };
    f.runtime.projection.mockResolvedValue({
      projection: { modelSelection: model, modelTier: "deep", commands: [{ id: "birth", intent }] },
    });
    await expect(ports.readModelAnchor!("s")).resolves.toEqual({ selection: model, tier: "deep" });
    await expect(ports.readBirthModel!("s", "birth")).resolves.toEqual({
      selection: model,
      tier: "deep",
    });
    f.engine.listEvents.mockResolvedValue([
      { payload: { kind: "command.recorded", command: { id: "birth", intent } } },
    ] as never);
    f.runtime.projection.mockClear();
    await expect(ports.readBirthModelFromLedger!("s", "birth")).resolves.toEqual({
      selection: model,
      tier: "deep",
    });
    await expect(ports.readBirthModelFromLedger!("s", "missing")).resolves.toBeNull();
    expect(f.runtime.projection).not.toHaveBeenCalled();
  });

  it("exposes only recovery before ready; tools and lazy watches need the matching proof", async () => {
    const f = await fixture();
    const delegated = {
      delegate: vi.fn(),
      recover: vi.fn(async () => ({ answered: 0, reported: 0, skipped: 0 })),
      liveChildren: vi.fn(() => ["child"]),
      watching: vi.fn(() => false),
      rearm: vi.fn(async () => {}),
    };
    vi.mocked(createDelegations).mockReturnValue(
      delegated as unknown as ReturnType<typeof createDelegations>,
    );
    const agents = f.facade.agents({
      host: f.host,
      delegation: f.delegation,
      automations: { kind: "live", execution: { kind: "idle" } } as unknown as ReturnType<
        typeof createRuntimeAutomations
      >,
      mcpSettings: null,
      events: f.events,
      log: console,
    });
    expect(() =>
      f.facade.agents({
        host: f.host,
        delegation: f.delegation,
        automations: { kind: "live", execution: { kind: "idle" } } as never,
        mcpSettings: null,
        events: f.events,
        log: console,
      }),
    ).toThrow("already been staged");
    expect(f.agentServices.createToolDoor).not.toHaveBeenCalled();
    expect(f.agentServices.createWatches).not.toHaveBeenCalled();
    const recovery = agents.recoveryDelegationsFor()!;
    expect(recovery).not.toHaveProperty("delegate");
    await recovery.recover([]);
    expect(delegated.recover).toHaveBeenCalledWith([]);
    expect(() => agents.toolDoor(f.facade as unknown as typeof f.ready)).toThrow(
      "no recovery proof",
    );
    expect(agents.toolDoor(f.ready)).toBe(f.door);
    expect(agents.toolDoor(f.ready)).toBe(f.door);
    expect(f.agentServices.createToolDoor).toHaveBeenCalledOnce();
    const listener = vi.mocked(f.host.sessionWakeBus!.subscribe).mock.calls[0]![0];
    const entry = { childSessionId: "child" } as never;
    vi.mocked(f.delegation.subagentDelegation).mockReturnValueOnce(entry);
    listener({
      event: {
        sessionId: "child",
        sequence: 12,
        payload: { kind: "turn.started", turnId: "turn" },
      },
    } as never);
    expect(delegated.rearm).toHaveBeenCalledExactlyOnceWith(entry, {
      turnId: "turn",
      afterSequence: 12,
    });
    // The door's mutations reach the staging's own event bus.
    expect(f.agentServices.createToolDoor.mock.calls[0]![0]).toEqual({ events: f.events });
    const toolPorts = f.agentServices.createToolDoor.mock.calls[0]![1];
    expect(toolPorts.submitSessionMessage).toBe(
      recoveredRuntimeSessionServices(f.ready).submitKickoffMessage,
    );
    expect(toolPorts.sessions()).toBe(f.sessions);
    expect(toolPorts.delegate!()).toBe(delegated);
    expect(toolPorts.supervise!()).toEqual({
      sessionEngine: f.host.sessionEngine,
      runtime: f.assembly.sessionRuntime,
    });
    expect(toolPorts.mcp!()).toBeNull();
    expect(toolPorts.watches!()).toBe(f.watch);
    expect(toolPorts.watches!()).toBe(f.watch);
    expect(f.agentServices.createWatches).toHaveBeenCalledOnce();
    expect(f.agentServices.createWatches.mock.calls[0]![0].pendingSubagents!("s")).toEqual([
      "child",
    ]);
  });

  it("does not expose services through an unrecognized facade and preserves close revocation for automations", async () => {
    const f = await fixture();
    await f.facade.waitForBirth("s");
    expect(() =>
      recoveredRuntimeSessionServices({ services: {} } as unknown as typeof f.ready),
    ).toThrow("no recovery proof");
    expect(() => recoveredRuntimeSessionServices({ ...f.ready })).toThrow("no recovery proof");
    const automation = recoveredSessionAutomationPorts(f.ready);
    expect(automation.services.sessions).toBe(f.sessions);
    await f.owner.close();
    expect(() => automation.services).toThrow("closing");
  });

  it("keeps degraded composition inert and refuses CLI Session ports without an engine", async () => {
    const f = await fixture();
    const facade = createRuntimeSessionFacade({
      host: degradedHost("unavailable"),
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
    const { ready } = await proofFor(facade);
    expect(recoveredRuntimeSessionServices(ready)).toMatchObject({
      sessions: null,
      sessionSkills: null,
      autoTitler: null,
      peekSummarizer: null,
      submitKickoffMessage: undefined,
    });
    expect(() => recoveredSessionCommandPorts(ready)).toThrow("engine is unavailable");
    const client = recoveredSessionClientPorts(ready);
    expect(client.sessionEngine).toBeNull();
    expect(client.sessionRuntime).toBeUndefined();
    expect(client.autoTitle).toBeUndefined();
    expect(client.summarizePeek).toBeUndefined();
  });
});

const SKILL = {
  name: "a",
  description: "a",
  body: "body",
  root: "/repo/.agents/skills/a",
  authorPolicy: { modelDiscoverable: true, userInvokable: true },
  effectivePolicy: { modelDiscoverable: true, userInvokable: true },
  policyDiagnostic: null,
};
function stage(f: Awaited<ReturnType<typeof fixture>>, overrides = {}) {
  return f.facade.agents({
    host: f.host,
    delegation: f.delegation,
    automations: { kind: "live", execution: { kind: "idle" } } as never,
    mcpSettings: null,
    events: f.events,
    log: console,
    ...overrides,
  });
}
async function alternate(
  f: Awaited<ReturnType<typeof fixture>>,
  change: Partial<Parameters<typeof createRuntimeSessionFacade>[0]>,
) {
  const facade = createRuntimeSessionFacade({
    host: f.host,
    assembly: f.assembly,
    homeDir: "/home",
    venue: { id: "remote", kind: "remote" },
    events: f.events,
    decisions: null,
    delegation: f.delegation,
    ...change,
  });
  return { facade, ...(await proofFor(facade)) };
}

describe("facade captured ports and capability degradations", () => {
  it("resolves skills once under current policy and handles each post-I/O refusal", async () => {
    const f = await fixture();
    const skills = recoveredRuntimeSessionServices(f.ready).sessionSkills!;
    vi.mocked(getProjectById).mockReturnValue({ path: "/repo" } as never);
    vi.mocked(loadSkills).mockResolvedValue({ ok: true, skills: [SKILL] });
    expect(await skills.resolve("p", ["a", "a"])).toHaveLength(1);
    expect(await skills.index("p", [])).not.toBeNull();
    vi.mocked(getProjectById).mockReturnValueOnce(undefined);
    await expect(skills.resolve("p", [])).rejects.toThrow("project for this Session");
    vi.mocked(getProjectById).mockReturnValueOnce(undefined);
    expect(await skills.index("p", [])).toBeNull();
    vi.mocked(loadSkills).mockResolvedValueOnce({ ok: false, error: "unreadable" });
    await expect(skills.resolve("p", [])).rejects.toThrow("unreadable");
    vi.mocked(loadSkills).mockResolvedValueOnce({ ok: false, error: "unreadable" });
    expect(await skills.index("p", [])).toBeNull();
    vi.mocked(getProjectById)
      .mockReturnValueOnce({ path: "/repo" } as never)
      .mockReturnValueOnce(undefined);
    await expect(skills.resolve("p", [])).rejects.toThrow("project for this Session");
    vi.mocked(getProjectById)
      .mockReturnValueOnce({ path: "/repo" } as never)
      .mockReturnValueOnce(undefined);
    expect(await skills.index("p", [])).toBeNull();
    vi.mocked(getProjectById).mockReturnValue({ path: "/repo", skillModes: { a: "off" } } as never);
    expect(await skills.index("p", [])).toBeNull();
  });
  it("covers ledger birth absence, current anchors, automatic metadata and default ladders", async () => {
    const f = await fixture();
    const ports = vi.mocked(createSessions).mock.calls[0]![0];
    const model = { providerId: "p", modelId: "m", reasoningLevel: "off" as const };
    vi.mocked(readModelAccessDefaults).mockReturnValue({
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: model,
    });
    expect(await ports.readDefaultModel!("ticket", "p")).toEqual(model);
    vi.mocked(getTicket).mockReturnValue({ projectId: "p" } as never);
    expect(ports.ticketBelongsToProject("p", "t")).toBe(true);
    vi.mocked(getTicket).mockReturnValue(undefined);
    expect(ports.ticketBelongsToProject("p", "t")).toBe(false);
    await ports.inspectModelAccess!();
    ports.recordSessionStarted!({ ticketId: "t", sessionId: "s", actor: { kind: "user" } });
    expect(recordSessionStartedOnce).toHaveBeenCalled();
    f.runtime.projection.mockResolvedValue({ projection: {} });
    expect(await ports.readBirthModel!("s", "birth")).toBeNull();
    f.runtime.projection.mockResolvedValue({
      projection: { commands: [{ id: "birth", intent: { kind: "session.stop" } }] },
    });
    expect(await ports.readBirthModel!("s", "birth")).toBeNull();
    const intent = { kind: "model.select", selection: model, auto: { marker: "frozen" } };
    f.runtime.projection.mockResolvedValue({ projection: { commands: [{ id: "birth", intent }] } });
    expect(await ports.readBirthModel!("s", "birth")).toEqual({
      selection: model,
      tier: null,
      auto: intent.auto,
    });
    f.engine.listEvents.mockResolvedValue([
      { payload: { kind: "session.created" } },
      { payload: { kind: "command.recorded", command: { id: "other", intent } } },
      { payload: { kind: "command.recorded", command: { id: "birth", intent } } },
    ] as never);
    expect(await ports.readBirthModelFromLedger!("s", "birth")).toEqual({
      selection: model,
      tier: null,
      auto: intent.auto,
    });
    f.engine.listEvents.mockResolvedValue([
      {
        payload: {
          kind: "command.recorded",
          command: { id: "birth", intent: { kind: "session.stop" } },
        },
      },
    ] as never);
    expect(await ports.readBirthModelFromLedger!("s", "birth")).toBeNull();
    await alternate(f, { decisions: { port: {} } as never });
    expect(vi.mocked(createSessions).mock.lastCall![0].autoSelect).toBeDefined();
  });
  it("adapts every utility/transcript port and rejects an incomplete retitle receipt", async () => {
    const f = await fixture();
    const title = vi.mocked(createAutoTitler).mock.calls[0]![0];
    const peek = vi.mocked(createPeekSummarizer).mock.calls[0]![0];
    expect(await title.readSession("missing")).toBeNull();
    f.engine.getSession.mockResolvedValue({
      session: { title: "title", ticketId: "t" },
      modelSelection: null,
    });
    expect(await title.readSession("s")).toEqual({ title: "title", ticketId: "t", model: null });
    title.readModelDefaults();
    peek.readModelDefaults();
    title.readTicket("t");
    expect(getTicketBrief).toHaveBeenCalledWith({}, "t");
    const signal = new AbortController().signal;
    await title.inspectModelAccess({ signal });
    await peek.inspectModelAccess({ signal });
    (f.pi as unknown as { completeUtility: ReturnType<typeof vi.fn> }).completeUtility = vi.fn(
      async () => "utility",
    );
    await title.completeUtility({} as never);
    await peek.completeUtility({} as never);
    await peek.recordUsage("s", {} as never);
    expect(f.engine.observe).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^usage:peek-summary:/) }),
    );
    f.engine.submit.mockResolvedValueOnce({ receipt: { status: "failed" } } as never);
    await expect(title.retitle("s", "new")).rejects.toThrow("not completed");
    const client = recoveredSessionClientPorts(f.ready);
    expect(await client.readTranscriptArtifact({} as never)).toBe("artifact");
    const command = recoveredSessionCommandPorts(f.ready);
    expect(await command.readTranscriptArtifact({} as never)).toBe("artifact");
    vi.mocked(getProjectById).mockReturnValue(undefined);
    expect(await command.skillsIndex!("p")).toBeNull();
    command.refineAutoTitle!({} as never);
    await command.inspectModelAccess!({ signal });
  });
  it("adapts partially absent runtime, engine, skills and model ports", async () => {
    const f = await fixture();
    const noRuntime = await alternate(f, {
      assembly: {
        ...f.assembly,
        sessionRuntime: null,
        piRuntimeHost: null,
        sessionToolSurface: null,
      },
      delegation: null,
    });
    expect(recoveredSessionCommandPorts(noRuntime.ready)).not.toHaveProperty("sessions");
    await noRuntime.facade.waitForBirth("s");
    // A missing database is the degraded variant now: no engine survives it, so
    // the skills port is absent and the CLI command ports refuse as a whole.
    const noDb = await alternate(f, { host: degradedHost("bad") });
    expect(recoveredRuntimeSessionServices(noDb.ready).sessionSkills).toBeNull();
    expect(() => recoveredSessionCommandPorts(noDb.ready)).toThrow("engine is unavailable");
    const other = await proofFor({ waitForBirth: async () => {}, agents: vi.fn() });
    expect(() => recoveredRuntimeSessionServices(other.ready)).toThrow("different runtime");
    const liveBirth = vi.fn(async () => {});
    (f.sessions as Sessions).waitForBirth = liveBirth;
    await f.facade.waitForBirth("s");
    expect(liveBirth).toHaveBeenCalledWith("s");
  });
});

describe("agent staging ports", () => {
  it("does not invent Automations for a degraded module", async () => {
    const f = await fixture();
    const agents = stage(f, { automations: { kind: "degraded" } as never });
    agents.toolDoor(f.ready);
    const tool = f.agentServices.createToolDoor.mock.lastCall![1];
    expect(tool.automations!()).toBeNull();
  });

  it("binds lazy collaborators, filters wakes and reports rearm failures", async () => {
    const f = await fixture();
    const delegated = {
      recover: vi.fn(async () => ({})),
      liveChildren: vi.fn(() => ["child"]),
      watching: vi.fn(() => false),
      rearm: vi.fn(async () => {}),
    };
    vi.mocked(createDelegations).mockReturnValue(delegated as never);
    const runner = { run: vi.fn(async () => "run") };
    const log = { error: vi.fn() };
    const agents = stage(f, {
      automations: { kind: "live", execution: { kind: "ready", runner } } as never,
      log,
    });
    agents.toolDoor(f.ready);
    const tool = f.agentServices.createToolDoor.mock.lastCall![1];
    tool.projects();
    tool.authorityPolicy!("p");
    tool.actorTicketDisplay!(null);
    tool.now!();
    expect(listProjects).toHaveBeenCalled();
    expect(getProjectAuthorityPolicy).toHaveBeenCalled();
    tool.refineAutoTitle!({} as never);
    const automation = tool.automations!()!;
    automation.list("p");
    await automation.run({} as never);
    expect(listAutomationsForProject).toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalled();
    expect(tool.watches!()).toBe(f.watch);
    const watch = f.agentServices.createWatches.mock.lastCall![0];
    watch.subscribeSessionWake(vi.fn());
    await watch.readTranscriptArtifact!({} as never);
    expect(watch.readComment!("absent")).toBeNull();
    vi.mocked(getComment).mockReturnValue({ body: "comment" } as never);
    expect(watch.readComment!("present")).toBe("comment");
    expect(watch.pendingSubagents!("s")).toEqual([]);
    agents.recoveryDelegationsFor();
    expect(watch.pendingSubagents!("s")).toEqual(["child"]);
    const delegatePorts = vi.mocked(createDelegations).mock.lastCall![0];
    await delegatePorts.readTranscriptArtifact!({} as never);
    delegatePorts.onMutation!({} as never);
    delegatePorts.now!();
    const listener = vi.mocked(f.host.sessionWakeBus!.subscribe).mock.calls.at(-1)![0];
    listener({ event: { payload: { kind: "turn.completed" } } } as never);
    delegated.watching.mockReturnValueOnce(true);
    listener({ event: { sessionId: "child", payload: { kind: "turn.started" } } } as never);
    vi.mocked(f.delegation.subagentDelegation).mockReturnValueOnce(null);
    listener({ event: { sessionId: "child", payload: { kind: "turn.started" } } } as never);
    vi.mocked(f.delegation.subagentDelegation).mockReturnValueOnce({
      childSessionId: "child",
    } as never);
    delegated.rearm.mockRejectedValueOnce(new Error("rearm failed"));
    listener({
      event: { sessionId: "child", sequence: 2, payload: { kind: "turn.started", turnId: "turn" } },
    } as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(log.error).toHaveBeenCalledWith("could not re-arm the notice for a resumed subagent", {
      childSessionId: "child",
      error: expect.objectContaining({ message: "rearm failed" }),
    });
    const other = await fixture();
    expect(() => agents.toolDoor(other.ready)).toThrow("different runtime");
  });
  it.each(["database", "runtime", "engine", "wake", "delegation"])(
    "fails closed with absent %s capability",
    async (missing) => {
      const f = await fixture();
      // "database" is the degraded variant; "engine" and "wake" are
      // type-impossible on a live host and cover the guards agents.ts still carries.
      const host =
        missing === "database"
          ? degradedHost("bad")
          : ({
              ...f.host,
              ...(missing === "engine" ? { sessionEngine: null } : {}),
              ...(missing === "wake" ? { sessionWakeBus: null } : {}),
            } as unknown as LiveHostCore);
      const alternateFacade = await alternate(f, {
        host,
        ...(missing === "runtime" ? { assembly: { ...f.assembly, sessionRuntime: null } } : {}),
        ...(missing === "delegation" ? { delegation: null } : {}),
      });
      const agents = alternateFacade.facade.agents({
        host,
        delegation: missing === "delegation" ? null : f.delegation,
        automations: { kind: "live", execution: { kind: "idle" } } as never,
        mcpSettings: null,
        events: f.events,
        log: console,
      });
      const recovery = agents.recoveryDelegationsFor();
      if (["database", "runtime", "engine", "delegation"].includes(missing))
        expect(recovery).toBeNull();
      const door = agents.toolDoor(alternateFacade.ready);
      if (["database", "delegation"].includes(missing)) expect(door).toBeNull();
      else {
        const tool = f.agentServices.createToolDoor.mock.lastCall![1];
        expect(tool.automations!()).toBeNull();
        expect(tool.watches!()).toBeNull();
        if (["runtime", "engine"].includes(missing)) expect(tool.supervise!()).toBeNull();
      }
    },
  );
});
