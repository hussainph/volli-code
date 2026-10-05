/** The runtime's Automations edge; the live module's own wiring is covered in automation-services.test.ts. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostedSessionRuntime } from "@volli/session-engine";
import {
  skillResourcePart,
  type Project,
  type SessionProjection,
  type SkillReference,
} from "@volli/shared";
import type { HostCore } from "../index";
import { getProjectById } from "../db/projects-repo";
import { loadPromptTemplates } from "../prompt-templates";
import { loadSkills } from "../skills";
import {
  createHostAutomations,
  type AutomationSessionPorts,
  type HostAutomations,
} from "../automation-services";
import { createRuntimeAutomations, type ReadyAutomationSessions } from "./automations";
import {
  createSessionRuntimeLifecycle,
  mapRecoveredSessionServices,
  type RecoveredSessionServices,
} from "./lifecycle";
import type { PiRuntimeHost } from "./pi-adapter";

vi.mock("../db/projects-repo", () => ({ getProjectById: vi.fn() }));
vi.mock("../prompt-templates", () => ({ loadPromptTemplates: vi.fn() }));
vi.mock("../skills", () => ({ loadSkills: vi.fn() }));
vi.mock("../automation-services", () => ({ createHostAutomations: vi.fn() }));

let lifecycle: ReturnType<typeof createSessionRuntimeLifecycle<null>>;
let recovered: RecoveredSessionServices<null>;
beforeEach(async () => {
  lifecycle = createSessionRuntimeLifecycle({
    host: {
      database: { ok: false },
      sessionEngine: null,
      hostNoticeOutbox: null,
      sessionWakeBus: null,
      maintenance: { shutdownNativeSessions: async () => {} },
    } as unknown as HostCore,
    ports: { power: { removeListener() {} }, log: { error() {} } } as unknown as Parameters<
      typeof createSessionRuntimeLifecycle
    >[0]["ports"],
    runtime: null,
    rpc: () => null,
    observability: null,
    delegation: null,
    delegationsFor: () => null,
    services: () => null,
    installQuitHold() {},
    stopProducers() {},
  });
  recovered = await lifecycle.ready();
});
afterEach(async () => {
  await lifecycle.close();
  vi.resetAllMocks();
});

const db = { name: "live" };
const moduleInput = () => vi.mocked(createHostAutomations).mock.calls[0]![0];

function fixture(options: { db?: boolean; piRuntime?: boolean } = {}) {
  const live = options.db ?? true;
  const service = { kind: "service" };
  const runner = { kind: "runner" };
  const pending = { kind: "pending" };
  let armed = false;
  let sessionPorts: AutomationSessionPorts | null | undefined;
  const module = {
    service,
    get execution() {
      return armed ? { kind: "ready", runner, pendingArmedRuns: pending } : { kind: "idle" };
    },
    // The module's own guard is covered beside it; this one reads every call.
    start: vi.fn((read: () => AutomationSessionPorts | null) => {
      sessionPorts = read();
      armed = true;
    }),
    stop: vi.fn(),
    settled: vi.fn(async () => {}),
  };
  vi.mocked(createHostAutomations).mockReturnValue(module as unknown as HostAutomations);
  const runtime = {
    command: vi.fn(async (_input: unknown): Promise<unknown> => ({ receipt: null })),
    projection: vi.fn(async (_input: unknown): Promise<unknown> => ({ projection: {} })),
    reportMessageDeliveryFailure: vi.fn(async () => {}),
  };
  const autoTitler = { refine: vi.fn(async () => {}) };
  const services = { sessions: { kind: "sessions" }, runtime, autoTitler };
  const pi = { inspectModelAccess: vi.fn(async () => ({})) };
  const log = { error: vi.fn() };
  const events = { publish: vi.fn() };
  const owner = createRuntimeAutomations({
    host: {
      database: live ? { ok: true, db: db as never } : { ok: false, error: "no database" },
      dataDir: "/data",
    },
    events,
    piRuntimeHost: (options.piRuntime ?? true) ? (pi as unknown as PiRuntimeHost) : null,
    homeDir: "/home",
    log,
  });
  // Real issued/revocable proof, with a port-only view over the degraded owner.
  const ready = (over: Partial<ReadyAutomationSessions> = {}) =>
    mapRecoveredSessionServices(
      recovered,
      () => ({ ...services, ...over }) as unknown as ReadyAutomationSessions,
    );
  const ports = () => {
    if (sessionPorts == null) throw new Error("The module was not armed with Session ports.");
    return sessionPorts;
  };
  return {
    owner,
    ready,
    ports,
    sessionPorts: () => sessionPorts,
    module,
    service,
    runner,
    pending,
    services,
    runtime,
    autoTitler,
    pi,
    log,
    events,
  };
}

const project = {
  id: "p1",
  name: "P",
  path: "/repo",
  ticketPrefix: "P",
  skillModes: {},
} as Project;
const skill: SkillReference = {
  name: "alpha",
  description: "",
  body: "body",
  root: ".agents/skills/alpha",
  authorPolicy: { modelDiscoverable: true, userInvokable: true },
  effectivePolicy: { modelDiscoverable: true, userInvokable: true },
  policyDiagnostic: null,
};
const working = {
  session: { id: "s1", title: null, projectId: "p1", ticketId: null, createdAt: 0 },
  attachments: [{ adapterId: "pi", status: "open" }],
  latestTurnOrigin: null,
  resumedAfterStop: false,
  stopped: null,
  interactions: { active: [] },
  attention: { active: [] },
  turnActive: true,
  lastTurnOutcome: null,
  lastTurnStopDetail: null,
  lastActivityAt: 0,
} as unknown as SessionProjection;

describe("live runtime automations", () => {
  it("composes the one live module over the open database, the host's events and log", () => {
    const f = fixture();
    expect(createHostAutomations).toHaveBeenCalledOnce();
    expect(moduleInput()).toMatchObject({ db, events: f.events, log: f.log });
    expect(f.owner.kind).toBe("live");
    if (f.owner.kind !== "live") throw new Error("Expected live Automations.");
    expect(f.owner.service).toBe(f.service);
    expect(f.owner.execution).toEqual({ kind: "idle" });
    expect(f.module.start).not.toHaveBeenCalled();
  });

  it("offers model-access inspection only when a Pi host booted", async () => {
    const f = fixture();
    await moduleInput().inspectModelAccess!();
    expect(f.pi.inspectModelAccess).toHaveBeenCalledWith({});
    vi.mocked(createHostAutomations).mockClear();
    fixture({ piRuntime: false });
    expect(moduleInput()).not.toHaveProperty("inspectModelAccess");
  });

  it("rejects forged, copied and revoked recovery proofs before arming a runner", async () => {
    const f = fixture();
    const ready = f.ready();
    expect(() => f.owner.start({ services: ready.services } as typeof ready)).toThrow(
      "no recovery proof",
    );
    expect(() => f.owner.start({ ...ready })).toThrow("no recovery proof");
    await lifecycle.close();
    expect(() => f.owner.start(ready)).toThrow("closing");
    expect(f.sessionPorts()).toBeUndefined();
    expect(f.owner.kind === "live" && f.owner.execution.kind).toBe("idle");
  });

  it("arms the module with the recovered Session side and keeps its getters live", () => {
    const f = fixture();
    f.owner.start(f.ready());
    expect(f.module.start).toHaveBeenCalledOnce();
    expect(f.ports().sessions).toBe(f.services.sessions);
    expect(f.owner.kind === "live" && f.owner.execution).toEqual({
      kind: "ready",
      runner: f.runner,
      pendingArmedRuns: f.pending,
    });
    f.owner.stop();
    expect(f.module.stop).toHaveBeenCalledOnce();
  });

  it("arms pending Runs alone when the Session runtime or its facade is missing", () => {
    const noSessions = fixture();
    noSessions.owner.start(noSessions.ready({ sessions: null }));
    expect(noSessions.sessionPorts()).toBeNull();
    vi.mocked(createHostAutomations).mockClear();
    const noRuntime = fixture();
    noRuntime.owner.start(noRuntime.ready({ runtime: null }));
    expect(noRuntime.sessionPorts()).toBeNull();
  });

  it("uses stable directories but re-reads the project policy after async supply reads", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    vi.mocked(getProjectById)
      .mockReturnValueOnce(project)
      .mockReturnValueOnce({ ...project, skillModes: { alpha: "off" } });
    vi.mocked(loadPromptTemplates).mockResolvedValue({ ok: true, templates: [] });
    vi.mocked(loadSkills).mockResolvedValue({ ok: true, skills: [skill] });
    expect(await f.ports().promptSupply("p1")).toEqual({ templates: [], skills: [] });
    expect(getProjectById).toHaveBeenCalledWith(db, "p1");
    expect(loadPromptTemplates).toHaveBeenCalledWith({
      projectCommandsDir: "/repo/.volli/commands",
      globalCommandsDir: "/data/commands",
    });
    expect(loadSkills).toHaveBeenCalledWith({
      projectSkillsDir: "/repo/.agents/skills",
      globalSkillsDir: "/home/.agents/skills",
    });
    vi.mocked(getProjectById).mockReturnValueOnce(project).mockReturnValueOnce(undefined);
    await expect(f.ports().promptSupply("p1")).rejects.toThrow("Unknown project");
  });

  it("refuses prompt supply when the project or either disk read cannot be used", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    vi.mocked(getProjectById).mockReturnValue(project);
    vi.mocked(loadPromptTemplates).mockResolvedValue({ ok: true, templates: [] });
    vi.mocked(loadSkills).mockResolvedValue({ ok: true, skills: [] });
    vi.mocked(getProjectById).mockReturnValueOnce(undefined);
    await expect(f.ports().promptSupply("p1")).rejects.toThrow("Unknown project");
    vi.mocked(loadPromptTemplates).mockResolvedValueOnce({
      ok: false,
      error: "templates unreadable",
    });
    await expect(f.ports().promptSupply("p1")).rejects.toThrow("templates unreadable");
    vi.mocked(loadSkills).mockResolvedValueOnce({ ok: false, error: "skills unreadable" });
    await expect(f.ports().promptSupply("p1")).rejects.toThrow("skills unreadable");
  });

  it("applies an empty mode map when the re-read project carries no skill modes", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    vi.mocked(getProjectById)
      .mockReturnValueOnce(project)
      .mockReturnValueOnce({ ...project, skillModes: undefined });
    vi.mocked(loadPromptTemplates).mockResolvedValue({ ok: true, templates: [] });
    vi.mocked(loadSkills).mockResolvedValue({ ok: true, skills: [] });
    await expect(f.ports().promptSupply("p1")).resolves.toEqual({ templates: [], skills: [] });
  });

  it("forwards exact command/message ids, resources and origin, and delivery failures", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    const input: Parameters<AutomationSessionPorts["deliverInstructions"]>[0] = {
      sessionId: "s1",
      commandId: "command-1",
      messageId: "message-1",
      text: "Do the thing",
      resources: [
        { name: "alpha", text: "body" },
        { name: "beta", text: "body" },
      ],
      origin: { kind: "automation", automationRunId: "run1", automationName: "Nightly" },
    };
    const result = { receipt: { status: "accepted" } };
    f.runtime.command.mockResolvedValue(result);
    await expect(f.ports().deliverInstructions(input)).resolves.toBe(result);
    expect(f.runtime.command).toHaveBeenCalledExactlyOnceWith({
      sessionId: input.sessionId,
      commandId: input.commandId,
      origin: input.origin,
      command: {
        kind: "message.submit",
        message: {
          id: input.messageId,
          role: "user",
          parts: [{ type: "text", text: input.text }, ...input.resources.map(skillResourcePart)],
        },
      },
    });
    const failure = {} as Parameters<HostedSessionRuntime["reportMessageDeliveryFailure"]>[0];
    await f.ports().reportInstructionDeliveryFailure(failure);
    expect(f.runtime.reportMessageDeliveryFailure).toHaveBeenCalledWith(failure);
  });

  it("maps live projection activity and propagates failures rather than treating unknown as idle", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    f.runtime.projection.mockResolvedValueOnce({ projection: working });
    await expect(f.ports().readSessionActivity("s1")).resolves.toBe("working");
    f.runtime.projection.mockRejectedValueOnce(new Error("projection unavailable"));
    await expect(f.ports().readSessionActivity("s1")).rejects.toThrow("projection unavailable");
    expect(f.runtime.reportMessageDeliveryFailure).not.toHaveBeenCalled();
  });

  it("offers title refinement only when the host has a titler", () => {
    const bare = fixture();
    bare.owner.start(bare.ready({ autoTitler: null }));
    expect(bare.ports()).not.toHaveProperty("refineAutoTitle");
    vi.mocked(createHostAutomations).mockClear();
    const f = fixture();
    f.owner.start(f.ready());
    const request = { sessionId: "s1", firstMessage: "Ship it", heuristicTitle: "Nightly" };
    f.ports().refineAutoTitle!(request);
    expect(f.autoTitler.refine).toHaveBeenCalledWith(request);
  });
});

it("joins the live Automation module before the host closes its database", async () => {
  const f = fixture();
  const settled = Promise.withResolvers<void>();
  f.module.settled.mockReturnValueOnce(settled.promise);
  const drain = f.owner.settled();
  expect(f.module.settled).toHaveBeenCalledOnce();
  settled.resolve();
  await drain;
});

describe("degraded runtime automations", () => {
  it("composes no module and offers no service, runner or pending Runs", () => {
    const f = fixture({ db: false });
    expect(createHostAutomations).not.toHaveBeenCalled();
    f.owner.start(f.ready({ sessions: null, runtime: null }));
    expect(f.owner.kind).toBe("degraded");
    expect(Object.keys(f.owner).toSorted()).toEqual(["kind", "settled", "start", "stop"]);
  });

  it("still refuses a forged proof, then settles once like the live owner", async () => {
    const f = fixture({ db: false });
    const ready = f.ready();
    expect(() => f.owner.start({ ...ready })).toThrow("no recovery proof");
    f.owner.start(ready);
    await lifecycle.close();
    // Settled: a revoked proof is no longer read.
    expect(() => f.owner.start(ready)).not.toThrow();
  });

  it("refuses every start after a stop, even one with a revoked proof", async () => {
    const f = fixture({ db: false });
    const ready = f.ready();
    f.owner.stop();
    await f.owner.settled();
    await lifecycle.close();
    expect(() => f.owner.start(ready)).not.toThrow();
  });
});
