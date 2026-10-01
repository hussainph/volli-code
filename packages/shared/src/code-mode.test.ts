import { describe, expect, it } from "vite-plus/test";

import { sessionToolBindings, sessionToolIds } from "./agent-runtime";
import {
  CODE_MODE_LIMIT_BOUNDS,
  codeModeSurfaceFor,
  DEFAULT_CODE_MODE_LIMITS,
  defaultToolRoute,
  isCodeCallable,
  isCodeCallableRoute,
  isDeclaredRoute,
  isListedRoute,
  isToolRoute,
  parseCodeModeSurface,
  isCodeModeMode,
  routeOf,
  TOOL_ROUTES,
  toolGroupOf,
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

describe("isCodeCallable", () => {
  it("holds a damaged record to the rules: no direct-only tool, unlisted verb or codemode in a program", () => {
    expect(isCodeCallable("read", "both")).toBe(true);
    expect(isCodeCallable("read", "direct")).toBe(false);
    expect(isCodeCallable("shell_start", "code")).toBe(false);
    expect(isCodeCallable("ask_user", "both")).toBe(false);
    expect(isCodeCallable("session.start", "code")).toBe(true);
    expect(isCodeCallable("mcp.install", "both")).toBe(false);
    expect(isCodeCallable("codemode", "both")).toBe(false);
    expect(isCodeCallable(mcp("search").providerName, "deferred")).toBe(true);
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

  it("routes whole groups under `only`, keeping a group with a direct-only member declared", () => {
    const search = mcp("search");
    const tools = [
      "read",
      "execute",
      "web_fetch",
      "browser_snapshot",
      "browser_screenshot",
      "ask_user",
      "session.delegate",
      "watch",
      search.providerName,
      "codemode",
    ] as const;
    const only = codeModeSurfaceFor({ tools, mcpTools: [search], mode: "only" });
    expect(only.mode).toBe("only");
    expect(only.routes).toEqual({
      read: "code",
      execute: "code",
      web_fetch: "code",
      // The Browser keeps its screenshot declared, so the whole group stays.
      browser_snapshot: "both",
      browser_screenshot: "direct",
      ask_user: "direct",
      // A Ticket Session's agent group is all callable, so it goes whole.
      "session.delegate": "code",
      watch: "code",
      [search.providerName]: "code",
    });
    // In a Board Session the same verbs sit beside `session.stop`, which stays.
    expect(
      codeModeSurfaceFor({ tools: ["session.start", "session.stop", "codemode"], mode: "only" })
        .routes,
    ).toEqual({ "session.start": "both", "session.stop": "direct" });
    const off = codeModeSurfaceFor({ tools, mcpTools: [search], mode: "off" });
    expect(Object.values(off.routes).every((route) => route === "direct")).toBe(true);
    expect(codeModeSurfaceFor({ tools, mode: "both" }).routes["read"]).toBe("both");
    expect(codeModeSurfaceFor({ tools, mode: "both", nudge: true }).nudge).toBe(true);
    expect(codeModeSurfaceFor({ tools, mode: "both", nudge: false })).not.toHaveProperty("nudge");
  });

  it("names a tool's capability group", () => {
    expect(
      [
        "read",
        "web_search",
        "todo_write",
        "shell_kill",
        "browser_find",
        "session.send",
        "watch",
        "automation.run",
        "mcp.install",
        "classify",
      ].map((tool) => toolGroupOf(tool)),
    ).toEqual([
      "coding",
      "web",
      "conversation",
      "shell",
      "browser",
      "agents",
      "agents",
      "agents",
      "mcp-management",
      "tool:classify",
    ]);
    expect(toolGroupOf(mcp("search").providerName, mcp("search"))).toBe("mcp:srv");
    expect(toolGroupOf(mcp("search").providerName)).toBe(`mcp:${mcp("search").providerName}`);
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

  it("reads back a record that routes exactly its surface, with its mode when it has one", () => {
    expect(parseCodeModeSurface(good, tools)).toEqual(good);
    expect(parseCodeModeSurface({ ...good, mode: "only" }, tools)).toEqual({
      ...good,
      mode: "only",
    });
    expect(parseCodeModeSurface({ ...good, nudge: true }, tools)).toEqual({ ...good, nudge: true });
    expect(isCodeModeMode("both")).toBe(true);
    expect(isCodeModeMode("sometimes")).toBe(false);
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
    expect(() => parseCodeModeSurface({ ...good, limits: { maxNestedCalls: 10 } }, tools)).toThrow(
      "codeMode.limits.timeoutMs must be a whole number",
    );
    expect(() => parseCodeModeSurface({ ...good, mode: "sometimes" }, tools)).toThrow(
      "codeMode.mode is not a Code Mode mode",
    );
    expect(() => parseCodeModeSurface({ ...good, nudge: false }, tools)).toThrow(
      "codeMode.nudge is true or absent",
    );
    // A key a newer build added is ignored, so a downgrade still decodes it.
    expect(
      parseCodeModeSurface({ ...good, extra: 1, limits: { ...good.limits, maxImages: 3 } }, tools),
    ).toEqual(good);
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
