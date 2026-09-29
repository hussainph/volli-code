import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Model } from "@earendil-works/pi-ai";
import {
  mcpProviderToolName,
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
      new Set(["server-1:read"]),
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

  it("pins Pi's contract: no call in a parallel batch starts until every approval settles", async () => {
    const log: string[] = [];
    const [first, second] = withParallelReadEligibility(
      [definition("first"), definition("second")],
      new Set(["server-1:first", "server-1:second"]),
    );
    const { tools, toolExecution } = applyToolDispatch(
      [tool(first!.providerName, log), tool(second!.providerName, log)],
      [first!, second!],
      true,
    );
    const approval = Promise.withResolvers<void>();
    const { streamFn } = scriptedProvider([
      { toolCalls: [{ name: first!.providerName }, { name: second!.providerName }] },
      { text: "done" },
    ]);
    const agent = new Agent({
      initialState: { systemPrompt: "", model: MODEL, tools, messages: [] },
      streamFn,
      toolExecution,
      beforeToolCall: async ({ toolCall }) => {
        log.push(`approve:${toolCall.id}`);
        // The first call waits on a person; nothing may run around it.
        if (toolCall.id === "tc-1-0") await approval.promise;
        return undefined;
      },
    });

    const run = agent.prompt("go");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(log).toEqual(["approve:tc-1-0"]);
    approval.resolve();
    await run;

    expect(log).toEqual([
      "approve:tc-1-0",
      "approve:tc-1-1",
      "start:tc-1-0",
      "start:tc-1-1",
      "end:tc-1-0",
      "end:tc-1-1",
    ]);
  });
});
