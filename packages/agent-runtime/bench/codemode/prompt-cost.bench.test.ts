/**
 * What Code Mode costs the Cache Prefix, and what routing a large MCP server
 * away from the declarations saves (VC-471, §2 "large tool sets").
 *
 * Offline and free: it builds a Ticket Session's real tool array — Volli's
 * own tools from `createSessionTools`, plus N synthetic MCP tools shaped like
 * a real server's (a two-sentence description, three to five typed
 * parameters) — and counts the tokens the provider would be sent for the
 * declarations under each routing:
 *
 * - `direct`: no Code Mode, every MCP tool declared.
 * - `both`: mode `both` — Code Mode added, every tool still declared.
 * - `code`: mode `both` with the MCP server routed `code` — listed in the
 *   codemode description, under its declaration budget, and not declared.
 * - `deferred`: mode `both` with the MCP server routed `deferred` — only
 *   counted in the codemode description; a program finds its tools with
 *   `searchTools()`. What a large server gets at birth, whatever the mode.
 * - `only`: mode `only` — every capability group a program can call whole is
 *   routed `code`; a group with a direct-only member stays declared.
 *
 * Tokens are o200k counts of each tool's name, description and JSON Schema,
 * the part every provider serializes; provider framing adds a constant.
 *
 *   pnpm -C packages/agent-runtime exec vp test run --config vite.bench.config.ts bench/codemode/prompt-cost.bench.test.ts
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  codeModeSurfaceFor,
  DEFAULT_CODE_MODE_LIMITS,
  mcpProviderToolName,
  sessionToolIds,
  type McpToolDefinition,
  type RuntimeMcpPort,
  type SessionRuntimeSpec,
} from "@volli/shared";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vite-plus/test";

import { CodeModeJournal } from "../../src/codemode/journal";
import { createCodeModeTool } from "../../src/codemode/tool";
import { createSessionTools } from "../../src/pi/tools";

const NOUNS = [
  "issue",
  "pull request",
  "commit",
  "branch",
  "release",
  "workflow",
  "label",
  "milestone",
  "comment",
  "review",
];
const VERBS = ["get", "list", "search", "create", "update", "close", "merge", "assign"];

function syntheticServer(count: number): McpToolDefinition[] {
  return Array.from({ length: count }, (_, index) => {
    const noun = NOUNS[index % NOUNS.length]!;
    const verb = VERBS[Math.floor(index / NOUNS.length) % VERBS.length]!;
    const toolName = `${verb}_${noun.replace(" ", "_")}${index >= 80 ? `_${index}` : ""}`;
    return {
      serverId: "github",
      toolName,
      providerName: mcpProviderToolName("github", "GitHub", toolName),
      description: `${verb[0]!.toUpperCase()}${verb.slice(1)} a ${noun} in a repository the token can see. Returns the ${noun} as JSON, including its number, state, author and timestamps.`,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner." },
          repo: { type: "string", description: "Repository name." },
          ...(verb === "list" || verb === "search"
            ? {
                query: { type: "string", description: `Filter ${noun}s by this text.` },
                perPage: { type: "number", description: "Results per page, at most 100." },
              }
            : { number: { type: "number", description: `The ${noun} number.` } }),
          ...(verb === "create" || verb === "update"
            ? { body: { type: "string", description: `The ${noun}'s new body, as Markdown.` } }
            : {}),
        },
        required: ["owner", "repo"],
      },
    };
  });
}

const port: RuntimeMcpPort = { call: async () => ({ content: [], isError: false }) };

function declarationTokens(tools: readonly AgentTool[]): number {
  return tools.reduce(
    (sum, tool) =>
      sum + countTokens(`${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`),
    0,
  );
}

function spec(mcp: readonly McpToolDefinition[]): SessionRuntimeSpec {
  return {
    identity: {
      role: "ticket",
      sessionId: "s",
      rootThreadId: "t",
      attachmentId: "a",
      projectId: "p",
      ticketId: "k",
    },
    workspacePath: "/tmp",
    venue: "local",
    model: { providerId: "anthropic", modelId: "claude-haiku-4-5", reasoningLevel: "off" },
    brief: { text: "" },
    tools: {
      tools: ["read", "edit", "write", "execute"],
      todoWrite: true,
      ...(mcp.length > 0 ? { mcp } : {}),
    },
    askUser: async () => ({ optionIds: [], response: null }) as never,
    webFetch: async () => {
      throw new Error("unused");
    },
    ...(mcp.length > 0 ? { mcp: port } : {}),
    observer: async () => undefined,
  };
}

type Routing = "direct" | "both" | "code" | "deferred" | "only";

function arrayFor(mcp: readonly McpToolDefinition[], routing: Routing): AgentTool[] {
  const base = spec(mcp);
  if (routing === "direct") return createSessionTools(base, null as never);
  const surface = codeModeSurfaceFor({
    tools: sessionToolIds(base),
    mcpTools: mcp,
    mode: routing === "only" ? "only" : "both",
    mcpRoute: () => (routing === "code" ? "code" : routing === "deferred" ? "deferred" : undefined),
    limits: DEFAULT_CODE_MODE_LIMITS,
  });
  return createSessionTools(
    { ...base, tools: { ...base.tools, codeMode: surface } },
    null as never,
    undefined,
    (codeMode, tools) =>
      createCodeModeTool({
        surface: codeMode,
        tools,
        gate: () => undefined,
        observe: async () => undefined,
        journal: new CodeModeJournal(),
      }),
  );
}

describe("VC-471 prompt cost of Code Mode", () => {
  it("measures the declarations for each routing as an MCP server grows", () => {
    const rows: string[][] = [];
    const routings: Routing[] = ["direct", "both", "code", "deferred", "only"];
    const measured = new Map<string, number>();
    for (const size of [0, 10, 50, 120]) {
      const mcp = syntheticServer(size);
      const row = [String(size)];
      for (const routing of routings) {
        if (size === 0 && (routing === "code" || routing === "deferred")) {
          row.push("—");
          continue;
        }
        const tools = arrayFor(mcp, routing);
        const tokens = declarationTokens(tools);
        measured.set(`${size}:${routing}`, tokens);
        row.push(`${tokens} (${tools.length})`);
      }
      rows.push(row);
    }
    const header = [
      "MCP tools",
      ...routings.map((routing) => `${routing}: tokens (declared tools)`),
    ];
    const widths = header.map((cell, column) =>
      Math.max(cell.length, ...rows.map((row) => row[column]!.length)),
    );
    const line = (cells: string[]) =>
      `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`;
    console.log(
      [
        "",
        "# VC-471 — declaration tokens by routing (o200k)",
        "",
        line(header),
        `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
        ...rows.map(line),
        "",
      ].join("\n"),
    );
    // What the table must show for the design to hold: Code Mode costs a
    // fixed amount added to a small surface, and routing a large server away
    // from the declarations holds the prefix near that amount however large
    // the server grows.
    expect(measured.get("0:both")!).toBeGreaterThan(measured.get("0:direct")!);
    expect(measured.get("120:code")!).toBeLessThan(measured.get("120:direct")! / 3);
    expect(measured.get("120:deferred")!).toBeLessThan(measured.get("120:code")!);
  });
});
