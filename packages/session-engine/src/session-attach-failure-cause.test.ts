/**
 * Why an attach failed reaches the host's log (VC-1099).
 *
 * `attachment.failed` keeps its durable shape; the runtime hands the host the
 * phase that failed, the error's class, whether a bound was outlasted and how
 * long it ran, just before that fact commits.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  createSessionEngine,
  createSessionRuntime,
  type BindingHandle,
  type NativeHarnessAdapter,
  type SessionAttachFailureCause,
} from "./index";
import { createSessionExecutorSlot } from "./executor-slot";
import {
  createInMemorySessionFollowUpLedger,
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
} from "./testing";

const BOUND_MS = 20;

function fixture(
  options: {
    attach?: () => Promise<BindingHandle>;
    prepare?: () => Promise<void>;
    report?: (cause: SessionAttachFailureCause) => void;
  } = {},
) {
  let sequence = 0;
  const clock = { now: () => ++sequence };
  const ledger = createInMemorySessionLedger();
  const engine = createSessionEngine({
    ledger,
    clock,
    ids: { next: (kind) => `${kind}-${++sequence}` },
  });
  const adapter: NativeHarnessAdapter = {
    id: "fake",
    durableIdNamespace: "fake",
    adapterVersion: "1",
    runtime: { path: "/fake", version: "1", fingerprint: "fake" },
    attach: async () => (await options.attach?.()) ?? handle(),
  };
  const causes: SessionAttachFailureCause[] = [];
  const runtime = createSessionRuntime({
    engine,
    artifacts: createInMemoryTranscriptArtifactStore(),
    followUps: createInMemorySessionFollowUpLedger(ledger),
    executors: createSessionExecutorSlot(adapter),
    clock,
    ids: { next: (kind) => `${kind}-${++sequence}` },
    followUpAdmissionTimeoutMs: BOUND_MS,
    directAttachTimeoutMs: BOUND_MS,
    firstAttachPreparationTimeoutMs: BOUND_MS,
    locations: {
      resolve: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
      prepare: async () => {
        await options.prepare?.();
        return { directory: "/fake", venue: { id: "local", kind: "local" } };
      },
      reaffirm: async () => undefined,
    },
    onAttachFailure: (cause) => {
      causes.push(cause);
      options.report?.(cause);
    },
  });
  const start = async (commandId = "start") => {
    const { sessionId } = await runtime.command({
      commandId: "create",
      command: {
        kind: "session.create",
        projectId: "project",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
      },
    });
    const attached = await runtime.command({
      commandId,
      sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    const failed = (await engine.listEvents({ sessionId })).flatMap(({ payload }) =>
      payload.kind === "attachment.failed" ? [payload] : [],
    );
    return { sessionId, attached, failed };
  };
  return { engine, runtime, causes, start };
}

function handle(released?: () => void): BindingHandle {
  return {
    native: { id: "native", detail: null },
    dispatch: async (command) => ({
      commandId: command.commandId,
      status: "accepted",
      acceptedAt: 1,
      native: null,
    }),
    reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
    release: async () => released?.(),
  };
}

describe("an attach failure's cause (VC-1099)", () => {
  it("names the direct executor attach that outlasted its ceiling, and releases the late binding", async () => {
    const commandId = "start";
    const code = "attach_timeout";
    const late = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const f = fixture({
      attach: async () => {
        await late.promise;
        return handle(released.resolve);
      },
    });

    const { attached, failed, sessionId } = await f.start(commandId);

    expect(attached.receipt).toMatchObject({ status: "rejected", code });
    expect(f.causes).toEqual([
      {
        sessionId,
        commandId,
        attachmentId: failed[0]!.attachment.id,
        phase: "executor-attach",
        code,
        errorName: "NativeAttachmentError",
        timedOut: true,
        phaseMs: expect.any(Number),
        elapsedMs: expect.any(Number),
      },
    ]);
    const [cause] = f.causes;
    expect(cause!.elapsedMs).toBeGreaterThanOrEqual(cause!.phaseMs);
    late.resolve();
    await released.promise;
    await f.runtime.close();
  });

  it("names a workspace preparation that failed on its own, whatever was thrown", async () => {
    const f = fixture({
      prepare: async () => {
        // eslint-disable-next-line no-throw-literal -- a non-Error throw is the case under test
        throw "worktree add died";
      },
    });

    const { attached } = await f.start();

    expect(attached.receipt).toMatchObject({ status: "rejected", code: "location_unavailable" });
    expect(f.causes).toMatchObject([
      {
        phase: "workspace-preparation",
        code: "location_unavailable",
        errorName: "string",
        timedOut: false,
      },
    ]);
    await f.runtime.close();
  });

  it("names a first attach's preparation that outlasted its ceiling as a timeout", async () => {
    const f = fixture({ prepare: () => new Promise<void>(() => undefined) });

    await f.start();

    expect(f.causes).toMatchObject([
      { phase: "workspace-preparation", errorName: "PreparationCeilingError", timedOut: true },
    ]);
    await f.runtime.close();
  });

  it("names a later direct attach's preparation that outlasted its ceiling as a timeout", async () => {
    let prepares = 0;
    const f = fixture({
      prepare: () => (++prepares === 1 ? Promise.resolve() : new Promise<void>(() => undefined)),
    });
    const { sessionId, attached } = await f.start();
    expect(attached.receipt?.status).toBe("accepted");
    await f.runtime.command({
      commandId: "stop",
      sessionId,
      command: { kind: "session.stop" },
    });

    const again = await f.runtime.command({
      commandId: "reattach",
      sessionId,
      command: { kind: "adapter.attach", continuity: "context_replay" },
    });

    expect(again.receipt).toMatchObject({ status: "rejected", code: "location_unavailable" });
    expect(f.causes).toMatchObject([
      {
        commandId: "reattach",
        phase: "workspace-preparation",
        errorName: "NativeAttachmentError",
        timedOut: true,
      },
    ]);
    await f.runtime.close();
  });

  it("does not diagnose a person's cancelled start as an attach failure", async () => {
    const attaching = Promise.withResolvers<void>();
    const late = Promise.withResolvers<BindingHandle>();
    const released = Promise.withResolvers<void>();
    const f = fixture({
      attach: () => {
        attaching.resolve();
        return late.promise;
      },
    });
    const starting = f.start();
    await attaching.promise;
    const [session] = await f.engine.listSessions({ projectId: "project", scope: "all" });
    expect(await f.runtime.abandonDirectStart(session!.session.id)).toBe(true);
    const { attached, failed } = await starting;
    expect(attached.receipt).toMatchObject({ status: "rejected", code: "attach_cancelled" });
    expect(failed).toHaveLength(1);
    expect(f.causes).toEqual([]);
    late.resolve(handle(released.resolve));
    await released.promise;
    await f.runtime.close();
  });

  it("still records the failure when the host's report throws", async () => {
    const f = fixture({
      attach: async () => {
        throw new TypeError("no runtime");
      },
      report: () => {
        throw new Error("log sink down");
      },
    });

    const { attached, failed } = await f.start();

    expect(attached.receipt).toMatchObject({ status: "rejected", code: "attach_failed" });
    expect(failed).toHaveLength(1);
    expect(f.causes).toMatchObject([{ phase: "executor-attach", errorName: "TypeError" }]);
    await f.runtime.close();
  });
});
