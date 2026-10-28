/**
 * The runner composition (VC-671), proved through its interface over a real
 * `createHostCore`: the quit hold is installed before anything can yield, the
 * host's edge binds only the recovered proof, a quit during recovery binds
 * nothing, and each stop policy drains exactly what it names: desktop's quit
 * leaves the shells, Automations and the database alone; a full drain closes
 * the shells, settles Automations and closes SQLite last.
 *
 * The executor is the one stand-in (no Pi process), and boot recovery's first
 * step is gated so a test can act while recovery is still open. Exhaustive
 * recovery ordering stays with `lifecycle.test.ts`; host stop steps with
 * host-core's `index.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ALWAYS_ONLINE, piOwnedModelAccess } from "@volli/agent-runtime";
import { DEFAULT_AUTHORITY_POLICY, LOCAL_RUNNER, sessionHostNoticeMetadata } from "@volli/shared";
import type { CodeModeBirth } from "@volli/shared";
import { SESSION_NOTICE_FORMAT, type ClaimedJob } from "@volli/shared/cloud";
import {
  createHostCore,
  isLiveHost,
  throwTransactionViolation,
  type HostCore,
  type HostCorePorts,
} from "../index";
import type { HostStopPolicy } from "../host-lifecycle";
import { HEADLESS_ATTENTION, NO_POWER_EVENTS } from "../ports";
import { SecretStore } from "../secrets";
import { SecretService } from "../secrets/service";
import * as handlerModule from "../handlers/host-handlers";
import * as boot from "./boot-recovery";
import { readRecoveredSessionServices, SessionRuntimeClosingError } from "./lifecycle";
import * as pi from "./pi-adapter";
import { createRunnerComposition, type RunnerHostEdge, type RunnerProductStore } from "./runner";
import { createCloudProductStore } from "../cloud-store";
import { registerSessionNoticeJob } from "../cloud-store/notice-jobs";
import { ownerGuardedInbox } from "../cloud-store/session-jobs";
import type { JobExecutor } from "../cloud-runner/inbox";
import { sqliteDrainCursorStore } from "../cloud-runner/sqlite-stores";
import { insertProject } from "../db/projects-repo";
import { testProject } from "../db/test-helpers";

const roots: string[] = [];
const hosts: HostCore[] = [];
const gates: PromiseWithResolvers<void>[] = [];
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resolve();
  for (const host of hosts.splice(0)) {
    await host.stop("test teardown");
    if (isLiveHost(host) && host.database.db.open) host.database.db.close();
  }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "volli-runner-"));
  roots.push(root);
  return root;
}

function hostPorts(): HostCorePorts {
  return {
    events: { publish: vi.fn() },
    attention: HEADLESS_ATTENTION,
    power: NO_POWER_EVENTS,
    connectivity: ALWAYS_ONLINE,
    log: { error: vi.fn(), warn: vi.fn() },
  };
}

const noKeys = {
  isEncryptionAvailable: () => false,
  encryptString: (): never => {
    throw new Error("no keys in this test");
  },
  decryptString: (): never => {
    throw new Error("no keys in this test");
  },
};

async function composedHost(policy: HostStopPolicy, options: { degraded?: boolean } = {}) {
  const root = tempRoot();
  const ports = hostPorts();
  const models = piOwnedModelAccess({ agentDir: join(root, "pi-agent") });
  await models.catalogReady;
  const databasePath = join(root, "volli.db");
  // A directory where the database file should be: the open fails.
  if (options.degraded === true) mkdirSync(databasePath);
  const host = createHostCore(ports, {
    dataDir: root,
    databasePath,
    stopPolicy: policy,
    onTransactionViolation: throwTransactionViolation,
    devDiagnostics: false,
    processReaders: { liveSessionIds: () => [], openTerminalCwds: () => [] },
    modelAccess: () => models,
    secretKey: noKeys,
  });
  hosts.push(host);
  vi.spyOn(pi, "createPiRuntimeHost").mockReturnValue({
    adapter: {
      id: "pi",
      durableIdNamespace: "pi",
      adapterVersion: "1",
      runtime: { path: "test", version: "1", fingerprint: "test" },
      attach: async () => {
        throw new Error("runner test does not attach");
      },
    },
    inspectModelAccess: async () => ({ observedAt: 0, models: [], providers: [] }),
    completeUtility: async () => {
      throw new Error("runner test does not complete");
    },
  } as unknown as ReturnType<typeof pi.createPiRuntimeHost>);
  return { host, ports, root };
}

/** Holds boot recovery's first step open until the returned gate resolves. */
function gateRecovery(calls: string[]): PromiseWithResolvers<void> {
  const gate = Promise.withResolvers<void>();
  gates.push(gate);
  const real = boot.closeStaleAttachments;
  vi.spyOn(boot, "closeStaleAttachments").mockImplementation(async (options) => {
    calls.push("recovery");
    await gate.promise;
    return real(options);
  });
  return gate;
}

