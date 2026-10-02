import { describe, expect, it, vi } from "vite-plus/test";

import { resolveAgentToolSurface } from "./agent-tool-surface";
import { sessionToolBindings, sessionToolIds } from "./agent-runtime";
import { decodeSessionEventPayload, encodeSessionJson } from "./session-event-codec";
import { mcpProviderToolName, type McpToolDefinition } from "./mcp";

function definition(serverId = "server-1", toolName = "echo"): McpToolDefinition {
  return {
    serverId,
    toolName,
    providerName: mcpProviderToolName(serverId, "Fixture", toolName),
    description: "Echo input",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  };
}

const call = vi.fn(async () => ({ content: [], isError: false }));

describe("MCP Agent Tool Surface", () => {
  it("appends settings-backed MCP names after static tools and registry verbs", () => {
    const tool = definition();
    expect(
      resolveAgentToolSurface({
        role: "ticket",
        capabilities: { coding: ["read"], interaction: ["ask_user"] },
        mcpTools: [tool],
      }),
    ).toEqual(["read", "ask_user", "session.delegate", "watch", tool.providerName]);
  });

  it("bounds a Subagent Session to MCP tools already frozen on its parent", () => {
    const inherited = definition("one", "inherited");
    const newlyEnabled = definition("two", "newly_enabled");

    expect(
      resolveAgentToolSurface({
        role: "subagent",
        capabilities: { coding: ["read"], interaction: [] },
        within: ["read", inherited.providerName],
        mcpTools: [inherited, newlyEnabled],
      }),
    ).toEqual(["read", inherited.providerName]);
  });

  it("rejects malformed dynamic definitions before constructing a tool surface", () => {
    expect(() =>
      resolveAgentToolSurface({
        role: "ticket",
        capabilities: { coding: ["read"], interaction: [] },
        mcpTools: [{ ...definition(), inputSchema: { type: "string" } }],
      }),
    ).toThrow(/invalid MCP tool.*root type/i);
  });

  it("derives bindings, provider names, and exact identity from one typed MCP port", () => {
    const tool = definition();
    const spec = { tools: { tools: [], mcp: [tool] }, mcp: { call } };

    expect(sessionToolIds(spec)).toEqual([tool.providerName]);
    expect(sessionToolBindings(spec)).toEqual([
      { tool: tool.providerName, definition: tool, port: spec.mcp },
    ]);
    expect(() => sessionToolIds({ tools: { tools: [], mcp: [tool] } })).toThrow(/MCP.*port/i);
  });

  it("round-trips frozen definitions in the durable Session input codec", () => {
    const tool = definition();
    const payload = {
      kind: "session.input.recorded" as const,
      input: { kind: "tool-surface" as const, tools: [tool.providerName], mcpTools: [tool] },
    };

    expect(decodeSessionEventPayload(JSON.parse(encodeSessionJson(payload)), "payload")).toEqual(
      payload,
    );
  });

  it("refuses a durable record whose MCP name and definition disagree", () => {
    const tool = definition();
    expect(() =>
      decodeSessionEventPayload(
        {
          kind: "session.input.recorded",
          input: { kind: "tool-surface", tools: ["mcp__other__tool__12345678"], mcpTools: [tool] },
        },
        "payload",
      ),
    ).toThrow(/MCP definitions.*tool surface/i);
  });

  it("refuses malformed durable MCP definition containers and entries", () => {
    const tool = definition();
    const payload = (mcpTools: unknown) => ({
      kind: "session.input.recorded",
      input: { kind: "tool-surface", tools: [tool.providerName], mcpTools },
    });

    expect(() => decodeSessionEventPayload(payload("not an array"), "payload")).toThrow(
      /mcpTools must be an array/i,
    );
    expect(() =>
      decodeSessionEventPayload(payload([{ ...tool, inputSchema: { type: "string" } }]), "payload"),
    ).toThrow(/root type/i);
    expect(() =>
      decodeSessionEventPayload(payload([{ ...tool, providerName: "mcp__not valid" }]), "payload"),
    ).toThrow(/providerName is invalid/i);
  });

  it("replays a frozen output schema exactly, a pre-0.99 record without one, and refuses a damaged one (VC-469)", () => {
    const typed: McpToolDefinition = {
      ...definition(),
      outputSchema: { type: "object", properties: { echo: { type: "string" } } },
    };
    const recorded = (tool: unknown) => ({
      kind: "session.input.recorded" as const,
      input: {
        kind: "tool-surface" as const,
        tools: [definition().providerName],
        mcpTools: [tool],
      },
    });

    // Written by this build: the schema comes back as it was frozen.
    expect(
      decodeSessionEventPayload(JSON.parse(encodeSessionJson(recorded(typed))), "payload"),
    ).toEqual(recorded(typed));
    // Written before the field existed: replayed without one, nothing added.
    const decoded = decodeSessionEventPayload(recorded(definition()), "payload") as unknown as {
      input: { mcpTools: McpToolDefinition[] };
    };
    expect(decoded.input.mcpTools[0]).toEqual(definition());
    expect("outputSchema" in decoded.input.mcpTools[0]!).toBe(false);
    // Discovery never freezes a schema it refused, so one that fails now was damaged.
    expect(() =>
      decodeSessionEventPayload(recorded({ ...typed, outputSchema: { type: "array" } }), "payload"),
    ).toThrow('payload.input.mcpTools[0] output schema root type must be "object"');
  });

  it("round-trips host-authored parallel-read eligibility and refuses any other value (VC-454)", () => {
    const tool: McpToolDefinition = { ...definition(), parallelRead: true };
    const payload = {
      kind: "session.input.recorded" as const,
      input: { kind: "tool-surface" as const, tools: [tool.providerName], mcpTools: [tool] },
    };

    expect(decodeSessionEventPayload(JSON.parse(encodeSessionJson(payload)), "payload")).toEqual(
      payload,
    );
    for (const damaged of [false, "true", 1, null]) {
      expect(() =>
        decodeSessionEventPayload(
          {
            ...payload,
            input: { ...payload.input, mcpTools: [{ ...tool, parallelRead: damaged }] },
          },
          "payload",
        ),
      ).toThrow(/parallelRead must be true when present/);
    }
  });
});
