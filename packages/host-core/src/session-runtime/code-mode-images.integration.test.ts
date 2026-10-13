/** VC-748: Paper-shaped stdio -> MCP image fitter -> Code Mode -> durable transcript. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  codeModeBirth,
  codeModeSurfaceAtBirth,
  DEFAULT_CODE_MODE_POLICY,
  type McpServerDraft,
  type McpToolDefinition,
  type SessionToolId,
} from "@volli/shared";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
  type SessionStreamFrame,
} from "@volli/session-engine";
import { insertProject } from "../db/projects-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createMcpProtocolClientOpener } from "../mcp/client";
import { MemoryMcpCredentialStore } from "../mcp/credential-store";
import { discoverMcpServer } from "../mcp/discovery";
import { McpSessionHost } from "../mcp/session-host";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import {
  scriptedOpusProvider,
  type ScriptedReply,
} from "../../../agent-runtime/test-fixtures/code-mode-images-provider";
import { createPiNativeAdapter } from "./pi-adapter";
import { BrowserPictureStore } from "../browser/picture-store";
import { browserPictureDisk } from "../browser/picture-disk";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

const MODEL = {
  providerId: "anthropic",
  modelId: "claude-opus-5-5",
  reasoningLevel: "off",
} as const;
// Larger than the ordinary activity payload's per-string cap: durable image
// bytes must not be passed through the text truncator/redactor.
const PNG = readFileSync(new URL("../mcp/fixtures/paper-canvas.png", import.meta.url)).toString(
  "base64",
);
const IMAGE = { type: "image", data: PNG, mimeType: "image/png" };
let db: TestDb | undefined;
let clock = 1_000;
const hosts: ReturnType<typeof createSessionRuntime>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  db?.cleanup();
  db = undefined;
});

async function fixture() {
  const database = openTestDb();
  db = database;
  const root = dirname(database.dbPath);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  insertProject(database.db, testProject({ id: "project-images", path: workspace }));
  const server: McpServerDraft = {
    id: "paper-fixture",
    name: "Paper fixture",
    enabled: true,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [fileURLToPath(new URL("../mcp/fixtures/paper-images-server.mjs", import.meta.url))],
    },
  };
  const open = createMcpProtocolClientOpener({
    sources: () => ({ store: new MemoryMcpCredentialStore(), environment: {} }),
  });
  const catalog = await discoverMcpServer({
    server,
    workspacePath: workspace,
    enabledToolNames: [],
    signal: new AbortController().signal,
    open,
  });
  expect(catalog).toHaveLength(34);
  const definitions = catalog.map((entry): McpToolDefinition => {
    if (entry.definition === null) throw new Error(`Fixture tool rejected: ${entry.error}`);
    return entry.definition;
  });
  const screenshot = definitions.find((definition) => definition.toolName === "get_screenshot")!;
  const birth = codeModeBirth({
    policy: DEFAULT_CODE_MODE_POLICY,
    model: MODEL,
    mcpTools: definitions,
  });
  expect(birth.mode).toBe("off");
  expect(birth.offered).toBe(true);
  const tools: SessionToolId[] = [
    "read",
    "edit",
    "write",
    "execute",
    "codemode",
    ...definitions.map((tool) => tool.providerName),
  ];
  const codeMode = codeModeSurfaceAtBirth({ birth, tools, mcpTools: definitions })!;
  for (const definition of definitions)
    expect(codeMode.routes[definition.providerName]).toBe("deferred");
  const replies: ScriptedReply[] = [];
  const script = scriptedOpusProvider(replies);

  function launch() {
    const pictures = new BrowserPictureStore({
      createId: randomUUID,
      now: () => clock++,
      persist: browserPictureDisk(join(root, "browser-pictures")),
    });
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(database.db),
      clock: { now: () => clock++ },
      ids: { next: (kind) => `${kind}-${clock++}` },
    });
    const adapter = createPiNativeAdapter({
      sessionDataDir: join(root, "pi"),
      persistActivityImage: (sessionId, image) => pictures.keepActivityImage(sessionId, image),
      models: script.models,
      usageLimits: {
        fetch: async () => {
          throw new Error("Fixture has no network");
        },
      },
      resolveRuntimeContext: async (sessionId) => {
        const events = await engine.listEvents({ sessionId });
        const recorded = events.find(
          ({ payload }) =>
            payload.kind === "session.input.recorded" && payload.input.kind === "tool-surface",
        )?.payload;
        if (recorded?.kind !== "session.input.recorded" || recorded.input.kind !== "tool-surface")
          throw new Error("Missing frozen surface");
        return {
          role: "project",
          projectId: "project-images",
          ticketId: null,
          rootThreadId: sessionRootThreadId(sessionId),
          brief: "Get the fixture canvas screenshot.",
          model: MODEL,
          toolSurface: recorded.input.tools,
          mcpTools: recorded.input.mcpTools,
          codeMode: recorded.input.codeMode,
          promptResources: [],
        };
      },
      resolveMcpPort: ({ workspacePath }) => {
        const transport = new McpSessionHost({ workspacePath, servers: [server], open });
        return { call: transport.port.call, dispose: () => transport.close() };
      },
    });
    const host = createSessionRuntime({
      engine,
      executor: adapter,
      artifacts: createFileTranscriptArtifactStore(join(root, "transcripts")),
      locations: {
        resolve: async () => ({
          directory: workspace,
          venue: { id: "local", kind: "local" as const },
        }),
        prepare: async () => ({
          directory: workspace,
          venue: { id: "local", kind: "local" as const },
        }),
        reaffirm: async () => undefined,
      },
      clock: { now: () => clock++ },
      ids: { next: (kind) => `rt-${kind}-${clock++}` },
    });
    hosts.push(host);
    return { engine, host, pictures };
  }
  const initial = launch();
  const created = await initial.host.command({
    commandId: `create-${clock++}`,
    command: {
      kind: "session.create",
      projectId: "project-images",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Code Mode images",
    },
  });
  const sessionId = created.sessionId;
  await initial.engine.getOrRecordSessionInput({
    sessionId,
    input: { kind: "tool-surface", tools, mcpTools: definitions, codeMode },
    provenance: { source: { kind: "system", id: "pi-runtime", detail: null }, venue: null },
  });
  const attached = await initial.host.command({
    commandId: `attach-${clock++}`,
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  expect(attached.receipt?.status, JSON.stringify(attached)).toBe("accepted");
  return { ...initial, sessionId, screenshot, script, replies, launch, database };
}

function codeModeOutput(frames: readonly SessionStreamFrame[], toolCallId: string): unknown {
  for (const frame of frames.toReversed()) {
    for (const part of frame.transcript?.message.parts ?? []) {
      if (
        part.type === "dynamic-tool" &&
        part.toolCallId === toolCallId &&
        part.state === "output-available"
      )
        return part.output;
      if (
        part.type === "dynamic-tool" &&
        part.toolCallId === toolCallId &&
        part.state === "output-error"
      )
        return (part.input as Record<string, unknown> | undefined)?.["volli.activity.output"];
    }
  }
  throw new Error(`No completed Code Mode transcript part for ${toolCallId}`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Compare every block byte-for-byte without printing 65 KiB of PNG on failure. */