function compose(
  { host, ports, root }: Awaited<ReturnType<typeof composedHost>>,
  store: RunnerProductStore = { kind: "local", host },
) {
  const calls: string[] = [];
  const transport = {
    close: vi.fn(async () => {
      calls.push("transport.close");
    }),
  };
  const doors = vi.fn(() => ({ experiments: null, busyWorktreeSites: async () => [] }));
  const installQuitHold = vi.fn(() => {
    calls.push("quit.hold");
  });
  const runner = createRunnerComposition({
    store,
    ports,
    version: "0.0.0-test",
    venue: { id: "test-host", kind: "remote" },
    homeDir: root,
    binDir: join(root, "bin"),
    env: {},
    packaged: true,
    cloudEnabled: () => store.kind === "cloud",
    secrets: new SecretService(
      isLiveHost(host) ? host.secretStore : new SecretStore(join(root, "s.enc"), noKeys),
    ),
    capabilities: { askUser: false, requestSecret: false },
    beforeExecution: async () => {},
    // What this host's doors answer; nothing here calls a verb.
    doors,
    transport: () => transport,
    stopProducers: () => {
      calls.push("host.producers.stop");
    },
    installQuitHold,
  });
  const automationsStart = vi.spyOn(runner.automations, "start").mockImplementation(() => {
    calls.push("automations.start");
  });
  const automationsStop = vi.spyOn(runner.automations, "stop");
  const automationsSettled = vi.spyOn(runner.automations, "settled");
  const shellsClose = vi.spyOn(runner.shells, "close");
  return {
    calls,
    runner,
    doors,
    automationsStart,
    transport,
    installQuitHold,
    automationsStop,
    automationsSettled,
    shellsClose,
  };
}

/** One composed notice, and the lifecycle intent that would compose it (VC-887). */
const notice = (sessionId: string, commandId: string) => ({
  sessionId,
  commandId,
  messageId: `${commandId}:message`,
  text: "composed once",
  metadata: sessionHostNoticeMetadata({ kind: "watch", events: [] }),
  label: "watch notice",
});
const intent = (value: ReturnType<typeof notice>) => ({
  sessionId: value.sessionId,
  commandId: value.commandId,
  compose: vi.fn(() => value),
});

