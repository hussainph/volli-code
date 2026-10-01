import type { McpCatalogTool, McpServerRecord, McpToolHints } from "@volli/shared";
import { mcpProviderToolName } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  changedTools,
  enabledToolNames,
  endpointKey,
  endpointLabel,
  groupTools,
  isSelectable,
  listedTools,
  matchesToolQuery,
  selectionOf,
  serverHealth,
  suggestedServerName,
  toggleTool,
  toggleTools,
  toolLabel,
  toolParameters,
  visibleTools,
} from "./mcp-tools-model";

function tool(
  name: string,
  options: {
    hints?: McpToolHints;
    description?: string;
    enabled?: boolean;
    unavailable?: boolean;
    inputSchema?: Record<string, unknown>;
  } = {},
): McpCatalogTool {
  return {
    name,
    description: options.description ?? `${name} description`,
    enabled: options.enabled ?? false,
    definition:
      options.unavailable === true
        ? null
        : {
            serverId: "s",
            toolName: name,
            providerName: mcpProviderToolName("s", "Server", name),
            description: options.description ?? "",
            inputSchema: (options.inputSchema ?? { type: "object" }) as never,
          },
    error: options.unavailable === true ? "input schema is invalid" : null,
    ...(options.hints === undefined ? {} : { hints: options.hints }),
  };
}

