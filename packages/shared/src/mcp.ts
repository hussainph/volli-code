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
export const MCP_PROVENANCE_VALUE_MAX_CHARS = 256;
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

/**
 * The package ecosystems the MCP registry's `server.json` names (VC-380).
 *
 * Stored so a person can see what an install SAID it was installing. Volli
 * fetches nothing and verifies nothing here: a "source" is a note, and the
 * download-and-verify half belongs to VC-379, which owns package format
 * support. A value that is recorded but not enforced has to say so wherever it
 * appears, which is why the field names below are deliberately flat metadata
 * rather than anything shaped like a lockfile entry.
 */
export const MCP_REGISTRY_TYPES = ["npm", "pypi", "nuget", "cargo", "oci", "mcpb"] as const;

export type McpRegistryType = (typeof MCP_REGISTRY_TYPES)[number];

/**
 * Where one stored server's configuration came from — recorded, never verified.
 *
 * Every field is nullable and `null` means "nobody said", which is the honest
 * answer for a server a person typed into the Configure pane by hand. An
 * install that quotes a registry entry fills them in; nothing downstream reads
 * them as a guarantee, and {@link UNKNOWN_MCP_PROVENANCE} is what a row without
 * them holds.
 */
export interface McpServerProvenance {
  /** Where the configuration was read from: a registry name, a URL, a doc. */
  source: string | null;
  /** The ecosystem the source named, when it named one. */
  registryType: McpRegistryType | null;
  /** The version string the install ASKED for. Nothing pins it to what runs. */
  version: string | null;
  /** A digest the install supplied (`mcpb`'s `fileSha256`). Recorded, not checked. */
  digest: string | null;
}

/** What a server whose origin nobody recorded carries. */
export const UNKNOWN_MCP_PROVENANCE: McpServerProvenance = Object.freeze({
  source: null,
  registryType: null,
  version: null,
  digest: null,
});

export type McpProvenanceSanitization =
  | { ok: true; provenance: McpServerProvenance }
  | { ok: false; reason: string };

/** Which management operation an audit record is about. Reads and toggles are not audited. */
export type McpOperationKind = "install" | "remove";

/** Whether the operation changed the project's configuration, or failed trying. */
export type McpOperationOutcome = "applied" | "failed";

/**
 * One durable record of an MCP MANAGEMENT operation (VC-380).
 *
 * Domain vocabulary, so it lives here rather than beside the SQL that stores
 * it: the Configure pane names this type, and a future non-desktop client
 * reading the same history through a host's API must be able to name it without
 * importing anything desktop-owned.
 */
