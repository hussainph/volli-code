import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
  readSessionTranscriptTail,
  isSessionStreamQueue,
} from "@volli/session-engine";
import type {
  SessionEvent,
  SessionRuntimeSpec,
  RuntimeAttachmentHandle,
  McpToolDefinition,
} from "@volli/shared";
import { createPiAgentRuntime } from "@volli/agent-runtime";
import {
  scriptedProvider,
  type ScriptedReply,
} from "../../../agent-runtime/test-fixtures/scripted-provider";
import { insertProject } from "../db/projects-repo";
import { createAgentCommandService } from "../agent-commands";
import { testHostHandlers } from "../testing/host-handlers";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createSqliteSessionFollowUpLedger } from "../db/session-follow-up-repo";
import { createPiNativeAdapter, type PiAdapterOptions } from "./pi-adapter";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

const releases: Array<() => void> = [];
const realHandles: RuntimeAttachmentHandle[] = [];
let db: TestDb | undefined;
let host: ReturnType<typeof createSessionRuntime> | undefined;
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await host?.close();
  for (const handle of realHandles.splice(0)) await handle.close();
  host = undefined;
  db?.cleanup();
  db = undefined;
});

async function fixture(
  options: { replies?: ScriptedReply[]; mcp?: boolean; adapter?: Partial<PiAdapterOptions> } = {},
) {
  db = openTestDb();
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
  const script = scriptedProvider(options.replies ?? [{ text: "done" }, { text: "retried" }]);
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
  host = createSessionRuntime({
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
      resolve: async () => ({ directory, venue: { id: "local", kind: "local" } }),
      prepare: async () => ({ directory, venue: { id: "local", kind: "local" } }),
      reaffirm: async () => undefined,
    },
    clock: { now },
    ids: { next: (kind) => `runtime-${kind}-${now()}` },
  });
  const runtime = host;
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
    expect(response.ok).toBe(true);
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

function failureRows(events: readonly SessionEvent[]) {
  return events.filter((event) => event.payload.kind === "attention.raised");
}