function server(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "s",
    projectId: "p",
    name: "Server",
    enabled: true,
    transport: { type: "streamable-http", url: "https://mcp.example.com/mcp" },
    provenance: { source: null, registryType: null, version: null, digest: null },
    catalog: [],
    stale: false,
    error: null,
    refreshedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const names = (tools: readonly McpCatalogTool[]): string[] => tools.map((entry) => entry.name);

const namedRemote = (url: string): string => suggestedServerName({ type: "streamable-http", url });

const namedLocal = (command: string, args: string[]): string =>
  suggestedServerName({ type: "stdio", command, args });

describe("finding tools", () => {
  it("leads with the server's title and keeps the exact name beside it", () => {
    expect(toolLabel(tool("list_issues", { hints: { title: "List issues" } }))).toEqual({
      title: "List issues",
      name: "list_issues",
    });
    expect(toolLabel(tool("list_issues"))).toEqual({ title: "list_issues", name: null });
  });

  it("never lets a title borrow another tool's name", () => {
    const others = new Set(["list_items", "delete_all"]);
    expect(toolLabel(tool("delete_all", { hints: { title: "list_items" } }), others)).toEqual({
      title: "delete_all",
      name: null,
    });
    expect(toolLabel(tool("delete_all", { hints: { title: "Delete all" } }), others)).toEqual({
      title: "Delete all",
      name: "delete_all",
    });
  });

  it("lists by frozen membership, so a toggled row stays where it was", () => {
    const catalog = [tool("alpha"), tool("beta"), tool("gamma")];
    expect(names(listedTools(catalog, "", null))).toEqual(["alpha", "beta", "gamma"]);
    expect(names(listedTools(catalog, "", new Set(["beta", "gamma"])))).toEqual(["beta", "gamma"]);
    expect(names(listedTools(catalog, "gam", new Set(["beta", "gamma"])))).toEqual(["gamma"]);
  });

  it("matches a query against the name, the title and the description, ignoring case", () => {
    const labelled = tool("get_x", { hints: { title: "Fetch Widget" }, description: "Reads one." });
    expect(matchesToolQuery(labelled, "")).toBe(true);
    expect(matchesToolQuery(labelled, "  ")).toBe(true);
    expect(matchesToolQuery(labelled, "GET_")).toBe(true);
    expect(matchesToolQuery(labelled, "widget")).toBe(true);
    expect(matchesToolQuery(labelled, "reads")).toBe(true);
    expect(matchesToolQuery(labelled, "delete")).toBe(false);
    expect(matchesToolQuery(tool("plain", { description: "" }), "title")).toBe(false);
  });

  it("lists what the query and the show filter allow, in the server's order", () => {
    const catalog = [tool("alpha"), tool("beta"), tool("gamma")];
    const selected = new Set(["beta"]);
    expect(names(visibleTools(catalog, "", "all", selected))).toEqual(["alpha", "beta", "gamma"]);
    expect(names(visibleTools(catalog, "", "on", selected))).toEqual(["beta"]);
    expect(names(visibleTools(catalog, "", "off", selected))).toEqual(["alpha", "gamma"]);
    expect(names(visibleTools(catalog, "a", "off", selected))).toEqual(["alpha", "gamma"]);
    expect(names(visibleTools(catalog, "gam", "all", selected))).toEqual(["gamma"]);
  });
});

describe("grouping tools", () => {
  it("puts read-only tools first when the server marks any, and the rest after", () => {
    const groups = groupTools([
      tool("create", { hints: { readOnly: false } }),
      tool("list", { hints: { readOnly: true } }),
      tool("unlabelled"),
      tool("broken", { unavailable: true }),
    ]);
    expect(groups.map((group) => [group.key, group.label, names(group.tools)])).toEqual([
      ["read-only", "Read-only", ["list"]],
      ["writes", "Can make changes", ["create", "unlabelled"]],
      ["unavailable", "Unavailable", ["broken"]],
    ]);
  });

  it("keeps one unlabelled list for a server that marks nothing read-only, and leaves out empty groups", () => {
    expect(
      groupTools([tool("a"), tool("b", { hints: { readOnly: false } })]).map((group) => [
        group.key,
        group.label,
        names(group.tools),
      ]),
    ).toEqual([["tools", null, ["a", "b"]]]);
    expect(groupTools([tool("x", { hints: { readOnly: true } })]).map((g) => g.key)).toEqual([
      "read-only",
    ]);
    expect(groupTools([])).toEqual([]);
  });
});

describe("selecting tools", () => {
  const catalog = [tool("a"), tool("b"), tool("broken", { unavailable: true })];

  it("counts only the tools that can be selected", () => {
    expect(isSelectable(catalog[2]!)).toBe(false);
    expect(selectionOf(catalog, new Set())).toBe("none");
    expect(selectionOf(catalog, new Set(["a"]))).toBe("some");
    expect(selectionOf(catalog, new Set(["a", "b"]))).toBe("all");
    expect(selectionOf([catalog[2]!], new Set())).toBe("none");
  });

  it("selects every listed tool from none or some, clears them from all, and leaves the rest", () => {
    const outside = new Set(["elsewhere"]);
    expect([...toggleTools(catalog, outside)].toSorted()).toEqual(["a", "b", "elsewhere"]);
    expect([...toggleTools(catalog, new Set(["a", "elsewhere"]))].toSorted()).toEqual([
      "a",
      "b",
      "elsewhere",
    ]);
    expect([...toggleTools(catalog, new Set(["a", "b", "elsewhere"]))]).toEqual(["elsewhere"]);
  });

  it("toggles one tool, and never turns on one that cannot be offered", () => {
    expect([...toggleTool(catalog[0]!, new Set())]).toEqual(["a"]);
    expect([...toggleTool(catalog[0]!, new Set(["a"]))]).toEqual([]);
    expect([...toggleTool(catalog[2]!, new Set())]).toEqual([]);
    expect([...toggleTool(catalog[2]!, new Set(["broken"]))]).toEqual([]);
  });

  it("counts the changes a pending selection makes, both ways", () => {
    expect(changedTools(new Set(["a", "b"]), new Set(["b", "c", "d"]))).toBe(3);
    expect(changedTools(new Set(["a"]), new Set(["a"]))).toBe(0);
  });

  it("reads the names a saved catalog has on, skipping any that cannot be offered", () => {
    expect(
      enabledToolNames([
        tool("on", { enabled: true }),
        tool("off"),
        { ...tool("broken", { unavailable: true }), enabled: true },
      ]),
    ).toEqual(["on"]);
  });
});

describe("a tool's arguments", () => {
  it("lists each property, whether it is required, and a single stated type", () => {
    expect(
      toolParameters(
        tool("t", {
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              limit: { type: ["number", "null"] },
              raw: null,
              list: [1],
            },
            required: ["id", 7],
          },
        }),
      ),
    ).toEqual([
      { name: "id", required: true, type: "string" },
      { name: "limit", required: false, type: null },
      { name: "raw", required: false, type: null },
      { name: "list", required: false, type: null },
    ]);
  });

  it("lists nothing for a tool with no definition, no properties, or a malformed schema", () => {
    expect(toolParameters(tool("t", { unavailable: true }))).toEqual([]);
    expect(toolParameters(tool("t"))).toEqual([]);
    expect(toolParameters(tool("t", { inputSchema: { properties: null } }))).toEqual([]);
    expect(toolParameters(tool("t", { inputSchema: { properties: [1] } }))).toEqual([]);
    expect(toolParameters(tool("t", { inputSchema: { properties: "x" } }))).toEqual([]);
    expect(
      toolParameters(tool("t", { inputSchema: { properties: { a: {} }, required: "a" } })),
    ).toEqual([{ name: "a", required: false, type: null }]);
  });
});

