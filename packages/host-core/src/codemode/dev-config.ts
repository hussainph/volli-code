/**
 * Code Mode at a Session's birth, in main (VC-471).
 *
 * The product setting — one switch, a built-in mode per model, Advanced
 * per-model pins — is the {@link CodeModePolicy} stored in app state and edited
 * in Settings → Models. {@link desktopCodeMode} reads it when a Session is born
 * and answers two questions for the surface resolver: is `codemode` offered,
 * and what routes does the new Session freeze. A Session keeps what it was
 * born with; changing the setting reaches only Sessions born after it.
 *
 * A developer can override the setting from an unpackaged build's environment,
 * exactly as VC-454's parallel MCP reads are. A packaged app ignores the
 * variable, so a shipped Volli cannot be talked into Code Mode by its
 * environment.
 *
 * ```sh
 * VOLLI_DEV_CODE_MODE=1 pnpm dev                      # every model, mode `both`
 * VOLLI_DEV_CODE_MODE='{
 *   "mode": "only",
 *   "mcp": { "<serverId>": "deferred" },
 *   "limits": { "maxNestedCalls": 100 }
 * }' pnpm dev
 * ```
 *
 * Everything here is the person's or developer's own statement, read from
 * main's state or process environment — never from the worktree a Session
 * can edit.
 */
import {
  CODE_MODE_LIMIT_BOUNDS,
  codeModeBirth,
  codeModeSurfaceAtBirth,
  DEFAULT_CODE_MODE_LIMITS,
  isCodeModeMode,
  isToolRoute,
  MCP_SERVER_ID_MAX_CHARS,
  type CodeModeBirth,
  type CodeModeLimits,
  type CodeModeMode,
  type CodeModePolicy,
  type CodeModeSurface,
  type McpToolDefinition,
  type SessionToolId,
  type ToolRoute,
} from "@volli/shared";

export const CODE_MODE_DEV_ENV = "VOLLI_DEV_CODE_MODE";

export interface CodeModeDevConfig {
  /** The mode every model is born with while the variable is set. */
  mode: CodeModeMode;
  /** A server's route, by server id; servers it does not name follow the mode. */
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
    return { mode: "both", mcpRoutes: new Map(), limits: { ...DEFAULT_CODE_MODE_LIMITS } };
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("must be 1 or a JSON object");
  for (const key of Object.keys(parsed)) {
    if (key !== "mode" && key !== "mcp" && key !== "limits") {
      throw new Error(`unknown field "${key}"`);
    }
  }
  if (parsed.mode !== undefined && !isCodeModeMode(parsed.mode)) {
    throw new Error("mode must be off, both or only");
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
  return { mode: parsed.mode ?? "both", mcpRoutes, limits };
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

/** The model a Session is born on, as far as Code Mode reads it. */
export interface CodeModeModel {
  providerId: string;
  modelId: string;
}

export interface DesktopCodeMode {
  /**
   * What Code Mode gives a Session born on `model` with `mcpTools`: whether
   * its surface names `codemode`, in which mode, with or without the prompt
   * paragraph, and which servers are too large to declare. Read from the
   * setting now — ONCE per birth: the caller hands this same answer to the
   * surface resolver and to {@link surfaceFor}, so a setting flipped between
   * the two can never freeze a `codemode` whose every route is `direct`.
   *
   * A build whose sandbox could not be located offers nothing and defers
   * nothing: a large server's tools routed behind a `codemode` that cannot
   * run would be unreachable for the Session's whole life.
   */
  birth(model: CodeModeModel | undefined, mcpTools: readonly McpToolDefinition[]): CodeModeBirth;
  /**
   * The record a new Session's surface freezes from `birth`, when that
   * surface names `codemode`. A Subagent Session's surface is already bounded
   * by its parent's (VC-9), so this routes only the tools the child holds —
   * by the child's own mode, from its own model.
   */
  surfaceFor(
    birth: CodeModeBirth,
    tools: readonly SessionToolId[],
    mcpTools: readonly McpToolDefinition[],
  ): CodeModeSurface | undefined;
}

/** What a Session gets when Code Mode cannot run at all: nothing, and nothing deferred. */
const UNAVAILABLE: CodeModeBirth = Object.freeze({
  mode: "off",
  nudge: false,
  offered: false,
  largeServers: new Set<string>(),
});

export function desktopCodeMode(options: {
  env: Readonly<Record<string, string | undefined>>;
  packaged: boolean;
  log: (message: string) => void;
  /** The stored setting, read per birth so a change reaches the next Session. */
  policy: () => CodeModePolicy;
  /** Whether this launch located a sandbox to run programs in. */
  sandboxAvailable: boolean;
}): DesktopCodeMode {
  const read = readCodeModeDevConfig(options.env, { packaged: options.packaged });
  if (read.kind === "invalid") options.log(read.reason);
  const config = read.kind === "on" ? read.config : undefined;
  // The developer's variable stands in for the setting while it is set: on,
  // with its one mode for every model.
  const policy = (model: CodeModeModel | undefined): CodeModePolicy =>
    config === undefined
      ? options.policy()
      : {
          enabled: true,
          models:
            model === undefined ? {} : { [`${model.providerId}/${model.modelId}`]: config.mode },
        };
  return {
    birth: (model, mcpTools) =>
      options.sandboxAvailable
        ? codeModeBirth({ policy: policy(model), model: model ?? null, mcpTools })
        : UNAVAILABLE,
    surfaceFor: (birth, tools, mcpTools) =>
      codeModeSurfaceAtBirth({
        birth,
        tools,
        mcpTools,
        limits: config?.limits ?? DEFAULT_CODE_MODE_LIMITS,
        mcpRoute: (definition) => config?.mcpRoutes.get(definition.serverId),
      }),
  };
}
