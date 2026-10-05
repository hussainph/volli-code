/** Composition contract; the integration test drives the real collaborators. */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostCore, HostCorePorts } from "@volli/host-core";
import type { HeadlessSecrets } from "./secrets";
import type { RuntimeAssemblyOptions } from "@volli/host-core/session-runtime/assembly";
import type { BackgroundShellHostDependencies } from "@volli/host-core/shell/background-shell-host";

const seam = vi.hoisted(() => ({
  assembly: vi.fn(),
  facade: vi.fn(),
  lifecycle: vi.fn(),
  context: vi.fn(),
  concurrency: vi.fn(),
  tokens: { mint: vi.fn(), revoke: vi.fn(), verify: vi.fn() },
  identities: vi.fn(),
  automations: vi.fn(),
  recovered: vi.fn(),
  commands: vi.fn(),
  automationPorts: vi.fn(),
  shellOptions: null as BackgroundShellHostDependencies | null,
  shells: { liveCwds: vi.fn(() => [] as string[]), close: vi.fn(async () => {}) },
  ticket: vi.fn(),
  project: vi.fn(),
  sites: vi.fn(() => [] as { sessionId: string; directory: string }[]),
  modelAccess: vi.fn(),
  observability: { start: vi.fn(), shutdown: vi.fn() },
}));
vi.mock("@volli/agent-runtime", () => ({ piOwnedModelAccess: seam.modelAccess }));
vi.mock("@volli/host-core/db/projects-repo", () => ({ getProjectById: seam.project }));
vi.mock("@volli/host-core/db/tickets-repo", () => ({ getTicket: seam.ticket }));
vi.mock("@volli/host-core/secrets/service", () => ({
  SecretService: class {
    constructor(public store: unknown) {}
  },
}));
vi.mock("@volli/host-core/observability/settings", () => ({
  AgentObservability: class {
    start = seam.observability.start;
    shutdown = seam.observability.shutdown;
  },
}));
vi.mock("@volli/host-core/session-tokens", () => ({
  createSessionTokenRegistry: () => seam.tokens,
}));
vi.mock("@volli/host-core/session-concurrency", () => ({
  createSessionConcurrencyEnvReader: seam.concurrency,
}));
vi.mock("@volli/host-core/shell/background-shell-host", () => ({
  BackgroundShellHost: class {
    constructor(options: BackgroundShellHostDependencies) {
      seam.shellOptions = options;
    }
    liveCwds = seam.shells.liveCwds;
    close = seam.shells.close;
  },
}));
vi.mock("@volli/host-core/mcp/dispatch-policy", () => ({
  desktopMcpDispatch: ({ log }: { log(message: string): void }) => {
    log("mcp");
    return {};
  },
}));
vi.mock("@volli/host-core/codemode/dev-config", () => ({
  desktopCodeMode: ({ log, policy }: { log(message: string): void; policy(): unknown }) => {
    log("codemode");
    policy();
    return {};
  },
}));
vi.mock("@volli/host-core/session-runtime/model-access-preferences", () => ({
  readCodeModePolicy: () => ({}),
}));
vi.mock("@volli/host-core/session-runtime/attachment-identity", () => ({
  createAttachmentIdentities: seam.identities,
}));
vi.mock("@volli/host-core/session-runtime/assembly", () => ({
  createRuntimeAssembly: seam.assembly,
}));
vi.mock("@volli/host-core/session-runtime/context", () => ({
  createRuntimeContextResolver: seam.context,
}));
vi.mock("@volli/host-core/session-runtime/automations", () => ({
  createRuntimeAutomations: seam.automations,
}));
vi.mock("@volli/host-core/session-runtime/delegation-store", () => ({
  createTicketSessionDelegationStore: () => ({}),
}));
vi.mock("@volli/host-core/session-runtime/facade", () => ({
  createRuntimeSessionFacade: seam.facade,
  recoveredRuntimeSessionServices: seam.recovered,
  recoveredSessionCommandPorts: seam.commands,
  recoveredSessionAutomationPorts: seam.automationPorts,
}));
vi.mock("@volli/host-core/session-runtime/lifecycle", () => ({
  createSessionRuntimeLifecycle: seam.lifecycle,
}));
vi.mock("@volli/host-core/worktree/agent-sites", () => ({ agentSitesWithin: seam.sites }));
import { createHeadlessSessionRuntime } from "./session-runtime";

