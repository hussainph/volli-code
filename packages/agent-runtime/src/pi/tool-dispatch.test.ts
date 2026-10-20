import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Model } from "@earendil-works/pi-ai";
import {
  mcpProviderToolName,
  mcpToolKey,
  withParallelReadEligibility,
  type McpToolDefinition,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { scriptedProvider } from "../../bench/parallel-tools/harness";
import { applyToolDispatch } from "./tool-dispatch";

const MODEL = {
  id: "dispatch-fixture",
  api: "anthropic-messages",
  provider: "dispatch-fixture",
  name: "dispatch fixture",
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<string>;

function definition(toolName: string): McpToolDefinition {
  return {
    serverId: "server-1",
    toolName,
    providerName: mcpProviderToolName("server-1", "Fixture", toolName),
    description: "Read-only and safe to run concurrently.",
    inputSchema: { type: "object" },
  };
}

function tool(name: string, log: string[]): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    async execute(toolCallId) {
      log.push(`start:${toolCallId}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      log.push(`end:${toolCallId}`);
      return { content: [{ type: "text" as const, text: name }], details: undefined };
    },
  };
}

describe("applyToolDispatch", () => {
  it("hands an unmarked Session its tools untouched and sequential", () => {
    const log: string[] = [];
    const tools = [tool("write", log), tool(definition("read").providerName, log)];
    const dispatch = applyToolDispatch(tools, [definition("read")], true);
    expect(dispatch.toolExecution).toBe("sequential");
    expect(dispatch.tools).toEqual(tools);
    expect(dispatch.tools[0]).toBe(tools[0]);
  });

  it("marks everything but the Session's host-marked reads sequential", () => {
    const log: string[] = [];
    const [read, mutate] = withParallelReadEligibility(
      [definition("read"), definition("mutate")],
      new Set([mcpToolKey(definition("read"))]),
    );
    const tools = [
      tool("write", log),
      tool(read!.providerName, log),
      tool(mutate!.providerName, log),
    ];
    const dispatch = applyToolDispatch(tools, [read!, mutate!], true);
    expect(dispatch.toolExecution).toBe("parallel");
    expect(dispatch.tools.map((entry) => entry.executionMode)).toEqual([
      "sequential",
      undefined,
      "sequential",
    ]);
    expect(dispatch.tools.map((entry) => entry.name)).toEqual(tools.map((entry) => entry.name));
    // The kill switch: the same marks on a runtime that does not honour them.
    expect(applyToolDispatch(tools, [read!, mutate!], false).toolExecution).toBe("sequential");
  });

  it("never lets a codemode call overlap direct MCP reads in one batch (VC-471)", async () => {
    // `codemode` is not a marked read, so a parallel Session marks it
    // sequential — and Pi runs a batch holding one sequential call one call at
    // a time, in source order. A program's own nested reads still overlap
    // inside the run; the run never overlaps anything the model called directly.
    const log: string[] = [];
    const [read] = withParallelReadEligibility(
      [definition("read")],
      new Set([mcpToolKey(definition("read"))]),
    );
    const { tools, toolExecution } = applyToolDispatch(
      [tool("codemode", log), tool(read!.providerName, log)],
      [read!],
      true,
    );
    expect(toolExecution).toBe("parallel");
    expect(tools.map((entry) => entry.executionMode)).toEqual(["sequential", undefined]);
    const { streamFn } = scriptedProvider([
      {
        toolCalls: [
          { name: read!.providerName },
          { name: "codemode" },
          { name: read!.providerName },
        ],
      },
      { text: "done" },
    ]);
    const agent = new Agent({
      initialState: { systemPrompt: "", model: MODEL, tools, messages: [] },
      streamFn,
      toolExecution,
    });
    await agent.prompt("go");
    expect(log).toEqual([
      "start:tc-1-0",
      "end:tc-1-0",
      "start:tc-1-1",
      "end:tc-1-1",
      "start:tc-1-2",
      "end:tc-1-2",
    ]);
  });
});
