/** Refresh across the real Pi adapter, SQLite ledger and Session engine. */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_CODE_MODE_LIMITS, type SessionInput, type McpToolDefinition } from "@volli/shared";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import {
  scriptedOpusProvider,
  type ScriptedReply,
} from "../../../agent-runtime/test-fixtures/code-mode-images-provider";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";
import { createPiNativeAdapter, type PiRuntimeContext } from "./pi-adapter";
import {
  additiveToolRefresh,
  effectiveToolSurface,
  declarationToolSurface,
  foldToolRefreshes,
} from "./tool-refresh";
import { McpSessionHost } from "../mcp/session-host";
import { createMcpProtocolClientOpener } from "../mcp/client";
import { MemoryMcpCredentialStore } from "../mcp/credential-store";

type Surface = Extract<SessionInput, { kind: "tool-surface" }>;
const MODEL = {
  providerId: "anthropic",
  modelId: "claude-opus-5-5",
  reasoningLevel: "off",
} as const;
const provenance = {
  source: { kind: "system", id: "pi-runtime", detail: null },
  venue: null,
} as const;
const ignoreCall = (_tool: string) => {};
let clock = Date.now();
let db: TestDb;
let runtime: ReturnType<typeof createSessionRuntime>;
afterEach(async () => {
  await runtime?.close();
  db?.cleanup();
});

