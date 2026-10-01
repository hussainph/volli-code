import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CODE_MODE_LIMITS } from "./code-mode";
import {
  CODE_MODE_POLICY_MODELS_MAX,
  codeModeBirth,
  codeModeModeFor,
  codeModeModelKey,
  codeModeNudgeFor,
  codeModeSurfaceAtBirth,
  DEFAULT_CODE_MODE_POLICY,
  defaultCodeModeMode,
  estimateMcpDeclarationTokens,
  LARGE_MCP_SERVER_TOKENS,
  LARGE_MCP_SERVER_TOOLS,
  largeMcpServerIds,
  readCodeModePolicy,
} from "./code-mode-policy";
import type { SessionToolId } from "./authority";
import { mcpProviderToolName, type McpToolDefinition } from "./mcp";

function tool(
  serverId: string,
  toolName: string,
  description = "Does a thing.",
): McpToolDefinition {
  return {
    serverId,
    toolName,
    providerName: mcpProviderToolName(serverId, serverId, toolName),
    description,
    inputSchema: { type: "object" },
  };
}

function server(serverId: string, count: number, description?: string): McpToolDefinition[] {
  return Array.from({ length: count }, (_, index) => tool(serverId, `t${index}`, description));
}

const SONNET = { providerId: "anthropic", modelId: "claude-sonnet-4-6" };
const GPT = { providerId: "openai-codex", modelId: "gpt-5.5" };

describe("per-model defaults", () => {
  it("answers each family's measured mode, and off for a model no row knows", () => {
    expect(defaultCodeModeMode("claude-haiku-4-5")).toBe("both");
    expect(defaultCodeModeMode("claude-sonnet-4-6")).toBe("both");
    expect(defaultCodeModeMode("claude-opus-5-5")).toBe("off");
    expect(defaultCodeModeMode("gpt-5.5")).toBe("off");
    expect(defaultCodeModeMode("glm-5.3-flash")).toBe("off");
    expect(defaultCodeModeMode("llama-4")).toBe("off");
  });

  it("finds the family behind a routed or regional id", () => {
    expect(defaultCodeModeMode("anthropic/claude-sonnet-4.6")).toBe("both");
    expect(defaultCodeModeMode("us.anthropic.claude-haiku-4-5-v1:0")).toBe("both");
    expect(defaultCodeModeMode("Claude-Sonnet-4")).toBe("both");
  });
});

describe("the policy", () => {
  it("is on by default, with no pins", () => {
    expect(DEFAULT_CODE_MODE_POLICY).toEqual({ enabled: true, models: {} });
    expect(Object.isFrozen(DEFAULT_CODE_MODE_POLICY)).toBe(true);
  });

  it("gives a model its pin, else its default, and nothing when switched off", () => {
    const policy = { enabled: true, models: { [codeModeModelKey(GPT)]: "only" as const } };
    expect(codeModeModelKey(GPT)).toBe("openai-codex/gpt-5.5");
    expect(codeModeModeFor(policy, GPT)).toBe("only");
    expect(codeModeModeFor(policy, SONNET)).toBe("both");
    expect(codeModeModeFor({ ...policy, enabled: false }, GPT)).toBe("off");
    // A pin is an own key, never an inherited one.
    expect(
      codeModeModeFor({ enabled: true, models: {} }, { providerId: "x", modelId: "toString" }),
    ).toBe("off");
  });

  it("reads a stored policy tolerantly, dropping what is not a pin", () => {
    expect(readCodeModePolicy(null)).toBe(DEFAULT_CODE_MODE_POLICY);
    expect(readCodeModePolicy([])).toBe(DEFAULT_CODE_MODE_POLICY);
    expect(readCodeModePolicy({ enabled: "yes", models: [] })).toEqual({
      enabled: true,
      models: {},
    });
    expect(
      readCodeModePolicy({
        enabled: false,
        models: {
          "anthropic/claude-sonnet-4-6": "only",
          "openai/gpt-5.5": "sometimes",
          noslash: "both",
          "/leading": "both",
          "trailing/": "both",
          [`p/${"m".repeat(600)}`]: "both",
        },
      }),
    ).toEqual({ enabled: false, models: { "anthropic/claude-sonnet-4-6": "only" } });
    const many = Object.fromEntries(
      Array.from({ length: CODE_MODE_POLICY_MODELS_MAX + 5 }, (_, index) => [
        `p/m${index}`,
        "both",
      ]),
    );
    expect(Object.keys(readCodeModePolicy({ enabled: true, models: many }).models)).toHaveLength(
      CODE_MODE_POLICY_MODELS_MAX,
    );
  });
});

