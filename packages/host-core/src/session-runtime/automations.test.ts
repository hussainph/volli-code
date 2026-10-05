/** Lifted automation ports; recovery itself is covered in lifecycle.test.ts. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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
import { createRuntimeAutomations, type ReadyAutomationSessions } from "./automations";
import type { RecoveredSessionServices } from "./lifecycle";
import type { PiRuntimeHost } from "./pi-adapter";

vi.mock("../db/projects-repo", () => ({ getProjectById: vi.fn() }));
vi.mock("../prompt-templates", () => ({ loadPromptTemplates: vi.fn() }));
vi.mock("../skills", () => ({ loadSkills: vi.fn() }));
afterEach(() => vi.resetAllMocks());
type Automations = HostCore["automations"];

function fixture(db = true, piRuntime = true) {
  const engine = {};
  const service = {};
  const runner = { recover: vi.fn(async () => {}) };
  const pending = { start: vi.fn(), stop: vi.fn() };
  const scheduler = { start: vi.fn(async () => {}), refresh: vi.fn(async () => {}), stop: vi.fn() };
  const make = {
    createEngine: vi.fn(() => (db ? engine : null)),
    createService: vi.fn((_engine: unknown, _ports: Parameters<Automations["createService"]>[1]) =>
      db ? service : null,
    ),
    createRunner: vi.fn((_ports: Parameters<Automations["createRunner"]>[0]) => runner),
    createPendingArmedRuns: vi.fn((_get: () => unknown) => pending),
    createScheduler: vi.fn((_engine: unknown, _runner: unknown) => scheduler),
  };
  const runtime = {
    command: vi.fn(async (_input: unknown): Promise<unknown> => ({ receipt: null })),
    projection: vi.fn(async (_input: unknown): Promise<unknown> => ({ projection: {} })),
    reportMessageDeliveryFailure: vi.fn(async () => {}),
  };
  const autoTitler = { refine: vi.fn(async () => {}) };
  const services = { sessions: {}, runtime, autoTitler };
  const pi = { inspectModelAccess: vi.fn(async () => ({})) };
  const log = { error: vi.fn() };
  const host = {
    database: db ? { ok: true, db: {} } : { ok: false },
    dataDir: "/data",
    automations: make,
  } as unknown as HostCore;
  const owner = createRuntimeAutomations({
    host,
    piRuntimeHost: piRuntime ? (pi as unknown as PiRuntimeHost) : null,
    homeDir: "/home",
    log,
  });
  // A localized proof fake isolates these port tests from lifecycle boot/drain;
  // the real lifecycle tests pin that raw consumers cannot bypass recovery.
  const ready = (over: Partial<ReadyAutomationSessions> = {}) =>
    ({
      services: { ...services, ...over },
    }) as unknown as RecoveredSessionServices<ReadyAutomationSessions>;
  const deps = () => make.createRunner.mock.calls[0]![0];
  return {
    owner,
    ready,
    deps,
    make,
    engine,
    service,
    services,
    runtime,
    autoTitler,
    pi,
    runner,
    pending,
    scheduler,
    log,
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

describe("runtime automation assembly", () => {
  it("builds CRUD early, arms the same runner later, and keeps the pending runner getter live", async () => {
    const f = fixture();
    expect(f.make.createEngine).toHaveBeenCalledOnce();
    expect(f.owner.service).toBe(f.service);
    expect(f.owner.runner).toBeNull();
    expect(f.owner.pendingArmedRuns).toBeNull();
    const ports = f.make.createService.mock.calls[0]![1];
    await ports.inspectModelAccess!();
    expect(f.pi.inspectModelAccess).toHaveBeenCalledWith({});
    ports.onAutomationsChanged!();
    expect(f.scheduler.refresh).not.toHaveBeenCalled();
    f.owner.start(f.ready());
    expect(f.make.createRunner).toHaveBeenCalledWith(
      expect.objectContaining({ engine: f.engine, sessions: f.services.sessions }),
    );
    expect(f.owner.runner).toBe(f.runner);
    expect(f.owner.pendingArmedRuns).toBe(f.pending);
    expect(f.pending.start).toHaveBeenCalledOnce();
    expect(f.runner.recover).toHaveBeenCalledOnce();
    expect(f.make.createScheduler).toHaveBeenCalledWith(f.engine, f.runner);
    expect(f.scheduler.start).toHaveBeenCalledOnce();
    expect(f.make.createPendingArmedRuns.mock.calls[0]![0]()).toBe(f.runner);
    ports.onAutomationsChanged!();
    expect(f.scheduler.refresh).toHaveBeenCalledOnce();
  });

  it("offers no model-access inspection when no Pi host booted", () => {
    const f = fixture(true, false);
    expect(Object.keys(f.make.createService.mock.calls[0]![1])).toEqual(["onAutomationsChanged"]);
  });

  it("logs a failed recovery or scheduler start instead of surfacing either", async () => {
    const f = fixture();
    f.runner.recover.mockRejectedValueOnce(new Error("ledger locked"));
    f.scheduler.start.mockRejectedValueOnce(new Error("cursor unreadable"));
    f.owner.start(f.ready());
    await vi.waitFor(() => {
      expect(f.log.error).toHaveBeenCalledWith("[volli] automation recovery failed: ledger locked");
      expect(f.log.error).toHaveBeenCalledWith(
        "[volli] automation scheduler could not start: cursor unreadable",
      );
    });
  });

  it("uses stable directories but re-reads the project policy after async supply reads", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    vi.mocked(getProjectById)
      .mockReturnValueOnce(project)
      .mockReturnValueOnce({ ...project, skillModes: { alpha: "off" } });
    vi.mocked(loadPromptTemplates).mockResolvedValue({ ok: true, templates: [] });
    vi.mocked(loadSkills).mockResolvedValue({ ok: true, skills: [skill] });
    expect(await f.deps().promptSupply("p1")).toEqual({ templates: [], skills: [] });
    expect(loadPromptTemplates).toHaveBeenCalledWith({
      projectCommandsDir: "/repo/.volli/commands",
      globalCommandsDir: "/data/commands",
    });
    expect(loadSkills).toHaveBeenCalledWith({
      projectSkillsDir: "/repo/.agents/skills",
      globalSkillsDir: "/home/.agents/skills",
    });
    vi.mocked(getProjectById).mockReturnValueOnce(project).mockReturnValueOnce(undefined);
    await expect(f.deps().promptSupply("p1")).rejects.toThrow("Unknown project");
  });

  it("refuses prompt supply when the project or either disk read cannot be used", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    vi.mocked(getProjectById).mockReturnValue(project);
    vi.mocked(loadPromptTemplates).mockResolvedValue({ ok: true, templates: [] });
    vi.mocked(loadSkills).mockResolvedValue({ ok: true, skills: [] });
    vi.mocked(getProjectById).mockReturnValueOnce(undefined);
    await expect(f.deps().promptSupply("p1")).rejects.toThrow("Unknown project");
    vi.mocked(loadPromptTemplates).mockResolvedValueOnce({
      ok: false,
      error: "templates unreadable",
    });
    await expect(f.deps().promptSupply("p1")).rejects.toThrow("templates unreadable");
    vi.mocked(loadSkills).mockResolvedValueOnce({ ok: false, error: "skills unreadable" });
    await expect(f.deps().promptSupply("p1")).rejects.toThrow("skills unreadable");
  });

  it("applies an empty mode map when the re-read project carries no skill modes", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    vi.mocked(getProjectById)
      .mockReturnValueOnce(project)
      .mockReturnValueOnce({ ...project, skillModes: undefined });
    vi.mocked(loadPromptTemplates).mockResolvedValue({ ok: true, templates: [] });
    vi.mocked(loadSkills).mockResolvedValue({ ok: true, skills: [] });
    await expect(f.deps().promptSupply("p1")).resolves.toEqual({ templates: [], skills: [] });
  });

  it("forwards exact command/message ids, resources and origin, and delivery failures", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    const input: Parameters<ReturnType<typeof f.deps>["deliverInstructions"]>[0] = {
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
    await expect(f.deps().deliverInstructions(input)).resolves.toBe(result);
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
    await f.deps().reportInstructionDeliveryFailure(failure);
    expect(f.runtime.reportMessageDeliveryFailure).toHaveBeenCalledWith(failure);
  });

  it("maps live projection activity and propagates failures rather than treating unknown as idle", async () => {
    const f = fixture();
    f.owner.start(f.ready());
    f.runtime.projection.mockResolvedValueOnce({ projection: working });
    await expect(f.deps().readSessionActivity("s1")).resolves.toBe("working");
    f.runtime.projection.mockRejectedValueOnce(new Error("projection unavailable"));
    await expect(f.deps().readSessionActivity("s1")).rejects.toThrow("projection unavailable");
    expect(f.runtime.reportMessageDeliveryFailure).not.toHaveBeenCalled();
  });

  it("offers title refinement only when the host has a titler", () => {
    const bare = fixture();
    bare.owner.start(bare.ready({ autoTitler: null }));
    expect(bare.deps()).not.toHaveProperty("refineAutoTitle");
    const f = fixture();
    f.owner.start(f.ready());
    const request = { sessionId: "s1", firstMessage: "Ship it", heuristicTitle: "Nightly" };
    f.deps().refineAutoTitle!(request);
    expect(f.autoTitler.refine).toHaveBeenCalledWith(request);
  });

  it("keeps degraded CRUD/pending honest and never schedules without a runner", () => {
    const dbless = fixture(false);
    dbless.owner.start(dbless.ready({ sessions: null, runtime: null }));
    expect(dbless.owner.service).toBeNull();
    expect(dbless.owner.runner).toBeNull();
    expect(dbless.owner.pendingArmedRuns).toBeNull();
    expect(dbless.make.createRunner).not.toHaveBeenCalled();
    expect(dbless.make.createPendingArmedRuns).not.toHaveBeenCalled();
    expect(dbless.make.createScheduler).not.toHaveBeenCalled();
    expect(dbless.runner.recover).not.toHaveBeenCalled();
    const f = fixture();
    f.owner.start(f.ready({ sessions: null, runtime: null }));
    expect(f.owner.runner).toBeNull();
    expect(f.make.createRunner).not.toHaveBeenCalled();
    expect(f.pending.start).toHaveBeenCalledOnce();
    expect(f.make.createPendingArmedRuns.mock.calls[0]![0]()).toBeNull();
    expect(f.make.createScheduler).not.toHaveBeenCalled();
    expect(f.runner.recover).not.toHaveBeenCalled();
  });

  it("starts once, stops both timers and refuses later starts, including a pre-start stop", () => {
    const f = fixture();
    f.owner.start(f.ready());
    f.owner.start(f.ready());
    expect(f.make.createRunner).toHaveBeenCalledOnce();
    expect(f.pending.start).toHaveBeenCalledOnce();
    expect(f.scheduler.start).toHaveBeenCalledOnce();
    expect(f.runner.recover).toHaveBeenCalledOnce();
    f.owner.stop();
    expect(f.pending.stop).toHaveBeenCalledOnce();
    expect(f.scheduler.stop).toHaveBeenCalledOnce();
    f.owner.start(f.ready());
    expect(f.make.createRunner).toHaveBeenCalledOnce();
    const stopped = fixture();
    stopped.owner.stop();
    stopped.owner.start(stopped.ready());
    expect(stopped.make.createRunner).not.toHaveBeenCalled();
    expect(stopped.pending.start).not.toHaveBeenCalled();
    expect(stopped.scheduler.start).not.toHaveBeenCalled();
    expect(stopped.runner.recover).not.toHaveBeenCalled();
  });
});
