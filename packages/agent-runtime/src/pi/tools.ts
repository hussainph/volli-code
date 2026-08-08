/**
 * Product tool names to Pi core's context-injected file tools.
 *
 * Volli names the contained file tools this slice is willing to load; Pi's
 * spellings stay behind this map so nothing above the runtime dispatches on
 * them.
 */

import {
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type AgentTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "@earendil-works/pi-ai";
import type { CodingToolId, RuntimeToolBundle } from "../contracts";
import type { ScopedExecutionEnv } from "./scoped-execution-env";

function bindContext<TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
  env: ScopedExecutionEnv,
): AgentTool<TParameters, TDetails> {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate, { env }),
  };
}

function createTool(tool: CodingToolId, env: ScopedExecutionEnv): AgentTool {
  switch (tool) {
    case "read":
      return bindContext(createReadTool(), env);
    case "edit":
      return bindContext(createEditTool(), env);
    case "write":
      return bindContext(createWriteTool(), env);
  }
}

/** Explicit contained Pi tool allowlist, in the order the product declared it. */
export function createPiTools(bundle: RuntimeToolBundle, env: ScopedExecutionEnv): AgentTool[] {
  return bundle.tools.map((tool) => createTool(tool, env));
}
