/**
 * Code Mode's frozen half (VC-471): which route each tool of a Session takes,
 * and the limits every script run is held to.
 *
 * Code Mode is one more tool, `codemode`, whose argument is a short JavaScript
 * program. The program calls the Session's own tools as `tools.<name>(args)`,
 * and only what it returns or prints reaches the model. Everything about WHICH
 * tools a program may call, and how far it may go, is decided here, at Session
 * birth, by the host — never by the program, never by a file in the worktree,
 * and never again after the Session exists.
 *
 * ## Routes
 *
 * A route says how the model reaches one tool of the frozen surface. The
 * vocabulary is Pi's MCP `exposure`, renamed where Pi's word means something
 * else in Volli:
 *
 * | route      | declared to the model | callable from a script | listed in the `codemode` description |
 * | ---------- | --------------------- | ---------------------- | ------------------------------------ |
 * | `direct`   | yes                   | no                     | no                                   |
 * | `both`     | yes                   | yes                    | yes                                  |
 * | `code`     | no                    | yes                    | yes                                  |
 * | `deferred` | no                    | yes                    | no — found with `searchTools()`      |
 * | `hidden`   | no                    | no                     | no                                   |
 *
 * Pi's `direct` is Volli's `both`: Pi's direct tools are also callable from
 * codemode, and Volli needs a word for a tool that is NOT (`ask_user`, the
 * todo list, background shells, screenshots). Pi's `codemode` exposure is
 * Volli's `code`, and `codemode-deferred` is `deferred`.
 *
 * ## Why the routes are frozen
 *
 * The routes decide the provider tool array (declared tools plus `codemode`),
 * and the Cache Prefix is computed over that array. A route that changed
 * between attachments would change the array, which the frozen-surface rule
 * forbids (VC-164). So the routes are part of the `tool-surface` record, a
 * restart reads them back, and a change of policy reaches only Sessions born
 * after it.
 *
 * ## Why the limits are frozen beside them
 *
 * Sandbox settings must come from app-owned state, never from a file the
 * Session can edit. The record is written by the host at birth, through the
 * Session Engine, and the runtime reads nothing else.
 */

import { CAPABILITY_TOOL_IDS, type SessionToolId } from "./authority";
import { isMcpToolId, type McpToolDefinition } from "./mcp";

/** The name the model calls, and the name the frozen surface records. */
export const CODE_MODE_TOOL_ID = "codemode";

export const TOOL_ROUTES = ["direct", "both", "code", "deferred", "hidden"] as const;
export type ToolRoute = (typeof TOOL_ROUTES)[number];

export function isToolRoute(value: unknown): value is ToolRoute {
  return typeof value === "string" && (TOOL_ROUTES as readonly string[]).includes(value);
}

/** Whether a tool on this route is in the provider tool array. */
export function isDeclaredRoute(route: ToolRoute): boolean {
  return route === "direct" || route === "both";
}

/** Whether a script may call a tool on this route. */
export function isCodeCallableRoute(route: ToolRoute): boolean {
  return route === "both" || route === "code" || route === "deferred";
}

/** Whether a tool on this route is declared, as TypeScript, in the `codemode` description. */
export function isListedRoute(route: ToolRoute): boolean {
  return route === "both" || route === "code";
}

/**
 * The hard limits one script run is held to. Every one is enforced by the
 * host, outside the VM; none can be raised from inside a script.
 */
export interface CodeModeLimits {
  /**
   * Active time per run, in milliseconds. Time a nested call spends waiting for
   * a person to answer an approval is not counted: a script that pauses on a
   * person must not time out because the person was slow.
   */
  timeoutMs: number;
  /** The QuickJS heap. Allocations past it fail inside the script. */
  memoryLimitBytes: number;
  /** What one run may hand the model, as UTF-8; the rest is cut and saved. */
  maxOutputBytes: number;
  /** Nested tool calls one run may make. The next one fails inside the script. */
  maxNestedCalls: number;
  /**
   * Nested calls in flight at once. Only tools that may overlap ever do (see
   * the runtime's scheduler); everything else runs one at a time regardless.
   */
  maxConcurrency: number;
  /**
   * Estimated tokens the TypeScript declarations in the `codemode` description
   * may spend. Tools past it are named by namespace and count, and a script
   * finds them with `searchTools()`.
   */
  declarationBudgetTokens: number;
}

