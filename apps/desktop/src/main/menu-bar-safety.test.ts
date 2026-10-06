/**
 * The VC-577 review's safety probes, made permanent — plus the cases the
 * final round added. Every test here drives the REAL host composition
 * (`createHostSessionServices` over a temporary SQLite database, the real
 * decorated Session Engine, a real Session runtime over a scripted executor)
 * into the REAL menu-bar controller and quit path. No Electron, no profile.
 *
 * B1: the quit verdict reads an authoritative, synchronous count — committed
 * turn facts, running shells, and work accepted but not yet started — and an
 * idle exit takes the runtime's start latch in the same call.
 * B3: a noted system shutdown is never refused by an interactive confirm.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { UIMessage } from "ai";
import type { RuntimeObservation } from "@volli/shared";
import {
  createInMemorySessionFollowUpLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionRuntime,
  SessionRuntimeExitingError,
  type BindingHandle,
  type HarnessCommand,
  type NativeHarnessAdapter,
  type ObservationSink,
} from "@volli/session-engine";

import { insertProject } from "../../../../packages/host-core/src/db/projects-repo";
import { openTestDb, testProject } from "../../../../packages/host-core/src/db/test-helpers";
import {
  createHostSessionServices,
  wireSessionRuntime,
} from "../../../../packages/host-core/src/session-services";
import { prepareDesktopQuit } from "./host-runtime";
import { createMenuBarHost, trayModel, type MenuBarHostPorts } from "./menu-bar-host";
import { refuseQuit, registerAcceptedQuitCoordinator } from "./quit-gate";
import { readUpdateLiveWork } from "./update-ipc";

const resources: Array<() => void> = [];
afterEach(() => {
  for (const clean of resources.splice(0)) clean();
  vi.useRealTimers();
});

function controller(liveWork: MenuBarHostPorts["liveWork"], quit = vi.fn()) {
  return createMenuBarHost({
    liveWork,
    browserTabs: { sessionTabCount: () => 0, closeForMenuBar: vi.fn(), reopen: vi.fn() },
    confirmCloseAgentTabs: () => "close",
    windows: { count: () => 0, closeAll: vi.fn(), open: vi.fn() },
    dock: { hide: vi.fn(), show: vi.fn() },
    tray: { show: vi.fn(), update: vi.fn(), destroy: vi.fn() },
    power: { hold: vi.fn(), release: vi.fn() },
    update: { ready: () => false, installInFlight: () => false, install: () => false },
    confirmQuit: () => "quit",
    quit,
    focusApp: vi.fn(),
    log: vi.fn(),
  });
}

function fixedWork(turns: number): MenuBarHostPorts["liveWork"] {
  return {
    current: () => ({ turns, shells: 0 }),
    subscribe: () => () => {},
    tryBeginIdleExit: () => turns === 0,
    abandonIdleExit: () => {},
  };
}

function services() {
  const ctx = openTestDb();
  resources.push(() => ctx.cleanup());
  insertProject(ctx.db, testProject({ id: "project" }));
  const host = createHostSessionServices(ctx.db, {
    log: { warn: vi.fn(), error: vi.fn() },
    events: { publish: vi.fn() },
    attention: { deliver: () => ({ delivered: true }), focusedSessionIds: () => new Set() },
  });
  resources.push(() => host.sessionActivityWatch.stop());
  return host;
}

const message = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
});

/** A scripted executor: a submit opens its turn, and the test ends it. */
class ScriptedExecutor implements NativeHarnessAdapter {
  id = "scripted";
  durableIdNamespace = "scripted";
  adapterVersion = "1";
  runtime = { path: "/scripted", version: "1", fingerprint: "scripted" };
  sink!: ObservationSink;
  commands: HarnessCommand[] = [];
  async attach(
    _spec: Parameters<NativeHarnessAdapter["attach"]>[0],
    sink: ObservationSink,
  ): Promise<BindingHandle> {
    this.sink = sink;
    return {
      native: { id: "native", detail: null },
      dispatch: async (command) => {
        this.commands.push(command);
        if (command.kind === "message.submit") {
          await this.emit({
            kind: "turn",
            state: "started",
            turnId: `turn:${command.commandId}`,
            occurredAt: 200,
          });
        }
        return { commandId: command.commandId, status: "accepted", acceptedAt: 201, native: null };
      },
      reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
      release: async () => undefined,
    };
  }
  emit(observation: RuntimeObservation) {
    return this.sink.emit(observation);
  }
  complete(commandId: string) {
    return this.emit({
      kind: "turn",
      state: "completed",
      turnId: `turn:${commandId}`,
      occurredAt: 300,
    });
  }
}

