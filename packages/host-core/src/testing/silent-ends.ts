/** TEST-ONLY: actual Pi adapter, engine, SQLite and transcript artifacts. */
import { LOCAL_RUNNER } from "@volli/shared";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
  readSessionTranscriptTail,
} from "@volli/session-engine";
import type { SessionRuntimeSpec, RuntimeAttachmentHandle, McpToolDefinition } from "@volli/shared";
import { createPiAgentRuntime } from "@volli/agent-runtime";
import {
  scriptedProvider,
  type ScriptedReply,
} from "../../../agent-runtime/test-fixtures/scripted-provider";
import { insertProject } from "../db/projects-repo";
import { createAgentCommandService } from "../agent-commands";
import { testHostHandlers } from "./host-handlers";
import { openTestDb, testProject } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createSqliteSessionFollowUpLedger } from "../db/session-follow-up-repo";
import { createPiNativeAdapter, type PiAdapterOptions } from "../session-runtime/pi-adapter";
import { createFileTranscriptArtifactStore } from "../session-runtime/transcript-artifacts";

export async function silentEndsFixture(
  options: {
    replies?: ScriptedReply[];
    provider?: ReturnType<typeof scriptedProvider>;
    mcp?: boolean;
    adapter?: Partial<PiAdapterOptions>;
  } = {},
) {
  const realHandles: RuntimeAttachmentHandle[] = [];
  const db = openTestDb();
  const root = dirname(db.dbPath);
  const directory = join(root, "workspace");
  mkdirSync(directory);
  insertProject(db.db, testProject({ id: "project", path: directory }));
  let clock = 1000;
  const now = () => clock++;
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(db.db),
    clock: { now },
    ids: { next: (kind) => `${kind}-${now()}` },
  });
  const script =
    options.provider ??
    scriptedProvider(options.replies ?? [{ text: "done" }, { text: "retried" }]);
  const models = script.models;
  const artifacts = createFileTranscriptArtifactStore(join(root, "transcripts"));
  const mcpTool: McpToolDefinition = {
    serverId: "fixture",
    toolName: "read",
    providerName: "mcp__fixture_read",
    description: "Read fixture",
    inputSchema: { type: "object", properties: {} },
  };
  let observe: SessionRuntimeSpec["observer"] | undefined;
  const adapter = createPiNativeAdapter({
    createRuntime: (runtimeOptions) => {
      const runtime = createPiAgentRuntime(runtimeOptions);
      return {
        ...runtime,
        startSession: async (spec) => {
          observe = spec.observer;
          const handle = await runtime.startSession(spec);
          realHandles.push(handle);
          return handle;
        },
      };
    },
    sessionDataDir: join(root, "pi"),
    models,
    now,
    usageLimits: {
      fetch: async () => {
        throw new Error("No network in this fixture");
      },
    },
    readWorkspaceEnvironment: () => ({ dependencies: null, installCommand: null }),
    resolveRuntimeContext: async (sessionId) => ({
      role: "project",
      projectId: "project",
      ticketId: null,
      rootThreadId: sessionRootThreadId(sessionId),
      brief: "Silent ends audit",
      model: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
      toolSurface: [
        "read",
        "edit",
        "write",
        "execute",
        ...(options.mcp ? [mcpTool.providerName] : []),
      ],
      ...(options.mcp ? { mcpTools: [mcpTool] } : {}),
      promptResources: [],
    }),
    ...options.adapter,
  });
  const terminal = Promise.withResolvers<void>();
  const runtime = createSessionRuntime({
    engine,
    executor: {
      ...adapter,
      attach: async (spec, sink) =>
        adapter.attach(spec, {
          emit: async (observation) => {
            await sink.emit(observation);
            if (observation.kind === "turn" && observation.state !== "started") terminal.resolve();
          },
        }),
    },
    artifacts,
    followUps: createSqliteSessionFollowUpLedger(db.db),
    locations: {
      resolve: async () => ({ directory, venue: LOCAL_RUNNER }),
      prepare: async () => ({ directory, venue: LOCAL_RUNNER }),
      reaffirm: async () => undefined,
    },
    clock: { now },
    ids: { next: (kind) => `runtime-${kind}-${now()}` },
  });
  const { sessionId } = await runtime.command({
    commandId: "create",
    command: {
      kind: "session.create",
      projectId: "project",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Audit",
    },
  });
  await runtime.command({
    commandId: "select-model",
    sessionId,
    command: {
      kind: "model.select",
      selection: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
    },
  });
  const attach = (commandId = "attach") =>
    runtime.command({
      commandId,
      sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
  const submit = (
    id = "send",
    delivery: "queue" | "steer" = "steer",
    opened = false,
    messageId = id,
  ) =>
    runtime.command({
      commandId: id,
      sessionId,
      command: {
        kind: "message.submit",
        message: { id: messageId, role: "user", parts: [{ type: "text", text: id }] },
        delivery,
        ...(opened ? { settle: "opened" as const } : {}),
      },
    });
  const projection = async () => (await runtime.projection({ sessionId })).projection;
  const events = () => engine.listEvents({ sessionId });
  const commandService = createAgentCommandService({
    db: db.db,
    handlers: testHostHandlers({ db: db.db }),
    appVersion: "test",
    sessionEngine: engine,
    now,
    readTranscriptArtifact: (reference) => artifacts.read(reference),
  });
  const peek = async () => {
    // The same JSON codec handed to an agent; real Pi, ledger and file bodies
    // feed this reply, rather than a hand-written delivery fixture.
    const response = await commandService.execute({
      v: 1,
      cmd: "session.peek",
      args: { id: sessionId.slice(0, 8) },
      ctx: { cwd: directory, env: {} },
    });
    if (!response.ok) throw new Error(response.error.message);
    return JSON.parse(JSON.stringify(response.data)) as Record<string, unknown>;
  };
  const tail = () =>
    readSessionTranscriptTail(
      {
        listEvents: (query) => engine.listEvents(query),
        readArtifact: (reference) => artifacts.read(reference),
      },
      { sessionId, limit: 20 },
    );
  return {
    db,
    close: async () => {
      await runtime.close();
      for (const handle of realHandles) await handle.close();
      db.cleanup();
    },
    runtime,
    engine,
    requests: script.requests,
    sessionId,
    attach,
    submit,
    projection,
    events,
    tail,
    peek,
    terminal: terminal.promise,
    crash: () =>
      observe!({
        kind: "attachment",
        state: "failed",
        failure: { reason: "unknown", message: "The runtime stopped unexpectedly" },
      }),
  };
}