beforeEach(() => {
  vi.resetAllMocks();
  seam.shellOptions = null;
});
function fixture() {
  const runtime = {
    openNativeBindings: vi.fn(() => []),
    projection: vi.fn(async () => ({ projection: { turnActive: true } })),
  };
  const assembly = { sessionRuntime: runtime, piRuntimeHost: {}, sessionToolSurface: {} };
  seam.assembly.mockReturnValue(assembly);
  const door = vi.fn(async () => ({ text: "ok" }));
  const agents = { toolDoor: vi.fn(() => door), recoveryDelegationsFor: vi.fn() };
  const facade = { agents: vi.fn(() => agents), waitForBirth: vi.fn(async () => {}) };
  seam.facade.mockReturnValue(facade);
  const proof = { services: facade };
  const lifecycle = {
    ready: vi.fn(async () => proof),
    close: vi.fn(async () => {}),
    observeScheduledResume: vi.fn(),
    relayShellNotice: vi.fn(),
  };
  seam.lifecycle.mockReturnValue(lifecycle);
  const automations = {
    start: vi.fn(),
    stop: vi.fn(),
    runner: {},
    pendingArmedRuns: { noteDeliberateMove: vi.fn() },
  };
  seam.automations.mockReturnValue(automations);
  seam.recovered.mockReturnValue({ sessions: {}, runtime });
  seam.commands.mockReturnValue({
    sessionEngine: "recovered-engine",
    sessions: "recovered-sessions",
  });
  seam.automationPorts.mockReturnValue("recovered-automation");
  seam.modelAccess.mockReturnValue({ models: "owned" });
  seam.shells.liveCwds.mockReturnValue([]);
  seam.sites.mockReturnValue([]);
  seam.concurrency.mockReturnValue(vi.fn(async () => ({ PATH: "/service/bin" })));
  const host = {
    database: { ok: true, db: {} },
    sessionEngine: { listAttachedSessions: vi.fn(async () => []) },
    dataDir: "/data",
    runtimeServices: {
      createDecisions: vi.fn(),
      createMcp: vi.fn(() => ({ settings: {} })),
      createWebAccess: vi.fn(),
    },
    maintenance: { createSpawnLedger: vi.fn() },
  } as unknown as HostCore;
  const log = { warn: vi.fn(), error: vi.fn() };
  const store = { redact: vi.fn((text) => text), redactPartial: vi.fn((text) => text) };
  const input = {
    host,
    version: "test",
    ports: { log, events: {} } as unknown as HostCorePorts,
    secrets: { store } as unknown as HeadlessSecrets,
    env: { HOME: "/home/service", PI_CODING_AGENT_DIR: "/auth", PATH: "/service/bin" },
    socketPath: "/run/hostd.sock",
    options: { binDir: "/bin", venue: { id: "hostd", kind: "remote" as const } },
  };
  return {
    input,
    runtime,
    assembly,
    agents,
    facade,
    lifecycle,
    proof,
    automations,
    log,
    store,
    launch: () => createHeadlessSessionRuntime(input),
  };
}

