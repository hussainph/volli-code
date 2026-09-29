/**
 * The developer-only opt-in for parallel MCP reads (VC-454).
 *
 * There is no product setting and no UI: this is read from one environment
 * variable, and only by an unpackaged build. A packaged app ignores it
 * entirely, so a shipped Volli cannot be talked into parallel dispatch by its
 * environment. Every field is host-authored by the developer who set it —
 * none of it comes from, or is checked against, anything an MCP server says
 * about its own tools.
 *
 * ```sh
 * VOLLI_DEV_MCP_PARALLEL='{
 *   "reads": ["<serverId>:<toolName>", ...],
 *   "limits": { "<serverId>": { "maxConcurrent": 2, "maxStarts": 6, "windowMs": 100 } }
 * }' pnpm dev
 * ```
 *
 * `reads` is the allowlist of exact `(serverId, toolName)` keys audited as
 * idempotent reads. It is stamped onto the MCP definitions of root Sessions
 * CREATED while it is set, and frozen there; an existing Session keeps what it
 * was born with, and a subagent Session inherits its parent's definitions,
 * marks included. The variable being set is also what lets those marks take effect
 * at all, so unsetting it and relaunching is the kill switch: every Session,
 * marked or not, goes back to one call at a time.
 *
 * `limits` overrides the shared per-server bound for the named servers
 * (`maxStarts` absent means no start-rate bound; `windowMs` defaults to one
 * second). Servers it does not name keep `DEFAULT_MCP_SERVER_LIMITS`, which
 * apply whether or not this variable is set.
 */
import { validateMcpServerLimits, type McpServerLimits } from "@volli/agent-runtime";
import { MCP_SERVER_ID_MAX_CHARS, MCP_TOOL_NAME_MAX_CHARS } from "@volli/shared";

export const MCP_PARALLEL_DEV_ENV = "VOLLI_DEV_MCP_PARALLEL";

export interface McpParallelDevConfig {
  /** Exact `serverId:toolName` keys, as `mcpToolKey` spells them. */
  reads: ReadonlySet<string>;
  limits: ReadonlyMap<string, McpServerLimits>;
}

export type McpParallelDevConfigResult =
  | { kind: "off" }
  | { kind: "on"; config: McpParallelDevConfig }
  | { kind: "invalid"; reason: string };

const SERVER_ID = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serverIdValid(serverId: string): boolean {
  return SERVER_ID.test(serverId) && serverId.length <= MCP_SERVER_ID_MAX_CHARS;
}

function readKey(entry: unknown): string {
  if (typeof entry !== "string") throw new Error("every reads entry must be a string");
  const colon = entry.indexOf(":");
  const serverId = colon < 0 ? "" : entry.slice(0, colon);
  const toolName = colon < 0 ? "" : entry.slice(colon + 1);
  if (!serverIdValid(serverId) || toolName.length === 0) {
    throw new Error(`reads entry "${entry}" is not "<serverId>:<toolName>"`);
  }
  if (toolName.length > MCP_TOOL_NAME_MAX_CHARS) {
    throw new Error(`reads entry "${entry}" names a tool that is too long`);
  }
  return entry;
}

function readLimits(serverId: string, value: unknown): McpServerLimits {
  if (!serverIdValid(serverId)) throw new Error(`limits key "${serverId}" is not a server id`);
  if (!isRecord(value)) throw new Error(`limits for "${serverId}" must be an object`);
  const { maxConcurrent, maxStarts, windowMs } = value;
  try {
    return validateMcpServerLimits({
      maxConcurrent: maxConcurrent as number,
      maxStarts: maxStarts === undefined ? Number.POSITIVE_INFINITY : (maxStarts as number),
      windowMs: windowMs === undefined ? 1_000 : (windowMs as number),
    });
  } catch (error) {
    throw new Error(`limits for "${serverId}": ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Read the opt-in from `env`. `packaged` builds always answer `off`; so does
 * an unset or empty variable. A value that does not parse answers `invalid`
 * with a reason, and the caller runs as if it were off — failing closed, to
 * one call at a time and the default bound.
 */
export function readMcpParallelDevConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { packaged: boolean },
): McpParallelDevConfigResult {
  const raw = env[MCP_PARALLEL_DEV_ENV];
  if (options.packaged || raw === undefined || raw.trim().length === 0) return { kind: "off" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("the value must be a JSON object");
    const unknownKey = Object.keys(parsed).find((key) => key !== "reads" && key !== "limits");
    if (unknownKey !== undefined) throw new Error(`unknown field "${unknownKey}"`);
    const reads = parsed.reads ?? [];
    if (!Array.isArray(reads)) throw new Error("reads must be an array");
    const limits = parsed.limits ?? {};
    if (!isRecord(limits)) throw new Error("limits must be an object");
    return {
      kind: "on",
      config: {
        reads: new Set(reads.map(readKey)),
        limits: new Map(
          Object.entries(limits).map(([serverId, value]) => [
            serverId,
            readLimits(serverId, value),
          ]),
        ),
      },
    };
  } catch (error) {
    return {
      kind: "invalid",
      reason: `${MCP_PARALLEL_DEV_ENV} was ignored: ${(error as Error).message}`,
    };
  }
}
