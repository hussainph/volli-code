import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { insertProject } from "./db/projects-repo";
import { readSessionUnread, writeSessionUnread } from "./db/session-read-repo";
import { openTestDb, testProject, type TestDb } from "./db/test-helpers";
import type { AttentionDeliveryPort } from "./ports/attention";
import type { HostEventBus, HostEventMap } from "./ports/events";
import {
  createHostSessionServices,
  wireSessionRuntime,
  type SessionRuntimeWiring,
  type HostSessionPorts,
  type HostSessionServices,
} from "./session-services";

let ctx: TestDb;
let services: HostSessionServices;
afterEach(() => {
  services?.sessionActivityWatch?.stop();
  ctx?.cleanup();
});

function ports() {
  return {
    log: { error: vi.fn(), warn: vi.fn() },
    events: { publish: vi.fn<HostEventBus["publish"]>() },
    attention: {
      deliver: vi.fn<AttentionDeliveryPort["deliver"]>(() => ({ delivered: true })),
      focusedSessionIds: vi.fn(() => new Set<string>()),
    },
  } satisfies HostSessionPorts;
}

/** What host-core's runtime assembly and lifecycle wire in once they exist. */
function runtimeWiring() {
  return {
    openNativeBindings: vi.fn(() => [{ attachmentId: "live-binding", sessionId: "live-session" }]),
    observeScheduledResume: vi.fn<SessionRuntimeWiring["observeScheduledResume"]>(),
    pendingTurnStarts: vi.fn((): ReadonlySet<string> => new Set<string>()),
    holdTurnStarts: vi.fn(),
    releaseTurnStarts: vi.fn(),
  } satisfies SessionRuntimeWiring;
}

/** The `session-activity` notices published so far, in order. */
function activity(sinks: ReturnType<typeof ports>) {
  return sinks.events.publish.mock.calls.flatMap(([topic, payload]) =>
    topic === "session-activity" ? [payload as HostEventMap["session-activity"]] : [],
  );
}

async function seeded() {
  ctx = openTestDb();
  const project = testProject({ id: "project" });
  insertProject(ctx.db, project);
  const sinks = ports();
  services = createHostSessionServices(ctx.db, sinks);
  const engine = services.sessionEngine!;
  const runtime = runtimeWiring();
  wireSessionRuntime(engine, runtime);
  const order: string[] = [];
  services.sessionWakeBus!.subscribe(() => order.push("wake"));
  runtime.observeScheduledResume.mockImplementation(() => {
    order.push("observe");
  });
  sinks.events.publish.mockImplementation((topic) => {
    if (topic === "session-activity") order.push("publish");
  });
  const created = await engine.createSession({
    commandId: "create-1",
    projectId: project.id,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: "Plan the move",
    provenance: {
      source: { kind: "system", id: "test", detail: null },
      venue: { id: "local", kind: "local" },
    },
  });
  return { engine, sinks, runtime, order, sessionId: created.session.id };
}