describe("large MCP servers", () => {
  it("estimates a declaration at four characters a token", () => {
    const definition = tool("srv", "find", "x".repeat(40));
    expect(estimateMcpDeclarationTokens(definition)).toBe(
      Math.ceil(
        (definition.providerName.length + 40 + JSON.stringify({ type: "object" }).length) / 4,
      ),
    );
  });

  it("is large past the tool count or the token estimate, and not at either", () => {
    const definitions = [
      ...server("small", LARGE_MCP_SERVER_TOOLS),
      ...server("many", LARGE_MCP_SERVER_TOOLS + 1),
      ...server("wordy", 2, "w".repeat(LARGE_MCP_SERVER_TOKENS * 2)),
    ];
    expect([...largeMcpServerIds(definitions)].toSorted()).toEqual(["many", "wordy"]);
  });
});

describe("a Session's birth", () => {
  const surface = ["read", "execute", "ask_user", "web_fetch"] as const;

  it("offers nothing with the switch off, large servers or not", () => {
    const birth = codeModeBirth({
      policy: { enabled: false, models: {} },
      model: SONNET,
      mcpTools: server("many", 30),
    });
    expect(birth).toEqual({ mode: "off", nudge: false, offered: false, largeServers: new Set() });
  });

  it("gives the prompt paragraph only in mode `both`, to a family it helps", () => {
    const pinned = { enabled: true, models: { [codeModeModelKey(GPT)]: "both" as const } };
    expect(codeModeNudgeFor("gpt-5.5")).toBe(true);
    expect(codeModeNudgeFor("claude-sonnet-4-6")).toBe(false);
    expect(codeModeNudgeFor("llama-4")).toBe(false);
    expect(codeModeBirth({ policy: pinned, model: GPT, mcpTools: [] })).toMatchObject({
      mode: "both",
      nudge: true,
    });
    expect(
      codeModeBirth({ policy: DEFAULT_CODE_MODE_POLICY, model: GPT, mcpTools: [] }).nudge,
    ).toBe(false);
    const birth = codeModeBirth({ policy: pinned, model: GPT, mcpTools: [] });
    expect(
      codeModeSurfaceAtBirth({ birth, tools: ["read", "codemode"], mcpTools: [] })?.nudge,
    ).toBe(true);
  });

  it("offers codemode when the model's mode is on, or for a large server alone", () => {
    expect(
      codeModeBirth({ policy: DEFAULT_CODE_MODE_POLICY, model: SONNET, mcpTools: [] }).offered,
    ).toBe(true);
    expect(
      codeModeBirth({ policy: DEFAULT_CODE_MODE_POLICY, model: GPT, mcpTools: [] }).offered,
    ).toBe(false);
    expect(
      codeModeBirth({ policy: DEFAULT_CODE_MODE_POLICY, model: null, mcpTools: [] }),
    ).toMatchObject({
      mode: "off",
      offered: false,
    });
    const large = codeModeBirth({
      policy: DEFAULT_CODE_MODE_POLICY,
      model: GPT,
      mcpTools: server("many", 30),
    });
    expect(large).toMatchObject({ mode: "off", offered: true });
    expect([...large.largeServers]).toEqual(["many"]);
  });

  it("freezes the mode's routes with every large server deferred, and a developer override over both", () => {
    const many = server("many", 21);
    const small = server("small", 2);
    const tools: SessionToolId[] = [
      ...surface,
      ...[...many, ...small].map((one) => one.providerName),
      "codemode",
    ];
    const birth = codeModeBirth({
      policy: DEFAULT_CODE_MODE_POLICY,
      model: GPT,
      mcpTools: [...many, ...small],
    });
    const record = codeModeSurfaceAtBirth({ birth, tools, mcpTools: [...many, ...small] })!;
    expect(record.mode).toBe("off");
    expect(record.limits).toEqual(DEFAULT_CODE_MODE_LIMITS);
    expect(record.routes["read"]).toBe("direct");
    expect(record.routes[many[0]!.providerName]).toBe("deferred");
    expect(record.routes[small[0]!.providerName]).toBe("direct");
    const overridden = codeModeSurfaceAtBirth({
      birth,
      tools,
      mcpTools: [...many, ...small],
      limits: { ...DEFAULT_CODE_MODE_LIMITS, maxNestedCalls: 5 },
      mcpRoute: (definition) => (definition.serverId === "many" ? "code" : undefined),
    })!;
    expect(overridden.routes[many[0]!.providerName]).toBe("code");
    expect(overridden.limits.maxNestedCalls).toBe(5);
    expect(codeModeSurfaceAtBirth({ birth, tools: surface, mcpTools: [] })).toBeUndefined();
  });
});