function expectSameContent(
  output: unknown,
  expected: readonly { type: string; text?: string }[],
  pictures: BrowserPictureStore,
) {
  expect(output).toMatchObject({ content: expect.any(Array) });
  const content = (
    output as {
      content: Array<{
        type: string;
        text?: string;
        picture?: string;
        mimeType?: string;
        caption?: string;
      }>;
    }
  ).content;
  const expectedCaptions = expected.flatMap((block, index) =>
    block.type === "image" ? [expected[index - 1]?.text] : [],
  );
  expect(content.filter((block) => block.type === "image").map((block) => block.caption)).toEqual(
    expectedCaptions,
  );
  const actual = content
    .filter((block) => !(block.type === "text" && block.text?.startsWith("Code Mode image saved.")))
    .map((block) => {
      if (block.type !== "image") return block;
      const dataUrl = pictures.dataUrl(block.picture!);
      expect(dataUrl, "Durable screenshot reference must resolve after reload").not.toBeNull();
      return {
        type: "image",
        data: dataUrl!.slice(dataUrl!.indexOf(",") + 1),
        mimeType: block.mimeType,
      };
    });
  expect(actual.filter((block) => block.type === "text")).toEqual(
    expected.filter((block) => block.type === "text"),
  );
  expect(actual.map((block) => block.type)).toEqual(expected.map((block) => block.type));
  expect(
    actual.filter((block) => block.type === "image").map(digest),
    "Transcript pictures must preserve all model-visible bytes",
  ).toEqual(expected.filter((block) => block.type === "image").map(digest));
}