describe("a server's health", () => {
  it("says only Off for a server that is off, whatever else is wrong", () => {
    expect(
      serverHealth(
        server({ enabled: false, error: "boom" }),
        {
          signIn: "needs-sign-in",
          missingSecrets: ["header A"],
        },
        true,
      ),
    ).toEqual({ state: "stopped", label: "Off", fix: null, detail: null });
  });

  it("ranks a sign-in in progress, then a needed sign-in, then a missing credential, then a failed refresh", () => {
    const failing = server({ error: "Could not refresh Server." });
    expect(serverHealth(failing, undefined, true)).toMatchObject({
      label: "Signing in…",
      fix: "cancel-sign-in",
    });
    expect(
      serverHealth(failing, { signIn: "needs-sign-in", missingSecrets: ["header A"] }, false),
    ).toMatchObject({ state: "waiting", label: "Needs sign-in", fix: "sign-in" });
    expect(
      serverHealth(failing, { signIn: "signed-in", missingSecrets: ["header A", "env B"] }, false),
    ).toEqual({
      state: "waiting",
      label: "Missing credential",
      fix: "credentials",
      detail: "Missing header A, env B",
    });
    expect(serverHealth(failing, undefined, false)).toEqual({
      state: "error",
      label: "Refresh failed",
      fix: "retry",
      detail: "Could not refresh Server.",
    });
  });

  it("says Signed in or Ready for a healthy server", () => {
    expect(serverHealth(server(), { signIn: "signed-in", missingSecrets: [] }, false)).toEqual({
      state: "ready",
      label: "Signed in",
      fix: null,
      detail: null,
    });
    expect(serverHealth(server(), undefined, false)).toMatchObject({ label: "Ready" });
  });
});

describe("where a server lives, and what to call it", () => {
  it("shows a remote server's host and path, and a local server's command line", () => {
    expect(endpointLabel({ type: "streamable-http", url: "https://mcp.linear.app/mcp" })).toBe(
      "mcp.linear.app/mcp",
    );
    expect(endpointLabel({ type: "streamable-http", url: "https://example.com/" })).toBe(
      "example.com",
    );
    expect(endpointLabel({ type: "streamable-http", url: "not a url" })).toBe("not a url");
    expect(endpointLabel({ type: "stdio", command: "npx", args: ["-y", "", "pkg"] })).toBe(
      "npx -y pkg",
    );
  });

  it("keys a connection by its endpoint alone", () => {
    expect(endpointKey({ type: "streamable-http", url: " https://a.example/mcp " })).toBe(
      endpointKey({ type: "streamable-http", url: "https://a.example/mcp" }),
    );
    expect(endpointKey({ type: "stdio", command: "npx", args: ["a", "b"] })).not.toBe(
      endpointKey({ type: "stdio", command: "npx", args: ["a b"] }),
    );
    expect(endpointKey({ type: "stdio", command: "x", args: [] })).not.toBe(
      endpointKey({ type: "streamable-http", url: "x" }),
    );
  });

  it("names a remote server by the meaningful part of its host", () => {
    const named = namedRemote;
    expect(named("https://mcp.linear.app/mcp")).toBe("Linear");
    expect(named("https://api.githubcopilot.com/mcp/")).toBe("Githubcopilot");
    expect(named("https://example.com/mcp")).toBe("Example");
    expect(named("https://mcp.app/mcp")).toBe("Mcp");
    expect(named("http://127.0.0.1:3000/mcp")).toBe("Local server");
    expect(named("http://[::1]:3000/mcp")).toBe("Local server");
    expect(named("http://localhost:3000/mcp")).toBe("Local server");
    expect(named("https://10.1.2.3/mcp")).toBe("10.1.2.3");
    expect(named("https://[2001:db8::1]/mcp")).toBe("[2001:db8::1]");
    expect(named("")).toBe("");
    expect(named("file:///tmp/server")).toBe("");
  });

  it("names a local server by its package, without a version", () => {
    const named = namedLocal;
    expect(named("npx", ["-y", "@acme/notes-mcp@1.2.0"])).toBe("notes-mcp");
    expect(named("uvx", ["tools-mcp"])).toBe("tools-mcp");
    expect(named("npx", ["@scope"])).toBe("@scope");
    expect(named("node", ["--inspect"])).toBe("node");
    expect(named("", [])).toBe("");
  });
});
