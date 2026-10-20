import type { AgentTool, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { McpToolDefinition } from "@volli/shared";

/**
 * How one Session's Agent dispatches a model-issued tool batch (VC-454).
 *
 * Selected per Session, from the Session's own frozen record: it runs Pi's
 * `parallel` mode only when its frozen MCP definitions carry at least one
 * host-authored {@link McpToolDefinition.parallelRead} mark, and only when the
 * runtime was built to honour those marks at all. Everything else — every
 * ordinary Session, and every Session of a runtime that does not honour them —
 * runs `sequential` with its tool array untouched.
 *
 * In `parallel` mode every tool that is not a marked MCP read is marked
 * `executionMode: "sequential"`: every built-in (edit, write, bash, verbs,
 * browser, shell…) and every unmarked MCP tool. Pi runs a whole assistant
 * batch serially the moment it contains one sequential call, so a batch that
 * mixes a marked read with anything else falls back to one call at a time, in
 * source order. Volli's built-ins declare no mode of their own; without this
 * marking a parallel Agent would run file edits concurrently.
 *
 * A definition's description, annotations or read-only claim never enter this
 * decision: those are third-party data, and the mark is not.
 */
export function applyToolDispatch(
  tools: readonly AgentTool[],
  mcp: readonly McpToolDefinition[],
  honourParallelReads: boolean,
): { tools: AgentTool[]; toolExecution: ToolExecutionMode } {
  const eligible = new Set<string>(
    honourParallelReads
      ? mcp
          .filter((definition) => definition.parallelRead === true)
          .map((definition) => definition.providerName)
      : [],
  );
  if (eligible.size === 0) return { tools: [...tools], toolExecution: "sequential" };
  return {
    tools: tools.map((tool) =>
      eligible.has(tool.name) ? tool : { ...tool, executionMode: "sequential" },
    ),
    toolExecution: "parallel",
  };
}