/** The real host Session services with a real runtime wired in, as host-core's assembly does. */
async function hostWithRuntime() {
  const host = services();
  const executor = new ScriptedExecutor();
  let locate: Promise<void> | undefined;
  let sequence = 0;
  const runtime = createSessionRuntime({
    engine: host.sessionEngine,
    artifacts: createInMemoryTranscriptArtifactStore(),
    followUps: createInMemorySessionFollowUpLedger(),
    executor,
    clock: { now: () => 1_000 + ++sequence },
    ids: { next: (kind) => `${kind}-${++sequence}` },
    locations: {
      resolve: async () => {
        await locate;
        return { directory: "/scripted", venue: { id: "local", kind: "local" } };
      },
      prepare: async () => ({ directory: "/scripted", venue: { id: "local", kind: "local" } }),
      reaffirm: async () => undefined,
    },
  });
  resources.push(() => void runtime.close());
  wireSessionRuntime(host.sessionEngine, {
    openNativeBindings: () => runtime.openNativeBindings(),
    pendingTurnStarts: () => runtime.pendingTurnStarts(),
    holdTurnStarts: () => runtime.holdTurnStarts(),
    releaseTurnStarts: () => runtime.releaseTurnStarts(),
  });
  const sessionId = (
    await runtime.command({
      commandId: "create",
      command: {
        kind: "session.create",
        projectId: "project",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "menu-bar safety",
      },
    })
  ).sessionId;
  await runtime.command({
    commandId: "attach",
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  await runtime.recoverFollowUps();
  await host.sessionActivityWatch.flush();
  return {
    host,
    runtime,
    executor,
    sessionId,
    holdLocate: () => {
      const gate = Promise.withResolvers<void>();
      locate = gate.promise;
      return () => {
        locate = undefined;
        gate.resolve();
      };
    },
  };
}

describe("VC-577 menu-bar safety, through the real host", () => {
  it("a durably started bound turn prevents exit before the activity coalescer flushes", async () => {
    const composed = services();
    const engine = composed.sessionEngine;
    const provenance = {
      source: { kind: "system" as const, id: "review", detail: null },
      venue: { id: "local", kind: "local" as const },
    };
    const born = await engine.createSession({
      commandId: "birth",
      projectId: "project",
      ticketId: null,
      parentSessionId: null,
      role: "project",
      title: "probe",
      provenance,
    });
    const sessionId = born.session.id;
    wireSessionRuntime(engine, {
      openNativeBindings: () => [{ sessionId, attachmentId: "binding" }],
    });
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
    await composed.sessionActivityWatch.flush();
    await engine.observe({
      id: "start",
      sessionId,
      occurredAt: 2,
      provenance,
      kind: "turn.started",
      attachmentId: "binding",
      turnId: "turn",
    });
    expect((await engine.getSession({ sessionId }))?.turnActive).toBe(true);
    // Production's actual host projection, not a mocked controller verdict.
    const host = controller(composed.liveWork);
    expect(host.branch()).toBe("menu-bar");
  });

  it("a turn admitted but not yet started blocks exit, and a finished one releases it", async () => {
    const h = await hostWithRuntime();
    const quitBar = controller(h.host.liveWork);
    expect(h.host.liveWork.current()).toEqual({ turns: 0, shells: 0 });
    const release = h.holdLocate();
    const submitting = h.runtime.command({
      commandId: "work",
      sessionId: h.sessionId,
      command: { kind: "message.submit", message: message("work") },
    });
    // Accepted, held before dispatch: no `turn.started` exists anywhere yet.
    expect((await h.host.sessionEngine.getSession({ sessionId: h.sessionId }))?.turnActive).toBe(
      false,
    );
    expect(h.host.liveWork.current()).toEqual({ turns: 1, shells: 0 });
    expect(quitBar.branch()).toBe("menu-bar");
    expect(h.host.liveWork.exiting()).toBe(false);
    release();
    await submitting;
    // Now its turn is the live work, counted from the committed fact.
    expect(h.runtime.pendingTurnStarts()).toEqual(new Set());
    expect(h.host.liveWork.current()).toEqual({ turns: 1, shells: 0 });
    expect(quitBar.branch()).toBe("menu-bar");
    await h.executor.complete("work");
    await h.runtime.recoverFollowUps();
    expect(h.host.liveWork.current()).toEqual({ turns: 0, shells: 0 });
    expect(quitBar.branch()).toBe("quit");
    expect(h.host.liveWork.exiting()).toBe(true);
  });

  it("a start racing the idle-exit latch is refused before any effect, and a queued row stays queued", async () => {
    const h = await hostWithRuntime();
    const quitBar = controller(h.host.liveWork);
    // ⌘Q over an idle host: the verdict and the latch are one call.
    expect(quitBar.branch()).toBe("quit");
    const before = (await h.host.sessionEngine.getSession({ sessionId: h.sessionId }))!.commands
      .length;
    await expect(
      h.runtime.command({
        commandId: "late",
        sessionId: h.sessionId,
        command: { kind: "message.submit", message: message("late") },
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeExitingError);
    expect(
      (await h.host.sessionEngine.getSession({ sessionId: h.sessionId }))!.commands,
    ).toHaveLength(before);
    expect(h.executor.commands).toEqual([]);
    // A follow-up is durable storage: accepted, and held for the next launch.
    await h.runtime.command({
      commandId: "kept",
      sessionId: h.sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("kept") },
    });
    await h.runtime.recoverFollowUps();
    const { projection } = await h.runtime.projection({ sessionId: h.sessionId });
    expect(projection.queue?.map(({ id, state }) => `${id}:${state}`)).toEqual(["kept:queued"]);
    expect(h.executor.commands).toEqual([]);
    expect(h.host.liveWork.current()).toEqual({ turns: 0, shells: 0 });
  });

  it("the Tray, the update dialog and the quit verdict read one count and agree", async () => {
    const h = await hostWithRuntime();
    const quitBar = controller(h.host.liveWork);
    const dialog = () =>
      readUpdateLiveWork({
        busyCommands: () => [],
        // Never asked: the host's read answers both counts with the flag on.
        openAgentTurns: () => Promise.reject(new Error("not today's count")),
        unsavedDrafts: () => [],
        liveWork: () => h.host.liveWork.current(),
      });
    async function agree(turns: number, shells: number) {
      const work = h.host.liveWork.current();
      expect(work).toEqual({ turns, shells });
      expect(trayModel(work, "none").title).toBe(
        turns + shells === 0 ? "Volli" : `Volli ${turns + shells}`,
      );
      await expect(dialog()).resolves.toMatchObject({
        openAgentSessions: turns,
        backgroundShells: shells,
      });
    }
    await agree(0, 0);
    // Accepted, not started.
    const release = h.holdLocate();
    const submitting = h.runtime.command({
      commandId: "work",
      sessionId: h.sessionId,
      command: { kind: "message.submit", message: message("work") },
    });
    await agree(1, 0);
    expect(quitBar.branch()).toBe("menu-bar");
    release();
    await submitting;
    // Started, plus a background shell it launched.
    h.host.liveWork.observeShell({ shellId: "dev-server", state: "running" });
    await agree(1, 1);
    expect(quitBar.branch()).toBe("menu-bar");
    await h.executor.complete("work");
    await h.runtime.recoverFollowUps();
    await agree(0, 1);
    expect(quitBar.branch()).toBe("menu-bar");
    h.host.liveWork.forgetShell("dev-server");
    await agree(0, 0);
    expect(quitBar.branch()).toBe("quit");
  });

  it("a system shutdown is not refused by a pre-decision draft gate", async () => {
    const host = controller(fixedWork(1));
    host.noteSystemShutdown();
    let listener!: (event: { preventDefault(): void }) => void;
    const stop = vi.fn(async () => {});
    const teardown = vi.fn();
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on: (_, callback) => {
          listener = callback;
        },
        exit: vi.fn(),
      },
      shutdownNativeSessions: stop,
      shutdownAgentSocket: async () => {},
      reportFailure: vi.fn(),
      prepareQuit: (event) =>
        prepareDesktopQuit(event, {
          stopAutomations: vi.fn(),
          unsavedQuit: (attempt) => refuseQuit(attempt),
          terminalQuit: (attempt) => refuseQuit(attempt),
          abortRepack: vi.fn(),
          menuBar: host,
          systemShutdownTeardown: teardown,
        }),
    });
    listener({ preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).toHaveBeenCalledOnce();
    // Terminals killed and drafts flushed, unasked.
    expect(teardown).toHaveBeenCalledOnce();
  });

  it("a cancelled logout, then a later ⌘Q, enters menu-bar mode", async () => {
    vi.useFakeTimers();
    const host = controller(fixedWork(1));
    let listener!: (event: { preventDefault(): void }) => void;
    const stop = vi.fn(async () => {});
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on: (_, callback) => {
          listener = callback;
        },
        exit: vi.fn(),
      },
      shutdownNativeSessions: stop,
      shutdownAgentSocket: async () => {},
      reportFailure: vi.fn(),
      prepareQuit: (event) =>
        prepareDesktopQuit(event, {
          stopAutomations: vi.fn(),
          unsavedQuit: vi.fn(),
          terminalQuit: vi.fn(),
          abortRepack: vi.fn(),
          menuBar: host,
          systemShutdownTeardown: vi.fn(),
        }),
    });
    host.noteSystemShutdown();
    // Another app cancelled the logout: Volli was never asked to quit.
    vi.advanceTimersByTime(60_000);
    listener({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.isResident()).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    resources.push(() => host.reveal());
  });

  it("two Command-Q attempts with a permanently live turn stay resident, but Tray Quit Anyway exits once", async () => {
    let listener!: (event: { preventDefault(): void }) => void;
    const quit = () => listener({ preventDefault: vi.fn() });
    const host = controller(fixedWork(1), vi.fn(quit));
    resources.push(() => host.reveal());
    const stop = vi.fn(async () => {});
    const exit = vi.fn();
    const automations = vi.fn();
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on: (_, callback) => {
          listener = callback;
        },
        exit,
      },
      shutdownNativeSessions: stop,
      shutdownAgentSocket: async () => {},
      reportFailure: vi.fn(),
      prepareQuit: (event) =>
        prepareDesktopQuit(event, {
          stopAutomations: automations,
          unsavedQuit: vi.fn(),
          terminalQuit: vi.fn(),
          abortRepack: vi.fn(),
          menuBar: host,
        }),
    });
    quit();
    quit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.isResident()).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(automations).not.toHaveBeenCalled();
    host.quitFromTray();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).toHaveBeenCalledOnce();
    expect(automations).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
