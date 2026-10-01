/**
 * Code Mode's product setting (VC-471, phase 2): one switch, a mode per model,
 * and the rule that keeps large MCP servers out of the declared tool array.
 *
 * What a person sees is one switch, "Code Mode", on by default. Behind it,
 * each model gets the mode the benchmark found best for it
 * ({@link CODE_MODE_MODEL_DEFAULTS}), and an Advanced list lets a person
 * pin a different mode for one model. Everything here is read once, when a
 * Session is born, and frozen into its `tool-surface` record: changing the
 * setting changes what new Sessions get and nothing about Sessions that
 * already exist, because their tool array is part of their Cache Prefix.
 *
 * ## Large MCP servers
 *
 * A server past {@link LARGE_MCP_SERVER_TOOLS} tools, or whose declarations
 * would cost past {@link LARGE_MCP_SERVER_TOKENS} tokens, is routed
 * `deferred` whatever the model's mode: none of its tools is declared, the
 * `codemode` description names the server and how many tools it has, and a
 * program finds the ones it needs with `searchTools()`. That holds for a model
 * whose mode is `off` too — such a Session gets `codemode` for its large
 * servers alone, with every other tool declared as before. Turning the switch
 * off turns this off with it: a Session born with Code Mode off declares every
 * tool, exactly as before Code Mode existed.
 */

import {
  CODE_MODE_TOOL_ID,
  codeModeSurfaceFor,
  DEFAULT_CODE_MODE_LIMITS,
  isCodeModeMode,
  type CodeModeLimits,
  type CodeModeMode,
  type CodeModeSurface,
  type ToolRoute,
} from "./code-mode";
import type { McpToolDefinition } from "./mcp";
import type { SessionToolId } from "./authority";

/** The setting, whole: what the Models pane edits and main stores. */
export interface CodeModePolicy {
  /** The one switch. Off: no new Session gets Code Mode at all. */
  enabled: boolean;
  /**
   * Advanced: a mode a person pinned for one model, by {@link codeModeModelKey}.
   * A model it does not name takes its built-in default.
   */
  models: Readonly<Record<string, CodeModeMode>>;
}

export const DEFAULT_CODE_MODE_POLICY: CodeModePolicy = Object.freeze({
  enabled: true,
  models: Object.freeze({}),
});

/** How many per-model pins a policy may hold; the catalog itself is about 1,000 models. */
export const CODE_MODE_POLICY_MODELS_MAX = 500;

/** The key a per-model pin is stored under. */
export function codeModeModelKey(model: { providerId: string; modelId: string }): string {
  return `${model.providerId}/${model.modelId}`;
}

/**
 * The built-in mode per model family, matched on the model id (so a model
 * reached through another provider — Claude on Bedrock, say — gets its
 * family's default). First match wins; a model no row matches is `off`.
 *
 * Each row is a benchmark finding, recorded in
 * `docs/research/code-mode-vc-471.md` §4, not a guess: a mode is the default
 * only where it measured cheaper at the same correctness.
 */
export const CODE_MODE_MODEL_DEFAULTS: readonly {
  readonly family: string;
  readonly match: RegExp;
  readonly mode: CodeModeMode;
  /**
   * Whether a Session of this family in mode `both` gets the system prompt's
   * short "when to write a program" paragraph. A measured property of the
   * model, like the mode: it helps where a model would otherwise never reach
   * for `codemode`, and costs a paragraph where it would anyway.
   */
  readonly nudge?: true;
}[] = Object.freeze([
  { family: "Claude Haiku", match: /^claude-(?:3-5-)?haiku/u, mode: "both" },
  { family: "Claude Sonnet", match: /^claude-(?:3-[57]-)?sonnet/u, mode: "both" },
  { family: "Claude Opus", match: /^claude-opus/u, mode: "both" },
  { family: "GPT-5", match: /^gpt-5/u, mode: "off", nudge: true },
  { family: "GLM", match: /^glm-/u, mode: "off", nudge: true },
]);

function familyOf(modelId: string): (typeof CODE_MODE_MODEL_DEFAULTS)[number] | undefined {
  // A routed id names its vendor first (`anthropic/claude-…`, Bedrock's
  // `us.anthropic.claude-…`); the family is what follows.
  const id = modelId
    .toLowerCase()
    .slice(modelId.lastIndexOf("/") + 1)
    .replace(/^(?:[a-z0-9-]+\.)+(?=claude-)/u, "");
  return CODE_MODE_MODEL_DEFAULTS.find((row) => row.match.test(id));
}

/** A model's built-in mode, before any pin. */
export function defaultCodeModeMode(modelId: string): CodeModeMode {
  return familyOf(modelId)?.mode ?? "off";
}

/** Whether a model's family is given the system prompt's Code Mode paragraph in mode `both`. */
export function codeModeNudgeFor(modelId: string): boolean {
  return familyOf(modelId)?.nudge === true;
}

