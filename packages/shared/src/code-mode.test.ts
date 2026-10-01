import { describe, expect, it } from "vite-plus/test";

import { sessionToolBindings, sessionToolIds } from "./agent-runtime";
import {
  CODE_MODE_LIMIT_BOUNDS,
  codeModeSurfaceFor,
  DEFAULT_CODE_MODE_LIMITS,
  defaultToolRoute,
  isCodeCallableRoute,
  isDeclaredRoute,
  isListedRoute,
  isToolRoute,
  parseCodeModeSurface,
  routeOf,
  TOOL_ROUTES,
  type CodeModeSurface,
} from "./code-mode";
import { mcpProviderToolName, type McpToolDefinition } from "./mcp";

const mcp = (toolName: string): McpToolDefinition => ({
  serverId: "srv",
  toolName,
  providerName: mcpProviderToolName("srv", "Server", toolName),
  description: `${toolName} from the server`,
  inputSchema: { type: "object" },
});

describe("routes", () => {
  it("says, per route, whether a tool is declared, callable from a program, and listed", () => {
    const table = TOOL_ROUTES.map((route) => [
      route,
      isDeclaredRoute(route),
      isCodeCallableRoute(route),
      isListedRoute(route),
    ]);
    expect(table).toEqual([
      ["direct", true, false, false],
      ["both", true, true, true],
      ["code", false, true, true],
      ["deferred", false, true, false],
      ["hidden", false, false, false],
    ]);
    expect(isToolRoute("both")).toBe(true);
    expect(isToolRoute("exposed")).toBe(false);
    expect(isToolRoute(3)).toBe(false);
  });

  it("keeps a person's question, the todo list, shells, screenshots and holds direct", () => {
    for (const tool of [
      "ask_user",
      "todo_write",
      "shell_start",
      "shell_output",
      "shell_kill",
      "browser_screenshot",
      "browser_acquire",
      "browser_release",
    ] as const) {
      expect(defaultToolRoute(tool)).toBe("direct");
    }
    for (const tool of [
      "read",
      "execute",
      "edit",
      "write",
      "web_fetch",
      "browser_snapshot",
    ] as const) {
      expect(defaultToolRoute(tool)).toBe("both");
    }
  });

  it("lets a program start, delegate and watch Sessions, and nothing else of the agent-control family", () => {
    for (const verb of ["session.start", "session.delegate", "watch", "mcp.list"] as const) {
      expect(defaultToolRoute(verb)).toBe("both");
    }
    for (const verb of ["session.stop", "session.send", "automation.run", "mcp.install"] as const) {
      expect(defaultToolRoute(verb)).toBe("direct");
    }
  });

  it("takes an MCP tool's route from the host's choice for it, `both` when it made none", () => {
    const definition = mcp("search");
    expect(defaultToolRoute(definition.providerName)).toBe("both");
    expect(defaultToolRoute(definition.providerName, "deferred")).toBe("deferred");
  });
});

describe("codeModeSurfaceFor", () => {
  it("routes every tool of the surface but codemode, with the default limits", () => {
    const search = mcp("search");
    const fetch = mcp("fetch");
    const surface = codeModeSurfaceFor({
      tools: [
        "read",
        "ask_user",
        "codemode",
        "session.stop",
        search.providerName,
        fetch.providerName,
      ],
      mcpTools: [search, fetch],
      mcpRoute: (definition) => (definition.toolName === "search" ? "deferred" : undefined),
    });
    expect(surface.routes).toEqual({
      read: "both",
      ask_user: "direct",
      "session.stop": "direct",
      [search.providerName]: "deferred",
      [fetch.providerName]: "both",
    });
    expect(surface.limits).toEqual(DEFAULT_CODE_MODE_LIMITS);
    expect(surface.limits).not.toBe(DEFAULT_CODE_MODE_LIMITS);
  });

  it("records limits a host chose", () => {
    const limits = { ...DEFAULT_CODE_MODE_LIMITS, maxNestedCalls: 10 };
    expect(codeModeSurfaceFor({ tools: ["read"], limits }).limits.maxNestedCalls).toBe(10);
  });
});

describe("parseCodeModeSurface", () => {
  const good: CodeModeSurface = {
    routes: { read: "code", write: "both" },
    limits: { ...DEFAULT_CODE_MODE_LIMITS },
  };
  const tools = ["read", "write", "codemode"];

  it("reads back a record that routes exactly its surface", () => {
    expect(parseCodeModeSurface(good, tools)).toEqual(good);
  });

  it("refuses every way a record can be damaged", () => {
    expect(() => parseCodeModeSurface(null, tools)).toThrow("codeMode must be an object");
    expect(() => parseCodeModeSurface([], tools)).toThrow("codeMode must be an object");
    expect(() => parseCodeModeSurface({ ...good, routes: "all" }, tools)).toThrow(
      "codeMode.routes must be an object",
    );
    expect(() => parseCodeModeSurface(good, ["read", "write"])).toThrow(
      "the surface does not hold codemode",
    );
    expect(() => parseCodeModeSurface({ ...good, routes: { read: "code" } }, tools)).toThrow(
      "must name exactly the tools of the surface",
    );
    expect(() =>
      parseCodeModeSurface({ ...good, routes: { read: "code", other: "both" } }, tools),
    ).toThrow("must name exactly the tools of the surface");
    expect(() =>
      parseCodeModeSurface({ ...good, routes: { read: "code", write: "exposed" } }, tools),
    ).toThrow("codeMode.routes.write is not a route");
    for (const key of Object.keys(
      CODE_MODE_LIMIT_BOUNDS,
    ) as (keyof typeof CODE_MODE_LIMIT_BOUNDS)[]) {
      const bound = CODE_MODE_LIMIT_BOUNDS[key];
      for (const value of [bound.min - 1, bound.max + 1, 1.5, "10"]) {
        expect(() =>
          parseCodeModeSurface({ ...good, limits: { ...good.limits, [key]: value } }, tools),
        ).toThrow(`codeMode.limits.${key} must be a whole number`);
      }
    }
    expect(() =>
      parseCodeModeSurface({ ...good, limits: { ...good.limits, maxImages: 3 } }, tools),
    ).toThrow("codeMode.limits names a limit this build does not know");
  });
});

describe("routeOf", () => {
  it("answers direct for a Session without Code Mode and for a tool it does not route", () => {
    expect(routeOf(undefined, "read")).toBe("direct");
    const surface = codeModeSurfaceFor({ tools: ["read", "codemode"] });
    expect(routeOf(surface, "read")).toBe("both");
    expect(routeOf(surface, "write")).toBe("direct");
  });
});

describe("the codemode binding", () => {
  it("binds codemode after every other capability tool, carrying its record", () => {
    const base = { tools: { tools: ["read", "execute"] as const } };
    const codeMode = codeModeSurfaceFor({
      tools: sessionToolIds({ tools: { tools: ["read", "execute"] } }),
    });
    const spec = { tools: { tools: [...base.tools.tools], codeMode } };
    expect(sessionToolIds(spec)).toEqual(["read", "execute", "codemode"]);
    expect(sessionToolBindings(spec).at(-1)).toEqual({ tool: "codemode", codeMode });
  });

  it("refuses a record that routes a different surface", () => {
    expect(() =>
      sessionToolIds({
        tools: {
          tools: ["read", "write"],
          codeMode: { routes: { read: "both" }, limits: DEFAULT_CODE_MODE_LIMITS },
        },
      }),
    ).toThrow("must name exactly the tools of the surface");
  });
});
