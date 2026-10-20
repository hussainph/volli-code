import type { ExecutionEnv } from "../types";

/** Filesystem and shell context required by the built-in execution tools. */
export interface ExecutionToolContext {
  env: ExecutionEnv;
}