export interface McpOperationRecord {
  id: string;
  projectId: string;
  /** The server id as requested, kept even after the server row is gone. */
  serverId: string;
  serverName: string;
  operation: McpOperationKind;
  outcome: McpOperationOutcome;
  /** One line a person can read in a list: what was asked and how it ended. */
  summary: string;
  /** What to do next when it failed, or extra context when it did not. */
  detail: string | null;
  provenance: McpServerProvenance;
  /** The Session that asked, when a Session did. Null for a person in the pane. */
  sessionId: string | null;
  ticketId: string | null;
  createdAt: number;
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
  /** Where this configuration came from, as recorded at its last successful save. */
  provenance: McpServerProvenance;
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

const PROVENANCE_TEXT = /^[^\p{Cc}\p{Cf}]+$/u;
const PROVENANCE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/** One provenance field, trimmed, or `null` when nobody supplied a usable value. */
function provenanceText(
  raw: unknown,
  field: string,
  pattern: RegExp,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.length > MCP_PROVENANCE_VALUE_MAX_CHARS) {
    return { ok: false, reason: `provenance ${field} is invalid` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  return pattern.test(trimmed)
    ? { ok: true, value: trimmed }
    : { ok: false, reason: `provenance ${field} is invalid` };
}

/**
 * Validate the provenance an install supplied before it is stored (VC-380).
 *
 * Absence is not a failure: a server configured by hand has no origin to
 * record, and refusing one would make the note mandatory on the path where
 * there is nothing true to write. What IS refused is a value that could not be
 * read back honestly — a control character that would rewrite a line in the
 * pane or a log, or a value too long to be a version or a digest. The charset
 * bound is also the only thing keeping a careless caller from parking a
 * credential in a field a person will read: it holds no secret because it can
 * hold nothing structured, and the verb schema offers no other place to put one.
 */
export function sanitizeMcpProvenance(input: unknown): McpProvenanceSanitization {
  if (input === undefined || input === null) {
    return { ok: true, provenance: UNKNOWN_MCP_PROVENANCE };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "provenance must be an object" };
  }
  const row = input as Record<string, unknown>;
  const source = provenanceText(row["source"], "source", PROVENANCE_TEXT);
  if (!source.ok) return source;
  const version = provenanceText(row["version"], "version", PROVENANCE_TEXT);
  if (!version.ok) return version;
  const digest = provenanceText(row["digest"], "digest", PROVENANCE_DIGEST);
  if (!digest.ok) return digest;
  const rawType = row["registryType"];
  let registryType: McpRegistryType | null = null;
  if (rawType !== undefined && rawType !== null && rawType !== "") {
    if (!(MCP_REGISTRY_TYPES as readonly unknown[]).includes(rawType)) {
      return {
        ok: false,
        reason: `registry type must be one of: ${MCP_REGISTRY_TYPES.join(", ")}`,
      };
    }
    registryType = rawType as McpRegistryType;
  }
  return {
    ok: true,
    provenance: {
      source: source.value,
      registryType,
      version: version.value,
      digest: digest.value,
    },
  };
}

/**
 * The sentence a caller must read before a server is saved (VC-380).
 *
 * Two transports, two genuinely different hazards, so there is no single
 * generic caution: a stdio server is a PROCESS this machine starts as the
 * person using it, and an HTTP server is a THIRD PARTY that receives the
 * arguments every one of its tools is called with. A warning that said "be
 * careful" for both would tell a caller nothing it could act on.
 *
 * The HTTP half names the ORIGIN only. A URL a caller supplies is exactly the
 * kind of place a token ends up, and the warning is repeated into a
 * confirmation, a durable audit row and a model's context — three places a
 * query string has no business reaching. The agent verbs refuse a query string
 * outright ({@link mcpEndpointSecretRefusal}), so the warning has none to hide;
 * naming the origin is a choice about what IDENTIFIES a server, not a redaction.
 */
export function mcpInstallWarning(server: McpServerDraft): string {
  if (server.transport.type === "stdio") {
    const command = [server.transport.command, ...server.transport.args].join(" ");
    return [
      `${server.name} is a local MCP server: Volli starts \`${command}\` and it runs on this machine as you,`,
      "with your files, your credentials on disk and your network access, every time a Session calls one of its tools.",
      "Volli downloads nothing and verifies nothing \u2014 the command must already be on PATH, and whatever it does when it starts is out of Volli's hands.",
    ].join(" ");
  }
  const origin = new URL(server.transport.url).origin;
  return [
    `${server.name} is a remote MCP server at ${origin}: it receives whatever arguments its tools are given,`,
    "including file contents, paths and anything a model puts in a tool call, and Volli cannot see what it does with them.",
    "Volli adds no credentials of its own and supports no authentication, so this endpoint must be one that needs none.",
  ].join(" ");
}

/**
 * Why an agent-supplied endpoint carrying a query string is refused (VC-380).
 *
 * Acceptance 12 is absolute: no secret reaches a server process, a verb
 * argument, or a stored record. A query string is the one place in a URL a
 * token can still sit once userinfo and fragments are already refused, and an
 * agent has no secret store to put one anywhere better. Volli cannot tell
 * `?token=…` from `?version=2`, so it refuses the shape rather than guessing at
 * the meaning — the alternative is storing an unknown value in plain text, in
 * the database and in every backup bundle, and calling that support.
 *
 * A non-secret parameter is a real cost of this rule, so the refusal NAMES the
 * way through: a person can still add such a server in Settings, where they can
 * see what they are typing and chose it themselves. That path is VC-8's and
 * this ticket does not reopen it.
 */
export function mcpEndpointSecretRefusal(): string {
  return [
    "That endpoint carries a query string, and the MCP verbs refuse one.",
    "Volli has no secret storage for MCP servers and cannot tell a token from an ordinary parameter, so a query string would be stored in plain text and sent to the server as given.",
    "Authenticated servers are not supported yet. Use an endpoint that needs no credentials, or add this server by hand in Settings \u2192 Configure \u2192 MCP Servers.",
  ].join(" ");
}

/**
 * The sentence a caller must read before a server is removed (VC-380).
 *
 * Removal is worse than it looks, and the warning says the part a caller could
 * not guess: a Session's MCP tools are frozen at its birth, and
 * `serversForFrozenMcpTools` THROWS when a frozen tool's server is gone — so
 * deleting a row breaks reattachment for older Sessions that were using it.
 * Disabling leaves the row in place and only changes what NEW Sessions get,
 * which is what most callers actually mean, so it is named here rather than
 * left to be discovered.
 */
export function mcpRemovalWarning(serverName: string): string {
  return [
    `Removing ${serverName} deletes its configuration.`,
    `Any older Session that was born holding one of ${serverName}'s tools will fail to reattach afterwards, because the transport its frozen tool needs no longer exists.`,
    "That is not reversible by re-adding the server under a new id. If the intent is only to keep the tools out of NEW Sessions, call mcp_disable instead: it leaves every existing Session able to reattach.",
  ].join(" ");
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
