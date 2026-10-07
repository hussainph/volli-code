/** The router-test adapter answers as the host's map does: the port its key reads, or unavailable. */
import { isOperationUnavailable, type HandlerCall } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DesktopRouterHandlers } from "./desktop-router";
import type { SessionRouterHandlers } from "./index";
import { sessionContext, sessionHandlersFrom, type LegacySessionPorts } from "./testing";
import { LOCAL_DESKTOP_CALLER } from "./catalog";
import { RpcDiagnosticLog } from "./index";

const CALL: HandlerCall = { actor: { kind: "user" } };
const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const sessionMayAct = () => true;
const resourceWorkspace = () => null;
type Ports = Omit<LegacySessionPorts, "caller" | "diagnostics">;

/** Every handler, with an input its port can take. */
function callAll(handlers: SessionRouterHandlers & DesktopRouterHandlers) {
  const sink = { emit: vi.fn(), fail: vi.fn() };
  return [
    () => handlers["sessions.create"]({} as never, CALL),
    () => handlers["sessions.attach"]({} as never, CALL),
    () => handlers["settings.experiments"](undefined, CALL),
    () => handlers["settings.setExperiment"]({ id: "cloud", enabled: true }, CALL),
    () => handlers["modelAccess.inspect"]({}, CALL),
    () => handlers["modelAccess.defaults"](undefined, CALL),
    () => handlers["modelAccess.setDefault"]({ purpose: "ticket", selection: null }, CALL),
    () => handlers["modelAccess.hiddenModels"](undefined, CALL),
    () => handlers["modelAccess.setHiddenModels"]([], CALL),
    () => handlers["modelAccess.compactionPolicy"](undefined, CALL),
    () => handlers["modelAccess.setCompactionPolicy"]({ autoCompaction: true }, CALL),
    () => handlers["modelAccess.codeModePolicy"](undefined, CALL),
    () => handlers["modelAccess.setCodeModePolicy"]({ enabled: true, models: {} }, CALL),
    () => handlers["modelAccess.pickerView"](undefined, CALL),
    () => handlers["modelAccess.setPickerView"]("all", CALL),
    () => handlers["session.snapshot"]({ sessionId: "s" }, CALL),
    () => handlers["session.history"]({ sessionId: "s", before: 2 }, CALL),
    () => handlers["session.projection"]({ sessionId: "s" }, CALL),
    () => handlers["session.subscribe"]({ sessionId: "s", afterSequence: 0 }, CALL, sink),
    () => handlers["session.subscribeQueue"]({ sessionId: "s", afterSequence: 0 }, CALL, sink),
    () => handlers["session.command"]({} as never, CALL),
    () =>
      handlers["session.cancelQueued"](
        { commandId: "cancel", sessionId: "s", messageId: "m" },
        CALL,
      ),
    () =>
      handlers["session.editQueued"](
        {
          commandId: "edit",
          sessionId: "s",
          messageId: "m",
          message: { id: "m", role: "user", parts: [{ type: "text", text: "edited" }] },
        },
        CALL,
      ),
    () => handlers["session.cancelInteraction"]({ sessionId: "s", interactionId: "i" }, CALL),
    () => handlers["session.reconcile"]({ sessionId: "s", attachmentId: "a" }, CALL),
    () => handlers["project.reorder"]({ orderedIds: [] }, CALL),
    () => handlers["worktree.trimSettings"](undefined, CALL),
    () => handlers["hosts.snapshot"](undefined, CALL),
    () => handlers["hosts.subscribe"](undefined, CALL, sink),
    () => handlers["hosts.retry"]({ hostId: HOST }, CALL),
    () => handlers["hosts.updateHost"]({ hostId: HOST, when: "now" }, CALL),
    () => handlers["hosts.cancelScheduledUpdate"]({ hostId: HOST }, CALL),
    () => handlers["hosts.signIn"]({ hostId: HOST, providerId: "anthropic" }, CALL),
    () => handlers["hosts.forget"]({ hostId: HOST }, CALL),
    () => handlers["hostAdd.start"]({ target: "you@box" }, CALL),
    () => handlers["hostAdd.subscribe"]({ flowId: "f" }, CALL, sink),
    () =>
      handlers["hostAdd.answer"](
        { flowId: "f", questionId: "q1", answer: { kind: "adopt" } },
        CALL,
      ),
    () => handlers["hostAdd.sudoPassword"]({ flowId: "f", questionId: "q1", password: "p" }, CALL),
    () => handlers["hostAdd.retry"]({ flowId: "f" }, CALL),
    () => handlers["hostAdd.cancel"]({ flowId: "f" }, CALL),
  ];
}