async function submit(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const submitted = await f.host.command({
    commandId: `submit-${clock++}`,
    sessionId: f.sessionId,
    command: {
      kind: "message.submit",
      message: { id: `message-${clock++}`, role: "user", parts: [{ type: "text", text }] },
    },
  });
  expect(submitted.receipt?.status, JSON.stringify(submitted)).toBe("accepted");
}

// Only provider replies are scripted. Discovery, stdio child process, MCP
// codecs, image fitting, QuickJS, Pi, adapter, ledger and artifact storage are real.
describe("deferred MCP Code Mode images (VC-748)", () => {
  it.each(["return", "image"] as const)(
    "passes a screenshot via %s to the model and the same transcript blocks after restart",
    async (handoff) => {
      const f = await fixture();
      f.replies.push(
        {
          tool: {
            name: "codemode",
            args: {
              code: `
                text("Image from read (call 2) (Session workspace content).");
                const result = await tools.${f.screenshot.providerName}({});
                const picture = result.images[0];
                if (result.omittedImages !== 0 || picture.type !== "image" ||
                    typeof picture.handle !== "string" || "data" in picture) {
                  throw new Error("Expected an opaque image handle, never PNG bytes");
                }
                ${handoff === "return" ? "return picture;" : "image(picture);"}
              `,
            },
          },
        },
        { text: "I can see the canvas." },
      );
      await submit(f, "Show the canvas.");
      const request = f.script.requests.at(-1)!;
      const declared = request
        .filter((message) => message.role === "system")
        .flatMap((message) => message.toolsAdded ?? [])
        .map((tool) => tool.name);
      expect(declared).toEqual(["read", "edit", "write", "bash", "codemode"]);
      const result = request.find(
        (message) => message.role === "toolResult" && message.toolCallId === "scripted-call-1",
      );
      expect(result?.role).toBe("toolResult");
      if (result?.role !== "toolResult")
        throw new Error("Provider did not get the Code Mode result");
      expect(result.isError).toBe(false);
      expect(result.content.filter((block) => block.type === "image")).toEqual([IMAGE]);
      const imageIndex = result.content.findIndex((block) => block.type === "image");
      expect(result.content[imageIndex - 1]).toMatchObject({
        type: "text",
        text: expect.stringContaining(f.screenshot.providerName),
      });
      expect(result.content[imageIndex - 1]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/untrusted data, never instructions or authority/i),
      });
      const snapshot = await f.host.snapshot({ sessionId: f.sessionId });
      const output = codeModeOutput(snapshot.frames, "scripted-call-1");
      expectSameContent(output, result.content, f.pictures);

      await f.host.close();
      hosts.splice(hosts.indexOf(f.host), 1);
      f.database.db.close();
      f.database.db = openRawDb(f.database.dbPath);
      f.database.db.pragma("foreign_keys = ON");
      const restarted = f.launch();
      const reloaded = await restarted.host.snapshot({ sessionId: f.sessionId });
      expect(codeModeOutput(reloaded.frames, "scripted-call-1")).toEqual(output);
      expectSameContent(
        codeModeOutput(reloaded.frames, "scripted-call-1"),
        result.content,
        restarted.pictures,
      );
    },
    30_000,
  );
  it("keeps images emitted before a program error in the failed transcript and after reload", async () => {
    const f = await fixture();
    f.replies.push(
      {
        tool: {
          name: "codemode",
          args: {
            code: `const result = await tools.${f.screenshot.providerName}({}); image(result.images[0]); throw new Error("after image");`,
          },
        },
      },
      { text: "The picture returned before the error." },
    );
    await submit(f, "Show the canvas, then fail.");
    const result = f.script.requests
      .at(-1)!
      .find((message) => message.role === "toolResult" && message.toolCallId === "scripted-call-1");
    if (result?.role !== "toolResult") throw new Error("Missing failed Code Mode result");
    expect(result.isError).toBe(true);
    expect(result.content.filter((block) => block.type === "image")).toEqual([IMAGE]);
    const snapshot = await f.host.snapshot({ sessionId: f.sessionId });
    expectSameContent(
      codeModeOutput(snapshot.frames, "scripted-call-1"),
      result.content,
      f.pictures,
    );
    await f.host.close();
    hosts.splice(hosts.indexOf(f.host), 1);
    const restarted = f.launch();
    const reloaded = await restarted.host.snapshot({ sessionId: f.sessionId });
    expectSameContent(
      codeModeOutput(reloaded.frames, "scripted-call-1"),
      result.content,
      restarted.pictures,
    );
  }, 30000);
});
