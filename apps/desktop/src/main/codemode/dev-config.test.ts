import {
  DEFAULT_CODE_MODE_LIMITS,
  DEFAULT_CODE_MODE_POLICY,
  type CodeModePolicy,
  mcpProviderToolName,
  type McpToolDefinition,
  type SessionToolId,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { CODE_MODE_DEV_ENV, desktopCodeMode, readCodeModeDevConfig } from "./dev-config";

const env = (value: string | undefined) => ({ [CODE_MODE_DEV_ENV]: value });

describe("readCodeModeDevConfig", () => {
  it("is off unless an unpackaged build sets the variable", () => {
    expect(readCodeModeDevConfig({}, { packaged: false })).toEqual({ kind: "off" });
    expect(readCodeModeDevConfig(env(""), { packaged: false })).toEqual({ kind: "off" });
    expect(readCodeModeDevConfig(env("0"), { packaged: false })).toEqual({ kind: "off" });
    expect(readCodeModeDevConfig(env("1"), { packaged: true })).toEqual({ kind: "off" });
  });

  it("turns on, mode `both`, with the default limits for a bare switch", () => {
    for (const value of ["1", "on", "true"]) {
      expect(readCodeModeDevConfig(env(value), { packaged: false })).toEqual({
        kind: "on",
        config: { mode: "both", mcpRoutes: new Map(), limits: DEFAULT_CODE_MODE_LIMITS },
      });
    }
  });

  it("reads a mode, server routes and limits from JSON", () => {
    const read = readCodeModeDevConfig(
      env(
        JSON.stringify({
          mode: "only",
          mcp: { github: "deferred" },
          limits: { maxNestedCalls: 50 },
        }),
      ),
      { packaged: false },
    );
    expect(read).toEqual({
      kind: "on",
      config: {
        mode: "only",
        mcpRoutes: new Map([["github", "deferred"]]),
        limits: { ...DEFAULT_CODE_MODE_LIMITS, maxNestedCalls: 50 },
      },
    });
    expect(readCodeModeDevConfig(env("{}"), { packaged: false })).toMatchObject({
      config: { mode: "both" },
    });
  });

  it("ignores, and says why, a value it cannot read", () => {
    for (const [value, reason] of [
      ["{", "JSON"],
      ["[1]", "must be 1 or a JSON object"],
      ['{"other": 1}', 'unknown field "other"'],
      ['{"mode": "sometimes"}', "mode must be off, both or only"],
      ['{"mcp": 1}', "mcp must be an object"],
      ['{"mcp": {"bad id": "code"}}', 'mcp key "bad id" is not a server id'],
      ['{"mcp": {"github": "everywhere"}}', 'mcp route for "github" is not a route'],
      ['{"limits": 1}', "limits must be an object"],
      ['{"limits": {"maxImages": 1}}', 'unknown limit "maxImages"'],
      ['{"limits": {"toString": 5}}', 'unknown limit "toString"'],
      ['{"limits": {"maxNestedCalls": 0}}', "limit maxNestedCalls must be a whole number"],
      ['{"limits": {"maxNestedCalls": "5"}}', "limit maxNestedCalls must be a whole number"],
      ['{"limits": {"maxNestedCalls": 1.5}}', "limit maxNestedCalls must be a whole number"],
    ] as const) {
      const read = readCodeModeDevConfig(env(value), { packaged: false });
      expect(read.kind).toBe("invalid");
      expect(read.kind === "invalid" && read.reason).toContain(reason);
    }
  });
});

describe("desktopCodeMode", () => {
  const search: McpToolDefinition = {
    serverId: "github",
    toolName: "search",
    providerName: mcpProviderToolName("github", "GitHub", "search"),
    description: "Search.",
    inputSchema: { type: "object" },
  };
  const tools: SessionToolId[] = ["read", "ask_user", "codemode", search.providerName];
  const sonnet = { providerId: "anthropic", modelId: "claude-sonnet-4-6" };
  const gpt = { providerId: "openai-codex", modelId: "gpt-5.5" };

  it("follows the stored setting, read at each birth", () => {
    const logged: string[] = [];
    let policy: CodeModePolicy = DEFAULT_CODE_MODE_POLICY;
    const codeMode = desktopCodeMode({
      env: env("{"),
      packaged: false,
      log: (line) => logged.push(line),
      policy: () => policy,
    });
    // An unreadable variable is ignored, and said so, and the setting rules.
    expect(logged).toHaveLength(1);
    expect(codeMode.birth(sonnet, [])).toMatchObject({ mode: "both", offered: true });
    expect(codeMode.birth(gpt, [])).toMatchObject({ mode: "off", offered: false });
    expect(codeMode.birth(undefined, [])).toMatchObject({ offered: false });
    expect(codeMode.surfaceFor(tools, [search], sonnet)).toMatchObject({
      mode: "both",
      routes: { read: "both", ask_user: "direct", [search.providerName]: "both" },
      limits: DEFAULT_CODE_MODE_LIMITS,
    });
    expect(codeMode.surfaceFor(["read"], [], sonnet)).toBeUndefined();
    policy = { enabled: true, models: { "openai-codex/gpt-5.5": "only" } };
    expect(codeMode.birth(gpt, [])).toMatchObject({ mode: "only", offered: true });
    policy = { enabled: false, models: {} };
    expect(codeMode.birth(sonnet, [])).toMatchObject({ offered: false });
  });

  it("lets a developer's variable stand in for the setting, for every model", () => {
    const codeMode = desktopCodeMode({
      env: env(JSON.stringify({ mode: "only", mcp: { github: "deferred" } })),
      packaged: false,
      log: () => undefined,
      policy: () => ({ enabled: false, models: {} }),
    });
    expect(codeMode.birth(gpt, [])).toMatchObject({ mode: "only", offered: true });
    expect(codeMode.birth(undefined, [])).toMatchObject({ mode: "off", offered: false });
    expect(codeMode.surfaceFor(tools, [search], gpt)?.routes).toEqual({
      read: "code",
      ask_user: "direct",
      [search.providerName]: "deferred",
    });
  });
});