describe("sessionHandlersFrom", () => {
  it("answers unavailable for every port a case left out", async () => {
    for (const call of callAll(sessionHandlersFrom({ runtime: {} }))) {
      const error = await Promise.resolve()
        .then(call as () => unknown)
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(isOperationUnavailable(error)).toBe(true);
    }
  });

  it("calls the port each key once read, with the runtime bound", async () => {
    const answered = vi.fn(async function (this: unknown) {
      return this;
    });
    const runtime = {
      snapshot: answered,
      history: answered,
      projection: answered,
      subscribe: vi.fn(async (_input, listener, onFailure) => {
        await listener("emission" as never);
        onFailure?.("failure");
        return () => {};
      }),
      command: answered,
      cancelInteraction: vi.fn(async () => {}),
      reconcile: answered,
    } as unknown as Ports["runtime"];
    const port = vi.fn(async () => "answer");
    const ports: Ports = {
      runtime,
      createSession: port as never,
      attachSession: port as never,
      readExperiments: port as never,
      writeExperiment: port as never,
      inspectModelAccess: port as never,
      readModelAccessDefaults: port as never,
      writeModelAccessDefault: port as never,
      readHiddenModels: port as never,
      writeHiddenModels: port as never,
      readCompactionPolicy: port as never,
      writeCompactionPolicy: port as never,
      readCodeModePolicy: port as never,
      writeCodeModePolicy: port as never,
      readModelPickerView: port as never,
      writeModelPickerView: port as never,
      desktop: {
        "project.reorder": port as never,
        "worktree.trimSettings": port as never,
        "hosts.snapshot": port as never,
        "hosts.subscribe": port as never,
        "hosts.retry": port as never,
        "hosts.updateHost": port as never,
        "hosts.cancelScheduledUpdate": port as never,
        "hosts.signIn": port as never,
        "hosts.forget": port as never,
        "hostAdd.start": port as never,
        "hostAdd.subscribe": port as never,
        "hostAdd.answer": port as never,
        "hostAdd.sudoPassword": port as never,
        "hostAdd.retry": port as never,
        "hostAdd.cancel": port as never,
      },
    };
    for (const call of callAll(sessionHandlersFrom(ports))) await call();
    expect(port).toHaveBeenCalledTimes(30);
    expect(port).toHaveBeenCalledWith({ flowId: "f", questionId: "q1", password: "p" }, CALL);
    expect(runtime.command).toHaveBeenCalledWith({
      commandId: "cancel",
      sessionId: "s",
      command: { kind: "message.cancel", messageId: "m" },
    });
    expect(runtime.command).toHaveBeenCalledWith({
      commandId: "edit",
      sessionId: "s",
      command: {
        kind: "message.edit",
        messageId: "m",
        message: { id: "m", role: "user", parts: [{ type: "text", text: "edited" }] },
      },
    });
    expect(await sessionHandlersFrom(ports)["session.snapshot"]({ sessionId: "s" }, CALL)).toBe(
      runtime,
    );
    expect(runtime.cancelInteraction).toHaveBeenCalledWith({
      sessionId: "s",
      interactionId: "i",
      reason: "abandoned",
      origin: { kind: "user" },
    });
  });

  it("keeps the caller's own context beside the map", () => {
    const context = sessionContext({
      caller: LOCAL_DESKTOP_CALLER,
      runtime: {},
      diagnostics: new RpcDiagnosticLog(),
      sessionMayAct,
      resourceWorkspace,
      transport: "electron-ipc",
      performanceObserver: { record: () => {} },
    });
    expect(context).toMatchObject({ sessionMayAct, resourceWorkspace, transport: "electron-ipc" });
    // 21 existing router handlers, session.history (VC-315), three queue
    // operations, four Session reads, the desktop-only tier's two (VC-608),
    // two log reads (VC-699) and thirteen remote hosts commands (VC-700).
    expect(Object.keys(context.handlers)).toHaveLength(46);
  });
});
