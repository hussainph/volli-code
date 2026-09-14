/**
 * Sanitized MCP vocabulary shared by the settings owner, durable Session input,
 * and Agent Runtime. MCP SDK values never cross into this module.
 */

import Ajv2020 from "ajv/dist/2020.js";

export const MCP_PROVIDER_NAME_MAX_CHARS = 64;
export const MCP_SERVER_ID_MAX_CHARS = 64;
export const MCP_SERVER_NAME_MAX_CHARS = 100;
export const MCP_TOOL_NAME_MAX_CHARS = 128;
export const MCP_DESCRIPTION_MAX_CHARS = 2_048;
export const MCP_ERROR_MAX_CHARS = 2_048;
export const MCP_SCHEMA_MAX_CHARS = 64 * 1_024;
export const MCP_SCHEMA_MAX_DEPTH = 16;
export const MCP_SCHEMA_MAX_NODES = 2_048;
export const MCP_TOOL_COUNT_MAX = 128;
export const MCP_CONNECTION_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 30_000;
export const MCP_RESULT_MAX_CHARS = 256 * 1_024;

export type McpJsonPrimitive = string | number | boolean | null;
export type McpJsonValue = McpJsonPrimitive | McpJsonObject | readonly McpJsonValue[];
export interface McpJsonObject {
  readonly [key: string]: McpJsonValue;
}

/** Provider-facing dynamic tool id. Exact MCP identity is always carried separately. */
export type McpToolId = `mcp__${string}`;

/** The complete sanitized definition frozen into Session history. */
export interface McpToolDefinition {
  serverId: string;
  toolName: string;
  providerName: McpToolId;
  description: string;
  inputSchema: McpJsonObject;
}

export interface McpToolCandidate {
  serverId: string;
  serverName: string;
  toolName: string;
  description?: string;
  inputSchema: unknown;
}

export type McpTransportConfig =
  | { type: "stdio"; command: string; args: readonly string[] }
  | { type: "streamable-http"; url: string };

export interface McpServerDraft {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportConfig;
}

export type McpServerSanitization =
  | { ok: true; server: McpServerDraft }
  | { ok: false; reason: string };

export interface McpCatalogTool {
  name: string;
  description: string;
  enabled: boolean;
  definition: McpToolDefinition | null;
  error: string | null;
}

export interface McpServerRecord extends McpServerDraft {
  projectId: string;
  catalog: readonly McpCatalogTool[];
  stale: boolean;
  error: string | null;
  refreshedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type McpToolSanitization =
  | { ok: true; definition: McpToolDefinition }
  | { ok: false; reason: string };

const PROVIDER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SERVER_ID = /^[A-Za-z0-9_-]+$/;
const JSON_SCHEMA_VALIDATOR = new Ajv2020({
  addUsedSchema: false,
  strict: false,
  validateFormats: false,
});

/** Small deterministic identity suffix. Final collision detection remains mandatory. */
function identityHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .toLowerCase();
  return cleaned.length === 0 ? fallback : cleaned;
}

/**
 * Stable and provider-safe by construction. The suffix binds the visible label
 * to exact server/tool identity; callers never recover identity by splitting it.
 */
export function mcpProviderToolName(
  serverId: string,
  serverName: string,
  toolName: string,
): McpToolId {
  const server = safeSegment(serverName, "server").slice(0, 18);
  const toolBudget = MCP_PROVIDER_NAME_MAX_CHARS - (5 + server.length + 2 + 2 + 8);
  const tool = safeSegment(toolName, "tool").slice(0, Math.max(1, toolBudget));
  const hash = identityHash(`${serverId}\u0000${toolName}`);
  return `mcp__${server}__${tool}__${hash}`;
}

export function isMcpToolId(value: unknown): value is McpToolId {
  return typeof value === "string" && value.startsWith("mcp__") && PROVIDER_NAME.test(value);
}

function schemaFailure(value: unknown): string | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return "input schema must be a JSON Schema object";
  }
  const root = value as Record<string, unknown>;
  if (root["type"] !== "object") return 'input schema root type must be "object"';
  if (
    root["properties"] !== undefined &&
    (root["properties"] === null ||
      Array.isArray(root["properties"]) ||
      typeof root["properties"] !== "object")
  ) {
    return "input schema properties must be an object";
  }
  if (
    root["required"] !== undefined &&
    (!Array.isArray(root["required"]) ||
      root["required"].some((entry: unknown) => typeof entry !== "string"))
  ) {
    return "input schema required must contain only strings";
  }

  let nodes = 0;
  const seen = new Set<object>();
  const visit = (entry: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > MCP_SCHEMA_MAX_NODES) return "input schema has too many values";
    if (depth > MCP_SCHEMA_MAX_DEPTH) return "input schema is nested too deeply";
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      return null;
    }
    if (typeof entry !== "object") return "input schema must contain only JSON values";
    if (seen.has(entry)) return "input schema must not contain cycles";
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const child of entry) {
        const failure = visit(child, depth + 1);
        if (failure !== null) return failure;
      }
      return null;
    }
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) {
      return "input schema must contain only JSON values";
    }
    for (const [key, child] of Object.entries(entry)) {
      if (key.length > 256) return "input schema contains an oversized key";
      const failure = visit(child, depth + 1);
      if (failure !== null) return failure;
    }
    return null;
  };
  const failure = visit(value, 0);
  if (failure !== null) return failure;
  const encoded = JSON.stringify(value);
  if (encoded.length > MCP_SCHEMA_MAX_CHARS) return "input schema is too large";
  try {
    return JSON_SCHEMA_VALIDATOR.validateSchema(value)
      ? null
      : "input schema must be valid JSON Schema";
  } catch {
    return "input schema must be valid JSON Schema";
  }
}