describe("host Session composition", () => {
  it("announces committed facts before folding and publishing, with one transaction writer", async () => {
    const { engine, sinks, runtime, order, sessionId } = await seeded();
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((entry) => entry === "wake")).toBe(true);
    await services.sessionActivityWatch!.flush();
    expect(order.slice(-2)).toEqual(["observe", "publish"]);
    expect(runtime.observeScheduledResume).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ id: sessionId }) }),
    );
    expect(sinks.events.publish).toHaveBeenCalledWith(
      "session-activity",
      expect.objectContaining({
        projectId: "project",
        row: expect.objectContaining({
          kind: "chat",
          record: expect.objectContaining({ sessionId }),
        }),
      }),
    );
    const transaction = vi.spyOn(services.sessionLedger!, "transaction");
    await services.hostNoticeOutbox!.pending();
    await engine.getSession({ sessionId });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("marks unattended turn edges unread and republishes only when focus clears unread work", async () => {
    const { engine, sinks, runtime, sessionId } = await seeded();
    await services.sessionActivityWatch!.flush();
    const projection = (await engine.getSession({ sessionId }))!;
    services.sessionReadWatch!.observe({
      ...projection,
      lastTurnOutcome: "completed",
      lastActivityAt: 4000,
    });
    expect(readSessionUnread(ctx.db, sessionId)).toEqual({ unreadSince: 4000 });
    expect(sinks.attention.focusedSessionIds).toHaveBeenCalled();

    sinks.events.publish.mockClear();
    services.sessionReadWatch!.observeFocused(new Set([sessionId]));
    await vi.waitFor(() => expect(activity(sinks)).toHaveLength(1));
    expect(activity(sinks)[0]?.row.read).toBeUndefined();
    expect(readSessionUnread(ctx.db, sessionId)).toEqual({ unreadSince: null });
    expect(runtime.openNativeBindings).toHaveBeenCalled();
    services.sessionReadWatch!.observeFocused(new Set([sessionId]));
    expect(activity(sinks)).toHaveLength(1);

    writeSessionUnread(ctx.db, sessionId, 5000);
    const failure = new Error("read unavailable");
    vi.spyOn(engine, "getSession").mockRejectedValue(failure);
    services.sessionReadWatch!.observeFocused(new Set([sessionId]));
    await vi.waitFor(() =>
      expect(sinks.log.warn).toHaveBeenCalledWith("could not publish the session's read row", {
        sessionId,
        error: failure,
      }),
    );
  });

  it("reads live turns from the same fold, intersected with open bindings (VC-577)", async () => {
    const { engine, runtime, sessionId } = await seeded();
    const observed = vi.spyOn(services.liveWork, "observeSession");
    await services.sessionActivityWatch.flush();
    expect(observed).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ id: sessionId }) }),
    );
    const projection = (await engine.getSession({ sessionId }))!;
    expect(services.liveWork.current()).toEqual({ turns: 0, shells: 0 });
    services.liveWork.observeSession({ ...projection, turnActive: true });
    // Folded open, but this Session holds no binding: not a live turn.
    expect(services.liveWork.current()).toEqual({ turns: 0, shells: 0 });
    runtime.openNativeBindings.mockReturnValue([{ attachmentId: "bound", sessionId }]);
    expect(services.liveWork.current()).toEqual({ turns: 1, shells: 0 });
    services.liveWork.observeSession({ ...projection, turnActive: false });
    expect(services.liveWork.current()).toEqual({ turns: 0, shells: 0 });
  });

  it("counts a committed turn start the moment its write resolves, before any fold (VC-577)", async () => {
    const { engine, runtime, sessionId } = await seeded();
    runtime.openNativeBindings.mockReturnValue([{ attachmentId: "binding", sessionId }]);
    const provenance = {
      source: { kind: "system" as const, id: "test", detail: null },
      venue: { id: "local", kind: "local" as const },
    };
    await engine.observe({
      id: "attach",
      sessionId,
      occurredAt: 1,
      provenance,
      kind: "attachment.opened",
      attachment: {
        id: "binding",
        sessionId,
        adapterId: "pi",
        venue: provenance.venue,
        continuity: "fresh",
        native: null,
        authority: null,
      },
    });
    await services.sessionActivityWatch.flush();
    expect(services.liveWork.current()).toEqual({ turns: 0, shells: 0 });
    const heard = vi.fn();
    services.liveWork.subscribe(heard);
    await engine.observe({
      id: "start",
      sessionId,
      occurredAt: 2,
      provenance,
      kind: "turn.started",
      attachmentId: "binding",
      turnId: "turn",
    });
    // No flush: the coalesced fold has not run, the count already has it.
    expect(services.liveWork.current()).toEqual({ turns: 1, shells: 0 });
    expect(heard).toHaveBeenCalledWith({ turns: 1, shells: 0 });
    // A fold of the older idle projection cannot overwrite the newer write.
    const projection = (await engine.getSession({ sessionId }))!;
    services.liveWork.observeSession({ ...projection, turnActive: false });
    expect(services.liveWork.current()).toEqual({ turns: 1, shells: 0 });
    await engine.observe({
      id: "end",
      sessionId,
      occurredAt: 3,
      provenance,
      kind: "turn.completed",
      attachmentId: "binding",
      turnId: "turn",
    });
    expect(services.liveWork.current()).toEqual({ turns: 0, shells: 0 });
  });

  it("counts the runtime's accepted starts and takes its start latch for an idle exit (VC-577)", async () => {
    const { runtime } = await seeded();
    runtime.pendingTurnStarts.mockReturnValue(new Set(["starting"]));
    expect(services.liveWork.current()).toEqual({ turns: 1, shells: 0 });
    expect(services.liveWork.tryBeginIdleExit()).toBe(false);
    expect(runtime.holdTurnStarts).not.toHaveBeenCalled();
    runtime.pendingTurnStarts.mockReturnValue(new Set());
    expect(services.liveWork.tryBeginIdleExit()).toBe(true);
    expect(runtime.holdTurnStarts).toHaveBeenCalledOnce();
    services.liveWork.abandonIdleExit();
    expect(runtime.releaseTurnStarts).toHaveBeenCalledOnce();
  });

  it("reports a live-work listener failure through the host log", async () => {
    const { sinks } = await seeded();
    const failure = new Error("listener");
    services.liveWork.subscribe(() => {
      throw failure;
    });
    services.liveWork.observeShell({ shellId: "shell", state: "running" });
    expect(sinks.log.warn).toHaveBeenCalledWith("live work listener failed", { error: failure });
  });

  it("folds with nothing open and nothing scheduled until the runtime wires each in", async () => {
    ctx = openTestDb();
    const project = testProject({ id: "project" });
    insertProject(ctx.db, project);
    const sinks = ports();
    services = createHostSessionServices(ctx.db, sinks);
    const engine = services.sessionEngine;
    const create = (commandId: string) =>
      engine.createSession({
        commandId,
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: commandId,
        provenance: {
          source: { kind: "system", id: "test", detail: null },
          venue: { id: "local", kind: "local" },
        },
      });
    const first = await create("before-the-runtime");
    await services.sessionActivityWatch.flush();
    // No runtime yet: nothing is starting, and the latch has nothing to hold.
    expect(services.liveWork.current()).toEqual({ turns: 0, shells: 0 });
    expect(services.liveWork.tryBeginIdleExit()).toBe(true);
    services.liveWork.abandonIdleExit();
    expect(activity(sinks).at(-1)?.row).toEqual(
      expect.objectContaining({ record: expect.objectContaining({ sessionId: first.session.id }) }),
    );

    // An engine the host did not compose has no services to report into.
    const stranger = runtimeWiring();
    wireSessionRuntime({ ...engine }, stranger);
    const late = runtimeWiring();
    wireSessionRuntime(engine, { openNativeBindings: late.openNativeBindings });
    wireSessionRuntime(engine, { observeScheduledResume: late.observeScheduledResume });
    wireSessionRuntime(engine, { pendingTurnStarts: late.pendingTurnStarts });
    wireSessionRuntime(engine, { holdTurnStarts: late.holdTurnStarts });
    wireSessionRuntime(engine, { releaseTurnStarts: late.releaseTurnStarts });
    expect(services.liveWork.tryBeginIdleExit()).toBe(true);
    services.liveWork.abandonIdleExit();
    expect(late.pendingTurnStarts).toHaveBeenCalled();
    expect(late.holdTurnStarts).toHaveBeenCalledOnce();
    expect(late.releaseTurnStarts).toHaveBeenCalledOnce();
    const second = await create("after-the-runtime");
    await services.sessionActivityWatch.flush();
    expect(late.openNativeBindings).toHaveBeenCalled();
    expect(late.observeScheduledResume).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ id: second.session.id }) }),
    );
    expect(stranger.openNativeBindings).not.toHaveBeenCalled();
    expect(stranger.observeScheduledResume).not.toHaveBeenCalled();
  });
});
