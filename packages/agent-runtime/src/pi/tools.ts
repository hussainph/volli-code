/**
 * Product tool names to Pi core's context-injected file tools.
 *
 * Volli names the file tools this slice is willing to load; Pi's spellings stay
 * behind this map so nothing above the runtime dispatches on them.
 *
 * The bundle is the only limit here. Every tool is bound to the same
 * environment the runtime resolved, which today is Pi's own and reaches the
 * whole machine — so what a Session cannot do is what it was never handed, not
 * what something downstream would refuse.
 */

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type AgentTool,
  type ExecutionEnv,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "@earendil-works/pi-ai";
import type { CodingToolId, RuntimeToolBundle } from "@volli/shared";

function bindContext<TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
  env: ExecutionEnv,
): AgentTool<TParameters, TDetails> {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate, { env }),
  };
}

function createTool(tool: CodingToolId, env: ExecutionEnv): AgentTool {
  switch (tool) {
    case "read":
      return bindContext(createReadTool(), env);
    case "edit":
      return bindContext(createEditTool(), env);
    case "write":
      return bindContext(createWriteTool(), env);
    case "execute":
      return bindContext(createBashTool(), env);
  }
}

/** Explicit Pi tool allowlist, in the order the product declared it. */
export function createPiTools(bundle: RuntimeToolBundle, env: ExecutionEnv): AgentTool[] {
  return bundle.tools.map((tool) => createTool(tool, env));
}