export function sanitizeMcpToolDefinition(input: McpToolCandidate): McpToolSanitization {
  if (!SERVER_ID.test(input.serverId) || input.serverId.length > MCP_SERVER_ID_MAX_CHARS) {
    return { ok: false, reason: "server id is invalid" };
  }
  if (input.serverName.trim().length === 0 || input.serverName.length > MCP_SERVER_NAME_MAX_CHARS) {
    return { ok: false, reason: "server name is invalid" };
  }
  if (input.toolName.length === 0) return { ok: false, reason: "tool name must not be empty" };
  if (input.toolName.length > MCP_TOOL_NAME_MAX_CHARS) {
    return { ok: false, reason: "tool name is too long" };
  }
  const description = input.description ?? "";
  if (description.length > MCP_DESCRIPTION_MAX_CHARS) {
    return { ok: false, reason: "tool description is too long" };
  }
  const schemaError = schemaFailure(input.inputSchema);
  if (schemaError !== null) return { ok: false, reason: schemaError };
  return {
    ok: true,
    definition: {
      serverId: input.serverId,
      toolName: input.toolName,
      providerName: mcpProviderToolName(input.serverId, input.serverName, input.toolName),
      description,
      inputSchema: input.inputSchema as McpJsonObject,
    },
  };
}

const STDIO_ARG_COUNT_MAX = 64;
const STDIO_VALUE_MAX_CHARS = 4_096;

/** Validate the settings shape before it reaches a transport constructor. */
export function sanitizeMcpServerDraft(input: {
  id: unknown;
  name: unknown;
  enabled: unknown;
  transport: unknown;
}): McpServerSanitization {
  if (
    typeof input.id !== "string" ||
    !SERVER_ID.test(input.id) ||
    input.id.length > MCP_SERVER_ID_MAX_CHARS
  ) {
    return { ok: false, reason: "server id is invalid" };
  }
  if (
    typeof input.name !== "string" ||
    input.name.trim().length === 0 ||
    input.name.length > MCP_SERVER_NAME_MAX_CHARS
  ) {
    return { ok: false, reason: "server name is invalid" };
  }
  if (typeof input.enabled !== "boolean") return { ok: false, reason: "enabled must be boolean" };
  if (input.transport === null || typeof input.transport !== "object") {
    return { ok: false, reason: "transport is invalid" };
  }
  const transport = input.transport as Record<string, unknown>;
  if (transport["type"] === "stdio") {
    const command = transport["command"];
    const args = transport["args"];
    if (
      typeof command !== "string" ||
      command.trim().length === 0 ||
      command.length > STDIO_VALUE_MAX_CHARS ||
      command.includes("\0") ||
      command.includes("\r") ||
      command.includes("\n")
    ) {
      return { ok: false, reason: "stdio executable is invalid" };
    }
    if (
      !Array.isArray(args) ||
      args.length > STDIO_ARG_COUNT_MAX ||
      args.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length > STDIO_VALUE_MAX_CHARS ||
          argument.includes("\u0000"),
      )
    ) {
      return { ok: false, reason: "stdio argument array is invalid" };
    }
    return {
      ok: true,
      server: {
        id: input.id,
        name: input.name.trim(),
        enabled: input.enabled,
        transport: { type: "stdio", command, args: [...(args as string[])] },
      },
    };
  }
  if (transport["type"] === "streamable-http") {
    if (typeof transport["url"] !== "string") {
      return { ok: false, reason: "streamable HTTP endpoint is invalid" };
    }
    if (transport["url"].length > STDIO_VALUE_MAX_CHARS) {
      return { ok: false, reason: "streamable HTTP endpoint is too long" };
    }
    let url: URL;
    try {
      url = new URL(transport["url"]);
    } catch {
      return { ok: false, reason: "streamable HTTP endpoint is invalid" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: "streamable HTTP endpoint must use http or https" };
    }
    if (url.username.length > 0 || url.password.length > 0) {
      return { ok: false, reason: "streamable HTTP endpoint must not contain credentials" };
    }
    if (url.hash.length > 0) {
      return { ok: false, reason: "streamable HTTP endpoint must not contain a fragment" };
    }
    return {
      ok: true,
      server: {
        id: input.id,
        name: input.name.trim(),
        enabled: input.enabled,
        transport: { type: "streamable-http", url: url.toString() },
      },
    };
  }
  return { ok: false, reason: "transport must be stdio or streamable-http" };
}

/** Validate a whole frozen set, including conflicts no single definition can see. */
export function validateMcpToolDefinitions(
  definitions: readonly McpToolDefinition[],
): readonly McpToolDefinition[] {
  if (definitions.length > MCP_TOOL_COUNT_MAX) {
    throw new Error(`MCP tool set exceeds the ${MCP_TOOL_COUNT_MAX}-tool limit`);
  }
  const identities = new Set<string>();
  const providerNames = new Set<string>();
  for (const definition of definitions) {
    const sanitized = sanitizeMcpToolDefinition({
      serverId: definition.serverId,
      serverName: "recorded",
      toolName: definition.toolName,
      description: definition.description,
      inputSchema: definition.inputSchema,
    });
    if (!sanitized.ok)
      throw new Error(`Invalid MCP tool ${definition.toolName}: ${sanitized.reason}`);
    if (!isMcpToolId(definition.providerName)) {
      throw new Error(`Invalid MCP provider name for ${definition.toolName}`);
    }
    const identity = `${definition.serverId}\u0000${definition.toolName}`;
    if (identities.has(identity)) throw new Error(`Duplicate MCP tool ${definition.toolName}`);
    identities.add(identity);
    if (providerNames.has(definition.providerName)) {
      throw new Error(`MCP provider name collision: ${definition.providerName}`);
    }
    providerNames.add(definition.providerName);
  }
  return definitions;
}
