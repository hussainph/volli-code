/** Composition contract; the integration test drives the real collaborators. */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostCorePorts, LiveHostCore } from "@volli/host-core";
import type { HeadlessSecrets } from "./secrets";
import { busyRefusal } from "@volli/host-core/worktree";
import type {
  RuntimeAssemblyOptions,
  BackgroundShellHostPorts,
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
  shellOptions: null as BackgroundShellHostPorts | null,
  shells: { liveCwds: vi.fn(() => [] as string[]), close: vi.fn(async () => {}) },
  ticket: vi.fn(),
  project: vi.fn(),
  sites: vi.fn(() => [] as { sessionId: string; directory: string }[]),
  release: vi.fn(),
  modelAccess: vi.fn(),
  piSignIn: vi.fn(),
  piHostCredentials: vi.fn(),
  observability: { start: vi.fn(), shutdown: vi.fn() },
  handlers: vi.fn(),
  workspaces: vi.fn(),
}));
vi.mock("./host-workspaces", () => ({ createHostWorkspaces: seam.workspaces }));
vi.mock("../../../packages/host-core/src/handlers/host-handlers", () => ({
  createHostHandlers: seam.handlers,
}));
vi.mock("@volli/agent-runtime", () => ({
  piOwnedModelAccess: seam.modelAccess,
  piSignIn: seam.piSignIn,
  piHostCredentials: seam.piHostCredentials,
}));
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
    constructor(options: BackgroundShellHostPorts) {
      seam.shellOptions = options;
    }
    liveCwds = seam.shells.liveCwds;
    close = seam.shells.close;
  },
}));
vi.mock("../../../packages/host-core/src/mcp/dispatch-policy", () => ({
  hostMcpDispatch: ({ log }: { log(message: string): void }) => {
    log("mcp");
    return {};
  },
}));
vi.mock("../../../packages/host-core/src/codemode/dev-config", () => ({
  hostCodeMode: ({ log, policy }: { log(message: string): void; policy(): unknown }) => {
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
    modelAccess: {
      models: "host-model-access-models",
      credentials: "host-model-access-credentials",
    },
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
    options: {
      binDir: "/bin",
      venue: { id: "hostd", kind: "remote" as const },
      platform: "linux",
    },
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
  it("composes one process-owned project service and closes it before the runtime", async () => {
    const f = fixture();
    const close = vi.fn(async () => {});
    const service = { list: vi.fn(), create: vi.fn(), close };
    seam.workspaces.mockReturnValue(service);
    const owner = createHeadlessSessionRuntime({
      ...f.input,
      options: { ...f.input.options, projectsRoot: "/home/service/volli" },
      boardFeed: {} as never,
    });
    await owner.ready();
    await owner.ready();
    expect(seam.workspaces).toHaveBeenCalledExactlyOnceWith({
      db: f.host.database.db,
      projectsRoot: "/home/service/volli",
      userInstall: true,
      env: f.input.env,
      gitCredentialHelper: "",
      detachedWork: f.host.detachedWork,
    });
    expect(seam.handlers.mock.lastCall![1]).toMatchObject({ workspaces: service });
    await owner.close();
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(
      f.lifecycle.close.mock.invocationCallOrder[0]!,
    );
  });

  it("passes system install and helper configuration and drains other owners if project close fails", async () => {
    const f = fixture();
    seam.workspaces.mockReturnValue({
      close: vi.fn(async () => {
        throw new Error("project drain failed");
      }),
    });
    const owner = createHeadlessSessionRuntime({
      ...f.input,
      options: {
        ...f.input.options,
        projectsRoot: "/srv/volli",
        userInstall: false,
        gitCredentialHelper: "!fixture",
      },
    });
    await owner.ready();
    expect(seam.workspaces.mock.lastCall![0]).toMatchObject({
      projectsRoot: "/srv/volli",
      userInstall: false,
      gitCredentialHelper: "!fixture",
    });
    await expect(owner.close()).rejects.toThrow("project drain failed");
    expect(f.lifecycle.close).toHaveBeenCalledOnce();
    expect(f.automations.settled).toHaveBeenCalledOnce();
  });

  it("composes no project service without the cloud-owned root", async () => {
    const f = fixture();
    await f.launch().ready();
    expect(seam.workspaces).not.toHaveBeenCalled();
    expect(seam.handlers.mock.lastCall![1]).toMatchObject({ workspaces: undefined });
  });

  it("captures all ports before recovery, gates commands, and joins shell drain", async () => {
    const f = fixture();
    const owner = f.launch();
    expect(f.lifecycle.ready).not.toHaveBeenCalled();
    // The host's one lazy runtime-service module, never a second model factory here.
    expect(seam.modelAccess).not.toHaveBeenCalled();
    expect(seam.observability.start).toHaveBeenCalledOnce();
    const input = seam.assembly.mock.lastCall![0] as RuntimeAssemblyOptions;
    expect(input).toMatchObject({
      askUser: true,
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
    // The host's one handler map, from the recovered services: the move's
    // armed arrival and its trim's drain are the handler's (VC-668).
    expect(seam.handlers).toHaveBeenCalledExactlyOnceWith(
      f.input.ports,
      expect.objectContaining({
        db: f.input.host.database.db,
        runtime: f.runtime,
        experiments: null,
        automations: f.automations,
        busyWorktreeSites: expect.any(Function),
        detachedWork: f.input.host.detachedWork,
        // Sign-ins on this host (VC-702), over the host's own Pi collection
        // and its own stores; the ChatGPT flow names the host by its id.
        signIns: expect.any(Object),
      }),
    );
    expect(seam.piSignIn).toHaveBeenCalledWith("host-model-access-models", expect.any(Object));
    expect(seam.piSignIn.mock.lastCall![1].deviceId()).toBe("hostd");
    expect(seam.piHostCredentials).toHaveBeenCalledWith("host-model-access-credentials");
    expect(ready.handlers).toBe(seam.handlers.mock.results[0]!.value);
    const caller = {} as never;
    const request = {} as never;
    await input.callVerb(caller, request, new AbortController().signal, undefined);
    expect(f.agents.toolDoor).toHaveBeenCalledWith(f.proof);
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
  it("installs Volli's git credential helper in every Session command only when given one", async () => {
    const f = fixture();
    f.launch();
    const without = seam.assembly.mock.lastCall![0] as RuntimeAssemblyOptions;
    // The cloud flag off: Sessions push exactly as before.
    expect(await without.concurrencyEnvFor("s")).not.toHaveProperty("GIT_CONFIG_COUNT");
    createHeadlessSessionRuntime({
      ...f.input,
      options: { ...f.input.options, gitCredentialHelper: "!'/opt/hostd' git-credential" },
    });
    const withHelper = seam.assembly.mock.lastCall![0] as RuntimeAssemblyOptions;
    expect(await withHelper.concurrencyEnvFor("s")).toEqual({
      PATH: "/service/bin",
      VOLLI_SOCKET: "/run/hostd.sock",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "!'/opt/hostd' git-credential",
    });
  });
  it("composes sign-ins over the recovered model access, and none without it (VC-702)", async () => {
    const f = fixture();
    const inspectModelAccess = vi.fn(async () => ({ observedAt: 0, providers: [], models: [] }));
    seam.recovered.mockReturnValue({
      sessions: {},
      runtime: f.runtime,
      piRuntimeHost: { inspectModelAccess },
    });
    seam.piHostCredentials.mockReturnValue({ stored: async () => [], setApiKey: vi.fn() });
    await f.launch().ready();
    const composed = seam.handlers.mock.lastCall![1] as { signIns: { status(): Promise<unknown> } };
    // The status reads the runtime's own snapshot, and the push store under
    // the data directory (absent here: no git host).
    expect(await composed.signIns.status()).toEqual({ providers: [], git: [] });
    expect(inspectModelAccess).toHaveBeenCalledWith({});
    seam.recovered.mockReturnValue({ sessions: {}, runtime: f.runtime, piRuntimeHost: null });
    await f.launch().ready();
    expect(seam.handlers.mock.lastCall![1]).toMatchObject({ signIns: null });
  });

  it("lists Sessions from the engine, live by this process's executor bindings (VC-713)", async () => {
    const f = fixture();
    const listSessions = vi.fn(async () => []);
    (f.host.sessionEngine as unknown as { listSessions: typeof listSessions }).listSessions =
      listSessions;
    const ready = await f.launch().ready();
    const { sessionListing } = seam.handlers.mock.lastCall![1] as {
      sessionListing: {
        db: unknown;
        listSessions(query: unknown): Promise<unknown>;
        liveAttachmentIds(): ReadonlySet<string>;
      };
    };
    expect(sessionListing.db).toBe(f.host.database.db);
    await sessionListing.listSessions({ projectId: "p", scope: "all" });
    expect(listSessions).toHaveBeenCalledWith({ projectId: "p", scope: "all" });
    f.runtime.openNativeBindings.mockReturnValue([
      { attachmentId: "a-1", sessionId: "s-1" },
    ] as never);
    expect([...sessionListing.liveAttachmentIds()]).toEqual(["a-1"]);
    const reads = vi.fn(async () => ({ v: 1 as const, ok: true as const, data: {} }));
    ready.serveSessionReads(reads);
    const handlers = seam.handlers.mock.lastCall![1];
    await handlers.sessionReads("session.show", "p", { session: "s-1" });
    expect(reads).toHaveBeenCalledWith("session.show", "p", { session: "s-1" });
    const listSignals = vi.fn(async () => []);
    (
      f.host.sessionEngine as unknown as { listLatestTicketSignals: typeof listSignals }
    ).listLatestTicketSignals = listSignals;
    await handlers.ticketSignals("p");
    expect(listSignals).toHaveBeenCalledWith({ projectId: "p" });
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
    void ready;
    expect(await owner.reclaim.busyWorktreeSites("/tree")).toEqual([
      { surface: "shell", directory: "/tree/shell" },
    ]);
    seam.release.mockResolvedValueOnce({ released: ["s"], stillOpen: [] });
    expect(await owner.reclaim.releaseAgentSites("/tree")).toEqual({
      released: ["s"],
      stillOpen: [],
    });
    const [runtime, directory, deps] = seam.release.mock.lastCall!;
    expect(runtime).toBe(f.runtime);
    expect(directory).toBe("/tree");
    expect(deps.newCommandId()).toMatch(/^[0-9a-f-]{36}$/);
    const refused = new Error("refused");
    deps.onError("s", refused);
    expect(f.log.error).toHaveBeenCalledWith("could not release session from directory", {
      sessionId: "s",
      directory: "/tree",
      error: refused,
    });
  });
  it("supplies busy Sessions and background shells, and fails closed on unreadable activity", async () => {
    const f = fixture();
    const owner = f.launch();
    await owner.ready();
    const ready = { busyWorktreeSites: owner.reclaim.busyWorktreeSites };
    seam.shells.liveCwds.mockReturnValue(["/tree/shell"]);
    seam.sites.mockReturnValue([{ sessionId: "s", directory: "/tree/agent" }]);
    const sites = await ready.busyWorktreeSites("/tree");
    expect(sites).toEqual([
      { surface: "shell", directory: "/tree/shell" },
      { surface: "agent", directory: "/tree/agent" },
    ]);
    expect(busyRefusal(sites[0]!)).toBe(
      "A background shell is still running in this worktree. Stop it first.",
    );
    f.runtime.projection.mockResolvedValueOnce({ projection: { turnActive: false } });
    expect(await ready.busyWorktreeSites("/tree")).toHaveLength(1);
    f.runtime.projection.mockRejectedValueOnce(new Error("unreadable"));
    await expect(ready.busyWorktreeSites("/tree")).rejects.toThrow("unreadable");
  });
  // VC-700 PR 1c: on a Mac host, a Session's git never reaches the keychain.
  it("hands a Mac's Session commands git with every credential helper reset", async () => {
    const f = fixture();
    createHeadlessSessionRuntime({
      ...f.input,
      options: { ...f.input.options, platform: "darwin" },
    });
    const input = seam.assembly.mock.lastCall![0] as RuntimeAssemblyOptions;
    expect(await input.concurrencyEnvFor("s")).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_TERMINAL_PROMPT: "0",
      VOLLI_SOCKET: "/run/hostd.sock",
    });
    // The platform defaults to this process's.
    const { platform: _, ...unnamed } = f.input.options;
    createHeadlessSessionRuntime({ ...f.input, options: unnamed });
    const defaulted = seam.assembly.mock.lastCall![0] as RuntimeAssemblyOptions;
    expect("GIT_TERMINAL_PROMPT" in (await defaulted.concurrencyEnvFor("s"))).toBe(
      process.platform === "darwin",
    );
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
    f.automations.kind = "degraded";
    expect((await owner.ready()).automationsAvailable).toBe(false);
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