async function fixture(birth: Surface, initial: Surface, supportsMidConvoSystemMessages?: boolean) {
  db = openTestDb();
  const root = dirname(db.dbPath);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  insertProject(db.db, testProject({ id: "project-refresh", path: workspace }));
  const replies: ScriptedReply[] = [];
  const script = scriptedOpusProvider(replies);
  if (supportsMidConvoSystemMessages !== undefined) {
    Object.assign(script.models.getModel(MODEL.providerId, MODEL.modelId)!, {
      compat: { supportsMidConvoSystemMessages },
    });
  }
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(db.db),
    clock: { now: () => clock++ },
    ids: { next: (kind) => `${kind}-${clock++}` },
  });
  let candidate = initial;
  let disposed = 0;
  const called: string[] = [];
  let onCall: (tool: string) => void = ignoreCall;
  const context = async (sessionId: string): Promise<PiRuntimeContext> => {
    const events = await engine.listEvents({ sessionId });
    const surface = effectiveToolSurface(events);
    if (surface === null) throw new Error("Missing surface");
    return {
      toolRefreshAnnouncements: foldToolRefreshes(events).announcements,
      role: "project",
      projectId: "project-refresh",
      ticketId: null,
      rootThreadId: sessionRootThreadId(sessionId),
      brief: "Test tool refresh.",
      model: MODEL,
      toolSurface: surface.tools,
      declarationSurface: declarationToolSurface(events) ?? undefined,
      refreshDescriptions: surface.refreshDescriptions,
      codeMode: surface.codeMode,
      mcpTools: surface.mcpTools,
      promptResources: [],
    };
  };
  const adapter = createPiNativeAdapter({
    now: () => clock++,
    sessionDataDir: join(root, "pi"),
    models: script.models,
    usageLimits: {
      fetch: async () => {
        throw new Error("No network");
      },
    },
    resolveRuntimeContext: context,
    refreshRuntimeContext: async (sessionId, request) => {
      const events = await engine.listEvents({ sessionId });
      const current = effectiveToolSurface(events);
      if (current === null) throw new Error("Missing surface");
      const refresh = additiveToolRefresh(
        current,
        candidate,
        request.trigger,
        declarationToolSurface(events) ?? current,
      );
      await engine.recordToolRefresh({
        sessionId,
        trigger: request.trigger,
        ...refresh,
        provenance,
      });
      return context(sessionId);
    },
    resolveMcpPort: () => {
      const transport = new McpSessionHost({
        workspacePath: workspace,
        servers: [
          {
            id: "paper",
            name: "Refresh fixture",
            enabled: true,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: [fileURLToPath(new URL("./fixtures/refresh-mcp-server.mjs", import.meta.url))],
            },
          },
        ],
        open: createMcpProtocolClientOpener({
          sources: () => ({ store: new MemoryMcpCredentialStore(), environment: {} }),
        }),
      });
      return {
        call: async (request, signal, ask) => {
          called.push(request.toolName);
          const result = await transport.port.call(request, signal, ask);
          onCall(request.toolName);
          return result;
        },
        dispose: async () => {
          await transport.close();
          disposed++;
        },
      };
    },
  });
  runtime = createSessionRuntime({
    engine,
    executor: adapter,
    artifacts: createFileTranscriptArtifactStore(join(root, "transcripts")),
    locations: {
      resolve: async () => ({ directory: workspace, venue: { id: "local", kind: "local" } }),
      prepare: async () => ({ directory: workspace, venue: { id: "local", kind: "local" } }),
      reaffirm: async () => undefined,
    },
    clock: { now: () => clock++ },
    ids: { next: (kind) => `rt-${kind}-${clock++}` },
  });
  const created = await runtime.command({
    commandId: `create-${clock++}`,
    command: {
      kind: "session.create",
      projectId: "project-refresh",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Refresh",
    },
  });
  const sessionId = created.sessionId;
  await engine.getOrRecordSessionInput({ sessionId, input: birth, provenance });
  const attached = await runtime.command({
    commandId: `attach-${clock++}`,
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  expect(attached.receipt?.status, JSON.stringify(attached)).toBe("accepted");
  async function turn() {
    const result = await runtime.command({
      commandId: `message-${clock++}`,
      sessionId,
      command: {
        kind: "message.submit",
        message: { id: `user-${clock++}`, role: "user", parts: [{ type: "text", text: "Go" }] },
      },
    });
    expect(result.receipt?.status, JSON.stringify(result)).toBe("accepted");
  }
  return {
    engine,
    sessionId,
    script,
    replies,
    turn,
    called,
    disposed: () => disposed,
    select: (value: Surface) => {
      candidate = value;
    },
    onCall: (callback: (tool: string) => void) => {
      onCall = callback;
    },
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    reattach: async () => {
      const snapshot = await runtime.snapshot({ sessionId });
      await runtime.command({
        commandId: `release-${clock++}`,
        sessionId,
        command: { kind: "adapter.release", attachmentId: snapshot.projection.liveExecutor!.id },
      });
      const result = await runtime.command({
        commandId: `reattach-${clock++}`,
        sessionId,
        command: { kind: "adapter.attach", continuity: "context_replay" },
      });
      expect(result.receipt?.status, JSON.stringify(result)).toBe("accepted");
    },
  };
}
const legacy: Surface = {
  kind: "tool-surface",
  tools: ["read", "codemode"],
  codeMode: { routes: { read: "both" }, limits: DEFAULT_CODE_MODE_LIMITS },
};
const tool: McpToolDefinition = {
  serverId: "paper",
  toolName: "lookup",
  providerName: "mcp__paper__lookup__12345678",
  description: "Lookup",
  inputSchema: { type: "object", properties: {} },
};

describe("Session tool refresh through Pi", { timeout: 20_000 }, () => {
  it("makes an install made by one program callable by the next in the same turn", async () => {
    const install = {
      ...tool,
      toolName: "install",
      providerName: "mcp__paper__install__12345678",
    } as const;
    const modern: Surface = {
      ...legacy,
      tools: [...legacy.tools, install.providerName],
      mcpTools: [install],
      codeMode: {
        ...legacy.codeMode!,
        descriptionVersion: 2,
        routes: { ...legacy.codeMode!.routes, [install.providerName]: "deferred" },
      },
    };
    const f = await fixture(modern, modern);
    f.onCall((name) => {
      if (name === "install")
        f.select({
          ...modern,
          tools: [...modern.tools, tool.providerName],
          mcpTools: [install, tool],
          codeMode: {
            ...modern.codeMode!,
            routes: { ...modern.codeMode!.routes, [tool.providerName]: "deferred" },
          },
        });
    });
    f.replies.push(
      {
        tool: {
          name: "codemode",
          args: { code: "text(await tools.mcp__paper__install__12345678({}));" },
        },
      },
      {
        tool: {
          name: "codemode",
          args: {
            code: 'text(await describeTool("mcp__paper__lookup__12345678")); text(await tools.mcp__paper__lookup__12345678({}));',
          },
        },
      },
      { text: "Installed and used" },
    );
    await f.turn();
    expect(f.called).toEqual(["install", "lookup"]);
    const events = await f.engine.listEvents({ sessionId: f.sessionId });
    expect(events.filter((event) => event.payload.kind === "session.tools.refreshed")).toHaveLength(
      1,
    );
    expect(
      events.find((event) => event.payload.kind === "session.tools.refreshed")?.payload,
    ).toMatchObject({
      trigger: expect.stringMatching(/^(code-mode|warm-turn)$/),
      added: [tool.providerName],
    });
    expect(JSON.stringify(f.script.requests[1]?.[0])).toBe(
      JSON.stringify(f.script.requests[0]?.[0]),
    );
    await runtime.close();
    expect(f.disposed()).toBe(2);
  });

  it("upgrades legacy Code Mode once on a cold turn and records the immutable birth separately", async () => {
    const f = await fixture(legacy, {
      ...legacy,
      codeMode: { ...legacy.codeMode!, descriptionVersion: 2 },
    });
    f.replies.push({ text: "Done" });
    await f.turn();
    const events = await f.engine.listEvents({ sessionId: f.sessionId });
    const refreshed = events.filter((event) => event.payload.kind === "session.tools.refreshed");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.payload).toMatchObject({ trigger: "cold-turn", changed: ["codemode"] });
    const birth = events.find((event) => event.payload.kind === "session.input.recorded");
    expect(birth?.payload).toEqual({ kind: "session.input.recorded", input: legacy });
    f.replies.push({ text: "Done again" });
    await f.turn();
    expect(
      (await f.engine.listEvents({ sessionId: f.sessionId })).filter(
        (event) => event.payload.kind === "session.tools.refreshed",
      ),
    ).toHaveLength(1);
  });

  it.each([true, false])(
    "adds and calls a deferred MCP tool warm, announces once when compatible (mid-conversation system support=%s)",
    async (supportsMidConvoSystemMessages) => {
      const modern = {
        ...legacy,
        codeMode: { ...legacy.codeMode!, descriptionVersion: 2 as const },
      };
      const f = await fixture(modern, modern, supportsMidConvoSystemMessages);
      f.replies.push({ text: "First" });
      await f.turn();
      const firstHead = JSON.stringify(f.script.requests[0]?.[0]);
      f.select({
        ...modern,
        tools: [...modern.tools, tool.providerName],
        mcpTools: [tool],
        codeMode: {
          ...modern.codeMode,
          routes: { ...modern.codeMode.routes, [tool.providerName]: "deferred" },
        },
      });
      f.replies.push(
        {
          tool: {
            name: "codemode",
            args: {
              code: 'const found = await searchTools("lookup"); text(found); text(await tools.mcp__paper__lookup__12345678({}));',
            },
          },
        },
        { text: "Second" },
      );
      await f.turn();
      expect(f.called).toEqual(["lookup"]);
      expect(JSON.stringify(f.script.requests[1]?.[0])).toBe(firstHead);
      const notices = f.script.requests[2]?.filter(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message).includes("Tools added through Code Mode"),
      );
      expect(notices).toHaveLength(supportsMidConvoSystemMessages ? 1 : 0);
      expect(
        f.script.requests[2]?.filter((message) =>
          JSON.stringify(message).includes("volliToolRefreshId"),
        ),
      ).toHaveLength(supportsMidConvoSystemMessages ? 1 : 0);
      const events = await f.engine.listEvents({ sessionId: f.sessionId });
      expect(
        events.filter((event) => event.payload.kind === "session.tools.refreshed"),
      ).toHaveLength(1);
      expect(effectiveToolSurface(events)?.tools).toContain(tool.providerName);
      await f.reattach();
      f.replies.push({ text: "Warm after reattach" });
      await f.turn();
      expect(JSON.stringify(f.script.requests[3]?.[0])).toBe(firstHead);
      expect(
        f.script.requests[3]?.filter((message) =>
          JSON.stringify(message).includes("volliToolRefreshId"),
        ),
      ).toHaveLength(supportsMidConvoSystemMessages ? 1 : 0);
      expect(
        (await f.engine.listEvents({ sessionId: f.sessionId })).filter(
          (event) => event.payload.kind === "session.tools.refreshed",
        ),
      ).toHaveLength(1);
      f.advance(60 * 60_000 + 1);
      f.replies.push({ text: "Cold publishes the deferred namespace" });
      await f.turn();
      expect(JSON.stringify(f.script.requests[4]?.[0])).not.toBe(firstHead);
      expect(JSON.stringify(f.script.requests[4]?.[0])).toContain("mcp:paper");
      expect(
        f.script.requests[4]?.filter(
          (message) =>
            message.role === "system" &&
            JSON.stringify(message).includes("Tools added through Code Mode"),
        ),
      ).toHaveLength(1);
      expect(
        f.script.requests[4]?.filter((message) =>
          JSON.stringify(message).includes("volliToolRefreshId"),
        ),
      ).toHaveLength(1);
      const published = (await f.engine.listEvents({ sessionId: f.sessionId })).filter(
        (event) => event.payload.kind === "session.tools.refreshed",
      );
      expect(published).toHaveLength(2);
      expect(published[1]?.payload).toMatchObject({
        trigger: "cold-turn",
        added: [],
        changed: ["codemode"],
      });
      await runtime.close();
      expect(f.disposed()).toBe(2);
    },
  );
});