describe("headless runtime ownership", () => {
  it("captures all ports before recovery, gates commands, and joins shell drain", async () => {
    const f = fixture();
    const owner = f.launch();
    expect(f.lifecycle.ready).not.toHaveBeenCalled();
    expect(seam.modelAccess).toHaveBeenCalledWith({ agentDir: "/auth" });
    expect(seam.observability.start).toHaveBeenCalledOnce();
    const input = seam.assembly.mock.lastCall![0] as RuntimeAssemblyOptions;
    expect(input).toMatchObject({
      askUser: false,
      requestSecret: false,
      venue: f.input.options.venue,
    });
    expect(input).not.toHaveProperty("browser");
    await input.beforeExecution();
    // The agent's `volli` reaches this host, beside the budget (VC-563).
    expect(await input.concurrencyEnvFor("s")).toEqual({
      PATH: "/service/bin",
      VOLLI_SOCKET: "/run/hostd.sock",
    });
    await seam.concurrency.mock.lastCall![0].listAttachedSessions();
    const context = seam.context.mock.lastCall![0];
    await context.waitForBirth("s"); // Internal recovery must not wait for itself.
    expect(f.lifecycle.ready).not.toHaveBeenCalled();
    expect(f.facade.waitForBirth).toHaveBeenCalledWith("s");
    expect(context.toolSurface()).toBe(f.assembly.sessionToolSurface);
    const shell = seam.shellOptions!;
    shell.redactOutput!("output");
    shell.redactNoticeOutput!("tail");
    shell.onNotice!({} as never);
    shell.publishState({} as never);
    shell.publishRemoved("id");
    expect(f.store.redact).toHaveBeenCalledWith("output");
    expect(f.lifecycle.relayShellNotice).toHaveBeenCalled();
    const identity = seam.identities.mock.lastCall![0];
    expect(identity.ticketDisplayIdOf("missing")).toBeNull();
    seam.ticket.mockReturnValue({ projectId: "p", ticketNumber: 1 });
    expect(identity.ticketDisplayIdOf("t")).toBeNull();
    seam.project.mockReturnValue({ ticketPrefix: "VC" });
    expect(identity.ticketDisplayIdOf("t")).toBe("VC-1");
    const ready = await owner.ready();
    expect(seam.commands).toHaveBeenCalledWith(f.proof);
    expect(ready).toMatchObject({
      sessionEngine: "recovered-engine",
      sessions: "recovered-sessions",
      automationsAvailable: true,
      venue: f.input.options.venue,
    });
    ready.onDeliberateMove({} as never);
    expect(f.automations.pendingArmedRuns.noteDeliberateMove).toHaveBeenCalled();
    const caller = {} as never;
    const request = {} as never;
    await input.callVerb(caller, request, new AbortController().signal, undefined);
    expect(f.agents.toolDoor).toHaveBeenCalledWith(f.proof);
    expect(owner.openNativeBindings()).toEqual([]);
    const drain = seam.lifecycle.mock.lastCall![0];
    expect(drain.services()).toBe(f.facade);
    drain.stopProducers();
    drain.installQuitHold(vi.fn());
    await drain.rpc().close();
    expect(f.automations.stop).toHaveBeenCalled();
    expect(seam.shells.close).toHaveBeenCalledOnce();
    await owner.close();
    expect(f.lifecycle.close).toHaveBeenCalled();
  });
  it("supplies busy Sessions and background shells, and fails closed on unreadable activity", async () => {
    const f = fixture();
    const ready = await f.launch().ready();
    seam.shells.liveCwds.mockReturnValue(["/tree/shell"]);
    seam.sites.mockReturnValue([{ sessionId: "s", directory: "/tree/agent" }]);
    expect(await ready.busyWorktreeSites("/tree")).toEqual([
      { surface: "terminal", directory: "/tree/shell" },
      { surface: "agent", directory: "/tree/agent" },
    ]);
    f.runtime.projection.mockResolvedValueOnce({ projection: { turnActive: false } });
    expect(await ready.busyWorktreeSites("/tree")).toHaveLength(1);
    f.runtime.projection.mockRejectedValueOnce(new Error("unreadable"));
    await expect(ready.busyWorktreeSites("/tree")).rejects.toThrow("unreadable");
  });
  it("uses explicit sandbox/model options and safe HOME fallbacks", async () => {
    const f = fixture();
    const owner = createHeadlessSessionRuntime({
      ...f.input,
      env: {},
      options: {
        ...f.input.options,
        modelAccess: {} as never,
        codeModeSandbox: { wasmPath: "/wasm" },
      },
    });
    expect(seam.modelAccess).not.toHaveBeenCalled();
    expect(seam.assembly.mock.lastCall![0].codeModeSandbox).toEqual({ wasmPath: "/wasm" });
    f.automations.runner = null as never;
    f.automations.pendingArmedRuns = null as never;
    const ready = await owner.ready();
    expect(ready.automationsAvailable).toBe(false);
    ready.onDeliberateMove({} as never);
    f.assembly.sessionRuntime = null as never;
    expect(owner.openNativeBindings()).toEqual([]);
    createHeadlessSessionRuntime({ ...f.input, env: { HOME: "/home/service" } });
    expect(seam.modelAccess).toHaveBeenCalledWith({ agentDir: "/home/service/.pi/agent" });
    createHeadlessSessionRuntime({ ...f.input, env: {} });
    expect(seam.modelAccess.mock.lastCall![0].agentDir).toMatch(/\.pi\/agent$/);
  });
  it("refuses absent database/engine/services and the unavailable tool door", async () => {
    const f = fixture();
    expect(() =>
      createHeadlessSessionRuntime({
        ...f.input,
        host: { ...f.input.host, database: { ok: false, error: "bad" } },
      }),
    ).toThrow("database is unavailable");
    expect(() =>
      createHeadlessSessionRuntime({ ...f.input, host: { ...f.input.host, sessionEngine: null } }),
    ).toThrow("database is unavailable");
    const owner = f.launch();
    seam.recovered.mockReturnValueOnce({ sessions: null, runtime: f.runtime });
    await expect(owner.ready()).rejects.toThrow("runtime is unavailable");
    seam.recovered.mockReturnValueOnce({ sessions: {}, runtime: null });
    await expect(owner.ready()).rejects.toThrow("runtime is unavailable");
    f.agents.toolDoor.mockReturnValueOnce(null as never);
    await expect(
      (seam.assembly.mock.lastCall![0] as RuntimeAssemblyOptions).callVerb(
        {} as never,
        {} as never,
        new AbortController().signal,
        undefined,
      ),
    ).rejects.toThrow("tool door is unavailable");
  });
});
