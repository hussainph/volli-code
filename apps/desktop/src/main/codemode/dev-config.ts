/**
 * The developer-only opt-in for Code Mode (VC-471, phase 1).
 *
 * There is no product setting and no UI yet: phase 2 ships those only if the
 * owner accepts phase 1's numbers. Until then Code Mode is read from one
 * environment variable, and only by an unpackaged build, exactly as VC-454's
 * parallel MCP reads are. A packaged app ignores it, so a shipped Volli cannot
 * be talked into Code Mode by its environment.
 *
 * ```sh
 * VOLLI_DEV_CODE_MODE=1 pnpm dev
 * VOLLI_DEV_CODE_MODE='{
 *   "mcp": { "<serverId>": "deferred" },
 *   "limits": { "maxNestedCalls": 100 }
 * }' pnpm dev
 * ```
 *
 * While it is set, every Session CREATED gets the `codemode` tool, its routes
 * and its limits frozen into its `tool-surface` record; `mcp` sets the route
 * of a server's tools (default `both`). A Session keeps what it was born with:
 * unsetting the variable stops new Sessions getting Code Mode and changes
 * nothing about Sessions that already have it, because their provider tool
 * array is part of their frozen Cache Prefix.
 *
 * Everything here is the developer's own statement, read from main's process
 * environment — never from the worktree a Session can edit.
 */
import { join } from "node:path";
import { codeModeSandboxAssetsFrom, type CodeModeSandboxAssets } from "@volli/agent-runtime";
import {
  CODE_MODE_LIMIT_BOUNDS,
  CODE_MODE_TOOL_ID,
  codeModeSurfaceFor,
  DEFAULT_CODE_MODE_LIMITS,
  isToolRoute,
  MCP_SERVER_ID_MAX_CHARS,
  type CodeModeLimits,
  type CodeModeSurface,
  type McpToolDefinition,
  type SessionToolId,
  type ToolRoute,
} from "@volli/shared";

export const CODE_MODE_DEV_ENV = "VOLLI_DEV_CODE_MODE";

export interface CodeModeDevConfig {
  /** A server's route, by server id; servers it does not name are `both`. */
  mcpRoutes: ReadonlyMap<string, ToolRoute>;
  limits: CodeModeLimits;
}

export type CodeModeDevConfigResult =
  | { kind: "off" }
  | { kind: "on"; config: CodeModeDevConfig }
  | { kind: "invalid"; reason: string };

const SERVER_ID = /^[A-Za-z0-9_-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfig(raw: string): CodeModeDevConfig {
  if (raw === "1" || raw === "on" || raw === "true") {
    return { mcpRoutes: new Map(), limits: { ...DEFAULT_CODE_MODE_LIMITS } };
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("must be 1 or a JSON object");
  for (const key of Object.keys(parsed)) {
    if (key !== "mcp" && key !== "limits") throw new Error(`unknown field "${key}"`);
  }
  const mcpRoutes = new Map<string, ToolRoute>();
  if (parsed.mcp !== undefined) {
    if (!isRecord(parsed.mcp)) throw new Error("mcp must be an object of server routes");
    for (const [serverId, route] of Object.entries(parsed.mcp)) {
      if (!SERVER_ID.test(serverId) || serverId.length > MCP_SERVER_ID_MAX_CHARS) {
        throw new Error(`mcp key "${serverId}" is not a server id`);
      }
      if (!isToolRoute(route)) throw new Error(`mcp route for "${serverId}" is not a route`);
      mcpRoutes.set(serverId, route);
    }
  }
  const limits: CodeModeLimits = { ...DEFAULT_CODE_MODE_LIMITS };
  if (parsed.limits !== undefined) {
    if (!isRecord(parsed.limits)) throw new Error("limits must be an object");
    for (const [key, value] of Object.entries(parsed.limits)) {
      if (!Object.hasOwn(CODE_MODE_LIMIT_BOUNDS, key)) throw new Error(`unknown limit "${key}"`);
      const bound = CODE_MODE_LIMIT_BOUNDS[key as keyof CodeModeLimits];
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < bound.min ||
        value > bound.max
      ) {
        throw new Error(`limit ${key} must be a whole number in [${bound.min}, ${bound.max}]`);
      }
      limits[key as keyof CodeModeLimits] = value;
    }
  }
  return { mcpRoutes, limits };
}

export function readCodeModeDevConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { packaged: boolean },
): CodeModeDevConfigResult {
  const raw = env[CODE_MODE_DEV_ENV]?.trim();
  if (options.packaged || raw === undefined || raw === "" || raw === "0") return { kind: "off" };
  try {
    return { kind: "on", config: readConfig(raw) };
  } catch (error) {
    return {
      kind: "invalid",
      reason: `${CODE_MODE_DEV_ENV} is ignored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface DesktopCodeMode {
  /** Whether new Sessions are offered `codemode`. */
  readonly enabled: boolean;
  /** The record a new Session's surface freezes, when that surface names `codemode`. */
  surfaceFor(
    tools: readonly SessionToolId[],
    mcpTools: readonly McpToolDefinition[],
  ): CodeModeSurface | undefined;
}

export function desktopCodeMode(options: {
  env: Readonly<Record<string, string | undefined>>;
  packaged: boolean;
  log: (message: string) => void;
}): DesktopCodeMode {
  const read = readCodeModeDevConfig(options.env, { packaged: options.packaged });
  if (read.kind === "invalid") options.log(read.reason);
  const config = read.kind === "on" ? read.config : undefined;
  return {
    enabled: config !== undefined,
    surfaceFor: (tools, mcpTools) => {
      if (!tools.includes(CODE_MODE_TOOL_ID)) return undefined;
      return codeModeSurfaceFor({
        tools,
        mcpTools,
        mcpRoute: (definition) => config?.mcpRoutes.get(definition.serverId),
        limits: config?.limits ?? DEFAULT_CODE_MODE_LIMITS,
      });
    },
  };
}

/**
 * Where an unpackaged build's Code Mode sandbox finds its worker and its
 * WebAssembly: the workspace's own installed copy of `@volli/agent-runtime`,
 * reached through the app directory's `node_modules`. Bundled into main, the
 * sandbox cannot find either beside itself.
 *
 * Answered for every unpackaged build, opt-in or not, so a Session born with
 * Code Mode keeps a working sandbox after the variable is unset. A packaged
 * build answers nothing: it offers Code Mode to no Session in phase 1, and a
 * Session that reaches it anyway gets a failed run rather than a crash.
 */
export function codeModeSandboxFor(
  unpackaged: boolean,
  appPath: () => string,
  log: (message: string) => void,
): { codeModeSandbox?: CodeModeSandboxAssets } {
  if (!unpackaged) return {};
  try {
    return {
      codeModeSandbox: codeModeSandboxAssetsFrom(
        join(appPath(), "node_modules", "@volli", "agent-runtime"),
      ),
    };
  } catch (error) {
    log(
      `Code Mode's sandbox could not be located: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}
