import { expect, test, vi } from "vite-plus/test";
import { createSessionEngine, createSessionExecutorSlot, createSessionRuntime } from "../index";
import {
  createInMemorySessionLedger,
  createInMemorySessionFollowUpLedger,
  createInMemoryTranscriptArtifactStore,
} from "../testing";

test("host queue observers neither subscribe to history nor authorize delivery", async () => {
  let next = 0;
  const ids = { next: () => `id-${++next}` };
  const clock = { now: () => 100 };
  const engine = createSessionEngine({ ledger: createInMemorySessionLedger(), ids, clock });
  const born = await engine.createSession({
    commandId: "birth",
    projectId: "p",
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: null,
    provenance: {
      source: { kind: "system", id: "test", detail: null },
      venue: { id: "local", kind: "local" },
    },
  });
  const failure = vi.fn();
  const runtime = createSessionRuntime({
    engine,
    clock,
    ids,
    followUps: createInMemorySessionFollowUpLedger(),
    artifacts: createInMemoryTranscriptArtifactStore(),
    executors: createSessionExecutorSlot({
      id: "fake",
      durableIdNamespace: "fake",
      adapterVersion: "1",
      runtime: { path: "fake", version: "1", fingerprint: "fake" },
      attach: async () => {
        throw new Error("held");
      },
    }),
    locations: {
      resolve: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
      prepare: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
      reaffirm: async () => {},
    },
    onFollowUpFailure: failure,
  });
  runtime.holdTurnStarts();
  const observed = vi.fn();
  const off = runtime.onFollowUpQueue!(observed);
  const offBad = runtime.onFollowUpQueue!(() => {
    throw new Error("observer failed");
  });
  const send = (id: string) =>
    runtime.command({
      sessionId: born.session.id,
      commandId: id,
      command: {
        kind: "message.submit",
        delivery: "queue",
        message: { id, role: "user", parts: [{ type: "text", text: id }] },
      },
    });
  try {
    expect((await send("first")).receipt?.status).toBe("accepted");
    await vi.waitFor(() =>
      expect(observed).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "queue", sessionId: born.session.id, revision: 1 }),
      ),
    );
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: "observer failed" }));
    off();
    offBad();
    await send("second");
    await Promise.resolve();
    expect(observed).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.close();
  }
  expect(() => runtime.onFollowUpQueue!(observed)).toThrow();
});
