import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CODE_MODE_LIMITS,
  mcpProviderToolName,
  type McpToolDefinition,
  type SessionToolId,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  CODE_MODE_DEV_ENV,
  codeModeSandboxFor,
  desktopCodeMode,
  readCodeModeDevConfig,
} from "./dev-config";

const env = (value: string | undefined) => ({ [CODE_MODE_DEV_ENV]: value });

describe("readCodeModeDevConfig", () => {
  it("is off unless an unpackaged build sets the variable", () => {
    expect(readCodeModeDevConfig({}, { packaged: false })).toEqual({ kind: "off" });
    expect(readCodeModeDevConfig(env(""), { packaged: false })).toEqual({ kind: "off" });
    expect(readCodeModeDevConfig(env("0"), { packaged: false })).toEqual({ kind: "off" });
    expect(readCodeModeDevConfig(env("1"), { packaged: true })).toEqual({ kind: "off" });
  });

  it("turns on with the default limits for a bare switch", () => {
    for (const value of ["1", "on", "true"]) {
      expect(readCodeModeDevConfig(env(value), { packaged: false })).toEqual({
        kind: "on",
        config: { mcpRoutes: new Map(), limits: DEFAULT_CODE_MODE_LIMITS },
      });
    }
  });

  it("reads server routes and limits from JSON", () => {
    const read = readCodeModeDevConfig(
      env(JSON.stringify({ mcp: { github: "deferred" }, limits: { maxNestedCalls: 50 } })),
      { packaged: false },
    );
    expect(read).toEqual({
      kind: "on",
      config: {
        mcpRoutes: new Map([["github", "deferred"]]),
        limits: { ...DEFAULT_CODE_MODE_LIMITS, maxNestedCalls: 50 },
      },
    });
  });

  it("ignores, and says why, a value it cannot read", () => {
    for (const [value, reason] of [
      ["{", "JSON"],
      ["[1]", "must be 1 or a JSON object"],
      ['{"other": 1}', 'unknown field "other"'],
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

  it("offers nothing and records nothing while off", () => {
    const logged: string[] = [];
    const off = desktopCodeMode({
      env: env("{"),
      packaged: false,
      log: (line) => logged.push(line),
    });
    expect(off.enabled).toBe(false);
    expect(logged).toHaveLength(1);
    expect(off.surfaceFor(["read"], [])).toBeUndefined();
    // A child inheriting codemode from its parent still freezes a whole record.
    expect(off.surfaceFor(tools, [search])?.limits).toEqual(DEFAULT_CODE_MODE_LIMITS);
  });

  it("freezes routes for exactly the surface a new Session was born with", () => {
    const on = desktopCodeMode({
      env: env(JSON.stringify({ mcp: { github: "code" } })),
      packaged: false,
      log: () => undefined,
    });
    expect(on.enabled).toBe(true);
    expect(on.surfaceFor(tools, [search])?.routes).toEqual({
      read: "both",
      ask_user: "direct",
      [search.providerName]: "code",
    });
    expect(on.surfaceFor(["read"], [])).toBeUndefined();
  });
});

describe("codeModeSandboxFor", () => {
  it("names nothing for a packaged build, and logs a sandbox it cannot find", () => {
    expect(
      codeModeSandboxFor(
        false,
        () => "/nowhere",
        () => undefined,
      ),
    ).toEqual({});
    const logged: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "volli-codemode-app-"));
    expect(
      codeModeSandboxFor(
        true,
        () => root,
        (line) => logged.push(line),
      ),
    ).toEqual({});
    expect(logged[0]).toContain("Code Mode's sandbox could not be located");
  });

  it("finds the workspace's own sandbox from the app directory", () => {
    const appPath = join(import.meta.dirname, "..", "..", "..");
    const found = codeModeSandboxFor(
      true,
      () => appPath,
      () => undefined,
    );
    expect(found.codeModeSandbox?.wasmPath).toMatch(/quickjs\.wasm$/u);
  });
});
