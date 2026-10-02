import { mkdtemp, mkdir, rm, symlink, access } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vite-plus/test";
import type { RuntimeObservation } from "@volli/shared";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
} from "@volli/session-engine";
import { RuntimeObservationTranslator } from "../../../session-engine/src/observation-translation.ts";
import { createDurableSpikeRuntime } from "./runtime.ts";
import { fallback, fixtureModels, fixtureSpec } from "./fixture.ts";

it("two stores project globally distinct facts into one Engine; live cursors reconcile", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".pi-durable-identities-"));
  let ids = 0;
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock: { now: () => 0 },
    ids: { next: (kind) => `${kind}-${++ids}` },
  });
  const artifacts = createInMemoryTranscriptArtifactStore();
  const factIds: string[] = [];
  const venue = { kind: "local" as const, id: "fixture-machine" };
  const provenance = { source: { kind: "adapter" as const, id: "pi", detail: null }, venue };
  try {
    for (const sessionId of ["first-session", "second-session"]) {
      const attachmentId = `${sessionId}:binding`;
      await engine.createSession({
        commandId: `${sessionId}:create`,
        requestedSessionId: sessionId,
        projectId: "project",
        ticketId: "ticket",
        role: "ticket",
        parentSessionId: null,
        title: null,
        provenance,
      });
      await engine.observe({
        id: `${sessionId}:opened`,
        sessionId,
        occurredAt: 0,
        provenance,
        kind: "attachment.opened",
        attachment: {
          id: attachmentId,
          sessionId,
          adapterId: "pi",
          venue,
          continuity: "fresh",
          native: null,
          authority: null,
        },
      });
      const observations: RuntimeObservation[] = [];
      const spec = fixtureSpec(directory, async (o) => {
        observations.push(o);
      });
      spec.identity = { ...spec.identity, sessionId, attachmentId };
      const { models } = fixtureModels("stream");
      const runtime = createDurableSpikeRuntime({
        enabled: true,
        fallback,
        models,
        checkpointPath: (id) => join(directory, `${id}.sqlite`),
      });
      const handle = await runtime.startSession(spec);
      try {
        await handle.submitUserMessage("hello", "queue", `${sessionId}:message`);
        const lastLiveCursor = observations
          .flatMap((o) => ("recoveryCursor" in o && o.recoveryCursor ? [o.recoveryCursor] : []))
          .at(-1)!;
        expect((await handle.reconcile(lastLiveCursor)).observations).toEqual([]);
        const translator = new RuntimeObservationTranslator({
          namespace: "pi-durable-spike",
          sessionId,
          attachmentId,
          now: () => 0,
        });
        for (const observation of observations)
          for (const fact of translator.replay(observation)) {
            factIds.push(fact.id);
            const base = {
              id: fact.id,
              sessionId,
              attachmentId,
              occurredAt: fact.occurredAt,
              provenance,
            };
            if (
              fact.kind === "turn.started" ||
              fact.kind === "turn.completed" ||
              fact.kind === "turn.interrupted"
            )
              await engine.observe({ ...base, kind: fact.kind, turnId: fact.turnId });
            else if (fact.kind === "transcript.message") {
              const reference = await artifacts.write({
                version: 1,
                threadId: fact.threadId,
                branchId: fact.branchId,
                attemptId: fact.attemptId,
                turnId: fact.turnId,
                message: fact.message,
              });
              await engine.observe({
                ...base,
                kind: "transcript.referenced",
                turnId: fact.turnId,
                reference,
              });
            }
          }
        expect((await engine.getSession({ sessionId }))?.lastTurnOutcome).toBe("completed");
      } finally {
        await handle.close();
      }
    }
    expect(new Set(factIds).size).toBe(factIds.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("compares stored birth membership before resolution and preserves order", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".pi-durable-membership-"));
  const { models } = fixtureModels("stream");
  const runtime = createDurableSpikeRuntime({
    enabled: true,
    fallback,
    models,
    checkpointPath: (id) => join(directory, `${id}.sqlite`),
  });
  try {
    const spec = fixtureSpec(directory, async () => {});
    spec.tools = { tools: ["write", "read"] };
    await (await runtime.startSession(spec)).close();
    await (await runtime.startSession(spec)).close();
    spec.tools = { tools: ["read"] };
    await expect(runtime.startSession(spec)).rejects.toThrow("frozen tools disagree");
    spec.tools = { tools: ["read", "write"] };
    await expect(runtime.startSession(spec)).rejects.toThrow("frozen tools disagree");
    spec.identity = { ...spec.identity, sessionId: "read-only-session" };
    spec.tools = { tools: ["read"] };
    await (await runtime.startSession(spec)).close();
    spec.tools = { tools: ["read", "write"] };
    await expect(runtime.startSession(spec)).rejects.toThrow("frozen tools disagree");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const race of [false, true])
  it(`refuses ${race ? "check-to-effect" : "dangling"} write symlink without authority snapshot`, async () => {
    const directory = await mkdtemp(join(process.cwd(), ".pi-durable-link-"));
    const workspace = join(directory, "work");
    await mkdir(workspace);
    const outside = join(directory, "outside.txt");
    if (!race) await symlink(outside, join(workspace, "effect.txt"));
    const observations: RuntimeObservation[] = [];
    const { models } = fixtureModels("unsafe");
    const runtime = createDurableSpikeRuntime({
      enabled: true,
      fallback,
      models,
      checkpointPath: () => join(directory, "execution.sqlite"),
      probe: race
        ? {
            beforeEffect: async () => {
              await symlink(outside, join(workspace, "effect.txt"));
            },
          }
        : undefined,
    });
    const handle = await runtime.startSession(
      fixtureSpec(workspace, async (o) => {
        observations.push(o);
      }),
    );
    try {
      await handle.submitUserMessage("write", "queue", "command-link");
      expect(observations.some((o) => o.kind === "activity" && o.state === "failed")).toBe(true);
      await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

it("delayed batches never label old deltas as the next Turn or emit after settlement", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".pi-durable-causal-"));
  const faux = fauxProvider({
    models: [{ id: "spike" }],
    tokensPerSecond: 100,
    tokenSize: { min: 3, max: 3 },
  });
  faux.setResponses([
    fauxAssistantMessage("FIRST answer ".repeat(20)),
    fauxAssistantMessage("SECOND answer ".repeat(20)),
  ]);
  let firstFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    firstFinished = resolve;
  });
  const original = faux.provider.streamSimple.bind(faux.provider);
  let calls = 0;
  faux.provider.streamSimple = (model, transcript, options) => {
    const stream = original(model, transcript, options);
    if (++calls === 1) void stream.result().then(firstFinished);
    return stream;
  };
  const models = createModels();
  models.setProvider(faux.provider);
  let entered!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observations: RuntimeObservation[] = [];
  let gated = false;
  const spec = fixtureSpec(directory, async (o) => {
    observations.push(o);
    if (o.kind === "delta" && !gated) {
      gated = true;
      entered();
      await held;
    }
  });
  const runtime = createDurableSpikeRuntime({
    enabled: true,
    fallback,
    models,
    checkpointPath: () => join(directory, "execution.sqlite"),
  });
  const handle = await runtime.startSession(spec);
  try {
    const first = handle.submitUserMessage("first", "queue", "command-first");
    await blocked;
    await finished;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = handle.submitUserMessage("second", "queue", "command-second");
    release();
    expect((await first).kind).toBe("delivered");
    expect((await second).kind).toBe("delivered");
    expect(faux.state.callCount).toBe(2);
    const settled = observations.filter((o) => o.kind === "message-settled");
    expect(settled.length).toBe(2);
    for (const row of settled) {
      const at = observations.indexOf(row);
      expect(
        observations.slice(at + 1).some((o) => o.kind === "delta" && o.turnId === row.turnId),
      ).toBe(false);
    }
    const secondTurn = settled[1].turnId;
    expect(
      observations
        .flatMap((o) => (o.kind === "delta" && o.turnId === secondTurn ? [o.text] : []))
        .join(""),
    ).not.toContain("FIRST");
  } finally {
    release();
    await handle.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
