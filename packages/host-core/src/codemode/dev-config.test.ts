import {
  DEFAULT_CODE_MODE_LIMITS,
  DEFAULT_CODE_MODE_POLICY,
  type CodeModePolicy,
  mcpProviderToolName,
  type McpToolDefinition,
  type SessionToolId,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { CODE_MODE_DEV_ENV, hostCodeMode, readCodeModeDevConfig } from "./dev-config";

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

describe("hostCodeMode", () => {
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
  /** A server past the size threshold, so it is deferred whatever the mode. */
  const large: McpToolDefinition[] = Array.from({ length: 21 }, (_, index) => ({
    ...search,
    serverId: "big",
    toolName: `t${index}`,
    providerName: mcpProviderToolName("big", "Big", `t${index}`),
  }));

  it("follows the stored setting, read at each birth", () => {
    const logged: string[] = [];
    let policy: CodeModePolicy = DEFAULT_CODE_MODE_POLICY;
    const codeMode = hostCodeMode({
      env: env("{"),
      packaged: false,
      log: (line) => logged.push(line),
      policy: () => policy,
      sandboxAvailable: true,
    });
    // An unreadable variable is ignored, and said so, and the setting rules.
    expect(logged).toHaveLength(1);
    const born = codeMode.birth(sonnet, []);
    expect(born).toMatchObject({ mode: "both", offered: true });
    expect(codeMode.birth(gpt, [])).toMatchObject({ mode: "off", offered: false });
    expect(codeMode.birth(undefined, [])).toMatchObject({ offered: false });
    expect(codeMode.surfaceFor(born, tools, [search])).toMatchObject({
      mode: "both",
      routes: { read: "both", ask_user: "direct", [search.providerName]: "both" },
      limits: DEFAULT_CODE_MODE_LIMITS,
    });
    expect(codeMode.surfaceFor(born, ["read"], [])).toBeUndefined();
    policy = { enabled: true, models: { "openai-codex/gpt-5.5": "only" } };
    expect(codeMode.birth(gpt, [])).toMatchObject({ mode: "only", offered: true });
    policy = { enabled: false, models: {} };
    expect(codeMode.birth(sonnet, [])).toMatchObject({ offered: false });
  });

  it("freezes the routes from the decision it is handed, whatever the setting says by then", () => {
    let policy: CodeModePolicy = DEFAULT_CODE_MODE_POLICY;
    const codeMode = hostCodeMode({
      env: {},
      packaged: false,
      log: () => undefined,
      policy: () => policy,
      sandboxAvailable: true,
    });
    const born = codeMode.birth(sonnet, []);
    // The switch flips between the surface and its record: the record still
    // follows the one decision the surface was resolved from.
    policy = { enabled: false, models: {} };
    expect(codeMode.surfaceFor(born, tools, [search])?.routes["read"]).toBe("both");
  });

  it("offers nothing and defers nothing when this launch has no sandbox", () => {
    const codeMode = hostCodeMode({
      env: env("1"),
      packaged: false,
      log: () => undefined,
      policy: () => DEFAULT_CODE_MODE_POLICY,
      sandboxAvailable: false,
    });
    const born = codeMode.birth(sonnet, large);
    expect(born).toMatchObject({ mode: "off", nudge: false, offered: false });
    expect(born.largeServers.size).toBe(0);
    // With a sandbox the same large server would have been deferred.
    const withSandbox = hostCodeMode({
      env: {},
      packaged: false,
      log: () => undefined,
      policy: () => DEFAULT_CODE_MODE_POLICY,
      sandboxAvailable: true,
    }).birth(gpt, large);
    expect(withSandbox).toMatchObject({ mode: "off", offered: true });
    expect([...withSandbox.largeServers]).toEqual(["big"]);
  });

  it("gives a child its own model's mode and paragraph, inside the tools its parent froze", () => {
    const pinned: CodeModePolicy = { enabled: true, models: { "openai-codex/gpt-5.5": "both" } };
    const codeMode = hostCodeMode({
      env: {},
      packaged: false,
      log: () => undefined,
      policy: () => pinned,
      sandboxAvailable: true,
    });
    // A GPT parent pinned to `both` carries the paragraph its family gets.
    const parent = codeMode.birth(gpt, []);
    expect(codeMode.surfaceFor(parent, tools, [search])).toMatchObject({
      mode: "both",
      nudge: true,
    });
    // Its Sonnet child decides from Sonnet: `both`, and no paragraph.
    const child = codeMode.birth(sonnet, []);
    const childTools: SessionToolId[] = ["read", "codemode"];
    const record = codeMode.surfaceFor(child, childTools, []);
    expect(record).toMatchObject({ mode: "both", routes: { read: "both" } });
    expect(record).not.toHaveProperty("nudge");
  });

  it("lets a developer's variable stand in for the setting, for every model", () => {
    const codeMode = hostCodeMode({
      env: env(JSON.stringify({ mode: "only", mcp: { github: "deferred" } })),
      packaged: false,
      log: () => undefined,
      policy: () => ({ enabled: false, models: {} }),
      sandboxAvailable: true,
    });
    const born = codeMode.birth(gpt, []);
    expect(born).toMatchObject({ mode: "only", offered: true });
    expect(codeMode.birth(undefined, [])).toMatchObject({ mode: "off", offered: false });
    expect(codeMode.surfaceFor(born, tools, [search])?.routes).toEqual({
      read: "code",
      ask_user: "direct",
      [search.providerName]: "deferred",
    });
  });
});
