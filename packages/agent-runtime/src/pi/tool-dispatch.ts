import type { AgentTool, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { McpToolDefinition } from "@volli/shared";

/**
 * How one runtime's Agents dispatch a model-issued tool batch (VC-444).
 *
 * Production is always `sequential`. `parallel` exists only behind the
 * fixture factory and is never a bare flag: it carries the host-authored set
 * of exact `serverId:toolName` MCP keys that may overlap. Every other tool —
 * every built-in (edit, write, bash, verbs, browser…) and every MCP tool not
 * on the list — is marked `sequential`, and Pi runs a whole batch serially the
 * moment it contains one sequential tool. An MCP definition's description,
 * annotations or read-only claim never enters this decision: those are
 * third-party data.
 */
export type ToolDispatch =
  | { mode: "sequential" }
  | { mode: "parallel"; mcpReadAllowlist: ReadonlySet<string> };

export const SEQUENTIAL_TOOL_DISPATCH: ToolDispatch = { mode: "sequential" };

/** The exact allowlist key for one frozen MCP definition. */
export function mcpDispatchKey(definition: Pick<McpToolDefinition, "serverId" | "toolName">) {
  return `${definition.serverId}:${definition.toolName}`;
}

/**
 * The tool array and Agent mode one attachment runs under.
 *
 * Sequential dispatch returns `tools` untouched, so ordinary Sessions are
 * byte-for-byte what they were. Parallel dispatch returns copies with
 * `executionMode: "sequential"` on everything that is not an allowlisted MCP
 * tool; tool names and schemas — the provider-visible half — do not change.
 */
export function applyToolDispatch(
  tools: readonly AgentTool[],
  mcp: readonly McpToolDefinition[],
  dispatch: ToolDispatch,
): { tools: AgentTool[]; toolExecution: ToolExecutionMode } {
  if (dispatch.mode === "sequential") return { tools: [...tools], toolExecution: "sequential" };
  const eligible = new Set<string>(
    mcp
      .filter((definition) => dispatch.mcpReadAllowlist.has(mcpDispatchKey(definition)))
      .map((definition) => definition.providerName),
  );
  return {
    tools: tools.map((tool) =>
      eligible.has(tool.name) ? tool : { ...tool, executionMode: "sequential" },
    ),
    toolExecution: "parallel",
  };
}
