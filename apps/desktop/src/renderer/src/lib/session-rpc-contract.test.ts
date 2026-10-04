// @vitest-environment node
import { expect, it, vi } from "vite-plus/test";
import {
  describeContract,
  expectHostError,
  recordSubscription,
} from "@volli/host-protocol/testing";
import { createSessionRouter, RpcDiagnosticLog } from "@volli/session-rpc";
import type { SessionRuntime, SessionStreamFrame } from "@volli/session-engine";
import { createSessionProjectionCheckpoint, EMPTY_MODEL_ACCESS_DEFAULTS } from "@volli/shared";
import { fakeElectron, sessionRouterContractLinks } from "./session-rpc-contract.test-support";

vi.mock("electron", () => fakeElectron);

const selection = { providerId: "test", modelId: "model", reasoningLevel: "high" as const };
const session = {
  id: "session-1",
  projectId: "project-1",
  ticketId: null,
  role: "project" as const,
  parentSessionId: null,
  title: null,
  createdAt: 10,
};
function frame(sequence: number): SessionStreamFrame {
  return {
    sessionId: session.id,
    sequence,
    transcript: null,
    event: {
      id: `event-${sequence}`,
      sessionId: session.id,
      sequence,
      occurredAt: 10,
      recordedAt: 10,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
      payload: { kind: "session.created", session },
    },
  };
}
function fixture() {
  let emit!: (value: SessionStreamFrame) => void | Promise<void>;
  let fail!: (error: unknown) => void;
  const cursors: number[] = [];
  const snapshot = {
    projection: createSessionProjectionCheckpoint(session, []).projection,
    throughSequence: 4,
    frames: [frame(4)],
    transcript: [],
  };
  const receipt = {
    id: "receipt-1",
    commandId: "command-1",
    status: "accepted" as const,
    acceptedAt: 10,
    result: { kind: "model.selected" as const, sessionId: session.id },
    recordedAt: 10,
    sequence: 5,
  };
  const runtime: SessionRuntime = {
    snapshot: async () => snapshot,
    projection: async () => ({ projection: snapshot.projection, throughSequence: 4 }),
    command: async (request) => ({
      sessionId: session.id,
      command: {
        id: request.commandId,
        sessionId: session.id,
        createdAt: 10,
        route: null,
        intent: { kind: "model.select", selection },
      },
      receipt,
      throughSequence: 5,
      refusal: null,
    }),
    subscribe: async ({ afterSequence }, next, onFailure) => {
      cursors.push(afterSequence);
      emit = next;
      fail = onFailure!;
      return () => {};
    },
    cancelInteraction: async () => {},
    reconcile: async () => {},
    close: async () => {},
  };
  const host = { runtime, diagnostics: new RpcDiagnosticLog() };
  return {
    host,
    receipt,
    cursors,
    emit: (value: SessionStreamFrame) => emit(value),
    fail: (error: unknown) => fail(error),
  };
}

describeContract("Session router", sessionRouterContractLinks(), ({ connect }) => {
  it("preserves projection and snapshot exactly as the direct caller answers", async () => {
    const { host } = fixture();
    const caller = createSessionRouter().createCaller(host);
    const client = await connect(host);
    const input = { sessionId: session.id };
    expect(await client.session.projection.query(input)).toStrictEqual(
      await caller.session.projection(input),
    );
    expect(await client.session.snapshot.query(input)).toStrictEqual(
      await caller.session.snapshot(input),
    );
  });

  it("routes a modelAccess facade and reports an absent facade", async () => {
    const { host } = fixture();
    const client = await connect({
      ...host,
      readModelAccessDefaults: () => EMPTY_MODEL_ACCESS_DEFAULTS,
    });
    expect(await client.modelAccess.defaults.query()).toStrictEqual(EMPTY_MODEL_ACCESS_DEFAULTS);
    expect(await expectHostError(client.modelAccess.inspect.query({}))).toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  it("passes command receipts through without changing acceptance into completion", async () => {
    const { host, receipt } = fixture();
    const client = await connect(host);
    const result = await client.session.command.mutate({
      sessionId: session.id,
      commandId: "command-1",
      command: { kind: "model.select", selection },
    });
    expect(result.receipt).toStrictEqual(receipt);
    expect(result.throughSequence).toBe(5);
  });

  it("reports invalid inputs as BAD_REQUEST", async () => {
    const client = await connect(fixture().host);
    expect(await expectHostError(client.session.snapshot.query({ sessionId: " " }))).toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("carries tracked ids and resumes from the greatest supplied cursor", async () => {
    const f = fixture();
    const client = await connect(f.host);
    const stream = recordSubscription<{ id: string; data: unknown }>((handlers) =>
      client.session.subscribe.subscribe({ sessionId: session.id }, handlers),
    );
    await stream.started;
    f.emit(frame(5));
    expect((await stream.received(1))[0]).toMatchObject({ id: "5", data: { sequence: 5 } });
    stream.unsubscribe();
    const resumed = recordSubscription<{ id: string; data: unknown }>((handlers) =>
      client.session.subscribe.subscribe(
        { sessionId: session.id, afterSequence: 2, lastEventId: "5" },
        handlers,
      ),
    );
    await resumed.started;
    expect(f.cursors).toStrictEqual([0, 5]);
    f.emit(frame(6));
    expect((await resumed.received(1))[0]?.id).toBe("6");
    resumed.unsubscribe();
  });

  it("ends queue overflow with TOO_MANY_REQUESTS, never clean completion", async () => {
    const f = fixture();
    const client = await connect(f.host);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: session.id }, handlers),
    );
    await stream.started;
    for (let sequence = 1; sequence <= 4098; sequence++) f.emit(frame(sequence));
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "TOO_MANY_REQUESTS" },
    });
    expect(stream.frames.length).toBeGreaterThan(0);
  });

  it("ends a source failure with INTERNAL_SERVER_ERROR, never clean completion", async () => {
    const f = fixture();
    const client = await connect(f.host);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: session.id }, handlers),
    );
    await stream.started;
    f.fail(new Error("source drain died"));
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "INTERNAL_SERVER_ERROR" },
    });
  });
});