describe("runner composition", () => {
  it("composes the cloud store's owner-scoped ports through assembly, facade, agents and lifecycle", async () => {
    const fixture = await composedHost("desktop-quit");
    const { host, root } = fixture;
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const cloudProject = testProject({ id: "cloud-project", path: join(root, "cloud-checkout") });
    const localProject = testProject({ id: "local-project", path: join(root, "local-checkout") });
    insertProject(host.database.db, cloudProject);
    insertProject(host.database.db, localProject);
    host.database.db
      .prepare("INSERT INTO cloud_shadow_rows(kind,id,owner_user_id) VALUES ('project',?,'a')")
      .run(cloudProject.id);
    const provenance = {
      source: { kind: "system", id: "test", detail: null },
      venue: LOCAL_RUNNER,
    } as const;
    const owned = await host.sessionEngine.createSession({
      commandId: "cloud-birth",
      projectId: cloudProject.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Owned by A",
      ownerUserId: "a",
      provenance,
    });
    const foreign = await host.sessionEngine.createSession({
      commandId: "foreign-birth",
      projectId: localProject.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Owned by B",
      ownerUserId: "b",
      provenance,
    });
    const local = await host.sessionEngine.createSession({
      commandId: "local-birth",
      projectId: localProject.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Frozen local",
      provenance,
    });
    const cursors = sqliteDrainCursorStore(host.database.db);
    for (const [sessionId, ownerUserId] of [
      [owned.session.id, "a"],
      [foreign.session.id, "b"],
    ] as const) {
      cursors.save({ sessionId, ownerUserId, generation: 1, acceptedThrough: 0, blocked: null });
    }
    const cloud = createCloudProductStore({
      host,
      ownerUserId: "a",
      backendUrl: "http://127.0.0.1:1",
      runnerId: () => "runner-a",
      home: root,
      busySites: async () => [],
    });
    const checkoutPath = join(root, "registered-checkout");
    cloud.registry().checkouts.register({
      projectId: cloudProject.id,
      projectRepoId: "repo",
      absPath: checkoutPath,
    });
    const bindRuntime = vi.spyOn(cloud, "bindRuntime");
    const bindEnvironment = vi.spyOn(cloud, "bindEnvironment");
    const bindNotices = vi.spyOn(cloud, "bindNotices");
    const dispose = vi.spyOn(cloud, "dispose");
    const [
      assemblyModule,
      facadeModule,
      agentsModule,
      lifecycleModule,
      contextModule,
      agentServiceModule,
      automationServicesModule,
      schedulerModule,
    ] = await Promise.all([
      import("./assembly"),
      import("./facade"),
      import("./agents"),
      import("./lifecycle"),
      import("./context"),
      import("../agent-services"),
      import("../automation-services"),
      import("../automations/scheduler"),
    ]);
    const buildAssembly = vi.spyOn(assemblyModule, "createRuntimeAssembly");
    const buildFacade = vi.spyOn(facadeModule, "createRuntimeSessionFacade");
    const buildAgents = vi.spyOn(agentsModule, "createRuntimeSessionAgents");
    const buildLifecycle = vi.spyOn(lifecycleModule, "createSessionRuntimeLifecycle");
    const buildContext = vi.spyOn(contextModule, "createRuntimeContextResolver");
    const buildHandlers = vi.spyOn(handlerModule, "createHostHandlers");
    const buildToolDoor = vi.spyOn(agentServiceModule, "createHostAgentToolDoor");
    const buildAutomations = vi.spyOn(automationServicesModule, "createHostAutomations");
    const buildScheduler = vi.spyOn(schedulerModule, "createAutomationScheduler");
    const f = compose(fixture, { kind: "cloud", host, cloud });
    // VC-952: a cloud launch composes no local Automation module at all — no
    // service, no runner, no scheduler — whatever the `cloud` flag says.
    expect(f.runner.automations.kind).toBe("degraded");
    expect(f.runner.automations).not.toHaveProperty("service");
    expect(f.runner.automations).not.toHaveProperty("execution");
    expect(buildAutomations).not.toHaveBeenCalled();
    const assembly = buildAssembly.mock.lastCall![0];
    const assembled = buildAssembly.mock.results[0]!.value;
    expect(assembly.automationsAvailable).toBe(false);
    expect(assembly.sessionEngine).toBe(cloud.engine);
    expect(assembly.locations).toBe(cloud.locations);
    expect(assembly.ownsSession).toBe(cloud.ownsSession);
    expect(buildContext.mock.lastCall![0].sessionEngine).toBe(cloud.engine);
    expect(buildContext.mock.lastCall![0].brief).toBe(cloud.brief);
    expect(assembly.resolveRuntimeContext).toBe(buildContext.mock.results[0]!.value);
    const facade = buildFacade.mock.lastCall![0];
    expect(facade.sessionEngine).toBe(cloud.engine);
    expect(facade.sessionBirth).toBe(cloud.sessionBirth);
    expect(facade.projectPath).toBe(cloud.projectPath);
    expect(facade.projectPath!(cloudProject.id)).toBe(checkoutPath);
    expect(facade.recordSessionStarted).toBeNull();
    const lifecycle = buildLifecycle.mock.lastCall![0];
    expect(lifecycle.sessionEngine).toBe(cloud.engine);
    expect(lifecycle.ownsSession).toBe(cloud.ownsSession);
    expect(lifecycle.projectIds).toBe(cloud.projectIds);
    // Its own interrupted turns resume behind its first connect (N2-3).
    expect(lifecycle.cloudRecovery).toBe(cloud.recovery);
    expect(lifecycle.ownsSession!(owned.session.id)).toBe(true);
    expect(lifecycle.ownsSession!(foreign.session.id)).toBe(false);
    expect(lifecycle.ownsSession!(local.session.id)).toBe(false);
    expect(lifecycle.projectIds!()).toEqual([cloudProject.id]);
    const agents = buildAgents.mock.lastCall![0];
    expect(agents.services.sessionEngine).toBe(cloud.engine);
    expect(agents.inProcessWatches).toBe(false);
    expect(agents.automationsAvailable).toBe(false);
    expect(agents.projects!()).toMatchObject([{ ...cloudProject, path: checkoutPath }]);
    expect(bindEnvironment).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(bindRuntime).toHaveBeenCalledExactlyOnceWith(
      f.runner.runtime,
      f.runner.transcriptArtifacts,
    );

    // Backend-queued notices enter this launch's owner-scoped outbox (VC-887).
    expect(bindNotices).toHaveBeenCalledExactlyOnceWith({ enqueue: expect.any(Function) });
    const notices = bindNotices.mock.lastCall![0];
    await host.start(f.runner.owner());
    expect(buildScheduler).not.toHaveBeenCalled();
    // A new cloud Session's surface omits the verb, direct and through Code
    // Mode: the route is derived from the surface, so neither can reach it.
    const birth: CodeModeBirth = {
      offered: true,
      mode: "both",
      nudge: false,
      largeServers: new Set(),
    };
    const surface = assembled.sessionToolSurface;
    expect(surface).not.toBeNull();
    const tools = surface!.resolve("project", [], undefined, [], birth, false);
    expect(tools).not.toContain("automation.run");
    const routes = assembly.codeMode.surfaceFor(birth, tools, [])?.routes;
    expect(Object.keys(routes ?? {})).not.toContain("automation.run");
    expect(routes?.["automation.run"]).toBeUndefined();
    expect(buildToolDoor.mock.lastCall![0].cloudSessionVerbs).toBe(cloud.cloudSessionVerbs);
    expect(buildToolDoor.mock.lastCall![0].automationsAvailable).toBe(false);
    expect(buildToolDoor.mock.lastCall![0].authorityPolicy(cloudProject.id)).toBe(
      DEFAULT_AUTHORITY_POLICY,
    );
    const ready = await f.runner.ready();
    expect(facadeModule.recoveredRuntimeSessionServices(ready).sessionEngine).toBe(cloud.engine);
    const stored = notice(owned.session.id, `watch:${owned.session.id}:one`);
    const first = intent(stored);
    await expect(notices.enqueue(first)).resolves.toEqual(stored);
    expect(first.compose).toHaveBeenCalledOnce();
    // A replay of a stored id composes nothing and gets the first payload back.
    const replay = intent({ ...stored, text: "re-minted" });
    await expect(notices.enqueue(replay)).resolves.toEqual(stored);
    expect(replay.compose).not.toHaveBeenCalled();
    // Settled (delivered or dropped): nothing is composed or stored again.
    host.database.db
      .prepare(
        'UPDATE host_notice_outbox SET notice = NULL, receipt = \'{"status":"accepted"}\' WHERE command_id = ?',
      )
      .run(stored.commandId);
    const settled = intent(stored);
    await expect(notices.enqueue(settled)).resolves.toBeNull();
    expect(settled.compose).not.toHaveBeenCalled();
    const elsewhere = intent(notice(foreign.session.id, `watch:${foreign.session.id}:one`));
    await expect(notices.enqueue(elsewhere)).rejects.toThrow("outside this launch's Session scope");
    expect(elsewhere.compose).not.toHaveBeenCalled();

    f.runner.handlers(ready);
    const listing = buildHandlers.mock.lastCall![1].sessionListing!;
    expect(
      (await listing.listSessions({ projectId: cloudProject.id, scope: "all" })).map(
        (projection) => projection.session.id,
      ),
    ).toEqual([owned.session.id]);
    expect(await listing.listSessions({ projectId: localProject.id, scope: "all" })).toEqual([]);
    await expect(host.stop("cloud shutdown")).resolves.toEqual({
      reason: "cloud shutdown",
      clean: true,
    });
    // A closed launch stores nothing: the job fails retryably and comes back.
    await expect(
      notices.enqueue(intent(notice(owned.session.id, `watch:${owned.session.id}:two`))),
    ).rejects.toBeInstanceOf(SessionRuntimeClosingError);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("runs a claimed session.notice through the real outbox and delivery: parked while detached, dropped for a stopped reader (VC-887)", async () => {
    const fixture = await composedHost("desktop-quit");
    const { host, root } = fixture;
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const db = host.database.db;
    const project = testProject({ id: "cloud-project", path: join(root, "cloud-checkout") });
    insertProject(db, project);
    db.prepare("INSERT INTO cloud_shadow_rows(kind,id,owner_user_id) VALUES ('project',?,'a')").run(
      project.id,
    );
    const provenance = {
      source: { kind: "system", id: "test", detail: null },
      venue: LOCAL_RUNNER,
    } as const;
    const born = async (commandId: string) => {
      const { session } = await host.sessionEngine.createSession({
        commandId,
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        ownerUserId: "a",
        provenance,
      });
      sqliteDrainCursorStore(db).save({
        sessionId: session.id,
        ownerUserId: "a",
        generation: 1,
        acceptedThrough: 0,
        blocked: null,
      });
      return session.id;
    };
    const detached = await born("detached-birth");
    const stopped = await born("stopped-birth");
    const cloud = createCloudProductStore({
      host,
      ownerUserId: "a",
      backendUrl: "http://127.0.0.1:1",
      runnerId: () => "runner-a",
      home: root,
      busySites: async () => [],
    });
    const bindNotices = vi.spyOn(cloud, "bindNotices");
    const f = compose(fixture, { kind: "cloud", host, cloud });
    await host.start(f.runner.owner());
    await f.runner.ready();
    // The production executor behind the production owner gate, over the
    // lifecycle door this composition bound: real SQLite outbox, real delivery.
    const executors = new Map<string, JobExecutor>();
    const newId = vi.fn(() => "the-only-nonce");
    registerSessionNoticeJob(
      ownerGuardedInbox(
        { register: (kind, executor) => void executors.set(kind, executor) },
        { engine: cloud.engine, ownerUserId: "a", owns: cloud.ownsSession },
      ),
      { outbox: () => bindNotices.mock.lastCall![0], newId },
    );
    const run = (sessionId: string) => {
      const commandId = `watch:${sessionId}:00000000-0000-4000-8000-0000000000e1`;
      const claimed = {
        job: {
          id: commandId,
          kind: "session.notice",
          runnerId: "runner-a",
          projectId: project.id,
          ticketId: null,
          sessionId,
          workingCopyId: null,
          commandId,
          payload: {
            format: SESSION_NOTICE_FORMAT,
            notice: "watch",
            commandId,
            changes: [
              {
                subject: "session",
                sessionId: "00000000-0000-4000-8000-0000000000e2",
                title: null,
                occurredAt: null,
                fact: "signaled-done",
                pendingSubagents: [],
                reason: { text: "Another author's words", totalChars: 22 },
              },
            ],
            overflow: 0,
          },
          priority: "normal",
          createdBy: { kind: "volli", reason: "policy" },
          createdAt: 0,
          availableAt: 0,
        },
        lease: { bootId: "boot", attempt: 1, expiresAt: Date.now() + 60_000 },
      } as unknown as ClaimedJob;
      return {
        commandId,
        done: executors.get("session.notice")!(claimed, {
          signal: new AbortController().signal,
          renew: async () => true,
        }),
      };
    };
    const row = (commandId: string) =>
      db
        .prepare("SELECT notice, receipt FROM host_notice_outbox WHERE command_id = ?")
        .get(commandId) as { notice: string | null; receipt: string | null } | undefined;
    const ON_RUNNER = { status: "done", result: { stage: "on_runner" } };

    // Detached reader: stored, answered on_runner, and parked (never submitted).
    const parked = run(detached);
    await expect(parked.done).resolves.toEqual(ON_RUNNER);
    expect(JSON.parse(row(parked.commandId)!.notice!)).toMatchObject({
      sessionId: detached,
      messageId: `${parked.commandId}:message`,
    });
    expect(row(parked.commandId)!.notice).toContain("the-only-nonce");
    await new Promise((done) => setTimeout(done, 50));
    expect(row(parked.commandId)!.receipt).toBeNull();
    expect(
      (await host.sessionEngine.listEvents({ sessionId: detached })).some(
        (event) => event.commandId === parked.commandId,
      ),
    ).toBe(false);

    // Stopped reader: the delivery settles it as dropped(reader-stopped).
    await host.sessionEngine.submit({
      commandId: "stop-reader",
      sessionId: stopped,
      intent: { kind: "session.stop", reason: null, by: { kind: "user" } },
      provenance,
    });
    const dropped = run(stopped);
    await expect(dropped.done).resolves.toEqual(ON_RUNNER);
    await vi.waitFor(() =>
      expect(row(dropped.commandId)).toEqual({
        notice: null,
        receipt: JSON.stringify({ status: "dropped", reason: "reader-stopped" }),
      }),
    );
    expect(newId).toHaveBeenCalledTimes(2);
    // A re-lease of either composes nothing: stored stays as stored, dropped stays dropped.
    await expect(run(detached).done).resolves.toEqual(ON_RUNNER);
    await expect(run(stopped).done).resolves.toEqual(ON_RUNNER);
    expect(newId).toHaveBeenCalledTimes(2);
    expect(row(parked.commandId)!.notice).toContain("the-only-nonce");
    expect(row(dropped.commandId)!.notice).toBeNull();
  });

  it("installs the quit hold synchronously and binds the host edge only from recovered readiness", async () => {
    const fixture = await composedHost("desktop-quit");
    const { host } = fixture;
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const recoveryCalls: string[] = [];
    const held = gateRecovery(recoveryCalls);
    const f = compose(fixture);
    // Before anything could yield.
    expect(f.installQuitHold).toHaveBeenCalledOnce();
    expect(f.runner.runtime).not.toBeNull();
    const bind = vi.fn<NonNullable<RunnerHostEdge["bind"]>>(() => {
      f.calls.push("bind");
    });
    const started = host.start(
      f.runner.owner({
        bind,
        closeSocket: async () => {
          f.calls.push("socket.close");
        },
      }),
    );
    await vi.waitFor(() => expect(recoveryCalls).toEqual(["recovery"]));
    // Recovery is still open: nothing schedules and nothing binds.
    expect(f.automationsStart).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    held.resolve();
    await started;
    expect(f.calls).toEqual(["quit.hold", "automations.start", "bind"]);
    expect(bind).toHaveBeenCalledOnce();
    const proof = bind.mock.calls[0]![0];
    expect(() => readRecoveredSessionServices(proof)).not.toThrow();
    await expect(f.runner.ready()).resolves.toBe(proof);
    // The tool door already asked for the one handler map; every door gets it.
    expect(f.doors).toHaveBeenCalledExactlyOnceWith(proof);
    expect(f.runner.handlers(proof)).toBe(f.runner.handlers(proof));
    expect(f.doors).toHaveBeenCalledOnce();

    f.calls.length = 0;
    const checkpoint = vi.spyOn(host.database.db, "pragma");
    const report = await host.stop("quit");
    expect(report).toEqual({ reason: "quit", clean: true });
    // The host's producers stop first (again as the lifecycle's drain begins);
    // the transport and the runtime drain beside the socket. Desktop quit
    // joins no shell close, no Automation settlement, no WAL checkpoint, and
    // leaves the database open for process exit.
    expect(f.calls[0]).toBe("host.producers.stop");
    // The Session drain and the socket close concurrently.
    expect(f.calls.slice(1).toSorted()).toEqual([
      "host.producers.stop",
      "socket.close",
      "transport.close",
    ]);
    expect(f.automationsStop).toHaveBeenCalledTimes(2);
    expect(f.shellsClose).not.toHaveBeenCalled();
    expect(f.automationsSettled).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(host.database.db.open).toBe(true);
    // One drain: a second quit joins it.
    await expect(host.stop("quit")).resolves.toBe(report);
    expect(f.transport.close).toHaveBeenCalledOnce();
    await expect(f.runner.ready()).rejects.toBeInstanceOf(SessionRuntimeClosingError);
  });

  it("a quit during recovery never binds, joins the open sweep, and leaves desktop's database open", async () => {
    const fixture = await composedHost("desktop-quit");
    const { host } = fixture;
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const recoveryCalls: string[] = [];
    const held = gateRecovery(recoveryCalls);
    const f = compose(fixture);
    const bind = vi.fn();
    const started = host.start(f.runner.owner({ bind }));
    const refused = expect(started).rejects.toBeInstanceOf(SessionRuntimeClosingError);
    await vi.waitFor(() => expect(recoveryCalls).toEqual(["recovery"]));
    let stopped = false;
    const stopping = host.stop("quit").then((report) => {
      stopped = true;
      return report;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The Session drain joins the recovery still in flight.
    expect(stopped).toBe(false);
    held.resolve();
    await refused;
    await expect(stopping).resolves.toEqual({ reason: "quit", clean: true });
    expect(bind).not.toHaveBeenCalled();
    expect(host.database.db.open).toBe(true);
  });

  it("fills the handler map's host-owned options itself, beside the host's door capabilities", async () => {
    const fixture = await composedHost("desktop-quit");
    const { host } = fixture;
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const build = vi.spyOn(handlerModule, "createHostHandlers");
    const f = compose(fixture);
    // A local launch keeps the live module, with the same start and stop.
    expect(f.runner.automations.kind).toBe("live");
    await host.start(f.runner.owner());
    const proof = await f.runner.ready();
    const map = f.runner.handlers(proof);
    expect(build).toHaveBeenCalledOnce();
    const [, options] = build.mock.calls[0]!;
    expect(build.mock.results[0]!.value).toBe(map);
    expect(options).toMatchObject({
      db: host.database.db,
      dataDir: host.dataDir,
      runtime: f.runner.runtime,
      pictures: f.runner.pictures,
      modelAccess: f.runner.piRuntimeHost,
      automations: f.runner.automations,
      worktreeReads: host.worktreeReads,
      detachedWork: host.detachedWork,
      // The door's own answer passes straight through.
      experiments: null,
    });
    expect(options.sessions).not.toBeNull();
    expect(options.submitSessionMessage).toBeTypeOf("function");
    expect(options.refineAutoTitle).toBeTypeOf("function");
    // Listing rows are live only while this process holds a binding.
    expect(options.sessionListing?.db).toBe(host.database.db);
    expect(options.sessionListing?.liveAttachmentIds()).toEqual(new Set());
    await expect(options.ticketSignals?.("project")).resolves.toEqual([]);
  });

  it("gives a degraded host's map no database, readers or listing", async () => {
    const fixture = await composedHost("desktop-quit", { degraded: true });
    const build = vi.spyOn(handlerModule, "createHostHandlers");
    const f = compose(fixture);
    await fixture.host.start(f.runner.owner());
    f.runner.handlers(await f.runner.ready());
    const [, options] = build.mock.calls[0]!;
    expect(options).toMatchObject({
      db: null,
      runtime: null,
      sessions: null,
      worktreeReads: null,
      sessionListing: null,
      ticketSignals: null,
    });
    expect(options).not.toHaveProperty("detachedWork");
  });

  it("stops the scheduler again when the host's edge fails to bind", async () => {
    const fixture = await composedHost("desktop-quit");
    const f = compose(fixture);
    const failure = new Error("bind failed");
    await expect(
      fixture.host.start(
        f.runner.owner({
          bind: () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);
    expect(f.automationsStart).toHaveBeenCalledOnce();
    expect(f.automationsStop).toHaveBeenCalledOnce();
  });

  it("composes a degraded host with no runtime, through the same start and stop", async () => {
    const fixture = await composedHost("desktop-quit", { degraded: true });
    const { host } = fixture;
    expect(host.kind).toBe("degraded");
    const f = compose(fixture);
    expect(f.runner.runtime).toBeNull();
    expect(f.runner.concurrency).toBeNull();
    expect(f.runner.observability).toBeNull();
    expect(f.runner.automations.kind).toBe("degraded");
    const bind = vi.fn();
    await host.start(f.runner.owner({ bind }));
    expect(bind).toHaveBeenCalledOnce();
    await expect(host.stop("quit")).resolves.toEqual({ reason: "quit", clean: true });
    expect(f.calls).toContain("transport.close");
  });

  it("a full drain closes the edge first, then the shells, settles Automations and closes SQLite", async () => {
    const fixture = await composedHost("drain-and-close");
    const { host } = fixture;
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const f = compose(fixture);
    f.shellsClose.mockImplementation(async () => {
      f.calls.push(`shells.close (database ${host.database.db.open ? "open" : "closed"})`);
    });
    f.automationsSettled.mockImplementation(async () => {
      f.calls.push("automations.settled");
    });
    await host.start(
      f.runner.owner({
        beforeClose: async () => {
          f.calls.push("edge.close");
        },
        drainRequests: async () => {
          f.calls.push("requests.drain");
          return true;
        },
      }),
    );
    f.calls.length = 0;
    await expect(host.stop("shutdown")).resolves.toEqual({ reason: "shutdown", clean: true });
    expect(f.calls).toEqual([
      "host.producers.stop",
      "edge.close",
      // The lifecycle's own producer stop joins the drain it starts.
      "host.producers.stop",
      "transport.close",
      "shells.close (database open)",
      "automations.settled",
      "requests.drain",
    ]);
    expect(host.database.db.open).toBe(false);
  });
});