/** The mode a new Session on `model` is born with under `policy`. */
export function codeModeModeFor(
  policy: CodeModePolicy,
  model: { providerId: string; modelId: string },
): CodeModeMode {
  if (!policy.enabled) return "off";
  const key = codeModeModelKey(model);
  return Object.hasOwn(policy.models, key)
    ? policy.models[key]!
    : defaultCodeModeMode(model.modelId);
}

/**
 * A stored policy, read tolerantly: anything unreadable falls back to the
 * default, and a pin that is not a mode is dropped rather than refusing the
 * whole setting. Written by main only, but it is durable data.
 */
export function readCodeModePolicy(value: unknown): CodeModePolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_CODE_MODE_POLICY;
  }
  const row = value as Record<string, unknown>;
  const enabled =
    typeof row["enabled"] === "boolean" ? row["enabled"] : DEFAULT_CODE_MODE_POLICY.enabled;
  const models: Record<string, CodeModeMode> = {};
  const stored = row["models"];
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    for (const [key, mode] of Object.entries(stored).slice(0, CODE_MODE_POLICY_MODELS_MAX)) {
      if (isCodeModeMode(mode) && isModelKey(key)) models[key] = mode;
    }
  }
  return { enabled, models };
}

function isModelKey(key: string): boolean {
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1 && key.length <= 512;
}

/** Tools past which an MCP server is large. */
export const LARGE_MCP_SERVER_TOOLS = 20;
/** Estimated declaration tokens past which an MCP server is large. */
export const LARGE_MCP_SERVER_TOKENS = 3_000;

/**
 * What one MCP tool's declaration costs, estimated: its name, description and
 * input schema as the provider would serialize them, at four characters a
 * token. Deliberately the cheap estimate — it decides a threshold, not a bill.
 */
export function estimateMcpDeclarationTokens(definition: McpToolDefinition): number {
  const chars =
    definition.providerName.length +
    definition.description.length +
    JSON.stringify(definition.inputSchema).length;
  return Math.ceil(chars / 4);
}

/** The servers, by id, whose tools are too many or too costly to declare. */
export function largeMcpServerIds(definitions: readonly McpToolDefinition[]): ReadonlySet<string> {
  const servers = new Map<string, { tools: number; tokens: number }>();
  for (const definition of definitions) {
    const server = servers.get(definition.serverId) ?? { tools: 0, tokens: 0 };
    server.tools += 1;
    server.tokens += estimateMcpDeclarationTokens(definition);
    servers.set(definition.serverId, server);
  }
  const large = new Set<string>();
  for (const [serverId, server] of servers) {
    if (server.tools > LARGE_MCP_SERVER_TOOLS || server.tokens > LARGE_MCP_SERVER_TOKENS) {
      large.add(serverId);
    }
  }
  return large;
}

/** What a new Session gets from Code Mode: whether `codemode` is offered, and its record. */
export interface CodeModeBirth {
  mode: CodeModeMode;
  /** Whether the system prompt carries Code Mode's paragraph: mode `both`, on a family it helps. */
  nudge: boolean;
  /** Whether the Session's surface should name `codemode`. */
  offered: boolean;
  /** The servers routed `deferred` for their size. */
  largeServers: ReadonlySet<string>;
}

/**
 * Whether a Session born on `model` with `mcpTools` is offered `codemode`:
 * when its mode is not `off`, or when it holds a large MCP server. With the
 * switch off, never.
 */
export function codeModeBirth(input: {
  policy: CodeModePolicy;
  model: { providerId: string; modelId: string } | null;
  mcpTools: readonly McpToolDefinition[];
}): CodeModeBirth {
  if (!input.policy.enabled) {
    return { mode: "off", nudge: false, offered: false, largeServers: new Set() };
  }
  const mode = input.model === null ? "off" : codeModeModeFor(input.policy, input.model);
  const nudge = mode === "both" && input.model !== null && codeModeNudgeFor(input.model.modelId);
  const largeServers = largeMcpServerIds(input.mcpTools);
  return { mode, nudge, offered: mode !== "off" || largeServers.size > 0, largeServers };
}

/**
 * The record a Session whose surface names `codemode` freezes: the mode's
 * routes, with every large server `deferred`. `mcpRoute` is a developer's
 * per-server override, and wins over both.
 */
export function codeModeSurfaceAtBirth(input: {
  birth: CodeModeBirth;
  tools: readonly SessionToolId[];
  mcpTools: readonly McpToolDefinition[];
  limits?: CodeModeLimits;
  mcpRoute?: (definition: McpToolDefinition) => ToolRoute | undefined;
}): CodeModeSurface | undefined {
  if (!input.tools.includes(CODE_MODE_TOOL_ID)) return undefined;
  return codeModeSurfaceFor({
    tools: input.tools,
    mcpTools: input.mcpTools,
    mode: input.birth.mode,
    nudge: input.birth.nudge,
    limits: input.limits ?? DEFAULT_CODE_MODE_LIMITS,
    mcpRoute: (definition) =>
      input.mcpRoute?.(definition) ??
      (input.birth.largeServers.has(definition.serverId) ? "deferred" : undefined),
  });
}