/**
 * Pi's own defaults where Pi has one (five minutes, a 3,000-token declaration
 * budget), and Volli's MCP result bound for the output. The rest are chosen to
 * fit the loop shape VC-245 measured: `bash` averaged 8.2 s a call, so 200
 * calls in five minutes is already more than a loop will reach.
 */
export const DEFAULT_CODE_MODE_LIMITS: CodeModeLimits = Object.freeze({
  timeoutMs: 300_000,
  memoryLimitBytes: 64 * 1_024 * 1_024,
  maxOutputBytes: 20 * 1_024,
  maxNestedCalls: 200,
  maxConcurrency: 4,
  declarationBudgetTokens: 3_000,
});

/**
 * The range each limit may take in a durable record. A record outside it is
 * damaged rather than a policy: zero calls, zero bytes or an hour of runtime
 * are not limits anybody chose.
 */
export const CODE_MODE_LIMIT_BOUNDS: Readonly<
  Record<keyof CodeModeLimits, { min: number; max: number }>
> = Object.freeze({
  timeoutMs: { min: 1_000, max: 1_800_000 },
  memoryLimitBytes: { min: 1_024 * 1_024, max: 1_024 * 1_024 * 1_024 },
  maxOutputBytes: { min: 1_024, max: 1_024 * 1_024 },
  maxNestedCalls: { min: 1, max: 10_000 },
  maxConcurrency: { min: 1, max: 32 },
  declarationBudgetTokens: { min: 0, max: 100_000 },
});

/**
 * How much of a Session's surface goes through Code Mode, chosen per model.
 *
 * - `off` — no `codemode` tool, unless a large MCP server needs one (see
 *   `code-mode-policy.ts`); every other tool is declared and called directly.
 * - `both` — `codemode` beside every tool, each tool also declared: the model
 *   picks per step. Costs the `codemode` description on every turn.
 * - `only` — `codemode` instead of every capability group a program can call
 *   whole (coding, web, each MCP server…); groups with a member a program
 *   cannot call (the Browser's screenshot, the shells, a person's question)
 *   stay declared whole.
 */
export const CODE_MODE_MODES = ["off", "both", "only"] as const;
export type CodeModeMode = (typeof CODE_MODE_MODES)[number];

export function isCodeModeMode(value: unknown): value is CodeModeMode {
  return typeof value === "string" && (CODE_MODE_MODES as readonly string[]).includes(value);
}

/** Code Mode as one Session was born with it. */
export interface CodeModeSurface {
  /**
   * The route of every tool in the frozen surface except `codemode` itself,
   * keyed by the durable tool id. Exactly those keys: a missing one or an
   * extra one is a damaged record.
   */
  routes: Readonly<Record<string, ToolRoute>>;
  limits: CodeModeLimits;
  /**
   * The mode the routes were derived from, for a reader (the Session header,
   * a benchmark). The routes are what binds; a record from before modes
   * existed has none.
   */
  mode?: CodeModeMode;
  /**
   * Whether the system prompt carries Code Mode's short "when to write a
   * program" paragraph. Frozen with the routes because the system prompt is
   * part of the Cache Prefix; chosen per model at birth, because whether the
   * paragraph helps is a measured property of the model.
   */
  nudge?: true;
}

/**
 * Tools a script never calls, whatever the host's MCP policy says.
 *
 * Each is a decision, and each is about what a script cannot do well rather
 * than about danger:
 *
 * - `ask_user` puts a question in front of a person. A loop that asks is a
 *   loop that interrupts someone N times; the model should ask, once, itself.
 * - `todo_write` is read by the person watching and by the ticket, both of
 *   which fold the list out of the model's own calls.
 * - The background shells start processes that outlive the script that
 *   started them, which a run's cancellation could not then reach.
 * - `browser_screenshot` returns an image. Phase 1 lets no image into a
 *   script or out of one (see the runtime's result shaping), so a screenshot
 *   from code would be a call whose whole result is thrown away.
 * - The hold pair is a turn-level promise to a person about a tab; a script
 *   gets holds implicitly through its writes, as a direct call does.
 */
const DIRECT_ONLY_CAPABILITIES: ReadonlySet<string> = new Set([
  "ask_user",
  "todo_write",
  "shell_start",
  "shell_output",
  "shell_kill",
  "browser_screenshot",
  "browser_acquire",
  "browser_release",
]);

