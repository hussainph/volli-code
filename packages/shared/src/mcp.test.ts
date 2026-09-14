import { describe, expect, it } from "vite-plus/test";

import {
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_SCHEMA_MAX_CHARS,
  MCP_SCHEMA_MAX_DEPTH,
  MCP_SCHEMA_MAX_NODES,
  MCP_SERVER_ID_MAX_CHARS,
  MCP_SERVER_NAME_MAX_CHARS,
  MCP_TOOL_COUNT_MAX,
  MCP_TOOL_NAME_MAX_CHARS,
  isMcpToolId,
  mcpProviderToolName,
  sanitizeMcpServerDraft,
  sanitizeMcpToolDefinition,
  validateMcpToolDefinitions,
  type McpToolCandidate,
  type McpToolDefinition,
  type McpToolId,
} from "./mcp";

function toolCandidate(overrides: Partial<McpToolCandidate> = {}): McpToolCandidate {
  return {
    serverId: "server-1",
    serverName: "Fixture",
    toolName: "tool",
    description: "Tool",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function serverCandidate(overrides: Record<string, unknown> = {}): {
  id: unknown;
  name: unknown;
  enabled: unknown;
  transport: unknown;
} {
  return {
    id: "server-1",
    name: "Fixture",
    enabled: true,
    transport: { type: "stdio", command: "node", args: [] },
    ...overrides,
  };
}

describe("mcpProviderToolName", () => {
  it("creates a stable provider-safe name while preserving exact MCP identity separately", () => {
    const name = mcpProviderToolName("server-1", "GitHub Cloud", "issues/create issue");

    expect(name).toMatch(/^mcp__[A-Za-z0-9_-]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toBe(mcpProviderToolName("server-1", "GitHub Cloud", "issues/create issue"));
    expect(name).not.toBe(mcpProviderToolName("server-2", "GitHub Cloud", "issues/create issue"));
  });

  it("keeps long and colliding cleaned names distinct with a stable hash", () => {
    const one = mcpProviderToolName("one", "Same", "create issue");
    const two = mcpProviderToolName("one", "Same", "create@issue");
    const long = mcpProviderToolName("one", "x".repeat(200), "y".repeat(200));

    expect(one).not.toBe(two);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(isMcpToolId(long)).toBe(true);
  });

  it("uses safe fallback segments and rejects every malformed dynamic id shape", () => {
    expect(mcpProviderToolName("one", "!!!", "???")).toMatch(/^mcp__server__tool__/);
    expect(isMcpToolId(undefined)).toBe(false);
    expect(isMcpToolId("read")).toBe(false);
    expect(isMcpToolId("mcp__not valid")).toBe(false);
  });
});

describe("sanitizeMcpToolDefinition", () => {
  it("accepts a bounded object JSON Schema without changing its meaning", () => {
    const inputSchema = {
      type: "object",
      properties: {
        issue: { type: "string", minLength: 1 },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["issue"],
      additionalProperties: false,
    } as const;

    const result = sanitizeMcpToolDefinition({
      serverId: "server-1",
      serverName: "GitHub",
      toolName: "create_issue",
      description: "Create an issue",
      inputSchema,
    });

    expect(result).toEqual({
      ok: true,
      definition: {
        serverId: "server-1",
        toolName: "create_issue",
        providerName: mcpProviderToolName("server-1", "GitHub", "create_issue"),
        description: "Create an issue",
        inputSchema,
      },
    });
  });

  it.each([
    ["empty name", "", "must not be empty"],
    ["oversized name", "x".repeat(MCP_TOOL_NAME_MAX_CHARS + 1), "is too long"],
  ])("rejects an %s", (_label, toolName, reason) => {
    const result = sanitizeMcpToolDefinition({
      serverId: "server-1",
      serverName: "Fixture",
      toolName,
      description: "Tool",
      inputSchema: { type: "object" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it("rejects oversized descriptions and schemas rather than truncating or weakening them", () => {
    const description = sanitizeMcpToolDefinition({
      serverId: "server-1",
      serverName: "Fixture",
      toolName: "tool",
      description: "x".repeat(MCP_DESCRIPTION_MAX_CHARS + 1),
      inputSchema: { type: "object" },
    });
    const schema = sanitizeMcpToolDefinition({
      serverId: "server-1",
      serverName: "Fixture",
      toolName: "tool",
      description: "Tool",
      inputSchema: { type: "object", description: "x".repeat(MCP_SCHEMA_MAX_CHARS) },
    });

    expect(description.ok).toBe(false);
    expect(schema.ok).toBe(false);
  });

  it.each([
    [null, "must be a JSON Schema object"],
    [[], "must be a JSON Schema object"],
    ["object", "must be a JSON Schema object"],
    [{ type: "string" }, 'root type must be "object"'],
    [{ type: "object", properties: null }, "properties must be an object"],
    [{ type: "object", properties: [] }, "properties must be an object"],
    [{ type: "object", properties: "value" }, "properties must be an object"],
    [{ type: "object", required: "value" }, "required must contain only strings"],
    [{ type: "object", required: [1] }, "required must contain only strings"],
    [{ type: "object", properties: { value: 1 } }, "valid JSON Schema"],
    [{ type: "object", properties: { value: { type: "not-a-type" } } }, "valid JSON Schema"],
    [{ type: "object", pattern: /secret/ }, "JSON values"],
    [{ type: "object", examples: [undefined] }, "JSON values"],
    [{ type: "object", default: Number.NaN }, "JSON values"],
    [{ type: "object", ["x".repeat(257)]: true }, "oversized key"],
    [{ type: "object", $schema: "urn:unknown" }, "valid JSON Schema"],
  ])("rejects an unsupported schema %#", (inputSchema, reason) => {
    const result = sanitizeMcpToolDefinition(toolCandidate({ inputSchema }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it("rejects cyclic, over-deep, and over-populated schemas before accepting them", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic["self"] = cyclic;
    let deep: Record<string, unknown> = { type: "object" };
    for (let index = 0; index <= MCP_SCHEMA_MAX_DEPTH; index += 1) {
      deep = { type: "object", properties: { next: deep } };
    }
    const populated = {
      type: "object",
      examples: Array.from({ length: MCP_SCHEMA_MAX_NODES }, () => null),
    };
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      type: "object",
    });

    for (const [inputSchema, reason] of [
      [cyclic, "cycles"],
      [deep, "nested too deeply"],
      [populated, "too many values"],
    ] as const) {
      const result = sanitizeMcpToolDefinition(toolCandidate({ inputSchema }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(reason);
    }
    expect(sanitizeMcpToolDefinition(toolCandidate({ inputSchema: nullPrototype })).ok).toBe(true);
  });

  it.each([
    [{ serverId: "bad id" }, "server id"],
    [{ serverId: "x".repeat(MCP_SERVER_ID_MAX_CHARS + 1) }, "server id"],
    [{ serverName: " " }, "server name"],
    [{ serverName: "x".repeat(MCP_SERVER_NAME_MAX_CHARS + 1) }, "server name"],
  ])("rejects invalid tool identity fields %#", (overrides, reason) => {
    const result = sanitizeMcpToolDefinition(toolCandidate(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it("defaults an absent description without changing the accepted schema", () => {
    expect(sanitizeMcpToolDefinition(toolCandidate({ description: undefined }))).toMatchObject({
      ok: true,
      definition: { description: "", inputSchema: { type: "object" } },
    });
  });
});

describe("sanitizeMcpServerDraft", () => {
  it("accepts only direct stdio argv or an unauthenticated Streamable HTTP endpoint", () => {
    expect(
      sanitizeMcpServerDraft({
        id: "server-1",
        name: "Local fixture",
        enabled: true,
        transport: { type: "stdio", command: "node", args: ["fixture.mjs", "--quiet"] },
      }),
    ).toEqual({
      ok: true,
      server: {
        id: "server-1",
        name: "Local fixture",
        enabled: true,
        transport: { type: "stdio", command: "node", args: ["fixture.mjs", "--quiet"] },
      },
    });
    expect(
      sanitizeMcpServerDraft({
        id: "remote-1",
        name: "Remote",
        enabled: false,
        transport: { type: "streamable-http", url: "https://mcp.example.test/tools" },
      }).ok,
    ).toBe(true);
  });

  it.each([
    [{ type: "stdio", command: 1, args: [] }, "executable"],
    [{ type: "stdio", command: "", args: [] }, "executable"],
    [{ type: "stdio", command: "x".repeat(4_097), args: [] }, "executable"],
    [{ type: "stdio", command: "node\u0000oops", args: [] }, "executable"],
    [{ type: "stdio", command: "node\roops", args: [] }, "executable"],
    [{ type: "stdio", command: "node\noops", args: [] }, "executable"],
    [{ type: "stdio", command: "node", args: null }, "argument"],
    [{ type: "stdio", command: "node", args: Array.from({ length: 65 }, () => "x") }, "argument"],
    [{ type: "stdio", command: "node", args: [1] }, "argument"],
    [{ type: "stdio", command: "node", args: ["x".repeat(4_097)] }, "argument"],
    [{ type: "stdio", command: "node", args: ["x\u0000oops"] }, "argument"],
    [{ type: "streamable-http", url: 1 }, "endpoint is invalid"],
    [{ type: "streamable-http", url: `https://example.test/${"x".repeat(4_096)}` }, "too long"],
    [{ type: "streamable-http", url: "not a URL" }, "endpoint is invalid"],
    [{ type: "streamable-http", url: "file:///tmp/mcp" }, "http"],
    [{ type: "streamable-http", url: "https://user:pass@example.test/mcp" }, "credentials"],
    [{ type: "streamable-http", url: "https://:pass@example.test/mcp" }, "credentials"],
    [{ type: "streamable-http", url: "https://example.test/mcp#token" }, "fragment"],
    [{ type: "other" }, "stdio or streamable-http"],
  ])(
    "rejects transport configuration that widens the model-controlled boundary %#",
    (transport, reason) => {
      const result = sanitizeMcpServerDraft(serverCandidate({ transport }));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(reason);
    },
  );

  it.each([
    [{ id: 1 }, "server id"],
    [{ id: "bad id" }, "server id"],
    [{ id: "x".repeat(MCP_SERVER_ID_MAX_CHARS + 1) }, "server id"],
    [{ name: 1 }, "server name"],
    [{ name: " " }, "server name"],
    [{ name: "x".repeat(MCP_SERVER_NAME_MAX_CHARS + 1) }, "server name"],
    [{ enabled: "yes" }, "enabled"],
    [{ transport: null }, "transport"],
    [{ transport: "stdio" }, "transport"],
  ])("rejects invalid top-level server configuration %#", (overrides, reason) => {
    const result = sanitizeMcpServerDraft(serverCandidate(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe("validateMcpToolDefinitions", () => {
  it("rejects duplicate exact identities and provider-name collisions", () => {
    const base = {
      serverId: "server-1",
      toolName: "echo",
      providerName: mcpProviderToolName("server-1", "Fixture", "echo"),
      description: "Echo",
      inputSchema: { type: "object" } as const,
    };

    expect(() => validateMcpToolDefinitions([base, { ...base }])).toThrow(/duplicate MCP tool/i);
    expect(() =>
      validateMcpToolDefinitions([base, { ...base, serverId: "server-2", toolName: "other" }]),
    ).toThrow(/provider name/i);
  });

  it("rejects an over-count, malformed definition, and malformed provider name", () => {
    const base: McpToolDefinition = {
      serverId: "server-1",
      toolName: "echo",
      providerName: mcpProviderToolName("server-1", "Fixture", "echo"),
      description: "Echo",
      inputSchema: { type: "object" },
    };

    expect(() =>
      validateMcpToolDefinitions(Array.from({ length: MCP_TOOL_COUNT_MAX + 1 }, () => base)),
    ).toThrow(/tool limit/i);
    expect(() =>
      validateMcpToolDefinitions([
        { ...base, description: "x".repeat(MCP_DESCRIPTION_MAX_CHARS + 1) },
      ]),
    ).toThrow(/invalid MCP tool/i);
    expect(() =>
      validateMcpToolDefinitions([{ ...base, providerName: "mcp__not valid" as McpToolId }]),
    ).toThrow(/invalid MCP provider name/i);
    expect(validateMcpToolDefinitions([base])).toEqual([base]);
  });
});
