import { describe, expect, it } from "vite-plus/test";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  type HarnessCommand,
  type NativeHarnessAdapter,
  type SessionStreamFrame,
  isSessionStreamFrame,
} from "@volli/session-engine";
import { createSessionRouter, LOCAL_DESKTOP_CALLER, RpcDiagnosticLog } from "./index";

async function fixture(
  options: {
    attach?: boolean;
    active?: boolean;
    terminal?: boolean;
    releaseFails?: boolean;
    interruptFails?: boolean;
  } = {},
) {
  let sequence = 0;
  const ids = { next: (kind: string) => `${kind}-${++sequence}` };
  const clock = { now: () => ++sequence };
  const venue = { id: "local", kind: "local" as const };
  const engine = createSessionEngine({ ledger: createInMemorySessionLedger(), clock, ids });
  const acts: string[] = [];
  let failRelease = options.releaseFails ?? false;
  const executor: NativeHarnessAdapter = {
    id: "fake",
    durableIdNamespace: "fake",
    adapterVersion: "1",
    runtime: { path: "/fake", version: "1", fingerprint: "fake" },
    attach: async () => ({
      native: { id: "fake-native", detail: null },
      dispatch: async (command: HarnessCommand) => {
        // Durable truth must lead every runtime act.
        expect((await engine.getSession({ sessionId }))?.stopped?.by).toEqual({ kind: "user" });
        acts.push(command.kind);
        if (options.interruptFails) throw new Error("interrupt failed");
        return {
          status: "accepted",
          commandId: command.commandId,
          acceptedAt: clock.now(),
          native: null,
        };
      },
      reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
      release: async (reason) => {
        if (reason !== "requested") return;
        expect((await engine.getSession({ sessionId }))?.stopped).not.toBeNull();
        acts.push("adapter.release");
        if (failRelease) throw new Error("release failed");
      },
    }),
  };
  const at = async () => ({ directory: "/fake", venue });
  const runtime = createSessionRuntime({
    engine,
    executor,
    ids,
    clock,
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: { resolve: at, prepare: at, reaffirm: async () => undefined },
  });
  const created = await runtime.command({
    commandId: "create",
    command: {
      kind: "session.create",
      projectId: "project",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Helper",
    },
  });
  const sessionId = created.sessionId;
  if (options.terminal) {
    await engine.observe({
      id: "terminal",
      sessionId,
      commandId: null,
      kind: "attachment.opened",
      occurredAt: clock.now(),
      provenance: { source: { kind: "system", id: "test", detail: null }, venue },
      attachment: {
        id: "terminal",
        sessionId,
        adapterId: "terminal",
        continuity: "fresh",
        venue,
        native: null,
        authority: null,
      },
    });
  } else if (options.attach !== false) {
    await runtime.command({
      commandId: "attach",
      sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
  }
  if (options.active) {
    const projection = await engine.getSession({ sessionId });
    await engine.observe({
      id: "turn",
      sessionId,
      attachmentId: projection!.attachments.at(-1)!.id,
      turnId: "turn",
      commandId: null,
      kind: "turn.started",
      occurredAt: clock.now(),
      provenance: { source: { kind: "adapter", id: "fake", detail: null }, venue },
    });
  }
  const caller = createSessionRouter().createCaller({
    caller: LOCAL_DESKTOP_CALLER,
    runtime,
    diagnostics: new RpcDiagnosticLog(),
    transport: "electron-ipc",
  });
  const stop = (commandId = "stop", reason?: string) =>
    caller.session.command({
      commandId,
      sessionId,
      command: { kind: "session.stop", ...(reason === undefined ? {} : { reason }) },
    });
  return {
    engine,
    runtime,
    caller,
    stop,
    sessionId,
    acts,
    allowRelease: () => {
      failRelease = false;
    },
  };
}

describe("session.command session.stop", () => {
  it("records the user actor and stopped event before interrupt/release, and publishes it", async () => {
    const f = await fixture({ active: true });
    const frames: SessionStreamFrame[] = [];
    const unsubscribe = await f.runtime.subscribe(
      { sessionId: f.sessionId, afterSequence: 0 },
      (frame) => {
        if (isSessionStreamFrame(frame)) frames.push(frame);
      },
    );
    const result = await f.stop("stop", "  Runaway  ");
    expect(result.stop).toMatchObject({
      interrupted: true,
      released: true,
      failures: [],
      previouslyStopped: false,
    });
    expect(result.receipt?.status).toBe("completed");
    expect(f.acts).toEqual(["executor.interrupt", "adapter.release"]);
    expect((await f.engine.getSession({ sessionId: f.sessionId }))?.stopped).toMatchObject({
      reason: "Runaway",
      by: { kind: "user" },
    });
    const stopped = frames.find((frame) => frame.event.payload.kind === "session.stopped");
    expect(stopped?.event.payload).toMatchObject({ reason: "Runaway", by: { kind: "user" } });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    unsubscribe();
    await f.runtime.close();
  });

  it("replays the completed command after a lost reply, but refuses a new stop of the closed attachment", async () => {
    const f = await fixture({ active: true });
    const first = await f.stop();
    const replay = await f.stop();
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.stop).toMatchObject({
      previouslyStopped: true,
      interrupted: true,
      released: true,
      failures: [],
    });
    expect(f.acts).toEqual(["executor.interrupt", "adapter.release"]);
    await expect(f.stop("stop", "changed")).rejects.toThrow("different intent");
    await expect(f.stop("new-stop")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("is not live"),
    });
    await f.runtime.close();
  });

  it("releases an idle live attachment without interrupting", async () => {
    const f = await fixture();
    expect((await f.stop()).stop).toMatchObject({
      interrupted: false,
      released: true,
      failures: [],
    });
    expect(f.acts).toEqual(["adapter.release"]);
    await f.runtime.close();
  });

  it("reports failures without losing the durable stop; a still-live retry writes no second stop", async () => {
    const f = await fixture({ releaseFails: true, interruptFails: true, active: true });
    const first = await f.stop();
    expect(first.stop).toMatchObject({
      interrupted: false,
      released: false,
      failures: [
        expect.stringContaining("interrupt failed"),
        expect.stringContaining("release failed"),
      ],
    });
    f.allowRelease();
    const retry = await f.stop("retry");
    expect(retry.stop).toMatchObject({ previouslyStopped: true, released: true });
    const projection = await f.engine.getSession({ sessionId: f.sessionId });
    expect(
      projection?.commands.filter((command) => command.intent.kind === "session.stop"),
    ).toHaveLength(1);
    expect(retry.receipt).toEqual(first.receipt);
    await f.runtime.close();
  });

  it("refuses unknown, terminal, and not-live targets without recording a stop", async () => {
    for (const options of [{ attach: false }, { terminal: true }]) {
      const f = await fixture(options);
      await expect(f.stop()).rejects.toThrow(options.terminal ? /terminal session/ : /is not live/);
      expect((await f.engine.getSession({ sessionId: f.sessionId }))?.stopped).toBeNull();
      expect(f.acts).toEqual([]);
      await expect(
        f.caller.session.command({
          commandId: "unknown",
          sessionId: "ghost",
          command: { kind: "session.stop" },
        }),
      ).rejects.toThrow("Unknown session.");
      await f.runtime.close();
    }
  });

  it("propagates an unexpected durable-write failure rather than wording it as a refusal", async () => {
    const f = await fixture();
    f.engine.submit = async () => {
      throw new Error("storage failed");
    };
    await expect(f.stop()).rejects.toThrow("storage failed");
    expect(f.acts).toEqual([]);
    expect((await f.engine.getSession({ sessionId: f.sessionId }))?.stopped).toBeNull();
    await f.runtime.close();
  });

  it("validates ids and optional reasons at the router seam", async () => {
    const f = await fixture();
    for (const reason of ["", "   ", "x".repeat(4001), 1]) {
      await expect(
        Reflect.apply(f.caller.session.command, f.caller.session, [
          {
            commandId: "invalid",
            sessionId: f.sessionId,
            command: { kind: "session.stop", reason },
          },
        ]),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    for (const sessionId of ["", undefined]) {
      await expect(
        f.caller.session.command({
          commandId: "invalid",
          sessionId,
          command: { kind: "session.stop" },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect((await f.engine.getSession({ sessionId: f.sessionId }))?.stopped).toBeNull();
    await f.runtime.close();
  });
});