/**
 * Verbs a script may call. Everything else in the registry stays direct.
 *
 * Starting and delegating Sessions and watching them are the multi-Session
 * shape VC-245 measured; `mcp.list` is a read. The rest of the agent-control
 * family (stop, send, Automation runs) and every MCP mutation stay where a
 * person can see each one called on its own.
 */
const CODE_CALLABLE_VERBS: ReadonlySet<string> = new Set([
  "session.start",
  "session.delegate",
  "watch",
  "mcp.list",
]);

/**
 * The capability group a tool belongs to, for routing whole groups at once.
 *
 * Code Mode routes a group, not a tool: a model that sees three of the
 * Browser's nine tools declared and six only inside programs reaches for the
 * three (a phase 1 benchmark watched GLM call `browser_screenshot` over and
 * over, the only Browser tool left declared). So under `only` a group either
 * leaves the declared array whole or stays in it whole.
 *
 * Each MCP server is its own group, named by the server id its definition
 * froze; one the caller has no definition for is grouped by its own name.
 */
export function toolGroupOf(tool: string, definition?: McpToolDefinition): string {
  if (isMcpToolId(tool)) return `mcp:${definition?.serverId ?? tool}`;
  switch (tool) {
    case "read":
    case "edit":
    case "write":
    case "execute":
      return "coding";
    case "web_fetch":
    case "web_search":
      return "web";
    case "ask_user":
    case "todo_write":
      return "conversation";
    case "shell_start":
    case "shell_output":
    case "shell_kill":
      return "shell";
  }
  if (tool.startsWith("browser_")) return "browser";
  if (tool.startsWith("session.") || tool === "watch" || tool === "automation.run") {
    return "agents";
  }
  if (tool.startsWith("mcp.")) return "mcp-management";
  return `tool:${tool}`;
}

/**
 * The default route for one tool, given the route the host chose for its MCP
 * server when it is an MCP tool.
 */
export function defaultToolRoute(tool: SessionToolId, mcpRoute?: ToolRoute): ToolRoute {
  if (isMcpToolId(tool)) return mcpRoute ?? "both";
  if ((CAPABILITY_TOOL_IDS as readonly string[]).includes(tool)) {
    return DIRECT_ONLY_CAPABILITIES.has(tool) ? "direct" : "both";
  }
  // What is left is the verb half of the vocabulary.
  return CODE_CALLABLE_VERBS.has(tool) ? "both" : "direct";
}

/**
 * Whether a program may call `tool` on `route` — the route, held to the
 * rules {@link defaultToolRoute} was written from.
 *
 * A record is host-written, but it is durable data, and durable data can be
 * damaged. Read through this, a record that routed `shell_start`, `ask_user`
 * or an agent-control verb into programs still leaves it direct: the
 * exclusions above are about what a program cannot do safely, and no record
 * decides those. `codemode` itself is never callable from a program.
 */
export function isCodeCallable(tool: string, route: ToolRoute): boolean {
  if (!isCodeCallableRoute(route) || tool === CODE_MODE_TOOL_ID) return false;
  if (isMcpToolId(tool)) return true;
  if ((CAPABILITY_TOOL_IDS as readonly string[]).includes(tool)) {
    return !DIRECT_ONLY_CAPABILITIES.has(tool);
  }
  return CODE_CALLABLE_VERBS.has(tool);
}

/**
 * The Code Mode record a new Session is born with: one route per tool of its
 * resolved surface, and the limits.
 *
 * `mode` (default `both`) says how far the surface goes through programs; see
 * {@link CodeModeMode}. `mcpRoute` is the host's per-server choice for MCP
 * tools — `deferred` for a large server, say — and wins over the mode for
 * the tools it answers; it is consulted only for MCP tools, and only for the
 * definition the surface actually froze. A route is always held to
 * {@link isCodeCallable}: no choice routes a direct-only tool into programs.
 */
