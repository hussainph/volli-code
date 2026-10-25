// N−1's shipped database codec, Session host and Pi adapter/runtime. No head imports.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const n1 = (path) => import(`n1:${path}`);

/**
 * N-1's executor port, under both names a shipped build reads: `executor` (one
 * adapter) before VC-916, `executors` (the executor slot) since. Each build
 * reads only its own name, so passing both fits every N-1.
 */
function executorPorts(adapter) {
  return {
    executor: adapter,
    executors: { runtimes: new Map([[adapter.id, adapter]]), defaultRuntime: adapter },
  };
}
const { dbPath, steps } = JSON.parse(process.argv[2]);
const step = steps[0];
const { openVolliDb } = await n1("./db/index");
const { createSessionEngine, createSessionRuntime, sessionRootThreadId } =
  await n1("@volli/session-engine");
const { createSqliteSessionLedger } = await n1("./session-control/sqlite-ledger");
const { createPiNativeAdapter } = await n1("./session-runtime/pi-adapter");
const { createFileTranscriptArtifactStore } = await n1("./session-runtime/transcript-artifacts");
const { scriptedProvider } = await n1(
  pathToFileURL(
    join(process.env.VOLLI_N1_TREE, "packages/agent-runtime/test-fixtures/scripted-provider.ts"),
  ).href,
);
const script = scriptedProvider([{ text: "N−1 continued successfully" }]);
const messages = (snapshot) =>
  snapshot.frames.flatMap((frame) => (frame.transcript ? [frame.transcript.message] : []));
let db = openVolliDb(dbPath);
let runtime;
try {
  let next = 0;
  const now = () => 1_791_100_300_000 + ++next;
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(db),
    clock: { now },
    ids: { next: (kind) => `silent-n1-${kind}-${++next}` },
  });
  const before = await engine.getSession({ sessionId: step.sessionId });
  const attachSpecs = [];
  const adapter = createPiNativeAdapter({
    sessionDataDir: step.sessionDataDir,
    models: script.models,
    now,
    readWorkspaceEnvironment: () => undefined,
    usageLimits: {
      fetch: async () => {
        throw new Error("Fixture has no network");
      },
    },
    resolveRuntimeContext: async () => ({
      role: "ticket",
      projectId: before.session.projectId,
      ticketId: before.session.ticketId,
      rootThreadId: sessionRootThreadId(step.sessionId),
      brief: "N−1 silent end continuation",
      model: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
      toolSurface: ["read"],
      promptResources: [],
    }),
  });
  runtime = createSessionRuntime({
    engine,
    artifacts: createFileTranscriptArtifactStore(step.transcriptsRoot),
    clock: { now },
    ids: { next: (kind) => `silent-n1-host-${kind}-${++next}` },
    locations: {
      resolve: async () => ({ directory: step.workspace, venue: { id: "local", kind: "local" } }),
      prepare: async () => ({ directory: step.workspace, venue: { id: "local", kind: "local" } }),
      reaffirm: async () => undefined,
    },
    ...executorPorts({
      ...adapter,
      attach: (spec, sink) => {
        attachSpecs.push(spec);
        return adapter.attach(spec, sink);
      },
    }),
  });
  // Replay BEFORE attaching, then again after attach: both are real artifact/codec reads.
  const replay = await runtime.snapshot({ sessionId: step.sessionId });
  if (before.liveExecutor) {
    await runtime.reconcile({ sessionId: step.sessionId, attachmentId: before.liveExecutor.id });
  } else {
    const attached = await runtime.command({
      commandId: "silent-n1-attach",
      sessionId: step.sessionId,
      command: { kind: "adapter.attach", continuity: "context_replay" },
    });
    if (attached.receipt?.status !== "accepted") throw new Error(JSON.stringify(attached));
  }
  const attached = await runtime.snapshot({ sessionId: step.sessionId });
  const request = {
    commandId: "silent-n1-next",
    sessionId: step.sessionId,
    command: {
      kind: "message.submit",
      settle: "turn",
      message: {
        id: "silent-n1-next",
        role: "user",
        parts: [{ type: "text", text: step.nextText }],
      },
    },
  };
  const first = await runtime.command(request);
  // Retry the same accepted command, as a client reconnect would. No new model turn/message.
  const retry = await runtime.command(request);
  const after = await runtime.snapshot({ sessionId: step.sessionId });
  // Drop the live host AND SQLite connection; a fresh engine must fold the stored history.
  await runtime.close();
  runtime = undefined;
  db.close();
  db = openVolliDb(dbPath);
  const coldEngine = createSessionEngine({
    ledger: createSqliteSessionLedger(db),
    clock: { now },
    ids: { next: (kind) => `silent-cold-engine-${kind}-${++next}` },
  });
  const cold = createSessionRuntime({
    engine: coldEngine,
    ...executorPorts(adapter),
    artifacts: createFileTranscriptArtifactStore(step.transcriptsRoot),
    clock: { now },
    ids: { next: (kind) => `silent-cold-${kind}-${++next}` },
    locations: {
      resolve: async () => ({ directory: step.workspace, venue: { id: "local", kind: "local" } }),
      prepare: async () => ({ directory: step.workspace, venue: { id: "local", kind: "local" } }),
      reaffirm: async () => undefined,
    },
  });
  const coldReplay = await cold.snapshot({ sessionId: step.sessionId });
  await cold.close();
  const events = await coldEngine.listEvents({ sessionId: step.sessionId });
  console.log(
    JSON.stringify({
      results: [
        {
          kind: step.kind,
          ok: true,
          value: {
            userVersion: db.pragma("user_version", { simple: true }),
            // Behavior only: no exact assertion on an older/newer decoded event or marker shape.
            replayMessages: messages(replay),
            attachedMessages: messages(attached),
            afterMessages: messages(after),
            coldMessages: messages(coldReplay),
            namedFailure: JSON.stringify(replay.projection.attention).includes(
              step.diagnostic ?? "",
            ),
            attached: attached.projection.liveExecutor?.status === "open",
            replayIdle: !replay.projection.turnActive,
            attachedIdle: !attached.projection.turnActive,
            idleAfter: !after.projection.turnActive,
            coldIdle: !coldReplay.projection.turnActive,
            queueAfter: after.projection.queue ?? [],
            firstStatus: first.receipt?.status,
            retryStatus: retry.receipt?.status,
            providerRequests: script.requests,
            attachCount: attachSpecs.length,
            continuity: attachSpecs[0]?.continuity,
            acceptedNext: events.filter(
              ({ payload }) =>
                payload.kind === "command.receipt.recorded" &&
                payload.receipt.commandId === request.commandId &&
                payload.receipt.status === "accepted",
            ).length,
          },
        },
      ],
    }),
  );
} finally {
  await runtime?.close();
  db.close();
}