// Only provider responses and host failures are scripted. Pi, codecs, sidecar,
// native adapter, engine and SQLite commits are real and no provider is called.
describe("silent ends audit (VC-758)", () => {
  it.each(["before stream", "between tool steps"])(
    "records a provider rejection %s durably",
    async (phase) => {
      const f = await fixture({
        replies: [
          ...(phase === "between tool steps"
            ? [{ tool: { name: "read", args: { path: "absent" } } }]
            : []),
          { throw: "Fixture provider request failed" },
        ],
      });
      expect((await f.attach()).receipt?.status).toBe("accepted");
      await f.submit();
      expect((await f.projection()).turnActive).toBe(false);
      expect(failureRows(await f.events())).toHaveLength(1);
      expect((await f.projection()).attention.active).toContainEqual(
        expect.objectContaining({
          kind: "adapter_unrecoverable",
          detail: expect.stringContaining("Fixture provider request failed"),
        }),
      );
      const peeked = await f.peek();
      expect(peeked["attention"]).toMatchObject({
        message: "Runtime stopped",
        recovery: "Retry",
        detail: expect.stringContaining("Fixture provider request failed"),
      });
      expect(peeked["transcript"]).toContainEqual(
        expect.objectContaining({ role: "user", text: "send", delivery: "Delivered" }),
      );
    },
  );

  it("records expired sign-in with one existing authentication recovery", async () => {
    const f = await fixture({ replies: [{ throw: "401 authentication_error: sign-in expired" }] });
    await f.attach();
    await f.submit();
    expect((await f.projection()).attention.active).toContainEqual(
      expect.objectContaining({ kind: "auth_required" }),
    );
    expect(failureRows(await f.events())).toHaveLength(1);
    expect((await f.projection()).turnActive).toBe(false);
  });

  it("records context assembly failing before attach", async () => {
    const f = await fixture({
      adapter: {
        resolveRuntimeContext: async () => {
          throw new Error("Context assembly failed");
        },
      },
    });
    expect((await f.attach()).receipt?.status).toBe("rejected");
    expect((await f.projection()).attention.active).toContainEqual(
      expect.objectContaining({ detail: "Context assembly failed" }),
    );
    expect(failureRows(await f.events())).toHaveLength(1);
    expect((await f.projection()).turnActive).toBe(false);
  });

  it("records MCP startup failing through the actual port resolver", async () => {
    const f = await fixture({
      mcp: true,
      adapter: {
        resolveMcpPort: () => {
          throw new Error("Tool startup failed");
        },
      },
    });
    expect((await f.attach()).receipt?.status).toBe("rejected");
    expect((await f.projection()).attention.active).toContainEqual(
      expect.objectContaining({ detail: "Tool startup failed" }),
    );
    expect(failureRows(await f.events())).toHaveLength(1);
  });

  it("keeps a failed MCP call visible while the model recovers between steps", async () => {
    const f = await fixture({
      mcp: true,
      replies: [
        { tool: { name: "mcp__fixture_read", args: {} } },
        { text: "The server refused that call" },
      ],
      adapter: {
        resolveMcpPort: () => ({
          call: async () => ({
            content: [{ type: "text", text: "Fixture server refused the call" }],
            isError: true,
          }),
          dispose: async () => undefined,
        }),
      },
    });
    await f.attach();
    await f.submit();
    const snapshot = await f.runtime.snapshot({ sessionId: f.sessionId });
    expect(
      snapshot.frames.flatMap((frame) => frame.transcript?.message.parts ?? []),
    ).toContainEqual(
      expect.objectContaining({
        type: "dynamic-tool",
        state: "output-error",
        errorText: expect.stringContaining("Fixture server refused the call"),
      }),
    );
    expect(JSON.stringify(f.requests)).toContain("Fixture server refused the call");
    expect(snapshot.projection.turnActive).toBe(false);
    expect(failureRows(await f.events())).toEqual([]);
  });

  it("preserves a runtime fatal observation as a durable recovery, not just a close", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.push(release.resolve);
    const f = await fixture({
      replies: [
        {
          text: "late output",
          wait: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      ],
    });
    await f.attach();
    await f.submit("send", "steer", true);
    await entered.promise;
    expect((await f.projection()).turnActive).toBe(true);
    await f.crash();
    expect((await f.projection()).liveExecutor).toBeNull();
    expect((await f.projection()).turnActive).toBe(false);
    expect((await f.projection()).attention.active).toContainEqual(
      expect.objectContaining({ detail: "The runtime stopped unexpectedly", attachmentId: null }),
    );
    expect(failureRows(await f.events())).toHaveLength(1);
    expect(await f.peek()).toMatchObject({
      lastTurnOutcome: "failed",
      attention: {
        message: "Runtime stopped",
        detail: "The runtime stopped unexpectedly",
        recovery: "Retry",
      },
    });
    const coldEngine = createSessionEngine({
      ledger: createSqliteSessionLedger(db!.db),
      clock: { now: () => 2000 },
      ids: { next: (kind) => `cold-${kind}` },
    });
    expect(
      (await coldEngine.getSession({ sessionId: f.sessionId }))?.attention.active,
    ).toContainEqual(
      expect.objectContaining({
        kind: "adapter_unrecoverable",
        detail: "The runtime stopped unexpectedly",
      }),
    );
    release.resolve();
    expect((await f.attach("recover")).receipt?.status).toBe("accepted");
    expect((await f.projection()).attention.active).toEqual([]);
  });

  it("records attachment preparation failing before the first model step", async () => {
    const f = await fixture({
      adapter: {
        prepareTurnAttachments: async () => {
          throw new Error("The attached file could not be read");
        },
      },
    });
    await f.attach();
    expect((await f.submit()).receipt?.status).toBe("rejected");
    // A definitive non-delivery is a rejected receipt, not a failed model turn.
    // The timeline can recover by resending; executor.retry would have no tail.
    expect((await f.events()).map((e) => e.payload)).toContainEqual(
      expect.objectContaining({
        kind: "command.receipt.recorded",
        receipt: expect.objectContaining({
          status: "rejected",
          detail: "The attached file could not be read",
        }),
      }),
    );
    expect(failureRows(await f.events())).toEqual([]);
    expect((await f.peek())["transcript"]).toContainEqual(
      expect.objectContaining({ role: "user", text: "send", delivery: "Not delivered" }),
    );
  });

  it("keeps a provider stall working without inventing a failure", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.push(release.resolve);
    const f = await fixture({
      replies: [
        {
          text: "finished",
          wait: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      ],
    });
    await f.attach();
    await f.submit("send", "steer", true);
    await entered.promise;
    expect((await f.projection()).turnActive).toBe(true);
    expect(failureRows(await f.events())).toEqual([]);
    release.resolve();
    await f.terminal;
    expect((await f.projection()).turnActive).toBe(false);
  });

  it.each(["queue", "steer"] as const)(
    "keeps %s pending until real Pi consumption",
    async (delivery) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      releases.push(release.resolve);
      const f = await fixture({
        replies: [
          {
            text: "first step",
            wait: async () => {
              entered.resolve();
              await release.promise;
            },
          },
          { text: "follow-up done" },
        ],
      });
      await f.attach();
      await f.submit("first", "steer", true);
      await entered.promise;
      const queued = Promise.withResolvers<void>();
      const releasing = Promise.withResolvers<void>();
      const drained = Promise.withResolvers<void>();
      let sawQueued = false;
      const stop = await f.runtime.subscribe(
        { sessionId: f.sessionId, afterSequence: 0 },
        (emission) => {
          if (!isSessionStreamQueue(emission)) return;
          if (emission.queue.some((item) => item.state === "queued")) {
            sawQueued = true;
            queued.resolve();
          }
          if (emission.queue.some((item) => item.state === "releasing")) releasing.resolve();
          if (sawQueued && emission.queue.length === 0) drained.resolve();
        },
      );
      expect((await f.submit("queued", "queue")).receipt?.status).toBe("accepted");
      await queued.promise;
      expect((await f.projection()).queue).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ id: "queued" }),
          state: "queued",
        }),
      );
      expect((await f.projection()).turnActive).toBe(true);
      expect(JSON.stringify((await f.tail()).entries)).not.toContain('"text":"queued"');
      let steered: ReturnType<typeof f.submit> | undefined;
      if (delivery === "steer") {
        steered = f.submit("steer-command", "steer", true, "queued");
        await releasing.promise;
        expect((await f.projection()).queue?.[0]?.state).toBe("releasing");
      }
      release.resolve();
      if (steered) expect((await steered).receipt?.status).toBe("accepted");
      await drained.promise;
      stop();
      const tail = await f.tail();
      expect(
        tail.entries.filter((entry) => entry.role === "user" && entry.text.includes("queued")),
      ).toHaveLength(1);
      expect((await f.projection()).queue).toEqual([]);
    },
  );

  it("records deliberate cancellation without failure Attention", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.push(release.resolve);
    const f = await fixture({
      replies: [
        {
          text: "cancelled",
          wait: async (signal) => {
            signal!.addEventListener("abort", () => release.resolve(), { once: true });
            entered.resolve();
            await release.promise;
          },
        },
      ],
    });
    await f.attach();
    await f.submit("send", "steer", true);
    await entered.promise;
    const interrupted = f.runtime.command({
      commandId: "interrupt",
      sessionId: f.sessionId,
      command: { kind: "executor.interrupt" },
    });
    await interrupted;
    await f.terminal;
    expect((await f.events()).some((e) => e.payload.kind === "turn.interrupted")).toBe(true);
    expect(failureRows(await f.events())).toEqual([]);
  });
});