export function codeModeSurfaceFor(input: {
  tools: readonly SessionToolId[];
  mcpTools?: readonly McpToolDefinition[];
  mcpRoute?: (definition: McpToolDefinition) => ToolRoute | undefined;
  limits?: CodeModeLimits;
  mode?: CodeModeMode;
  nudge?: boolean;
}): CodeModeSurface {
  const mode = input.mode ?? "both";
  const definitions = new Map(
    (input.mcpTools ?? []).map((definition) => [definition.providerName as string, definition]),
  );
  const tools = input.tools.filter((tool) => tool !== CODE_MODE_TOOL_ID);
  // A group leaves the declared array only when every member this surface
  // holds can be called from a program.
  const mixed = new Set<string>();
  for (const tool of tools) {
    if (!isCodeCallable(tool, "both")) mixed.add(toolGroupOf(tool, definitions.get(tool)));
  }
  const routes: Record<string, ToolRoute> = {};
  for (const tool of tools) {
    const definition = definitions.get(tool);
    const chosen = definition === undefined ? undefined : input.mcpRoute?.(definition);
    if (chosen !== undefined) {
      routes[tool] = defaultToolRoute(tool, chosen);
      continue;
    }
    const callable = defaultToolRoute(tool) === "both";
    if (!callable || mode === "off") routes[tool] = "direct";
    else if (mode === "both" || mixed.has(toolGroupOf(tool, definition))) routes[tool] = "both";
    else routes[tool] = "code";
  }
  return {
    routes,
    limits: { ...(input.limits ?? DEFAULT_CODE_MODE_LIMITS) },
    ...(input.mode === undefined ? {} : { mode }),
    ...(input.nudge === true ? { nudge: true as const } : {}),
  };
}

/**
 * A Code Mode record read back against the surface it was frozen with.
 *
 * Strict in both directions about routes, on the frozen-surface rule's
 * reasoning: a record that names a tool the surface does not hold, or leaves
 * one out, would bind a different provider tool array than the one the
 * Session was born with. Strict about every limit and field this build
 * knows; a key it does not know is ignored, so an older build can still
 * decode a newer Session's record.
 */
export function parseCodeModeSurface(
  value: unknown,
  tools: readonly string[],
  context = "codeMode",
): CodeModeSurface {
  const row = record(value, context);
  const routesRow = record(row.routes, `${context}.routes`);
  const limitsRow = record(row.limits, `${context}.limits`);
  if (!tools.includes(CODE_MODE_TOOL_ID)) {
    throw new Error(`${context} is present but the surface does not hold ${CODE_MODE_TOOL_ID}`);
  }
  const expected = tools.filter((tool) => tool !== CODE_MODE_TOOL_ID);
  const keys = Object.keys(routesRow);
  if (keys.length !== expected.length || expected.some((tool) => !Object.hasOwn(routesRow, tool))) {
    throw new Error(`${context}.routes must name exactly the tools of the surface`);
  }
  const routes: Record<string, ToolRoute> = {};
  for (const tool of expected) {
    const route = routesRow[tool];
    if (!isToolRoute(route)) throw new Error(`${context}.routes.${tool} is not a route`);
    routes[tool] = route;
  }
  const limits = {} as CodeModeLimits;
  for (const key of Object.keys(CODE_MODE_LIMIT_BOUNDS) as (keyof CodeModeLimits)[]) {
    const limit = limitsRow[key];
    const bound = CODE_MODE_LIMIT_BOUNDS[key];
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < bound.min ||
      limit > bound.max
    ) {
      throw new Error(
        `${context}.limits.${key} must be a whole number in [${bound.min}, ${bound.max}]`,
      );
    }
    limits[key] = limit;
  }
  // A key this build does not know — a limit or a field a newer build added —
  // is left unread rather than refused, so a downgrade can still attach a
  // Session a newer build created. Every key this build DOES know is held to
  // its rule above and below; the routes, which bind the tool array, stay
  // exact in both directions.
  if (row.mode !== undefined && !isCodeModeMode(row.mode)) {
    throw new Error(`${context}.mode is not a Code Mode mode`);
  }
  if (row.nudge !== undefined && row.nudge !== true) {
    throw new Error(`${context}.nudge is true or absent`);
  }
  return {
    routes,
    limits,
    ...(row.mode === undefined ? {} : { mode: row.mode }),
    ...(row.nudge === true ? { nudge: true as const } : {}),
  };
}

/** The route of one tool in a surface that holds Code Mode; `direct` for one it does not route. */
export function routeOf(surface: CodeModeSurface | undefined, tool: string): ToolRoute {
  if (surface === undefined) return "direct";
  return surface.routes[tool] ?? "direct";
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}
