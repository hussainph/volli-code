/** Composition contract; the integration test drives the real collaborators. */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostCorePorts, LiveHostCore } from "@volli/host-core";
import type { HeadlessSecrets } from "./secrets";
import type {
  RuntimeAssemblyOptions,
  BackgroundShellHostDependencies,
} from "@volli/host-core/session-runtime";

const seam = vi.hoisted(() => ({
  assembly: vi.fn(),
  facade: vi.fn(),
  lifecycle: vi.fn(),
  context: vi.fn(),
  concurrency: vi.fn(),
  tokens: { mint: vi.fn(), revoke: vi.fn(), verify: vi.fn(), liveSessionIds: vi.fn() },
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
  release: vi.fn(),
  modelAccess: vi.fn(),
  observability: { start: vi.fn(), shutdown: vi.fn() },
}));
vi.mock("@volli/agent-runtime", () => ({ piOwnedModelAccess: seam.modelAccess }));
vi.mock("../../../packages/host-core/src/db/projects-repo", () => ({
  getProjectById: seam.project,
}));
vi.mock("../../../packages/host-core/src/db/tickets-repo", () => ({ getTicket: seam.ticket }));
vi.mock("../../../packages/host-core/src/secrets/service", () => ({
  SecretService: class {
    constructor(public store: unknown) {}
  },
}));
vi.mock("../../../packages/host-core/src/observability/settings", () => ({
  AgentObservability: class {
    start = seam.observability.start;
    shutdown = seam.observability.shutdown;
  },
}));
vi.mock("../../../packages/host-core/src/session-tokens", () => ({
  createSessionTokenRegistry: () => seam.tokens,
}));
vi.mock("../../../packages/host-core/src/session-concurrency", () => ({
  createSessionConcurrencyEnvReader: seam.concurrency,
}));
vi.mock("../../../packages/host-core/src/shell/background-shell-host", () => ({
  BackgroundShellHost: class {
    constructor(options: BackgroundShellHostDependencies) {
      seam.shellOptions = options;
    }
    liveCwds = seam.shells.liveCwds;
    close = seam.shells.close;
  },
}));
vi.mock("../../../packages/host-core/src/mcp/dispatch-policy", () => ({
  desktopMcpDispatch: ({ log }: { log(message: string): void }) => {
    log("mcp");
    return {};
  },
}));
vi.mock("../../../packages/host-core/src/codemode/dev-config", () => ({
  desktopCodeMode: ({ log, policy }: { log(message: string): void; policy(): unknown }) => {
    log("codemode");
    policy();
    return {};
  },
}));
vi.mock("../../../packages/host-core/src/session-runtime/model-access-preferences", () => ({
  readCodeModePolicy: () => ({}),
}));
vi.mock("../../../packages/host-core/src/session-runtime/attachment-identity", () => ({
  createAttachmentIdentities: seam.identities,
}));
vi.mock("../../../packages/host-core/src/session-runtime/assembly", () => ({
  createRuntimeAssembly: seam.assembly,
}));
vi.mock("../../../packages/host-core/src/session-runtime/context", () => ({
  createRuntimeContextResolver: seam.context,
}));
vi.mock("../../../packages/host-core/src/session-runtime/automations", () => ({
  createRuntimeAutomations: seam.automations,
}));
vi.mock("../../../packages/host-core/src/session-runtime/delegation-store", () => ({
  createTicketSessionDelegationStore: () => ({}),
}));
vi.mock("../../../packages/host-core/src/session-runtime/facade", () => ({
  createRuntimeSessionFacade: seam.facade,
  recoveredRuntimeSessionServices: seam.recovered,
  recoveredSessionCommandPorts: seam.commands,
  recoveredSessionAutomationPorts: seam.automationPorts,
}));
vi.mock("../../../packages/host-core/src/session-runtime/lifecycle", () => ({
  createSessionRuntimeLifecycle: seam.lifecycle,
}));
vi.mock("../../../packages/host-core/src/worktree/agent-sites", () => ({
  agentSitesWithin: seam.sites,
  releaseAgentSites: seam.release,
}));
import { createHeadlessSessionRuntime, headlessModelAccess } from "./session-runtime";

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
  const agents = { toolDoor: vi.fn(() => door), recoveryDelegationsFor: vi.fn(), stop: vi.fn() };
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
    kind: "live",
    start: vi.fn(),
    stop: vi.fn(),
    settled: vi.fn(async () => {}),
    execution: { kind: "ready", runner: {}, pendingArmedRuns: { noteDeliberateMove: vi.fn() } },
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
  const runtimeServices = {
    modelAccess: { models: "host-model-access" },
    decisions: { decide: "host-decisions" },
    mcp: { selectedTools: "host-mcp" },
    webAccess: { web: "host-web-access" },
  };
  const spawnLedger = { ledger: "host-spawn-ledger" };
  const host = {
    kind: "live",
    database: { ok: true, db: {} },
    sessionEngine: { listAttachedSessions: vi.fn(async () => []) },
    dataDir: "/data",
    runtimeServices,
    maintenance: { spawnLedger },
  } as unknown as LiveHostCore;
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
    host,
    runtimeServices,
    spawnLedger,
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
    // The host's one lazy runtime-service module, never a second model factory here.
    expect(seam.modelAccess).not.toHaveBeenCalled();
    expect(seam.observability.start).toHaveBeenCalledOnce();
    const input = seam.assembly.mock.lastCall![0] as RuntimeAssemblyOptions;
    expect(input).toMatchObject({
      askUser: false,
      requestSecret: false,
      venue: f.input.options.venue,
    });
    expect(input.modelAccess).toBe(f.runtimeServices.modelAccess);
    expect(input.decisions).toBe(f.runtimeServices.decisions);
    expect(input.mcpSettings).toBe(f.runtimeServices.mcp);
    expect(input.webAccess).toBe(f.runtimeServices.webAccess);
    expect(seam.shellOptions!.ledger).toBe(f.spawnLedger);
    // Automations take the host's metadata and its event port, never a host bag.
    expect(seam.automations).toHaveBeenCalledWith({
      host: { database: f.host.database, dataDir: "/data" },
      events: f.input.ports.events,
      piRuntimeHost: f.assembly.piRuntimeHost,
      homeDir: "/home/service",
      log: f.log,
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
    expect(f.automations.execution.pendingArmedRuns.noteDeliberateMove).toHaveBeenCalled();
    const caller = {} as never;
    const request = {} as never;
    await input.callVerb(caller, request, new AbortController().signal, undefined);
    expect(f.agents.toolDoor).toHaveBeenCalledWith(f.proof);
    expect(owner.openNativeBindings()).toEqual([]);
    const drain = seam.lifecycle.mock.lastCall![0];
    expect(drain.services()).toBe(f.facade);
    drain.stopProducers();
    expect(f.automations.stop).toHaveBeenCalledOnce();
    owner.stopProducers();
    expect(f.automations.stop).toHaveBeenCalledTimes(2);
    drain.installQuitHold(vi.fn());
    // The runtime's drain JOINS shell termination: it settles only after the
    // shells have, so SQLite can never close under a shell still exiting.
    const shellsClosed = Promise.withResolvers<void>();
    seam.shells.close.mockReturnValueOnce(shellsClosed.promise);
    let rpcClosed = false;
    const rpcClose = drain
      .rpc()
      .close()
      .then(() => {
        rpcClosed = true;
      });
    expect(seam.shells.close).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(rpcClosed).toBe(false);
    shellsClosed.resolve();
    await rpcClose;
    expect(rpcClosed).toBe(true);
    // A shell that failed to stop fails the drain rather than vanishing.
    seam.shells.close.mockRejectedValueOnce(new Error("shell survived"));
    await expect(drain.rpc().close()).rejects.toThrow("shell survived");
    await owner.close();
    expect(f.lifecycle.close).toHaveBeenCalledOnce();
    expect(f.automations.settled).toHaveBeenCalledOnce();
  });
  it("reads live Sessions from the attachment tokens it minted, on every call", () => {
    const f = fixture();
    const owner = f.launch();
    seam.tokens.liveSessionIds.mockReturnValueOnce([]).mockReturnValueOnce(["s1"]);
    expect(owner.liveSessionIds()).toEqual([]);
    expect(owner.liveSessionIds()).toEqual(["s1"]);
  });
  it("refuses reclaim until recovery, then asks the recovered runtime", async () => {
    const f = fixture();
    const owner = f.launch();
    await expect(owner.reclaim.busyWorktreeSites("/tree")).rejects.toThrow("not ready");
    await expect(owner.reclaim.releaseAgentSites("/tree")).rejects.toThrow("not ready");
    expect(seam.release).not.toHaveBeenCalled();
    const ready = await owner.ready();
    seam.shells.liveCwds.mockReturnValue(["/tree/shell"]);
    expect(await owner.reclaim.busyWorktreeSites("/tree")).toEqual(
      await ready.busyWorktreeSites("/tree"),
    );
    seam.release.mockResolvedValueOnce({ released: ["s"], stillOpen: [] });
    expect(await owner.reclaim.releaseAgentSites("/tree")).toEqual({
      released: ["s"],
      stillOpen: [],
    });
    const [runtime, directory, deps] = seam.release.mock.lastCall!;
    expect(runtime).toBe(f.runtime);
    expect(directory).toBe("/tree");
    expect(deps.newCommandId()).toMatch(/^[0-9a-f-]{36}$/);
    deps.onError("s", new Error("refused"));
    expect(f.log.error).toHaveBeenCalledWith(
      "[volli] could not release Session s from /tree:",
      "refused",
    );
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
  it("uses an explicit sandbox and reports a missing automation runner", async () => {
    const f = fixture();
    const owner = createHeadlessSessionRuntime({
      ...f.input,
      env: {},
      options: { ...f.input.options, codeModeSandbox: { wasmPath: "/wasm" } },
    });
    expect(seam.assembly.mock.lastCall![0].codeModeSandbox).toEqual({ wasmPath: "/wasm" });
    expect(seam.automations.mock.lastCall![0].homeDir).toMatch(/.+/);
    f.automations.execution = { kind: "idle" } as never;
    const ready = await owner.ready();
    expect(ready.automationsAvailable).toBe(false);
    ready.onDeliberateMove({} as never);
    f.automations.kind = "degraded";
    expect((await owner.ready()).automationsAvailable).toBe(false);
    ready.onDeliberateMove({} as never);
    f.automations.kind = "live";
    f.automations.execution = {
      kind: "unavailable",
      pendingArmedRuns: { noteDeliberateMove: vi.fn() },
    } as never;
    ready.onDeliberateMove({} as never);
    f.assembly.sessionRuntime = null as never;
    expect(owner.openNativeBindings()).toEqual([]);
  });
  it("resolves the host's model access from the service account's own environment", () => {
    seam.modelAccess.mockReturnValue({ models: "owned" });
    const scripted = {} as never;
    expect(headlessModelAccess({ PI_CODING_AGENT_DIR: "/auth" }, { modelAccess: scripted })).toBe(
      scripted,
    );
    expect(seam.modelAccess).not.toHaveBeenCalled();
    expect(headlessModelAccess({ HOME: "/h", PI_CODING_AGENT_DIR: "/auth" }, {})).toEqual({
      models: "owned",
    });
    expect(seam.modelAccess).toHaveBeenLastCalledWith({ agentDir: "/auth" });
    headlessModelAccess({ HOME: "/home/service" }, {});
    expect(seam.modelAccess).toHaveBeenLastCalledWith({ agentDir: "/home/service/.pi/agent" });
    headlessModelAccess({}, {});
    expect(seam.modelAccess.mock.lastCall![0].agentDir).toMatch(/\.pi\/agent$/);
  });
  it("refuses absent recovered services and the unavailable tool door", async () => {
    const f = fixture();
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
