/**
 * MCP results through the real loop on Pi 0.99 (VC-469): an error that keeps
 * its structured data, and a result too long for the model that is cut, saved
 * beside the sidecar, and read back under an enforcing authority gate.
 *
 * Everything runs for real — Pi's `Agent`, the tools, the gate, the sidecar —
 * except the provider, which is scripted one request at a time.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type Models,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  MCP_RESULT_INLINE_MAX_BYTES,
  mcpProviderToolName,
  sessionToolIds,
  type AuthoritySnapshot,
  type McpToolDefinition,
  type RuntimeMcpCallResult,
  type RuntimeObservation,
  type SessionRuntimeSpec,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { createPiAgentRuntime } from "./runtime";
import { toolOutputDirectoryFor } from "./tool-output";
import { MCP_UNTRUSTED_DATA_WARNING, SAVED_TOOL_OUTPUT_WARNING } from "./tools";

const MODEL_ID = "claude-haiku-4-5";

/** One provider request: what the model was sent, and a reply to build. */
type Step = (reply: AssistantMessage, sent: readonly Message[]) => void;

function scriptedModels(steps: Step[]): Models {
  let call = 0;
  const stream: StreamFn = (model, context) => {
    const reply: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const step = steps[call++];
    if (step === undefined) throw new Error(`no scripted step for provider call ${call}`);
    step(reply, context.messages);
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: "start", partial: reply });
      events.push({
        type: "done",
        reason: reply.stopReason === "toolUse" ? "toolUse" : "stop",
        message: reply,
      });
      events.end(reply);
    });
    return events;
  };
  const faux = fauxProvider({
    api: "anthropic-messages",
    provider: "anthropic",
    models: [{ id: MODEL_ID, reasoning: true }],
  });
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple: stream as typeof faux.provider.streamSimple,
  });
  return models;
}

function callTool(name: string, args: JsonObject, id: string): Step {
  return (reply) => {
    reply.content.push({ type: "toolCall", id, name, arguments: args });
    reply.stopReason = "toolUse";
  };
}

function say(text: string): Step {
  return (reply) => {
    reply.content.push({ type: "text", text });
  };
}

function toolResultsIn(sent: readonly Message[]): ToolResultMessage[] {
  return sent.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

const MCP_TOOL: McpToolDefinition = {
  serverId: "fixture-1",
  toolName: "issues/create",
  providerName: mcpProviderToolName("fixture-1", "GitHub Fixture", "issues/create"),
  description: "Create a fixture issue",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { url: { type: "string" }, number: { type: "integer" } },
  },
};

/** An enforcing Session, so a read of saved output has to pass the real gate. */
function attachment(answer: () => RuntimeMcpCallResult): {
  spec: SessionRuntimeSpec;
  observations: RuntimeObservation[];
  sessionDataDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "volli-tool-results-"));
  const workspacePath = join(root, "worktree");
  const sessionDataDir = join(root, "sessions");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(sessionDataDir, { recursive: true });
  writeFileSync(join(workspacePath, "MARKER.txt"), "marker\n");
  const observations: RuntimeObservation[] = [];
  const spec: SessionRuntimeSpec = {
    identity: {
      role: "ticket",
      sessionId: "session-1",
      rootThreadId: "thread-1",
      attachmentId: "attachment-1",
      projectId: "project-1",
      ticketId: "ticket-1",
    },
    workspacePath,
    venue: "local",
    model: { providerId: "anthropic", modelId: MODEL_ID, reasoningLevel: "off" },
    brief: { text: "VC-12 — file the fixture issue." },
    tools: { tools: ["read"], mcp: [MCP_TOOL] },
    mcp: { call: async () => answer() },
    observer: async (observation) => {
      observations.push(observation);
    },
  };
  const authority: AuthoritySnapshot = {
    mode: "auto",
    location: "worktree",
    enforcement: "enforce",
    judgmentMode: "ask",
    tools: sessionToolIds(spec),
    rulePackId: BUILTIN_RULE_PACK_ID,
    rulePackHash: BUILTIN_RULE_PACK_HASH,
    classifierModel: null,
    fallback: { consecutiveDenials: 3, sessionDenials: 20 },
  };
  return { spec: { ...spec, authority }, observations, sessionDataDir };
}

