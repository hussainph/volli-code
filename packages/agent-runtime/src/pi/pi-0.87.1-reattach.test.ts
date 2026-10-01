/**
 * A Session created on Pi 0.87.1 reattaches on 0.99 (VC-469).
 *
 * The sidecar is not invented: `fixtures/pi-0.87.1-sidecar.json` is the file
 * this runtime wrote on 0.87.1 for the conversation restated here — one brief,
 * an MCP call the server refused with `isError` (which 0.87.1's wrapper threw,
 * folding its structured content into the error text), a successful call whose
 * structured content rode as a text line and a `details` string, and a final
 * answer. Only the workspace path is templated, so it can be laid down under
 * any temporary directory.
 *
 * What must hold: the attachment reopens the file it names, replays every one
 * of those messages to the model exactly as they were recorded, offers exactly
 * the tools that Session was offered on 0.87.1, and keeps writing to it.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  getCurrentTools,
  type AssistantMessage,
  type Message,
  type Tool,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  mcpProviderToolName,
  type McpToolDefinition,
  type RuntimeObservation,
  type SessionRuntimeSpec,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { createPiAgentRuntime } from "./runtime";

interface Fixture {
  piVersion: string;
  sessionId: string;
  sidecarFileName: string;
  offeredTools: Tool[];
  sidecarLines: string[];
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/pi-0.87.1-sidecar.json", import.meta.url), "utf8"),
) as Fixture;

/** The definition that Session froze, exactly as 0.87.1-era discovery wrote it. */
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
};

/** Pi's one-directory-per-workspace rule for sidecars. */
function sidecarDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
}

function recordingModels(seen: Message[][]) {
  const stream: StreamFn = (model, context) => {
    seen.push([...context.messages]);
    const reply: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Still issue #7." }],
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
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: "start", partial: reply });
      events.push({ type: "done", reason: "stop", message: reply });
      events.end(reply);
    });
    return events;
  };
  const faux = fauxProvider({
    api: "anthropic-messages",
    provider: "anthropic",
    models: [{ id: "claude-haiku-4-5", reasoning: true }],
  });
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple: stream as typeof faux.provider.streamSimple,
  });
  return models;
}

describe("a Session created on Pi 0.87.1", () => {
  it("reattaches on 0.99 with its recorded conversation and tool list unchanged", async () => {
    expect(FIXTURE.piVersion).toBe("0.87.1");
    const root = mkdtempSync(join(tmpdir(), "volli-087-reattach-"));
    const workspacePath = join(root, "worktree");
    const sessionDataDir = join(root, "sessions");
    mkdirSync(workspacePath, { recursive: true });
    const directory = join(sessionDataDir, sidecarDirectoryName(workspacePath));
    mkdirSync(directory, { recursive: true });
    const sessionFilePath = join(directory, FIXTURE.sidecarFileName);
    const recorded = FIXTURE.sidecarLines.map((line) =>
      line.replaceAll("{{WORKSPACE}}", workspacePath),
    );
    writeFileSync(sessionFilePath, `${recorded.join("\n")}\n`);

    const observations: RuntimeObservation[] = [];
    const spec: SessionRuntimeSpec = {
      identity: {
        role: "ticket",
        sessionId: "session-087",
        rootThreadId: "thread-087",
        attachmentId: "attachment-087",
        projectId: "project-1",
        ticketId: "ticket-1",
      },
      workspacePath,
      venue: "local",
      model: { providerId: "anthropic", modelId: "claude-haiku-4-5", reasoningLevel: "off" },
      brief: { text: "VC-12 — file the fixture issue." },
      tools: { tools: ["read"], mcp: [MCP_TOOL] },
      mcp: {
        call: async () => {
          throw new Error("a replayed Session calls nothing until asked");
        },
      },
      recovery: { runtime: "pi", sessionId: FIXTURE.sessionId, sessionFilePath },
      observer: async (observation) => {
        observations.push(observation);
      },
    };
    const seen: Message[][] = [];
    const runtime = createPiAgentRuntime({ sessionDataDir, models: recordingModels(seen) });

    const handle = await runtime.startSession(spec);
    // The same file, not a fresh one beside it.
    expect(handle.recovery).toEqual(spec.recovery);
    // Its durable facts come back through the path a restart reads.
    const replay = await handle.reconcile(null);
    expect(
      replay.observations.flatMap((observation) =>
        observation.kind === "activity" ? [[observation.activityId, observation.state]] : [],
      ),
    ).toEqual([
      ["tc-err", "failed"],
      ["tc-ok", "completed"],
    ]);

    await handle.submitUserMessage("Which issue was it?");

    // The first request after the upgrade offers exactly 0.87.1's tools.
    expect(seen).toHaveLength(1);
    expect(getCurrentTools(seen[0]!)).toEqual(FIXTURE.offeredTools);
    // Every recorded message replays as it was written, the 0.87.1 MCP result
    // shapes included: the thrown error folded into one text block, and the
    // structured content as a text line beside a `details` string.
    const records = recorded.flatMap((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown> | Record<string, unknown>[];
      return Array.isArray(parsed) ? parsed : [parsed];
    });
    // 0.87.1-era delivery recorded the first user message in its acceptance
    // marker and every later message as an entry of its own.
    const accepted = records.find(
      (record) => (record["data"] as { kind?: unknown } | undefined)?.kind === "command-accepted",
    )?.["data"] as { message: Message };
    const entries = records.flatMap((record) =>
      record["type"] === "message" ? [record["message"] as Message] : [],
    );
    expect(entries.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const replayed = seen[0]!.filter((message) => message.role !== "system");
    expect(replayed.slice(0, -1)).toEqual([accepted.message, ...entries]);
    const results = replayed.filter(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    expect(results.map((result) => [result.toolCallId, result.isError])).toEqual([
      ["tc-err", true],
      ["tc-ok", false],
    ]);
    expect(results[1]?.details).toEqual({
      structuredContent: '{"number":7,"url":"https://fixture/7"}',
    });
    expect(replayed.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(replayed.at(-1))).toContain("Which issue was it?");

    // It keeps writing to the same file, in 0.99's shape.
    await handle.close();
    const written = readFileSync(sessionFilePath, "utf8").trimEnd().split("\n");
    expect(written.slice(0, recorded.length)).toEqual(recorded);
    expect(written.slice(recorded.length).join("\n")).toContain('"thinkingLevel":"off"');
    expect(observations.some((observation) => observation.kind === "attention")).toBe(false);
  });
});
