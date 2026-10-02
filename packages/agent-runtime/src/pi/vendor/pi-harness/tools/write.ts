import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types";
import { getOrThrow } from "../types";
import { withFileMutationQueue } from "./file-mutation-queue";
import { resolveToolPath } from "./path-utils";
import type { ExecutionToolContext } from "./tool-context";

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export function createWriteTool<
  TContext extends ExecutionToolContext = ExecutionToolContext,
>(): AgentHarnessTool<TContext, typeof writeSchema, undefined> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    async execute(_toolCallId, { path, content }, _onUpdate, { env }, _invocation, context) {
      const absolutePath = await resolveToolPath(env, path, context);
      return withFileMutationQueue(
        env,
        absolutePath,
        async () => {
          if (context.abortSignal?.aborted) throw new Error("Operation aborted");
          getOrThrow(await env.writeFile(absolutePath, content, context));
          if (context.abortSignal?.aborted) throw new Error("Operation aborted");
          return {
            content: [{ type: "text", text: `Successfully wrote to ${path}` }],
            details: undefined,
          };
        },
        context,
      );
    },
  };
}