describe("MCP results on Pi 0.99 (VC-469)", () => {
  it("reaches the model as an error and keeps the server's structured data", async () => {
    const { spec, observations, sessionDataDir } = attachment(() => ({
      content: [{ type: "text", text: "An issue with that title already exists." }],
      structuredContent: { code: "duplicate", existing: 6 },
      isError: true,
    }));
    const sent: (readonly Message[])[] = [];
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: scriptedModels([
        callTool(MCP_TOOL.providerName, { title: "Duplicate" }, "tc-dup"),
        (reply, messages) => {
          sent.push(messages);
          say("It already exists as #6.")(reply, messages);
        },
      ]),
    });
    const handle = await runtime.startSession(spec);
    await handle.submitUserMessage("File the fixture issue.");

    // The model meets an error result: Pi's own flag, the notice, the server's
    // words, and the structured data no text block carried.
    const [result] = toolResultsIn(sent[0]!);
    expect(result).toMatchObject({
      toolCallId: "tc-dup",
      isError: true,
      content: [
        { type: "text", text: MCP_UNTRUSTED_DATA_WARNING },
        { type: "text", text: "An issue with that title already exists." },
        { type: "text", text: 'Structured content: {"code":"duplicate","existing":6}' },
      ],
    });

    // The durable record keeps it: a failed activity whose output is the
    // native result, structured data included.
    const ended = observations.filter(
      (observation) => observation.kind === "activity" && observation.state === "failed",
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      activityId: "tc-dup",
      output: {
        isError: true,
        structuredContent: { code: "duplicate", existing: 6 },
      },
    });
    // And replays it after a relaunch: a fresh runtime reopening the sidecar.
    const recovery = handle.recovery!;
    await handle.close();
    const relaunched = await createPiAgentRuntime({
      sessionDataDir,
      models: scriptedModels([]),
    }).startSession({ ...spec, recovery });
    const replay = await relaunched.reconcile(null);
    expect(replay.observations.filter((observation) => observation.kind === "activity")).toEqual(
      ended,
    );
    await relaunched.close();
  });

  it("cuts a 1 MB result for the model, saves it beside the sidecar, and lets the Session read it back", async () => {
    const whole = Array.from(
      { length: 16_384 },
      (_, index) => `row ${String(index).padStart(5, "0")} ${"·".repeat(28)}`,
    ).join("\n");
    expect(Buffer.byteLength(whole)).toBeGreaterThan(1_000_000);
    const { spec, observations, sessionDataDir } = attachment(() => ({
      content: [{ type: "text", text: whole }],
      structuredContent: { url: "https://fixture/7", number: 7 },
      isError: false,
    }));
    const sent: (readonly Message[])[] = [];
    let savedPath = "";
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: scriptedModels([
        callTool(MCP_TOOL.providerName, { title: "Huge" }, "tc-huge"),
        (reply, messages) => {
          sent.push(messages);
          const shown = JSON.stringify(toolResultsIn(messages)[0]?.content);
          savedPath =
            /\[Full output: (.+?) \(read it with offset\/limit; the output starts at line 3\)\]/u.exec(
              JSON.parse(shown)[1].text as string,
            )![1]!;
          callTool(
            "read",
            { path: savedPath, offset: 8_000, limit: 2 },
            "tc-read",
          )(reply, messages);
        },
        (reply, messages) => {
          sent.push(messages);
          say("Read the middle.")(reply, messages);
        },
      ]),
    });
    const handle = await runtime.startSession(spec);
    await handle.submitUserMessage("File it.");

    // What the model read: the start and the end around Codex's marker.
    const [cut] = toolResultsIn(sent[0]!);
    expect(cut?.isError).toBe(false);
    const shown = (cut!.content[1] as { text: string }).text;
    expect(Buffer.byteLength(shown)).toBeLessThan(MCP_RESULT_INLINE_MAX_BYTES + 1_024);
    expect(shown).toContain("row 00000 ");
    expect(shown).toContain("row 16383 ");
    expect(shown).not.toContain("row 08000 ");
    expect(shown).toMatch(/…\d+ chars truncated…/u);

    // Where the whole went: the attachment's own directory, beside its sidecar.
    const sidecar = handle.recovery!.sessionFilePath;
    expect(dirname(savedPath)).toBe(toolOutputDirectoryFor(sidecar));
    expect(
      readFileSync(savedPath, "utf8").endsWith(
        `\n\n${whole}\nStructured content: {"number":7,"url":"https://fixture/7"}`,
      ),
    ).toBe(true);
    // The sidecar holds the cut, never the megabyte.
    expect(statSync(sidecar).size).toBeLessThan(200_000);

    // The read was allowed by the enforcing gate and came back marked.
    expect(observations.some((observation) => observation.kind === "authority")).toBe(false);
    const read = toolResultsIn(sent[1]!).find((message) => message.toolCallId === "tc-read");
    expect(read?.isError).toBe(false);
    expect(read?.content[0]).toEqual({ type: "text", text: SAVED_TOOL_OUTPUT_WARNING });
    expect(JSON.stringify(read?.content)).toContain("row 07997 ");
    await handle.close();
    expect(existsSync(savedPath)).toBe(true);
  });

  it("lets every attachment its history reaches read the saved output: a carry, a relaunch, a chain", async () => {
    const whole = Array.from(
      { length: 4_096 },
      (_, index) => `entry ${index} ${"-".repeat(40)}`,
    ).join("\n");
    const { spec, observations, sessionDataDir } = attachment(() => ({
      content: [{ type: "text", text: whole }],
      isError: false,
    }));
    let savedPath = "";
    const first = await createPiAgentRuntime({
      sessionDataDir,
      models: scriptedModels([
        callTool(MCP_TOOL.providerName, { title: "Long" }, "tc-long"),
        (reply, messages) => {
          const shown = (toolResultsIn(messages)[0]!.content[1] as { text: string }).text;
          savedPath = /\[Full output: (.+?) \(/u.exec(shown)![1]!;
          say("Saved.")(reply, messages);
        },
      ]),
    }).startSession(spec);
    await first.submitUserMessage("File it.");
    const firstRecovery = first.recovery!;
    await first.close();

    /** One attachment that reads the saved file once, and what it was sent back. */
    const readOnce = async (overrides: Partial<SessionRuntimeSpec>, label: string) => {
      const sent: (readonly Message[])[] = [];
      const handle = await createPiAgentRuntime({
        sessionDataDir,
        models: scriptedModels([
          callTool("read", { path: savedPath, offset: 2_000, limit: 1 }, `tc-${label}`),
          (reply, messages) => {
            sent.push(messages);
            say("Read it.")(reply, messages);
          },
        ]),
      }).startSession({ ...spec, ...overrides });
      await handle.submitUserMessage(`Read the middle (${label}).`);
      const recovery = handle.recovery!;
      await handle.close();
      const read = toolResultsIn(sent[0]!).find((message) => message.toolCallId === `tc-${label}`);
      return { read, recovery };
    };
    const carryFrom = (recovery: typeof firstRecovery, attachmentId: string) => ({
      ...recovery,
      attachmentId,
      workspacePath: spec.workspacePath,
    });

    // B carries A: A's file is outside B's own directory, and readable.
    const b = await readOnce(
      {
        identity: { ...spec.identity, attachmentId: "attachment-b" },
        carry: carryFrom(firstRecovery, "attachment-1"),
      },
      "b",
    );
    // B relaunched: no carry any more, only its own sidecar, which names A's file.
    const bAgain = await readOnce(
      { identity: { ...spec.identity, attachmentId: "attachment-b" }, recovery: b.recovery },
      "b-again",
    );
    // C carries B, which carried A.
    const c = await readOnce(
      {
        identity: { ...spec.identity, attachmentId: "attachment-c" },
        carry: carryFrom(b.recovery, "attachment-b"),
      },
      "c",
    );

    expect(dirname(savedPath)).not.toBe(toolOutputDirectoryFor(b.recovery.sessionFilePath));
    // Every read passed the enforcing gate and came back marked as untrusted.
    expect(observations.some((observation) => observation.kind === "authority")).toBe(false);
    for (const { read } of [b, bAgain, c]) {
      expect(read?.isError).toBe(false);
      expect(read?.content[0]).toEqual({ type: "text", text: SAVED_TOOL_OUTPUT_WARNING });
      expect(JSON.stringify(read?.content)).toContain("entry 1997 ");
    }
  });
});
